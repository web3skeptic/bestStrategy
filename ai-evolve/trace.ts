// Prints a compact per-round trace of one match for one seat — army, where it
// stands relative to the enemy Capital, economy and research.
//   npx tsx ai-evolve/trace.ts --genome=ai-evolve/out/hard-a/best.json --factions=agrar:temple --seed=1001 --every=5
import { readFileSync } from 'node:fs';
import { createGameState, chooseFaction, endTurn, getCurrentPlayer, getPlayerIncome, getPopulationCap, getPopulationCount } from '../src/game';
import { runAiTurn, type AiDifficulty } from '../src/ai';
import { normalizeGenome } from '../src/aiGenome';
import { hexDistance } from '../src/hex';
import type { FactionId } from '../src/types';
import { installSeededRandom, setSeed } from '../ml/rng';

const args: Record<string, string> = {};
for (const a of process.argv.slice(2)) { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]!] = m[2]!; }
const genome = args.genome ? normalizeGenome(JSON.parse(readFileSync(args.genome, 'utf8'))) : undefined;
const factions = (args.factions ?? 'agrar:temple').split(':') as [FactionId, FactionId];
const opp = (args.opp ?? 'medium') as AiDifficulty;
const every = Number(args.every ?? 5);
installSeededRandom();
setSeed(Number(args.seed ?? 1001));
const state = createGameState();
chooseFaction(state, 0, factions[0]);
chooseFaction(state, 1, factions[1]);
while (state.phase === 'playing' && state.turnNumber <= Number(args.rounds ?? 80)) {
  const seat = getCurrentPlayer(state).id;
  runAiTurn(state, seat === 0 ? 'hard' : opp, seat, seat === 0 ? genome : undefined);
  if (seat === 0 && state.turnNumber % every === 0) {
    const enemyCap = state.capitals.find(c => c.playerId === 1)!;
    const myCap = state.capitals.find(c => c.playerId === 0)!;
    const mine = state.units.filter(u => u.hp > 0 && u.playerId === 0);
    const types = new Map<string, number>();
    for (const u of mine) types.set(u.type, (types.get(u.type) ?? 0) + 1);
    const dists = mine.filter(u => u.type !== 'founder').map(u => hexDistance(u.pos, enemyCap.pos)).sort((a, b) => a - b);
    const theirs = state.units.filter(u => u.hp > 0 && u.playerId === 1).length;
    const tech = state.playerTech[0]!;
    console.log(`r${state.turnNumber} pop ${getPopulationCount(state, 0)}/${getPopulationCap(state, 0)} aura ${state.players[0]!.aura} inc ${getPlayerIncome(state, 0)} ` +
      `farms ${state.farms.filter(f => f.ownerId === 0).length} roads ${state.roads.filter(r => r.ownerId === 0).length} | ` +
      `${[...types].map(([t, n]) => `${t}:${n}`).join(' ')} | dist->enemyCap ${dists.join(',')} | capHP me ${myCap.hp} them ${enemyCap.hp} | enemy units ${theirs} | ` +
      `tech ${[...tech.researched].length}${tech.researching ? '+' + tech.researching.techId : ''} | on capital: ${state.units.find(u => u.hp > 0 && u.pos.q === myCap.pos.q && u.pos.r === myCap.pos.r)?.type ?? '-'} | queue ${state.trainingQueue.filter(o => o.playerId === 0).map(o => o.unitType).join(',')}`);
  }
  if (state.phase === 'playing') endTurn(state);
}
console.log(`end: round ${state.turnNumber}, winner ${state.winner?.id ?? 'none'}`);
