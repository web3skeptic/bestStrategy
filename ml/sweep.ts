// M0.1 / M0.2 — evaluate ONE bot config vs the hard AI with side + first-move
// alternation (same protocol as ml/eval.ts), print a result line, and append a
// JSONL record to a shared results file. Designed to be fanned out across
// processes (poor-man's parallelism) until ml/pool.ts (M1.1) lands.
//
// Usage:
//   npx tsx ml/sweep.ts --weights W --n 40 --seed 700000 \
//     [--mode search|greedy] [--K 6] [--margin 0] [--temp 0.12] \
//     [--leaf V|H|blend] [--budget 500|inf] [--out FILE] [--tag NAME]
import { MLP } from './mlp';
import { hardTurn, makeValueBot, makeSearchBot, runGame, TurnFn } from './play';
import { wilson } from './eval';
import { heuristicLeaf } from './heuristicLeaf';
import { featurize } from './features';
import { GameState } from '../src/types';
import { appendFileSync } from 'fs';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const weights = arg('weights', 'ml/weights/value-net-main.json')!;
const n = Number(arg('n', '40'));
const seedBase = Number(arg('seed', '700000'));
const mode = arg('mode', 'search')!;               // search | greedy
const K = Number(arg('K', '6'));
const margin = Number(arg('margin', '0'));
const temp = Number(arg('temp', '0.12'));
const leafKind = arg('leaf', 'V')!;                // V | H | blend
const budgetArg = arg('budget', 'inf')!;           // inf neutralizes __botBudget
const maxDecisions = budgetArg === 'inf' ? 1e9 : Number(budgetArg);
const out = arg('out');
const tag = arg('tag', `${mode}-K${K}-m${margin}-${leafKind}`)!;

const net = MLP.load(weights);

// Leaf evaluator for the search bot (M0.2 ablation knob).
const vLeaf = (s: GameState, botId: number) => net.value(featurize(s, botId));
let leaf: ((s: GameState, botId: number) => number) | undefined;
if (leafKind === 'H') leaf = (s, b) => heuristicLeaf(s, b);
else if (leafKind === 'blend') leaf = (s, b) => 0.5 * vLeaf(s, b) + 0.5 * heuristicLeaf(s, b);
else leaf = undefined; // V (default inside makeSearchBot)

const bot: TurnFn = mode === 'greedy'
  ? makeValueBot(net, { temp: 0, margin })
  : makeSearchBot(net, hardTurn, { K, temp, margin, leaf });

let wins = 0, losses = 0, draws = 0, played = 0;
const t0 = Date.now();
const pairs = Math.ceil(n / 2);
for (let i = 0; i < pairs && played < n; i++) {
  const seed = seedBase + i;
  const forceFirst = i % 2;
  {
    const r = runGame({ seed, forceFirst, turns: [bot, hardTurn], maxDecisions });
    if (r.winner === 0) wins++; else if (r.winner === 1) losses++; else draws++;
    played++;
    console.log(`[${tag}] ${played}/${n} seed=${seed} slot0 winner=${r.winner} r=${r.rounds} | W${wins} L${losses} D${draws} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  if (played >= n) break;
  {
    const r = runGame({ seed, forceFirst, turns: [hardTurn, bot], maxDecisions });
    if (r.winner === 1) wins++; else if (r.winner === 0) losses++; else draws++;
    played++;
    console.log(`[${tag}] ${played}/${n} seed=${seed} slot1 winner=${r.winner} r=${r.rounds} | W${wins} L${losses} D${draws} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
}
const games = wins + losses + draws;
const [lo, hi] = wilson(wins, games);
const secs = ((Date.now() - t0) / 1000).toFixed(0);
const rec = { tag, mode, K, margin, temp, leaf: leafKind, weights, n: games, wins, losses, draws,
  winRate: +(wins / games).toFixed(4), ciLow: +lo.toFixed(4), ciHigh: +hi.toFixed(4), secs: +secs };
console.log(`\nRESULT ${tag}: ${wins}W ${losses}L ${draws}D / ${games} = ${(wins / games * 100).toFixed(1)}%  CI[${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]  in ${secs}s`);
if (out) appendFileSync(out, JSON.stringify(rec) + '\n');
