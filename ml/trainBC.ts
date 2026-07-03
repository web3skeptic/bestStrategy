// Streaming behavioural-cloning trainer for the policy head π(s,a) (plan M2.3).
// Plays hard-vs-hard games on the fly (fresh seeds, no sample store); at each
// expert decision, softmax-cross-entropy pushes probability toward the hard AI's
// chosen micro over the legal candidate set (end-turn included, expert force-
// included, capped at 64). Resumable + heartbeat-logged via ml/runs.ts.
//
// Usage: npx tsx ml/trainBC.ts --tag bc1 --steps 4000 --batch 256 --lr 1e-3 \
//          --hidden 128,128 --seed 10000 [--saveEvery 200] [--resume]
import { MLP } from './mlp';
import { newPolicyNet, POLICY_IN, STATE_DIM } from './policy';
import { featurize } from './features';
import { actionFeatures, buildActionCtx, ACTION_DIM } from './actionFeatures';
import { legalMicros, Micro } from './gameEnv';
import { GameState } from '../src/types';
import { streamHardDecisions, matchMicro } from './bcRecord';
import { initRun, heartbeat, saveProgress, readProgress, logLine, RunHandle } from './runs';
import { existsSync } from 'fs';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const CAP = 64; // max candidates scored per decision during training

interface Decision { inputs: Float64Array[]; expertIdx: number; action: string; }

// Optional class-rebalancing for the CE loss (default OFF → reproducibility).
// - 'inverse-freq': weight each decision by 1/freq(type), normalised so the mean
//   weight over the seen type distribution is 1 (keeps the effective LR scale).
// - 'focal': multiply CE by (1 - p_true)^gamma — down-weights easy decisions the
//   policy already gets right, concentrating gradient on rare/hard ones (capture).
interface WeightOpts { mode: 'none' | 'inverse-freq' | 'focal'; focalGamma: number; typeCounts: Map<string, number>; }

function makeDecision(state: GameState, micro: Micro, pid: number): Decision | null {
  const cands = legalMicros(state);
  const eIdx = matchMicro(cands, micro);
  if (eIdx < 0) return null; // expert action not in candidate set (≈never; fidelity=100%)
  let use = cands, idx = eIdx;
  if (cands.length > CAP) {
    const others: Micro[] = [];
    for (let i = 0; i < cands.length && others.length < CAP - 1; i++) if (i !== eIdx) others.push(cands[i]!);
    use = [cands[eIdx]!, ...others]; idx = 0;
  }
  const sf = featurize(state, pid);
  const ctx = buildActionCtx(state, pid);
  const inputs = use.map(c => {
    const inp = new Float64Array(POLICY_IN); inp.set(sf, 0);
    const a = new Float64Array(ACTION_DIM); actionFeatures(state, ctx, c, a); inp.set(a, STATE_DIM);
    return inp;
  });
  return { inputs, expertIdx: idx, action: use[idx]!.action };
}

function trainStep(net: MLP, batch: Decision[], lr: number, perType: Map<string, [number, number]>, wo: WeightOpts): { loss: number; acc: number } {
  net.beginBatch();
  let loss = 0, correct = 0;
  const B = batch.length;
  for (const d of batch) {
    const C = d.inputs.length;
    const logits = new Float64Array(C);
    for (let k = 0; k < C; k++) logits[k] = net.value(d.inputs[k]!);
    let mx = -Infinity; for (const v of logits) if (v > mx) mx = v;
    let sum = 0; const pr = new Float64Array(C);
    for (let k = 0; k < C; k++) { pr[k] = Math.exp(logits[k]! - mx); sum += pr[k]!; }
    for (let k = 0; k < C; k++) pr[k]! /= sum;
    // Per-decision loss/gradient weight (w === 1 for mode 'none' → unchanged).
    let w = 1;
    if (wo.mode === 'inverse-freq') {
      const tc = wo.typeCounts;
      tc.set(d.action, (tc.get(d.action) ?? 0) + 1);
      let total = 0; for (const v of tc.values()) total += v;
      w = total / (tc.size * tc.get(d.action)!);           // mean-1 over the type dist.
    } else if (wo.mode === 'focal') {
      w = Math.pow(1 - pr[d.expertIdx]!, wo.focalGamma);
    }
    loss += w * -Math.log(Math.max(1e-9, pr[d.expertIdx]!));
    let am = 0; for (let k = 1; k < C; k++) if (logits[k]! > logits[am]!) am = k;
    const hit = am === d.expertIdx ? 1 : 0; correct += hit;
    const pt = perType.get(d.action) ?? [0, 0]; pt[0] += hit; pt[1] += 1; perType.set(d.action, pt);
    for (let k = 0; k < C; k++) net.accumulate(d.inputs[k]!, w * (pr[k]! - (k === d.expertIdx ? 1 : 0)));
  }
  net.step(lr, B);
  return { loss: loss / B, acc: correct / B };
}

(async () => {
  const tag = arg('tag', 'bc1')!;
  const steps = Number(arg('steps', '4000'));
  const batch = Number(arg('batch', '256'));
  const lr = Number(arg('lr', '1e-3'));
  const hidden = (arg('hidden', '128,128')!).split(',').map(Number);
  const seedBase = Number(arg('seed', '10000'));
  const saveEvery = Number(arg('saveEvery', '200'));
  const reportEvery = Number(arg('report', '50'));
  const resume = process.argv.includes('--resume');
  const weightsPath = `ml/weights/policy-${tag}.json`;

  // ── Class-imbalance remedies (all DEFAULT OFF → current runs reproduce) ──
  // --classWeight <none|inverse-freq|focal>   --focalGamma <g>   (loss reweighting)
  // --oversample <type,type:factor>           (duplicate rare-type decisions in the
  //                                            stream, e.g. capture,upgrade-temple:4)
  const wo: WeightOpts = {
    mode: (arg('classWeight', 'none') as WeightOpts['mode']),
    focalGamma: Number(arg('focalGamma', '2.0')),
    typeCounts: new Map<string, number>(),
  };
  const oversampleTypes = new Set<string>();
  let oversampleFactor = 1;
  const osArg = arg('oversample', '');
  if (osArg) {
    const [typesCsv, facStr] = osArg.split(':');
    oversampleFactor = Math.max(1, Math.floor(Number(facStr ?? '1')));
    for (const t of (typesCsv ?? '').split(',')) if (t) oversampleTypes.add(t);
  }

  const h: RunHandle = initRun(tag, { kind: 'bc', steps, batch, lr, hidden, seedBase, weightsPath });
  const net = resume && existsSync(weightsPath) ? MLP.load(weightsPath) : newPolicyNet(hidden, lr);
  const prog = resume ? readProgress(h) : null;
  let step = prog ? Number(prog.step) : 0;
  let gameCursor = prog ? Number(prog.gameCursor) : seedBase;
  let decisionsSeen = prog ? Number(prog.decisionsSeen ?? 0) : 0;
  if (prog) console.log(`RESUME tag=${tag} step=${step} gameCursor=${gameCursor}`);

  const buffer: Decision[] = [];
  const perType = new Map<string, [number, number]>();
  let winLoss = 0, winAcc = 0, winN = 0, unmatched = 0, t0 = Date.now();

  const onMicro = (state: GameState, micro: Micro, pid: number) => {
    const d = makeDecision(state, micro, pid);
    if (!d) { unmatched++; return; }
    // Oversample: push rare-type decisions `factor`× so they recur across batches.
    const reps = oversampleTypes.has(d.action) ? oversampleFactor : 1;
    for (let r = 0; r < reps; r++) buffer.push(d);
  };

  while (step < steps) {
    streamHardDecisions(gameCursor++, onMicro);
    decisionsSeen = decisionsSeen; // (buffer holds them)
    while (buffer.length >= batch && step < steps) {
      const b = buffer.splice(0, batch);
      const m = trainStep(net, b, lr, perType, wo);
      step++; decisionsSeen += batch;
      winLoss += m.loss; winAcc += m.acc; winN++;
      if (step % reportEvery === 0) {
        const types = [...perType.entries()].map(([k, [c, n]]) => `${k}:${(100 * c / Math.max(1, n)).toFixed(0)}%`).join(' ');
        const line = `step ${step}/${steps} loss=${(winLoss / winN).toFixed(3)} top1=${(100 * winAcc / winN).toFixed(1)}% games=${gameCursor - seedBase} dec=${decisionsSeen} unmatched=${unmatched} | ${types} | ${((Date.now() - t0) / 1000).toFixed(0)}s`;
        console.log(line); logLine(h, line);
        heartbeat(h, { step, steps, loss: +(winLoss / winN).toFixed(3), top1: +(winAcc / winN).toFixed(3), games: gameCursor - seedBase, decisionsSeen });
        winLoss = 0; winAcc = 0; winN = 0; perType.clear();
      }
      if (step % saveEvery === 0) { net.save(weightsPath); saveProgress(h, { step, gameCursor, decisionsSeen }); }
    }
  }
  net.save(weightsPath); saveProgress(h, { step, gameCursor, decisionsSeen });
  console.log(`DONE bc tag=${tag} steps=${step} games=${gameCursor - seedBase} decisions=${decisionsSeen} weights=${weightsPath}`);
})().catch(e => { console.error(e); process.exit(1); });
