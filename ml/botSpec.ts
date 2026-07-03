// Serializable bot specifications + a factory that turns one into a TurnFn.
// Shared by the worker pool (ml/pool.ts), the pooled eval driver, and sweeps so a
// bot config can cross a process boundary as plain JSON. Nets are cached by path.
import { MLP } from './mlp';
import { hardTurn, normalTurn, makeValueBot, makeSearchBot, TurnFn } from './play';
import { makePolicyBot } from './policy';
import { heuristicLeaf } from './heuristicLeaf';
import { featurize } from './features';
import { GameState } from '../src/types';

export type LeafKind = 'V' | 'H' | 'blend';

export type BotSpec =
  | { kind: 'hard' }
  | { kind: 'normal' }
  | { kind: 'greedy'; weights: string; margin?: number; temp?: number }
  | { kind: 'search'; weights: string; K?: number; margin?: number; temp?: number; leaf?: LeafKind; opp?: BotSpec }
  | { kind: 'policy'; weights: string; temp?: number; maxMicros?: number };

const netCache = new Map<string, MLP>();
function loadNet(path: string): MLP {
  let n = netCache.get(path);
  if (!n) { n = MLP.load(path); netCache.set(path, n); }
  return n;
}

function leafFn(net: MLP, kind: LeafKind | undefined): ((s: GameState, b: number) => number) | undefined {
  if (kind === 'H') return (s, b) => heuristicLeaf(s, b);
  if (kind === 'blend') return (s, b) => 0.5 * net.value(featurize(s, b)) + 0.5 * heuristicLeaf(s, b);
  return undefined; // 'V' → makeSearchBot's default net-value leaf
}

export function buildTurnFn(spec: BotSpec): TurnFn {
  switch (spec.kind) {
    case 'hard': return hardTurn;
    case 'normal': return normalTurn;
    case 'greedy': {
      const net = loadNet(spec.weights);
      return makeValueBot(net, { temp: spec.temp ?? 0, margin: spec.margin ?? 0 });
    }
    case 'search': {
      const net = loadNet(spec.weights);
      const opp = buildTurnFn(spec.opp ?? { kind: 'hard' });
      return makeSearchBot(net, opp, { K: spec.K, margin: spec.margin, temp: spec.temp, leaf: leafFn(net, spec.leaf) });
    }
    case 'policy': {
      const net = loadNet(spec.weights);
      return makePolicyBot(net, { temp: spec.temp ?? 0, maxMicros: spec.maxMicros });
    }
  }
}

export function describeBot(spec: BotSpec): string {
  switch (spec.kind) {
    case 'hard': return 'hard';
    case 'normal': return 'normal';
    case 'greedy': return `greedy(m=${spec.margin ?? 0})`;
    case 'search': return `search(K=${spec.K ?? 6},m=${spec.margin ?? 0},t=${spec.temp ?? 0.12},leaf=${spec.leaf ?? 'V'})`;
    case 'policy': return `policy(t=${spec.temp ?? 0})`;
  }
}
