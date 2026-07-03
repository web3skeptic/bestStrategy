// M3.1 — turn-level search with π-proposed candidate turns. K candidate turns
// (1 π-greedy + K−1 π-sampled), each rolled out fully by the policy net (cheap:
// no clones per micro, the policy scores actions directly), opponent reply modelled
// by `opp` (the hard AI — the legitimate, v1-precedent opponent model), leaf = V or
// a V+heuristic blend, terminal ±1e6 short-circuit. Commits the best candidate turn.
import { MLP } from './mlp';
import { GameState } from '../src/types';
import { cloneState } from './gameEnv';
import { featurize } from './features';
import { heuristicLeaf } from './heuristicLeaf';
import { makePolicyBot } from './policy';
import { TurnFn } from './play';

export type LeafFn = (s: GameState, botId: number) => number;

export function makePolicySearchBot(
  policyNet: MLP, valueNet: MLP | null, opp: TurnFn,
  opts: { K?: number; temp?: number; rng?: () => number; leaf?: LeafFn; depth?: number } = {},
): TurnFn {
  const K = opts.K ?? 8;
  const rng = opts.rng ?? Math.random;
  const depth = opts.depth ?? 1;
  const greedy = makePolicyBot(policyNet, { temp: 0 });
  const explore = makePolicyBot(policyNet, { temp: opts.temp ?? 1.0, rng });
  const leaf: LeafFn = opts.leaf ?? ((s, botId) => (valueNet ? valueNet.value(featurize(s, botId)) : heuristicLeaf(s, botId)));
  const terminalVal = (s: GameState, botId: number): number | null =>
    s.phase !== 'playing' ? (s.winner ? (s.winner.id === botId ? 1e6 : -1e6) : 0) : null;

  return (s) => {
    const botId = s.currentPlayerIndex;
    const candidates: GameState[] = [];
    { const c = cloneState(s); greedy(c); candidates.push(c); }
    for (let k = 1; k < K; k++) { const c = cloneState(s); explore(c); candidates.push(c); }

    let best = candidates[0]!, bestV = -Infinity;
    for (const c of candidates) {
      let v = terminalVal(c, botId);
      if (v === null) {
        const r = cloneState(c);
        opp(r); // opponent (hard AI) replies
        let tv = terminalVal(r, botId);
        if (tv === null && depth >= 2) {
          // depth-2: our π-greedy reply, then their reply, before the leaf.
          greedy(r); tv = terminalVal(r, botId);
          if (tv === null) { opp(r); tv = terminalVal(r, botId); }
        }
        v = tv !== null ? tv : leaf(r, botId);
      }
      if (v > bestV) { bestV = v; best = c; }
    }
    Object.assign(s, best);
  };
}
