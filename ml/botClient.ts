// ─────────────────────────────────────────────────────────────────────────────
// Browser-safe RL "Hard AI".
//
// Ships the M4 deliverable: the `policy-g2` policy network + turn-level search
// (searchPolicy): K=12 candidate turns (1 π-greedy + 11 π-sampled @ temp=1.0),
// each answered by ONE opponent reply (depth=1), leaf = blend of the value net
// (`value-net-v2mc-best`) and the material heuristic. ~92% vs the hand-crafted
// hard AI (see docs/best-strategy-rl/M4-RL-REBUILD-REPORT.md).
//
// This runs entirely on the client:
//   • weights are bundled JSON (Vite inlines them) → MLP.fromJSON, no fs;
//   • the forward pass (mlp.ts), featurizers (features.ts / actionFeatures.ts)
//     and turn search are pure JS;
//   • candidate turns are simulated on CLONES of the real state through the SAME
//     authoritative dispatcher (server/actionDispatcher.executeAction) the
//     interactive game uses — identical rules, so the featurizer sees exactly the
//     state representation the net was trained on (BC recorded from this engine).
//
// The chosen turn's micro sequence is re-applied to the REAL state through the
// dispatcher and the turn is NOT ended (the caller owns end-turn) — so this drops
// straight in behind src/ai.runHardAITurn with the same contract.
// ─────────────────────────────────────────────────────────────────────────────
import { MLP } from './mlp';
import { featurize } from './features';
import { scoreCandidates, POLICY_IN } from './policy';
import { ACTION_DIM } from './actionFeatures';
import { legalMicros, applyMicro, cloneState, Micro } from './gameEnv';
import { heuristicLeaf } from './heuristicLeaf';
import { endTurn } from '../src/game';
import { executeAction } from '../server/actionDispatcher';
import { GameState, HexCoord } from '../src/types';
import type { TurnFn } from './play';
import type { AIAction } from '../src/ai';

import policyWeightsJson from './weights/policy-g2.json';
import valueWeightsJson from './weights/value-net-v2mc-best.json';

// Ship spec (M4): policy-g2 + turn-search K=12, temp=1.0, depth=1, blend leaf.
export const RL_TEMP = 1.0;
const MAX_MICROS = 48; // matches makePolicyBot default (per-turn micro cap)

// Search breadth. K=12 is the shipped spec (~92% vs hard AI). Cost scales ~linearly
// with K; per-turn latency in the browser runs ~0.4s early → ~6s late-game at K=12,
// so this is exposed for tuning (lower K = snappier, slightly weaker). The headless
// eval certifies the default.
let searchK = 12;
export function setSearchK(k: number): void { searchK = Math.max(1, Math.floor(k)); }
export function getSearchK(): number { return searchK; }

type NetJSON = { sizes: number[]; t?: number; lr?: number; layers: { W: number[]; b: number[] }[] };

let policyNet: MLP | null = null;
let valueNet: MLP | null = null;
function nets(): { policy: MLP; value: MLP } {
  if (!policyNet) policyNet = MLP.fromJSON(policyWeightsJson as unknown as NetJSON);
  if (!valueNet) valueNet = MLP.fromJSON(valueWeightsJson as unknown as NetJSON);
  return { policy: policyNet, value: valueNet };
}

const argmax = (a: Float64Array): number => { let b = 0; for (let i = 1; i < a.length; i++) if (a[i]! > a[b]!) b = i; return b; };

const terminalVal = (s: GameState, botId: number): number | null =>
  s.phase !== 'playing' ? (s.winner ? (s.winner.id === botId ? 1e6 : -1e6) : 0) : null;

// ── Turn rollout ─────────────────────────────────────────────────────────────
// Play one full policy turn on `s` (mutating it to an ended state) and RECORD the
// applied micros (excluding the final end-turn). Byte-for-byte the same decision
// rule as ml/policy.makePolicyBot (argmax when temp=0, softmax sample otherwise),
// so the recorded sequence is exactly the policy's own turn.
function rolloutRecord(
  s: GameState, net: MLP, temp: number, rng: () => number,
  scratch: { input: Float64Array; act: Float64Array },
): Micro[] {
  const micros: Micro[] = [];
  for (let step = 0; step < MAX_MICROS; step++) {
    if (s.phase !== 'playing') return micros;
    const cands = legalMicros(s);
    if (cands.length === 0) { endTurn(s); return micros; }
    const logits = scoreCandidates(net, s, s.currentPlayerIndex, cands, scratch);
    let choice: number;
    if (temp > 0) {
      let mx = -Infinity; for (const v of logits) if (v > mx) mx = v;
      let sum = 0; const pr = new Float64Array(logits.length);
      for (let k = 0; k < logits.length; k++) { pr[k] = Math.exp((logits[k]! - mx) / temp); sum += pr[k]!; }
      let r = rng() * sum, acc = 0; choice = logits.length - 1;
      for (let k = 0; k < logits.length; k++) { acc += pr[k]!; if (r <= acc) { choice = k; break; } }
    } else {
      choice = argmax(logits);
    }
    const micro = cands[choice]!;
    if (micro.action === 'end-turn') { endTurn(s); return micros; }
    if (!applyMicro(s, micro)) { endTurn(s); return micros; } // never loop on a no-op
    micros.push(micro);
  }
  if (s.phase === 'playing') endTurn(s);
  return micros;
}

// ── Turn search ──────────────────────────────────────────────────────────────
// Pick the best candidate turn and return its micro sequence (excluding end-turn)
// WITHOUT mutating `state`. Mirrors ml/searchPolicy.makePolicySearchBot exactly:
// K candidates (1 greedy + K-1 temp-sampled), one opponent reply (`opp`) each,
// blend leaf, terminal ±1e6 short-circuit — additionally recording the winning
// turn's micros so the caller can re-apply them to the real state.
export function chooseTurnMicros(state: GameState, opp: TurnFn, rng: () => number = Math.random): Micro[] {
  const { policy, value } = nets();
  const botId = state.currentPlayerIndex;
  const scratch = { input: new Float64Array(POLICY_IN), act: new Float64Array(ACTION_DIM) };

  const candidates: { micros: Micro[]; end: GameState }[] = [];
  { const c = cloneState(state); const m = rolloutRecord(c, policy, 0, rng, scratch); candidates.push({ micros: m, end: c }); }
  for (let k = 1; k < searchK; k++) {
    const c = cloneState(state);
    const m = rolloutRecord(c, policy, RL_TEMP, rng, scratch);
    candidates.push({ micros: m, end: c });
  }

  let best = candidates[0]!, bestV = -Infinity;
  for (const cand of candidates) {
    let v = terminalVal(cand.end, botId);
    if (v === null) {
      const r = cloneState(cand.end);
      opp(r); // opponent (hard AI) replies — the legitimate, plan-blessed opponent model
      const tv = terminalVal(r, botId);
      v = tv !== null ? tv : (0.5 * value.value(featurize(r, botId)) + 0.5 * heuristicLeaf(r, botId));
    }
    if (v > bestV) { bestV = v; best = cand; }
  }
  return best.micros;
}

// A TurnFn wrapper (applies the chosen turn to `s` and ends it). Used by the
// headless eval harness so it measures the EXACT code path the browser runs.
export function makeRLTurnFn(opp: TurnFn, rng: () => number = Math.random): TurnFn {
  return (s) => {
    const micros = chooseTurnMicros(s, opp, rng);
    for (const m of micros) { if (s.phase !== 'playing') break; applyMicro(s, m); }
    if (s.phase === 'playing') endTurn(s);
  };
}

// ── Combat-log descriptors ───────────────────────────────────────────────────
// Build a lightweight AIAction (only `.pos` — for the fog-visibility gate — and
// `.description` are used by main.ts) from a micro, BEFORE it is applied.
function describe(state: GameState, m: Micro): AIAction | null {
  const p = m.params as Record<string, unknown>;
  const unitById = (id: unknown) => (typeof id === 'string' ? state.units.find(u => u.id === id) : undefined);
  const templeById = (id: unknown) => (typeof id === 'string' ? state.temples.find(t => t.id === id) : undefined);
  const home = state.temples.find(t => t.ownerId === state.currentPlayerIndex)?.pos ?? { q: 0, r: 0 };
  switch (m.action) {
    case 'move': {
      const u = unitById(p.unitId); const to = p.to as HexCoord | undefined;
      if (!to) return null;
      return { type: 'move', pos: { ...to }, description: `Hard AI ${u?.type ?? 'unit'} advances to (${to.q},${to.r})` };
    }
    case 'attack': {
      const u = unitById(p.unitId); const t = unitById(p.targetId);
      const pos = t ? { ...t.pos } : (u ? { ...u.pos } : home);
      return { type: 'attack', pos, description: `Hard AI ${u?.type ?? 'unit'} attacks at (${pos.q},${pos.r})` };
    }
    case 'capture': {
      const u = unitById(p.unitId); const pos = u ? { ...u.pos } : home;
      return { type: 'upgrade', pos, description: `Hard AI captures temple at (${pos.q},${pos.r})` };
    }
    case 'recruit': {
      const t = templeById(p.templeId); const pos = t ? { ...t.pos } : home;
      return { type: 'spawn', pos, description: `Hard AI recruits ${String(p.unitType)} at (${pos.q},${pos.r})` };
    }
    case 'upgrade-temple': {
      const t = templeById(p.templeId); const pos = t ? { ...t.pos } : home;
      return { type: 'upgrade', pos, description: `Hard AI upgrades temple at (${pos.q},${pos.r})` };
    }
    case 'research':
      return { type: 'upgrade', pos: { ...home }, description: `Hard AI researches ${String(p.techId)}` };
    case 'build-teleport': {
      const pos = (p.pos as HexCoord | undefined) ?? home;
      return { type: 'upgrade', pos: { ...pos }, description: `Hard AI builds teleport at (${pos.q},${pos.r})` };
    }
    default:
      return null;
  }
}

// ── Public entry (drop-in for the hand-crafted hard AI's turn) ───────────────
// Pick the best turn, then re-apply its micros to the REAL state through the
// shared dispatcher. Does NOT end the turn — the caller (main.ts runAI) owns
// endTurn, exactly like src/ai.runHardAITurn's original contract.
export function runRLHardTurn(state: GameState, opp: TurnFn): AIAction[] {
  const micros = chooseTurnMicros(state, opp);
  const actions: AIAction[] = [];
  for (const m of micros) {
    if (state.phase !== 'playing') break;
    const act = describe(state, m); // capture positions BEFORE applying
    const res = executeAction(state, state.currentPlayerIndex, m.action, m.params);
    if (res.ok && act) actions.push(act);
  }
  return actions;
}
