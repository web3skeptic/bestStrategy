// ─────────────────────────────────────────────────────────────────────────────
// M4 — REINFORCE-with-baseline over π+search (expert-iteration flavor).
//
// ROLLOUT POLICY = search-over-π, EXACTLY as Gate G3 (see searchPolicy.ts):
//   proposer π (policy-g2.json OR policy-bc3.json per the initializer A/B),
//   K=12, temp=1.0, depth=1, leaf=blend (0.5·V + 0.5·heuristic), V=value-net-v2mc-best.
//   The terminal ±1e6 short-circuit is PRESERVED UNCONDITIONALLY (the win-lock that
//   recovers pivotal temple-captures). searchTurnRecording() below is a faithful,
//   NON-PERTURBING re-implementation of makePolicySearchBot that additionally records
//   the micro-actions (and their pre-decision states) of the candidate turn search
//   selected, so the policy gradient can credit them.
//
// ── GRADIENT-CREDIT FORMULATION (documented decision, see report) ──
//   A "turn" is a macro-action = a sequence of micros. Search proposes K candidate
//   turns (1 greedy + K−1 temp=1 sampled) and commits the best (terminal short-circuit,
//   else opponent-reply leaf value). We reinforce the policy TOWARD the turn search
//   selected (expert-iteration): the improved macro-action gets positive credit when it
//   led to a good return.
//     log π(turn | s_t) = Σ_micro log π(micro | intermediate state)
//   Every decision made while ROLLING OUT the selected candidate (including the final
//   end-turn choice) is credited with the SAME per-turn advantage A_t.
//
//   REINFORCE-with-baseline, Monte-Carlo return, discount γ:
//     baseline  V = value-net-v2mc-best (FROZEN in Phase A; never trained here).
//     advantage A_t = R_t − V(s_t)
//     R_t = γ^(M−t)·z  +  Σ_{k=t..M−1} γ^(k−t)·F_k         (M = #our turns, z = terminal ±1/0)
//   POTENTIAL-BASED shaping (Ng et al. 1999 — policy-invariant, telescopes):
//     F_k = γ·Φ(s_{k+1}) − Φ(s_k),   Φ(s) = β · (#temples owned by our player at s).
//   β is SMALL and ANNEALED so terminal win(+1)/loss(−1) dominates. We shape the
//   OUTCOME (temples owned), NEVER the capture action-type → structurally cannot
//   recreate the bc2 reward-hacking collapse.
//
//   Per credited micro k with candidate softmax p and chosen index a, the loss is
//     L = −A_t · log π(a | s) → dL/dlogit_k = A_t·(p_k − 1{k=a})
//   i.e. the SAME machinery as trainBC's softmax-CE, with the CE weight replaced by
//   the advantage. Positive advantage pushes π toward the search-selected micro.
//
//   WHY expert-iteration ADVANTAGE-WEIGHTING (not AGZ-style pure imitation of the
//   search target): the value leaf V is FROZEN in M4 → AGZ imitation would put ZERO
//   outcome signal into π. Advantage-weighting is the ONLY variant that injects
//   win/loss into π given a frozen leaf. (A69-ratified 2026-07-03.)
//
//   ASYMMETRIC ADVANTAGE DAMPING — ANNEALED, action-type-agnostic, kill-switched
//   (A69 HARD REQUIREMENT, supersedes the earlier permanent-0.4 framing):
//     A_eff = A > 0 ? A : A·d(ep),   d = negAdvDamp(start 0.4) → 1.0 linearly over a
//     warm-up window (first --negAdvDampWarmupFrac of the run), then 1.0 (NO damping).
//   - d depends ONLY on advantage sign + training progress — ZERO action-type term
//     (asymmetric protection of high-variance capture moves would smuggle the bc2
//     capture-preference back in through the advantage; forbidden).
//   - WHY ANNEAL (A69 direction-correction): damping negatives WEAKENS the policy's
//     ability to ABANDON losing early moves (down-push ∝ |A|·d) — and "won't abandon
//     losing early moves" IS the B3=100% failure mode. So a PERMANENT 0.4 caps the
//     G4 ceiling. Damping is EARLY manifold-holding / stability ONLY; late training
//     MUST run full-strength negative gradients (d=1.0). It is NOT a B3 fix.
//   - KILL-SWITCH: if the WR climb flattens/regresses while d<1.0, the monitor touches
//     `/tmp/rl-<tag>.dampoff` → d forced to 1.0 live for the remainder. Effective d is
//     logged each episode for the damping-on-vs-off read.
//
// ── BC-MIX ANCHOR ──
//   Each update also accumulates a small BC softmax-CE gradient (coef λ_bc) from the
//   hard-AI expert stream (reuse streamHardDecisions/matchMicro) into the SAME batch,
//   so a single Adam step blends RL + imitation → prevents drift off the manifold.
//
// ── EPISODE MIX ──  --hardFrac (default 0.8): 80% vs-hard / 20% self-play.
// ── Φ-SIGNAL-DENSITY instrumentation (the initializer-A/B metric) ──
//   In `--mode ab`, roll out N self-play games (NO training) and report the fraction
//   of player-trajectories in which a temple capture COMPLETES and Φ fires (the
//   player's owned-temple count increments). This is the kill-criterion metric.
//
// ── SEED HYGIENE ── train-vs-hard 810000+, self-play 820000+, ckpt-select 830000+.
// ── CHECKPOINTS ── ml/weights/policy-rl-<tag>-<step>.json (NEVER overwrite g2/bc3/v2mc).
//
// Usage:
//   npx tsx ml/trainRL.ts --mode ab    --init ml/weights/policy-g2.json  --abGames 40
//   npx tsx ml/trainRL.ts --mode train --tag g2 --init ml/weights/policy-g2.json \
//       --episodes 20 --smoke
// ─────────────────────────────────────────────────────────────────────────────
import { MLP } from './mlp';
import { GameState } from '../src/types';
import { reset, cloneState, legalMicros, applyMicro, isAlive, Micro } from './gameEnv';
import { endTurn, getOwnedStructures } from '../src/game';
import { featurize } from './features';
import { actionFeatures, buildActionCtx, ACTION_DIM } from './actionFeatures';
import { POLICY_IN, STATE_DIM } from './policy';
import { heuristicLeaf } from './heuristicLeaf';
import { hardTurn, materialWinner, runGame, TurnFn } from './play';
import { makePolicyBot } from './policy';
import { streamHardDecisions, matchMicro } from './bcRecord';
import { evalPool } from './evalPool';
import { runJobsPool, GameJob } from './pool';
import { BotSpec } from './botSpec';
import { wilson } from './eval';
import { hexDistance } from '../src/hex';
import { existsSync, readFileSync } from 'fs';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

// ── input featurization for one candidate set (state ⊕ action per candidate) ──
const _scratchInput = new Float64Array(POLICY_IN);
function candInputs(state: GameState, pid: number, cands: Micro[]): Float64Array[] {
  const sf = featurize(state, pid);
  const ctx = buildActionCtx(state, pid);
  return cands.map(c => {
    const inp = new Float64Array(POLICY_IN);
    inp.set(sf, 0);
    const a = new Float64Array(ACTION_DIM); actionFeatures(state, ctx, c, a); inp.set(a, STATE_DIM);
    return inp;
  });
}
function scoreOnly(net: MLP, state: GameState, pid: number, cands: Micro[]): Float64Array {
  const sf = featurize(state, pid);
  const ctx = buildActionCtx(state, pid);
  const logits = new Float64Array(cands.length);
  _scratchInput.set(sf, 0);
  const a = new Float64Array(ACTION_DIM);
  for (let k = 0; k < cands.length; k++) {
    actionFeatures(state, ctx, cands[k]!, a); _scratchInput.set(a, STATE_DIM);
    logits[k] = net.value(_scratchInput);
  }
  return logits;
}
function argmax(a: Float64Array): number { let b = 0; for (let i = 1; i < a.length; i++) if (a[i]! > a[b]!) b = i; return b; }
function softmax(logits: Float64Array): Float64Array {
  let mx = -Infinity; for (const v of logits) if (v > mx) mx = v;
  let s = 0; const p = new Float64Array(logits.length);
  for (let k = 0; k < logits.length; k++) { p[k] = Math.exp(logits[k]! - mx); s += p[k]!; }
  for (let k = 0; k < p.length; k++) p[k]! /= s;
  return p;
}
function ownedTemples(s: GameState, pid: number): number {
  return getOwnedStructures(s, pid).length;
}

// ── PLUGGABLE shaping potential Φ: State×pid → ℝ (A50 STEP-1 refinement) ──────
// Potential-based shaping F(s,s') = γΦ(s') − Φ(s) is Ng-1999 policy-invariant for
// ANY Φ:S→ℝ, so the CHOICE of Φ only changes WHERE the shaping term has gradient,
// never the optimal policy. Selected by --phi. Both return a RAW potential ~O(1);
// the caller multiplies by the small annealed coefficient β so terminal win/loss
// dominates.
export type PhiFn = (s: GameState, pid: number) => number;

// Φ_temples = #temples owned. STEP-0 showed the 8 G3 losses never contest temples
// (maxOwned ≤ 2/4) → this potential is FLAT (≈0 shaping gradient) in exactly the
// trajectories the bot loses. Kept as the capture-insurance arm.
const phiTemples: PhiFn = (s, pid) => ownedTemples(s, pid);

// Φ_early = an early-game / positional / anti-suppression potential — has gradient
// in the suppression phase where the bot actually fails. Defensible bounded scalar:
//   0.5·tanh(materialHpDiff/100) + 0.5·boardControl − 0.5·templeSuppression
//   materialHpDiff  = ΣmyHP − ΣenemyHP
//   boardControl    = mean over my units of (1 − nearestEnemyTempleDist/(2R)) ∈[0,1]
//                     (advancement off the home temple = the opposite of "ground down")
//   templeSuppression = fraction of my temples with an enemy unit within dist 2 ∈[0,1]
// → roughly bounded in [−1, 1], changes almost every turn (units move / HP shifts).
const phiEarly: PhiFn = (s, pid) => {
  const R = s.mapRadius;
  const myUnits = s.units.filter(u => u.hp > 0 && u.playerId === pid);
  const enemyUnits = s.units.filter(u => u.hp > 0 && u.playerId !== pid);
  const myTemples = getOwnedStructures(s, pid);
  const enemyTemples = s.players.filter(p => p.id !== pid).flatMap(p => getOwnedStructures(s, p.id));
  const capturable = s.strategicSites.filter(t => t.ownerId !== pid);
  const myHp = myUnits.reduce((a, u) => a + u.hp, 0);
  const themHp = enemyUnits.reduce((a, u) => a + u.hp, 0);
  const targets = enemyTemples.length ? enemyTemples : capturable;
  let ctrl = 0;
  for (const u of myUnits) {
    let m = Infinity; for (const t of targets) m = Math.min(m, hexDistance(u.pos, t.pos));
    ctrl += 1 - Math.min(1, (m === Infinity ? R : m) / (2 * R));
  }
  const control = myUnits.length ? ctrl / myUnits.length : 0;
  let suppressed = 0;
  for (const t of myTemples) for (const e of enemyUnits) if (hexDistance(e.pos, t.pos) <= 2) { suppressed++; break; }
  const suppression = myTemples.length ? suppressed / myTemples.length : 0;
  return 0.5 * Math.tanh((myHp - themHp) / 100) + 0.5 * control - 0.5 * suppression;
};

function getPhi(name: string): PhiFn { return name === 'early' ? phiEarly : phiTemples; }

// One decision made during a rolled-out turn: the pre-decision state clone + chosen micro.
interface CreditStep { state: GameState; micro: Micro; pid: number; }

// Faithful, non-perturbing re-implementation of makePolicyBot's turn loop that
// RECORDS every decision (pre-state clone + chosen micro). Mutates `s` in place.
// RNG consumption is identical to makePolicyBot (cloneState uses no Math.random),
// so a rollout here is bit-identical to the deployed proposer's turn.
function rolloutTurnRecording(net: MLP, s: GameState, temp: number, rng: () => number, maxMicros = 48): CreditStep[] {
  const steps: CreditStep[] = [];
  const pid = s.currentPlayerIndex;
  for (let step = 0; step < maxMicros; step++) {
    if (s.phase !== 'playing') return steps;
    const cands = legalMicros(s);
    if (cands.length === 0) { endTurn(s); return steps; }
    const logits = scoreOnly(net, s, s.currentPlayerIndex, cands);
    let choice: number;
    if (temp > 0) {
      const p = new Float64Array(logits.length);
      let mx = -Infinity; for (const v of logits) if (v > mx) mx = v;
      let sum = 0; for (let k = 0; k < logits.length; k++) { p[k] = Math.exp((logits[k]! - mx) / temp); sum += p[k]!; }
      let r = rng() * sum, acc = 0; choice = logits.length - 1;
      for (let k = 0; k < logits.length; k++) { acc += p[k]!; if (r <= acc) { choice = k; break; } }
    } else choice = argmax(logits);
    const micro = cands[choice]!;
    steps.push({ state: cloneState(s), micro, pid });
    if (micro.action === 'end-turn') { endTurn(s); return steps; }
    if (!applyMicro(s, micro)) { endTurn(s); return steps; }
  }
  if (s.phase === 'playing') endTurn(s);
  return steps;
}

// Search-over-π turn that plays exactly like makePolicySearchBot (K candidates,
// terminal ±1e6 short-circuit, opp reply, depth, leaf) AND returns the credit steps
// of the committed candidate. `opp` models the reply (hard AI, as G3).
function searchTurnRecording(
  pnet: MLP, leaf: (s: GameState, b: number) => number, opp: TurnFn,
  s: GameState, K: number, temp: number, depth: number, rng: () => number,
): CreditStep[] {
  const botId = s.currentPlayerIndex;
  const terminalVal = (st: GameState, b: number): number | null =>
    st.phase !== 'playing' ? (st.winner ? (st.winner.id === b ? 1e6 : -1e6) : 0) : null;
  const cands: { state: GameState; steps: CreditStep[] }[] = [];
  { const c = cloneState(s); const st = rolloutTurnRecording(pnet, c, 0, rng); cands.push({ state: c, steps: st }); }
  for (let k = 1; k < K; k++) { const c = cloneState(s); const st = rolloutTurnRecording(pnet, c, temp, rng); cands.push({ state: c, steps: st }); }

  let best = cands[0]!, bestV = -Infinity;
  for (const cand of cands) {
    const c = cand.state;
    let v = terminalVal(c, botId);
    if (v === null) {
      const r = cloneState(c);
      opp(r);
      let tv = terminalVal(r, botId);
      if (tv === null && depth >= 2) { /* depth-2: our greedy reply then their reply */
        rolloutTurnRecording(pnet, r, 0, rng); tv = terminalVal(r, botId);
        if (tv === null) { opp(r); tv = terminalVal(r, botId); }
      }
      v = tv !== null ? tv : leaf(r, botId);
    }
    if (v > bestV) { bestV = v; best = cand; }
  }
  Object.assign(s, best.state);
  return best.steps;
}

// ── one recorded turn (for training / advantage computation) ──
interface TurnRec { pid: number; s: GameState; sAfter: GameState; ownedBefore: number; ownedAfter: number; steps: CreditStep[]; }

interface EpisodeResult { turns: TurnRec[]; winner: number | null; }

// Play one full episode. `learner` pids use search-over-π (recorded); non-learner
// pids use `opp` (hard AI). Returns per-turn records + winner.
function playEpisode(cfg: {
  pnet: MLP; leaf: (s: GameState, b: number) => number; opp: TurnFn;
  learner: Set<number>; seed: number; nPlayers: number; forceFirst?: number;
  K: number; temp: number; depth: number; maxRounds: number;
}): EpisodeResult {
  const s = reset({ seed: cfg.seed, nPlayers: cfg.nPlayers, forceFirst: cfg.forceFirst });
  const rng = Math.random; // seeded global stream (reset seeded it); matches G3 deployment
  const turns: TurnRec[] = [];
  let half = 0;
  const cap = cfg.maxRounds * cfg.nPlayers;
  while (s.phase === 'playing' && s.turnNumber <= cfg.maxRounds && half < cap) {
    const pid = s.currentPlayerIndex;
    if (cfg.learner.has(pid)) {
      const before = cloneState(s);
      const ownedBefore = ownedTemples(s, pid);
      const steps = searchTurnRecording(cfg.pnet, cfg.leaf, cfg.opp, s, cfg.K, cfg.temp, cfg.depth, rng);
      turns.push({ pid, s: before, sAfter: cloneState(s), ownedBefore, ownedAfter: ownedTemples(s, pid), steps });
    } else {
      cfg.opp(s);
    }
    half++;
  }
  const winner = s.winner ? s.winner.id : (s.phase === 'playing' ? materialWinner(s) : null);
  return { turns, winner };
}

// ── advantage computation with potential-based Φ shaping ──
// Returns, per credited micro, its advantage weight (grouping micros by their turn).
interface AdvGroup { steps: CreditStep[]; adv: number; captured: boolean; pid: number; }
function computeAdvantages(ep: EpisodeResult, vnet: MLP, gamma: number, beta: number, phi: PhiFn): AdvGroup[] {
  const out: AdvGroup[] = [];
  // group turns by pid, in play order
  const byPid = new Map<number, TurnRec[]>();
  for (const t of ep.turns) { (byPid.get(t.pid) ?? byPid.set(t.pid, []).get(t.pid)!).push(t); }
  for (const [pid, ts] of byPid) {
    const z = ep.winner === null ? 0 : (ep.winner === pid ? 1 : -1);
    const M = ts.length;
    // R_t = γ^(M−t)·z + Σ_{k=t..M−1} γ^(k−t)·F_k,  F_k = γ·Φ(s_{k+1}) − Φ(s_k)
    //   Φ(s_k)     = β·phi(ts[k].s, pid)            (turn-start state)
    //   Φ(s_{k+1}) = β·phi(ts[k+1].s, pid) for k<M−1, else β·phi(ts[M−1].sAfter, pid) (terminal)
    const F = new Array<number>(M);
    for (let k = 0; k < M; k++) {
      const phiK = beta * phi(ts[k]!.s, pid);
      const phiNext = beta * (k < M - 1 ? phi(ts[k + 1]!.s, pid) : phi(ts[M - 1]!.sAfter, pid));
      F[k] = gamma * phiNext - phiK;
    }
    for (let t = 0; t < M; t++) {
      let R = Math.pow(gamma, M - t) * z;
      for (let k = t; k < M; k++) R += Math.pow(gamma, k - t) * F[k]!;
      const V = vnet.value(featurize(ts[t]!.s, pid));
      out.push({ steps: ts[t]!.steps, adv: R - V, captured: ts[t]!.ownedAfter > ts[t]!.ownedBefore, pid });
    }
  }
  return out;
}

// Accumulate the REINFORCE grad for one credited micro into net's batch.
// Returns π's prob-mass on the search-SELECTED action (−1 if the micro no longer
// matches, ≈never), for the lost-game suppression telemetry.
function accumulatePG(net: MLP, step: CreditStep, adv: number): number {
  const cands = legalMicros(step.state);
  const idx = matchMicro(cands, step.micro);
  if (idx < 0) return -1;
  const inputs = candInputs(step.state, step.pid, cands);
  const logits = new Float64Array(cands.length);
  for (let k = 0; k < cands.length; k++) logits[k] = net.value(inputs[k]!);
  const p = softmax(logits);
  for (let k = 0; k < cands.length; k++) net.accumulate(inputs[k]!, adv * (p[k]! - (k === idx ? 1 : 0)));
  return p[idx]!;
}

// Accumulate a BC softmax-CE grad (coef λ) for one expert decision.
const BC_CAP = 64;
function accumulateBC(net: MLP, state: GameState, micro: Micro, pid: number, lambda: number): number {
  const all = legalMicros(state);
  const eIdx = matchMicro(all, micro);
  if (eIdx < 0) return 0;
  let cands = all, idx = eIdx;
  if (all.length > BC_CAP) {
    const others: Micro[] = [];
    for (let i = 0; i < all.length && others.length < BC_CAP - 1; i++) if (i !== eIdx) others.push(all[i]!);
    cands = [all[eIdx]!, ...others]; idx = 0;
  }
  const inputs = candInputs(state, pid, cands);
  const logits = new Float64Array(cands.length);
  for (let k = 0; k < cands.length; k++) logits[k] = net.value(inputs[k]!);
  const p = softmax(logits);
  for (let k = 0; k < cands.length; k++) net.accumulate(inputs[k]!, lambda * (p[k]! - (k === idx ? 1 : 0)));
  return 1;
}

function blendLeaf(vnet: MLP): (s: GameState, b: number) => number {
  return (s, b) => 0.5 * vnet.value(featurize(s, b)) + 0.5 * heuristicLeaf(s, b);
}

// ─────────────────────────────── MODE: ab (Φ-signal density) ───────────────────
async function runAB(pnetPath: string, vnet: MLP, K: number, temp: number, depth: number, nGames: number, seedBase: number, maxRounds: number) {
  const pnet = MLP.load(pnetPath);
  const leaf = blendLeaf(vnet);
  let trajFired = 0, trajTotal = 0, gameFired = 0, totalCaps = 0;
  const t0 = Date.now();
  for (let g = 0; g < nGames; g++) {
    const ep = playEpisode({ pnet, leaf, opp: hardTurn, learner: new Set([0, 1]), seed: seedBase + g, nPlayers: 2, forceFirst: g % 2, K, temp, depth, maxRounds });
    // per player-trajectory: did that pid ever complete a temple capture (Φ fired)?
    const firedByPid = new Map<number, boolean>();
    let anyGame = false;
    for (const t of ep.turns) {
      const inc = t.ownedAfter > t.ownedBefore;
      if (inc) { totalCaps += (t.ownedAfter - t.ownedBefore); anyGame = true; }
      firedByPid.set(t.pid, (firedByPid.get(t.pid) ?? false) || inc);
    }
    for (const pid of [0, 1]) { trajTotal++; if (firedByPid.get(pid)) trajFired++; }
    if (anyGame) gameFired++;
    if ((g + 1) % 5 === 0 || g === nGames - 1)
      console.log(`  ab ${pnetPath.split('/').pop()} ${g + 1}/${nGames}  trajFired=${trajFired}/${trajTotal} gameFired=${gameFired}/${g + 1}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const density = trajFired / trajTotal;
  console.log(`AB-RESULT init=${pnetPath} N=${nGames} trajFired=${trajFired}/${trajTotal} PHI-DENSITY(traj)=${(100 * density).toFixed(1)}%  gameFired=${gameFired}/${nGames}(${(100 * gameFired / nGames).toFixed(1)}%)  captures=${totalCaps}`);
  return { density, trajFired, trajTotal, gameFired, nGames, totalCaps };
}

// ───────────────── MODE: coverage (Φ-gradient coverage on loss trajectories) ───
// A50 STEP-1 check (Phase A, cheap, READ-ONLY replay — writes NO weights, no train).
// Reconstructs the EXACT G3 gate pairing per gameId so the replay reproduces the
// LOSS trajectory (evalPool: pair=⌊id/2⌋, seed=800000+pair, botSlot=id%2,
// forceFirst=pair%2). For BOTH potentials measures Φ-gradient COVERAGE = fraction of
// our-turn transitions (s_k → s_{k+1}) where the shaping term is non-zero
// (|Φ(s_{k+1}) − Φ(s_k)| > eps). Prediction (A50): Φ_temples coverage ≈ 0 on the
// early-suppression losses (temples never contested) while Φ_early coverage ≫ 0.
async function runCoverage(pnetPath: string, vnet: MLP, K: number, temp: number, depth: number, gameIds: number[], gateSeedBase: number, maxRounds: number) {
  const pnet = MLP.load(pnetPath);
  const leaf = blendLeaf(vnet);
  const EPS = 1e-9;
  const phis: [string, PhiFn][] = [['temples', phiTemples], ['early', phiEarly]];
  const agg = new Map<string, { changed: number; total: number }>(phis.map(([n]) => [n, { changed: 0, total: 0 }]));
  const aggLoss = new Map<string, { changed: number; total: number }>(phis.map(([n]) => [n, { changed: 0, total: 0 }]));
  console.log(`COVERAGE init=${pnetPath} gameIds=[${gameIds.join(',')}] gateSeedBase=${gateSeedBase} (read-only gate-pairing replay, no training)`);
  for (const id of gameIds) {
    const pair = Math.floor(id / 2), seed = gateSeedBase + pair, botSlot = id % 2, forceFirst = pair % 2;
    const ep = playEpisode({ pnet, leaf, opp: hardTurn, learner: new Set([botSlot]), seed, nPlayers: 2, forceFirst, K, temp, depth, maxRounds });
    const ours = ep.turns.filter(t => t.pid === botSlot);
    const isLoss = ep.winner !== null && ep.winner !== botSlot;
    const perSeed: Record<string, string> = {};
    for (const [name, phi] of phis) {
      let changed = 0, total = 0;
      for (let k = 0; k < ours.length; k++) {
        const cur = phi(ours[k]!.s, botSlot);
        const next = k < ours.length - 1 ? phi(ours[k + 1]!.s, botSlot) : phi(ours[ours.length - 1]!.sAfter, botSlot);
        total++; if (Math.abs(next - cur) > EPS) changed++;
      }
      const a = agg.get(name)!; a.changed += changed; a.total += total;
      if (isLoss) { const al = aggLoss.get(name)!; al.changed += changed; al.total += total; }
      perSeed[name] = `${changed}/${total}`;
    }
    console.log(`  game ${id} (seed ${seed} slot ${botSlot}): outcome=${ep.winner === botSlot ? 'W' : ep.winner === null ? 'D' : 'L'} ourTurns=${ours.length} maxOwned=${Math.max(0, ...ours.map(t => t.ownedAfter))}  temples ${perSeed.temples}  early ${perSeed.early}`);
  }
  const fmt = (m: Map<string, { changed: number; total: number }>) => phis.map(([n]) => { const a = m.get(n)!; return `${n}=${(100 * a.changed / Math.max(1, a.total)).toFixed(1)}% (${a.changed}/${a.total})`; }).join('  ');
  console.log(`COVERAGE-RESULT all: ${fmt(agg)}`);
  console.log(`COVERAGE-RESULT losses-only: ${fmt(aggLoss)}`);
}

// ─────────────────────────────── MODE: train (+ smoke) ────────────────────────
async function runTrain(opts: {
  tag: string; initPath: string; vnet: MLP; K: number; temp: number; depth: number;
  episodes: number; lr: number; gamma: number; beta0: number; betaAnneal: number;
  bcCoef: number; hardFrac: number; seedHard: number; seedSelf: number;
  maxRounds: number; saveEvery: number; smoke: boolean; phi: PhiFn; phiName: string;
  pressureSeeds: number[]; pressureFrac: number; negAdvDamp: number; negAdvDampWarmupFrac: number;
}) {
  // Annealed damping factor d(ep): start → 1.0 linearly over the warm-up window, then
  // 1.0. Kill-switch: presence of the dampoff file forces d=1.0 live (monitor-triggered).
  const killFile = `/tmp/rl-${opts.tag}.dampoff`;
  const dampAt = (ep: number): number => {
    if (existsSync(killFile)) return 1.0;
    const w = Math.max(1, opts.negAdvDampWarmupFrac * opts.episodes);
    return opts.negAdvDamp + (1 - opts.negAdvDamp) * Math.min(1, ep / w);
  };
  const net = MLP.load(opts.initPath);   // policy π (trainable); starts from the A/B-chosen init
  net.lr = opts.lr;
  const leaf = blendLeaf(opts.vnet);
  let hardSeed = opts.seedHard, selfSeed = opts.seedSelf;
  console.log(`TRAIN cfg phi=${opts.phiName} β0=${opts.beta0} anneal=${opts.betaAnneal} hardFrac=${opts.hardFrac} negAdvDamp=${opts.negAdvDamp}→1.0/warmup${opts.negAdvDampWarmupFrac} killFile=${killFile} pressureFrac=${opts.pressureFrac} pressureSeeds=${opts.pressureSeeds.length}`);
  // Telemetry tells (A69, ratified DROP-only — never raise damping on plateau):
  // (a) π prob-mass on the search-selected action in LOST games; (b) mean neg-adv
  // magnitude on capture/pivotal turns. If the WR climb flattens/regresses while d<1.0
  // → drop damping to 1.0 live (touch the killFile), NOT raise it; a genuine WR CRASH
  // → prefer an LR/shaping cut. The anneal (dampAt) already removes damping over time.
  const telem = { lostSelMass: 0, lostSelN: 0, negAdvCapSum: 0, negAdvCapN: 0 };
  let wins = 0, played = 0;
  const t0 = Date.now();
  // BC stream state
  let bcSeed = 30000; const bcBuf: { s: GameState; m: Micro; pid: number }[] = [];
  const refillBC = () => { while (bcBuf.length < 512) streamHardDecisions(bcSeed++, (st, m, pid) => bcBuf.push({ s: cloneState(st), m, pid })); };

  for (let ep = 0; ep < opts.episodes; ep++) {
    const beta = opts.beta0 * Math.pow(opts.betaAnneal, ep); // annealed Φ coefficient
    const vsHard = Math.random() < opts.hardFrac;
    // Early-pressure curriculum lever (Phase B): with prob pressureFrac, a vs-hard
    // episode draws from the supplied early-pressure seed pool (810k block) instead
    // of the incrementing counter — biases the rollout distribution toward the
    // early-game-suppression states STEP-0 found to be the real fragility. Default
    // pressureFrac=0 → pure incrementing seeds (Phase A).
    const usePressure = vsHard && opts.pressureSeeds.length > 0 && Math.random() < opts.pressureFrac;
    const seed = usePressure ? opts.pressureSeeds[Math.floor(Math.random() * opts.pressureSeeds.length)]!
      : (vsHard ? hardSeed++ : selfSeed++);
    const learner = vsHard ? new Set([0]) : new Set([0, 1]);
    const opp = hardTurn;
    const forceFirst = ep % 2;
    const result = playEpisode({ pnet: net, leaf, opp, learner, seed, nPlayers: 2, forceFirst, K: opts.K, temp: opts.temp, depth: opts.depth, maxRounds: opts.maxRounds });
    const learnerWon = result.winner !== null && learner.has(result.winner);
    if (vsHard) { played++; if (result.winner === 0) wins++; }

    const advGroups = computeAdvantages(result, opts.vnet, opts.gamma, beta, opts.phi);
    // Asymmetric damping (A69): full positive credit; negatives scaled by the ANNEALED
    // action-type-agnostic factor d(ep) (0.4→1.0), kill-switchable to 1.0 live.
    const dVal = dampAt(ep);
    const damp = (a: number) => a > 0 ? a : a * dVal;
    // advantage-RMS scale for LR stability (no mean shift → sign preserved)
    let sumsq = 0, cnt = 0; for (const g of advGroups) { const d = damp(g.adv); sumsq += d * d; cnt++; }
    const rms = Math.sqrt(sumsq / Math.max(1, cnt)) + 1e-6;
    const scale = 1 / rms;

    net.beginBatch();
    let items = 0; let advAbs = 0;
    for (const g of advGroups) {
      const a = damp(g.adv) * scale; advAbs += Math.abs(a);
      const lost = result.winner !== null && result.winner !== g.pid; // this pid lost
      for (const st of g.steps) {
        const pSel = accumulatePG(net, st, a);
        if (pSel < 0) continue; items++;
        if (lost) { telem.lostSelMass += pSel; telem.lostSelN++; } // π mass on search-selected action in LOST games
      }
      if (g.captured && g.adv < 0) { telem.negAdvCapSum += Math.abs(g.adv); telem.negAdvCapN++; } // neg-adv magnitude on capture/pivotal turns
    }
    // BC-mix anchor
    refillBC();
    const bcN = Math.min(128, bcBuf.length);
    let bcItems = 0;
    for (let i = 0; i < bcN; i++) { const d = bcBuf.shift()!; bcItems += accumulateBC(net, d.s, d.m, d.pid, opts.bcCoef); }
    const B = Math.max(1, items + bcItems);

    // weight snapshot for grad-flow diagnostic (smoke)
    let before0: number[] | null = null;
    if (opts.smoke) before0 = Array.from(net.layers[0]!.W.slice(0, 8));
    net.step(opts.lr, B);
    let dW = 0;
    if (opts.smoke && before0) { const now = net.layers[0]!.W; for (let i = 0; i < 8; i++) dW += Math.abs(now[i]! - before0[i]!); }

    if (opts.smoke || (ep + 1) % 5 === 0)
      console.log(`ep ${ep + 1}/${opts.episodes} ${vsHard ? 'vsHard' : 'self'} seed=${seed} win=${learnerWon ? 'Y' : 'n'} turns=${result.turns.length} pgItems=${items} bcItems=${bcItems} |adv|·scale=${(advAbs / Math.max(1, advGroups.length)).toFixed(3)} β=${beta.toFixed(4)} d=${dVal.toFixed(3)}${opts.smoke ? ` |dW[0:8]|=${dW.toExponential(2)}` : ''} ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    if ((ep + 1) % opts.saveEvery === 0 || ep === opts.episodes - 1) {
      const path = `ml/weights/policy-rl-${opts.tag}-${ep + 1}.json`;
      net.save(path);
      // Per-checkpoint TELEM (A69 P1): expose BOTH off-ramp signals so the monitor
      // (or A77/A69) can pull the bidirectional damping lever. lostSelMass HIGH +
      // trainWR stalling across checkpoints → over-protecting positionally-bad turns
      // → touch killFile to jump d→1.0 ahead of schedule. (trainWR here is the cheap
      // in-loop vs-hard signal; the authoritative WR-climb slope is the monitor's
      // WR@40g seed-830k sequence.)
      const cm = telem.lostSelN ? telem.lostSelMass / telem.lostSelN : NaN;
      const cc = telem.negAdvCapN ? telem.negAdvCapSum / telem.negAdvCapN : NaN;
      const cwr = played ? wins / played : NaN;
      console.log(`  saved ${path}  CKPT-TELEM d=${dVal.toFixed(3)} trainWR=${(cwr * 100).toFixed(1)}%(n=${played}) lostSelMass=${cm.toFixed(3)}(n=${telem.lostSelN}) negAdvOnCapTurns=${cc.toFixed(3)}(n=${telem.negAdvCapN})`);
    }
  }
  const wr = played ? wins / played : NaN;
  const lostMass = telem.lostSelN ? telem.lostSelMass / telem.lostSelN : NaN;
  const negAdvCap = telem.negAdvCapN ? telem.negAdvCapSum / telem.negAdvCapN : NaN;
  console.log(`TRAIN-DONE tag=${opts.tag} episodes=${opts.episodes} vsHardPlayed=${played} vsHardWins=${wins} trainWR=${(wr * 100).toFixed(1)}%  TELEM lostSelMass=${lostMass.toFixed(3)}(n=${telem.lostSelN}) negAdvOnCapTurns=${negAdvCap.toFixed(3)}(n=${telem.negAdvCapN})`);
  return { finalPath: `ml/weights/policy-rl-${opts.tag}-${opts.episodes}.json` };
}

// ─────────────────────────────── CLI ─────────────────────────────────────────
(async () => {
  const mode = arg('mode', 'train')!;
  const vPath = arg('value', 'ml/weights/value-net-v2mc-best.json')!;
  if (!existsSync(vPath)) { console.error(`value net not found: ${vPath}`); process.exit(1); }
  const vnet = MLP.load(vPath);
  const K = Number(arg('K', '12')), temp = Number(arg('temp', '1.0')), depth = Number(arg('depth', '1'));
  const maxRounds = Number(arg('maxRounds', '90'));

  if (mode === 'ab') {
    const init = arg('init', 'ml/weights/policy-g2.json')!;
    const nGames = Number(arg('abGames', '40'));
    const seedBase = Number(arg('seed', '820000'));
    await runAB(init, vnet, K, temp, depth, nGames, seedBase, maxRounds);
    return;
  }

  if (mode === 'pressure') {
    // Build the early-pressure curriculum pool (STEER-2 / A69's B3 finding): 810k
    // seeds where the GREEDY g2 proposer is beaten by the hard AI = seeds featuring
    // aggressive hard-AI early play (the suppression exposure we want over-sampled).
    // Fast greedy proxy (no search) so pool-building doesn't burn the search budget;
    // documented approximation — refinable with search-losses later.
    const init = arg('init', 'ml/weights/policy-g2.json')!;
    const pnet = MLP.load(init);
    const greedy = makePolicyBot(pnet, { temp: 0 });
    const n = Number(arg('n', '120')), base = Number(arg('seed', '810000')), cap = Number(arg('cap', '24'));
    const pool: number[] = [];
    let losses = 0;
    for (let i = 0; i < n; i++) {
      const seed = base + i;
      const r = runGame({ seed, nPlayers: 2, forceFirst: i % 2, turns: [greedy, hardTurn], maxRounds });
      const lost = r.winner !== 0; // bot is slot 0; loss or material-loss
      if (lost) { losses++; if (pool.length < cap) pool.push(seed); }
    }
    console.log(`PRESSURE probe init=${init} n=${n} base=${base} greedyLosses=${losses}/${n}`);
    console.log(`PRESSURE-POOL ${pool.join(',')}`);
    return;
  }

  if (mode === 'evalseeds') {
    // Eval a policy-search checkpoint over an ARBITRARY seed list vs hard (used for
    // the held-out SUPPRESSION-COHORT WR — the 840k greedy-g2-loss seeds). RL bot
    // plays slot 0 (the greedy-suppressed side) with the SAME forceFirst the probe
    // used (=(seed-base)%2), reproducing the suppression regime. Reports WR + Wilson.
    const weights = arg('weights', 'ml/weights/policy-g2.json')!;
    const seedFile = arg('seedFile'); const seedsArg = arg('seeds');
    const base = Number(arg('base', '840000'));
    let seeds: number[] = [];
    if (seedFile && existsSync(seedFile)) seeds = readFileSync(seedFile, 'utf8').trim().split(/[\s,]+/).filter(x => x).map(Number);
    else if (seedsArg) seeds = seedsArg.split(',').map(Number);
    const nCap = Number(arg('n', String(seeds.length)));
    seeds = seeds.slice(0, nCap);
    const workers = Number(arg('workers', '3'));
    const bot: BotSpec = { kind: 'policy-search', weights, valueWeights: vPath, K, temp, leaf: 'blend', depth };
    const opp: BotSpec = { kind: 'hard' };
    const jobs: GameJob[] = seeds.map((seed, i) => ({ id: i, seed, forceFirst: (seed - base) % 2, slots: [bot, opp], maxDecisions: 1e9 }));
    const results = await runJobsPool(jobs, { workers });
    let wins = 0; for (const r of results) if (r.winner === 0) wins++;
    const n = seeds.length; const [lo, hi] = wilson(wins, n);
    console.log(`EVALSEEDS weights=${weights} cohort=${seedFile ?? 'inline'} n=${n} WR=${(100 * wins / Math.max(1, n)).toFixed(1)}% [${(100 * lo).toFixed(1)},${(100 * hi).toFixed(1)}] (${wins}W/${n - wins}L)`);
    return;
  }

  if (mode === 'coverage') {
    const init = arg('init', 'ml/weights/policy-g2.json')!;
    // Default = the 8 STEP-0 G3-loss gameIds (reconstructs exact gate pairing off the
    // 800k gate block; READ-ONLY replay only, never a training seed).
    const gameIds = (arg('gameIds', '4,29,33,50,62,71,72,81')!).split(',').map(Number);
    await runCoverage(init, vnet, K, temp, depth, gameIds, Number(arg('gateSeedBase', '800000')), maxRounds);
    return;
  }

  // train / smoke
  const tag = arg('tag', 'g2')!;
  const init = arg('init', 'ml/weights/policy-g2.json')!;
  const smoke = process.argv.includes('--smoke');
  const episodes = Number(arg('episodes', smoke ? '12' : '400'));
  const phiName = arg('phi', 'temples')!;
  const pressureSeeds = (arg('pressureSeeds', '')!).split(',').filter(x => x).map(Number);
  const r = await runTrain({
    tag, initPath: init, vnet, K, temp, depth, episodes,
    lr: Number(arg('lr', '3e-4')), gamma: Number(arg('gamma', '0.99')),
    beta0: Number(arg('shape', '0.05')), betaAnneal: Number(arg('shapeAnneal', '0.997')),
    bcCoef: Number(arg('bcCoef', '0.1')), hardFrac: Number(arg('hardFrac', '0.8')),
    seedHard: Number(arg('seedHard', '810000')), seedSelf: Number(arg('seedSelf', '820000')),
    maxRounds, saveEvery: Number(arg('saveEvery', smoke ? '12' : '25')), smoke,
    phi: getPhi(phiName), phiName, pressureSeeds, pressureFrac: Number(arg('pressureFrac', '0')),
    negAdvDamp: Number(arg('negAdvDamp', '0.4')), negAdvDampWarmupFrac: Number(arg('negAdvDampWarmupFrac', '0.4')),
  });

  if (smoke) {
    const nEval = Number(arg('evalGames', '20'));
    console.log(`SMOKE win-rate eval: ${r.finalPath} vs hard, ${nEval}g seed-830000 ...`);
    const res = await evalPool({
      bot: { kind: 'policy-search', weights: r.finalPath, valueWeights: vPath, K, temp, leaf: 'blend', depth },
      opp: { kind: 'hard' }, n: nEval, seedBase: 830000, workers: Number(process.env.ML_WORKERS ?? '3'),
    });
    console.log(`SMOKE-EVAL ${res.wins}W ${res.losses}L ${res.draws}D / ${res.games} = ${(res.winRate * 100).toFixed(1)}% Wilson95 [${(res.ciLow * 100).toFixed(1)},${(res.ciHigh * 100).toFixed(1)}]`);
  }
})().catch(e => { console.error(e); process.exit(1); });
