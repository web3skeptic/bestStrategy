// AI-vs-AI simulation harness (dev tool, not part of `npm test`) — plays many
// games across difficulty/faction pairings without manual clicking, so
// difficulty tuning can be checked empirically instead of by feel. See
// src/ai.ts's header comment for the current AI architecture.
//
// Usage:
//   npx tsx scripts/ai-simulate.ts                          # default sweep
//   npx tsx scripts/ai-simulate.ts --games=20 --maxRounds=200
//   npx tsx scripts/ai-simulate.ts --pairs=normal:hard,hard:expert
//   npx tsx scripts/ai-simulate.ts --factions=agrar:temple
import { createGameState, chooseFaction, endTurn, getCurrentPlayer, getPlayerCapital, getPlayerIncome } from '../src/game';
import { runAiTurn, AiDifficulty } from '../src/ai';
import type { GameState } from '../src/types';

function parseArgs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

interface GameResult {
  d0: AiDifficulty; d1: AiDifficulty; f0: string; f1: string;
  winner: 0 | 1 | null; rounds: number;
  finalArmy0: number; finalArmy1: number;
  finalIncome0: number; finalIncome1: number;
}

function playOneGame(d0: AiDifficulty, d1: AiDifficulty, f0: 'agrar' | 'temple', f1: 'agrar' | 'temple', maxRounds: number): GameResult {
  const state: GameState = createGameState();
  chooseFaction(state, 0, f0);
  chooseFaction(state, 1, f1);
  let rounds = 0;
  while (state.phase !== 'gameOver' && rounds < maxRounds) {
    rounds++;
    const seat = getCurrentPlayer(state).id;
    runAiTurn(state, seat === 0 ? d0 : d1, seat);
    endTurn(state);
  }
  const winner = state.winner ? (state.winner.id as 0 | 1) : null;
  return {
    d0, d1, f0, f1, winner, rounds,
    finalArmy0: state.units.filter(u => u.hp > 0 && u.playerId === 0).length,
    finalArmy1: state.units.filter(u => u.hp > 0 && u.playerId === 1).length,
    finalIncome0: getPlayerIncome(state, 0),
    finalIncome1: getPlayerIncome(state, 1),
  };
}

const args = parseArgs();
const gamesPerPair = Number(args.games ?? 10);
const maxRounds = Number(args.maxRounds ?? 300);
const ALL: AiDifficulty[] = ['easy', 'normal', 'hard', 'expert'];
const pairs: [AiDifficulty, AiDifficulty][] = args.pairs
  ? args.pairs.split(',').map(p => { const [a, b] = p.split(':') as [AiDifficulty, AiDifficulty]; return [a, b]; })
  : [['easy', 'normal'], ['normal', 'hard'], ['hard', 'expert'], ['easy', 'expert']];
const [fA, fB] = (args.factions ?? 'agrar:temple').split(':') as ['agrar' | 'temple', 'agrar' | 'temple'];

console.log(`AI-vs-AI simulation: ${pairs.length} pairing(s) x ${gamesPerPair} games, maxRounds=${maxRounds}, factions=${fA} vs ${fB}\n`);

const allResults: GameResult[] = [];
for (const [d0, d1] of pairs) {
  const results: GameResult[] = [];
  for (let g = 0; g < gamesPerPair; g++) {
    // Alternate which difficulty/faction plays seat 0 so neither the seat-0
    // first-mover edge nor a faction gets baked into the win rate.
    const swap = g % 2 === 1;
    const r = playOneGame(swap ? d1 : d0, swap ? d0 : d1, swap ? fB : fA, swap ? fA : fB, maxRounds);
    if (swap && r.winner !== null) (r as { winner: 0 | 1 | null }).winner = r.winner === 0 ? 1 : 0;
    results.push(r);
  }
  allResults.push(...results);

  const d0Wins = results.filter(r => r.winner === 0).length;
  const d1Wins = results.filter(r => r.winner === 1).length;
  const draws = results.filter(r => r.winner === null).length;
  const avgRounds = (results.reduce((s, r) => s + r.rounds, 0) / results.length).toFixed(1);
  console.log(`${d0} vs ${d1}: ${d0}=${d0Wins} ${d1}=${d1Wins} draws/timeout=${draws} (avg ${avgRounds} rounds)`);
}

console.log(`\n${allResults.length} total games played.`);
