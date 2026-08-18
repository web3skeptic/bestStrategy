// Evaluate the NN value-bot vs the hard AI. Cancels first-move + side bias by
// playing each seed twice with sides swapped and alternating who moves first.
import { MLP } from './mlp';
import { loadNet } from './mlpIO';
import { hardTurn, makeValueBot, makeSearchBot, runGame, TurnFn } from './play';

export interface EvalResult { wins: number; losses: number; draws: number; games: number; winRate: number; ciLow: number; ciHigh: number; }

// Wilson score interval (95%).
export function wilson(wins: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const h = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return [(c - h) / d, (c + h) / d];
}

export function evalVsHard(net: MLP, nGames: number, seedBase = 500000, botTemp = 0, search = false, K = 6): EvalResult {
  const bot: TurnFn = search ? makeSearchBot(net, hardTurn, { K }) : makeValueBot(net, { temp: botTemp });
  let wins = 0, losses = 0, draws = 0;
  const pairs = Math.ceil(nGames / 2);
  let played = 0;
  for (let i = 0; i < pairs && played < nGames; i++) {
    const seed = seedBase + i;
    const forceFirst = i % 2; // alternate who moves first
    // Game A: NN is slot 0
    {
      const r = runGame({ seed, forceFirst, turns: [bot, hardTurn] });
      if (r.winner === 0) wins++; else if (r.winner === 1) losses++; else draws++;
      played++;
    }
    if (played >= nGames) break;
    // Game B: NN is slot 1 (sides swapped, same seed/map)
    {
      const r = runGame({ seed, forceFirst, turns: [hardTurn, bot] });
      if (r.winner === 1) wins++; else if (r.winner === 0) losses++; else draws++;
      played++;
    }
  }
  const games = wins + losses + draws;
  const [lo, hi] = wilson(wins, games);
  return { wins, losses, draws, games, winRate: wins / games, ciLow: lo, ciHigh: hi };
}

// CLI: npx tsx ml/eval.ts <weights.json> <nGames> [seedBase] [temp]
if (process.argv[1] && process.argv[1].endsWith('eval.ts')) {
  const path = process.argv[2] ?? 'ml/weights/value-net.json';
  const n = Number(process.argv[3] ?? 200);
  const seedBase = Number(process.argv[4] ?? 700000);
  const temp = Number(process.argv[5] ?? 0);
  const search = process.argv[6] === 'search';
  const net = loadNet(path);
  const t0 = Date.now();
  const r = evalVsHard(net, n, seedBase, temp, search);
  if (search) console.log('(using turn-level 1-ply search bot vs hard AI)');
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`NN vs HARD: ${r.wins}W ${r.losses}L ${r.draws}D / ${r.games} games`);
  console.log(`win-rate = ${(r.winRate * 100).toFixed(1)}%  (Wilson 95% CI [${(r.ciLow * 100).toFixed(1)}%, ${(r.ciHigh * 100).toFixed(1)}%])  in ${secs}s`);
  console.log(r.ciLow > 0.5 ? 'RESULT: NN beats hard AI (CI lower bound > 50%)' : 'RESULT: not proven > 50% yet');
}
