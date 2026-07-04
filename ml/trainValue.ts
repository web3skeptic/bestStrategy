// Streaming value-net v2 trainer V(s) (plan M2.4). Split out from ml/train.ts;
// reuses the new state-feature vector (the SAME `featurize` the BC trainer uses),
// the hard-vs-hard streaming corpus (games generated on the fly by seed), and the
// resumable runs infra (ml/runs.ts).
//
// Two selectable OUTPUT HEADS (`--head tanh|linear`) and two selectable TARGETS
// (`--target mc|td --lambda 0.9 --gamma 1.0`):
//   • mc  — Monte-Carlo: the final game outcome z∈{-1,+1} from the to-move
//           player's perspective, propagated to every visited turn-boundary state.
//   • td  — TD(λ): per-trajectory λ-returns bootstrapped from the value net's own
//           CURRENT estimates, using the negamax sign convention for the 2-player
//           alternating game (V(s) is always from the to-move player's frame, so a
//           child ply's value enters the parent with a flipped sign). Reduces to
//           MC at λ=1 and to TD(0) at λ=0. γ default 1.0 (finite, terminal-reward).
//
// MODEL SELECTION is by validation SPEARMAN RANK-CORRELATION between V(s) and the
// eventual game outcome, BUCKETED BY GAME PHASE (early/mid/late) — NOT greedy
// win-rate. Phase = fraction of the game elapsed at that state (state's ply index /
// total plies of that game), split at thirds (early <1/3, mid <2/3, late ≥2/3).
// Fraction-of-progress buckets keep the three phases balanced across variable-
// length games (a game can end anywhere from ~R3 to the R90 cap). Rank-correlation
// is invariant to the monotone head transform, so tanh vs linear are compared on
// the same footing.
//
// Head note: MLP.forward is LINEAR-only, so `--head tanh` is applied HERE (in the
// trainer's loss + in validation) via the generic accumulate() gradient API; a net
// trained with the tanh head, once loaded by searchPolicy/eval, returns the raw
// pre-tanh logit from net.value(). That logit is a monotone function of tanh(logit),
// so the search LEAF RANKING (argmax over candidates) is identical — see report.
//
// Usage:
//   npx tsx ml/trainValue.ts --tag v2mc  --head tanh   --target mc \
//     --steps 4000 --batch 256 --lr 1e-3 --hidden 128,128 --seed 300000 \
//     --valGames 60 [--saveEvery 200] [--report 50] [--out ml/weights/value-net-v2mc.json] [--resume]
//   npx tsx ml/trainValue.ts --tag v2td --head linear --target td --lambda 0.9 --gamma 1.0 ...
import { MLP } from './mlp';
import { loadNet, saveNet } from './mlpIO';
import { featurize, FEATURE_DIM } from './features';
import { reset } from './gameEnv';
import { hardTurn, materialWinner } from './play';
import { GameState } from '../src/types';
import { initRun, heartbeat, saveProgress, readProgress, logLine, RunHandle } from './runs';
import { existsSync } from 'fs';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

// Held-out validation games live in a seed block disjoint from every training/eval
// block (train 10k–500k · probes/eval 700k–800k · gate 1,000,000+). 760k sits in
// the probe band and is never used for training here.
const VAL_SEED_BASE = 760000;

type Head = 'tanh' | 'linear';
type Target = 'mc' | 'td';

interface StateRec { x: Float64Array; pid: number; }
interface Traj { recs: StateRec[]; winner: number | null; }
interface Sample { x: Float64Array; target: number; }

// Play one hard-vs-hard game; record the (to-move POV features, to-move pid) at
// every turn boundary, plus the (material-decided if capped) winner. Mirrors
// streamHardDecisions but at TURN granularity — the granularity V is queried at
// during search (leaf = post-turn position).
function playGame(seed: number, maxRounds = 90): Traj {
  const s: GameState = reset({ seed, nPlayers: 2 });
  const recs: StateRec[] = [];
  let half = 0;
  while (s.phase === 'playing' && s.turnNumber <= maxRounds && half < maxRounds * 2) {
    recs.push({ x: featurize(s, s.currentPlayerIndex), pid: s.currentPlayerIndex });
    hardTurn(s);
    half++;
  }
  const winner = s.winner ? s.winner.id : (s.phase === 'playing' ? materialWinner(s) : null);
  return { recs, winner };
}

// Outcome of a game from player `pid`'s perspective: +1 win, −1 loss, 0 draw.
function outcomeFor(winner: number | null, pid: number): number {
  return winner === null ? 0 : (winner === pid ? 1 : -1);
}

// Apply the selected output head to a raw linear logit.
function applyHead(head: Head, logit: number): number {
  return head === 'tanh' ? Math.tanh(logit) : logit;
}

// Turn one game's trajectory into (x, target) samples for the chosen target rule.
//   mc: target = eventual outcome from the state's to-move perspective.
//   td: per-trajectory λ-returns, negamax bootstrap on the net's CURRENT headed
//       value. G_t = γ[(1−λ)(−b_{t+1}) + λ(−G_{t+1})] for t<H−1; G_{H−1}=o_{H−1}.
//       (λ=1 ⇒ MC ; λ=0 ⇒ one-step TD.) All values are in the state's OWN frame.
function targetsFor(traj: Traj, target: Target, head: Head, net: MLP, lambda: number, gamma: number): Sample[] {
  const H = traj.recs.length;
  const out: Sample[] = [];
  if (target === 'mc') {
    for (const r of traj.recs) out.push({ x: r.x, target: outcomeFor(traj.winner, r.pid) });
    return out;
  }
  // TD(λ): compute the net's current headed value b_t for every state, then fold
  // the λ-returns backward with the per-ply sign flip.
  const b = traj.recs.map(r => applyHead(head, net.value(r.x)));
  const G = new Float64Array(H);
  for (let t = H - 1; t >= 0; t--) {
    if (t === H - 1) {
      G[t] = outcomeFor(traj.winner, traj.recs[t]!.pid); // bootstrap on the true terminal outcome
    } else {
      G[t] = gamma * ((1 - lambda) * -b[t + 1]! + lambda * -G[t + 1]!);
    }
  }
  for (let t = 0; t < H; t++) out.push({ x: traj.recs[t]!.x, target: G[t]! });
  return out;
}

// One Adam step over a minibatch. Head-aware MSE: yhat = head(logit); the gradient
// wrt the logit is (yhat − target) · head'(logit) (the tanh factor for `tanh`, 1 for
// `linear`), fed straight into the generic linear-output backprop (accumulate).
function trainStep(net: MLP, batch: Sample[], lr: number, head: Head): number {
  net.beginBatch();
  let loss = 0;
  const B = batch.length;
  for (const s of batch) {
    const logit = net.value(s.x);
    const yhat = applyHead(head, logit);
    const err = yhat - s.target;
    loss += err * err;
    const dOut = head === 'tanh' ? err * (1 - yhat * yhat) : err;
    net.accumulate(s.x, dOut);
  }
  net.step(lr, B);
  return loss / B;
}

// ── Spearman rank-correlation (average ranks → Pearson on ranks). Average ranks
// are REQUIRED here: outcomes take only {−1,0,+1}, so ties dominate and the
// 1−6Σd² shortcut would be wrong. ──
function rankAvg(a: number[]): number[] {
  const n = a.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i]! - a[j]!);
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && a[idx[j + 1]!]! === a[idx[i]!]!) j++;
    const avg = (i + j) / 2 + 1; // average 1-based rank for the tie block
    for (let k = i; k <= j; k++) ranks[idx[k]!] = avg;
    i = j + 1;
  }
  return ranks;
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return NaN;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]!; my += y[i]!; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i]! - mx, dy = y[i]! - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const den = Math.sqrt(sxx * syy);
  return den > 0 ? sxy / den : NaN;
}

function spearman(xs: number[], ys: number[]): number {
  if (xs.length < 2) return NaN;
  return pearson(rankAvg(xs), rankAvg(ys));
}

// A held-out validation sample: cached features (played ONCE at startup) tagged
// with the state's game-phase and the eventual outcome from its to-move POV.
interface ValRec { x: Float64Array; phase: 0 | 1 | 2; outcome: number; }

function buildValidation(nGames: number): ValRec[] {
  const recs: ValRec[] = [];
  for (let g = 0; g < nGames; g++) {
    const traj = playGame(VAL_SEED_BASE + g);
    const H = traj.recs.length;
    for (let t = 0; t < H; t++) {
      const frac = H > 1 ? t / (H - 1) : 0;
      const phase: 0 | 1 | 2 = frac < 1 / 3 ? 0 : frac < 2 / 3 ? 1 : 2;
      recs.push({ x: traj.recs[t]!.x, phase, outcome: outcomeFor(traj.winner, traj.recs[t]!.pid) });
    }
  }
  return recs;
}

interface RankReport { overall: number; early: number; mid: number; late: number; n: number; }

function rankCorr(net: MLP, head: Head, val: ValRec[]): RankReport {
  // Spearman is invariant to the monotone head transform, but apply the head so
  // the reported V is exactly the trained quantity.
  const vAll: number[] = [], oAll: number[] = [];
  const byPhase: [number[], number[]][] = [[[], []], [[], []], [[], []]];
  for (const r of val) {
    const v = applyHead(head, net.value(r.x));
    vAll.push(v); oAll.push(r.outcome);
    byPhase[r.phase]![0].push(v); byPhase[r.phase]![1].push(r.outcome);
  }
  return {
    overall: spearman(vAll, oAll),
    early: spearman(byPhase[0]![0], byPhase[0]![1]),
    mid: spearman(byPhase[1]![0], byPhase[1]![1]),
    late: spearman(byPhase[2]![0], byPhase[2]![1]),
    n: val.length,
  };
}

function fmt(x: number): string { return Number.isFinite(x) ? x.toFixed(4) : ' n/a  '; }

process.on('uncaughtException', (e) => { console.error(`UNCAUGHT: ${e?.stack ?? e}`); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(`UNHANDLED: ${(e as Error)?.stack ?? e}`); process.exit(1); });

(async () => {
  const tag = arg('tag', 'v2')!;
  const head = (arg('head', 'tanh') as Head);
  const target = (arg('target', 'mc') as Target);
  const lambda = Number(arg('lambda', '0.9'));
  const gamma = Number(arg('gamma', '1.0'));
  const steps = Number(arg('steps', '4000'));
  const batch = Number(arg('batch', '256'));
  const lr = Number(arg('lr', '1e-3'));
  const hidden = (arg('hidden', '128,128')!).split(',').map(Number);
  const seedBase = Number(arg('seed', '300000'));
  const saveEvery = Number(arg('saveEvery', '200'));
  const reportEvery = Number(arg('report', '50'));
  const valGames = Number(arg('valGames', '60'));
  const resume = process.argv.includes('--resume');
  const weightsPath = arg('out', `ml/weights/value-net-${tag}.json`)!;
  const bestPath = weightsPath.replace(/\.json$/, '-best.json');

  if (head !== 'tanh' && head !== 'linear') throw new Error(`--head must be tanh|linear (got ${head})`);
  if (target !== 'mc' && target !== 'td') throw new Error(`--target must be mc|td (got ${target})`);

  const cfg = { kind: 'value', head, target, lambda, gamma, steps, batch, lr, hidden, seedBase, valGames, weightsPath };
  const h: RunHandle = initRun(tag, cfg, { train: `${seedBase}+`, val: `${VAL_SEED_BASE}+${valGames}` });
  const net = resume && existsSync(weightsPath) ? loadNet(weightsPath) : new MLP([FEATURE_DIM, ...hidden, 1], lr);
  const prog = resume ? readProgress(h) : null;
  let step = prog ? Number(prog.step) : 0;
  let gameCursor = prog ? Number(prog.gameCursor) : seedBase;
  let samplesSeen = prog ? Number(prog.samplesSeen ?? 0) : 0;
  let bestRank = prog ? Number(prog.bestRank ?? -Infinity) : -Infinity;
  if (prog) console.log(`RESUME tag=${tag} step=${step} gameCursor=${gameCursor}`);

  console.log(`Building held-out validation set: ${valGames} games from seed ${VAL_SEED_BASE}...`);
  const val = buildValidation(valGames);
  console.log(`  ${val.length} validation states (phase split by game-progress thirds).`);

  const buffer: Sample[] = [];
  let winLoss = 0, winN = 0, t0 = Date.now();

  while (step < steps) {
    // Stream one game, compute its targets under the CURRENT net (matters for TD).
    const traj = playGame(gameCursor++);
    for (const s of targetsFor(traj, target, head, net, lambda, gamma)) buffer.push(s);

    while (buffer.length >= batch && step < steps) {
      const b = buffer.splice(0, batch);
      const loss = trainStep(net, b, lr, head);
      step++; samplesSeen += batch;
      winLoss += loss; winN++;

      if (step % reportEvery === 0) {
        const line = `step ${step}/${steps} loss=${(winLoss / winN).toFixed(4)} games=${gameCursor - seedBase} samples=${samplesSeen} buf=${buffer.length} | ${((Date.now() - t0) / 1000).toFixed(0)}s`;
        console.log(line); logLine(h, line);
        heartbeat(h, { step, steps, loss: +(winLoss / winN).toFixed(4), games: gameCursor - seedBase, samplesSeen });
        winLoss = 0; winN = 0;
      }

      if (step % saveEvery === 0) {
        saveNet(net, weightsPath);
        const rr = rankCorr(net, head, val);
        const rline = `  [val step ${step}] rankcorr overall=${fmt(rr.overall)} early=${fmt(rr.early)} mid=${fmt(rr.mid)} late=${fmt(rr.late)} (n=${rr.n})`;
        console.log(rline); logLine(h, rline);
        if (Number.isFinite(rr.overall) && rr.overall > bestRank) {
          bestRank = rr.overall; saveNet(net, bestPath);
          const bl = `  ↑ new best overall rankcorr ${rr.overall.toFixed(4)} → saved ${bestPath}`;
          console.log(bl); logLine(h, bl);
        }
        saveProgress(h, { step, gameCursor, samplesSeen, bestRank });
      }
    }
  }

  saveNet(net, weightsPath);
  const rr = rankCorr(net, head, val);
  if (Number.isFinite(rr.overall) && rr.overall > bestRank) { bestRank = rr.overall; saveNet(net, bestPath); }
  saveProgress(h, { step, gameCursor, samplesSeen, bestRank });

  // ── Final model-selection table (this is how the better head/target combo is
  // chosen — per-phase + overall Spearman rank-corr on the held-out games). ──
  const bar = '─'.repeat(58);
  const table = [
    bar,
    `V-NET v2 MODEL-SELECTION SUMMARY  tag=${tag}`,
    `  head=${head}  target=${target}${target === 'td' ? `  lambda=${lambda}  gamma=${gamma}` : ''}`,
    `  input=${FEATURE_DIM}  hidden=[${hidden.join(',')}]  steps=${step}  games=${gameCursor - seedBase}  valStates=${rr.n}`,
    bar,
    `  phase        Spearman(V, outcome)`,
    `  early (<1/3)     ${fmt(rr.early)}`,
    `  mid   (<2/3)     ${fmt(rr.mid)}`,
    `  late  (≥2/3)     ${fmt(rr.late)}`,
    `  OVERALL          ${fmt(rr.overall)}`,
    bar,
    `RESULT tag=${tag} head=${head} target=${target} rankcorr_overall=${fmt(rr.overall)} early=${fmt(rr.early)} mid=${fmt(rr.mid)} late=${fmt(rr.late)}`,
    bar,
  ].join('\n');
  console.log(table);
  for (const l of table.split('\n')) logLine(h, l);
  console.log(`DONE value tag=${tag} steps=${step} weights=${weightsPath} best=${bestPath} (bestOverall=${fmt(bestRank)})`);
})().catch(e => { console.error(e); process.exit(1); });
