// Policy head π(s,a): an MLP scoring [stateFeatures ⊕ actionFeatures] → logit,
// softmax over the legal candidate set. Replaces greedy-over-V as the bot's own
// move generator (plan §2.0.2 / M2.3). No cloning per candidate — the action
// featurizer encodes each micro's effect directly.
import { MLP } from './mlp';
import { featurize, FEATURE_DIM } from './features';
import { actionFeatures, buildActionCtx, ACTION_DIM } from './actionFeatures';
import { legalMicros, applyMicro, Micro } from './gameEnv';
import { endTurn } from '../src/game';
import { GameState } from '../src/types';
import type { TurnFn } from './play';

export const STATE_DIM = FEATURE_DIM;      // 73 (may grow if features.ts is extended)
export const POLICY_IN = STATE_DIM + ACTION_DIM;

export function newPolicyNet(hidden = [128, 128], lr = 1e-3): MLP {
  return new MLP([POLICY_IN, ...hidden, 1], lr);
}

// Score every candidate: fills `logits`. Reuses scratch buffers (alloc-light).
export function scoreCandidates(
  net: MLP, state: GameState, pid: number, cands: Micro[],
  scratch?: { input: Float64Array; act: Float64Array },
): Float64Array {
  const sf = featurize(state, pid);
  const ctx = buildActionCtx(state, pid);
  const input = scratch?.input ?? new Float64Array(POLICY_IN);
  const act = scratch?.act ?? new Float64Array(ACTION_DIM);
  input.set(sf, 0);
  const logits = new Float64Array(cands.length);
  for (let k = 0; k < cands.length; k++) {
    actionFeatures(state, ctx, cands[k]!, act);
    input.set(act, STATE_DIM);
    logits[k] = net.value(input);
  }
  return logits;
}

function argmax(a: Float64Array): number { let b = 0; for (let i = 1; i < a.length; i++) if (a[i]! > a[b]!) b = i; return b; }

// Turn policy from π: at each decision, score all legal candidates (incl. end-turn)
// and pick argmax (greedy) or a temperature sample. Ends the turn when end-turn is
// chosen, no candidate applies, or the per-turn cap is hit.
export function makePolicyBot(net: MLP, opts: { temp?: number; rng?: () => number; maxMicros?: number } = {}): TurnFn {
  const temp = opts.temp ?? 0;
  const rng = opts.rng ?? Math.random;
  const maxMicros = opts.maxMicros ?? 48;
  const scratch = { input: new Float64Array(POLICY_IN), act: new Float64Array(ACTION_DIM) };
  return (s) => {
    for (let step = 0; step < maxMicros; step++) {
      if (s.phase !== 'playing') return;
      const cands = legalMicros(s);
      if (cands.length === 0) { endTurn(s); return; }
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
      if (micro.action === 'end-turn') { endTurn(s); return; }
      if (!applyMicro(s, micro)) { endTurn(s); return; } // never loop on a no-op
    }
    if (s.phase === 'playing') endTurn(s);
  };
}
