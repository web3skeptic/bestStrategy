// Verifies redefined change #1: a single structure can spawn MORE THAN ONE
// unit in the SAME turn (no per-turn gate), still bounded by the population
// cap + aura + tile occupancy. Uses the real engine functions.
//
// PHASE 3 NOTE: population cap is now a flat INTERIM_POPULATION_CAP (no more
// temple levels — see game.ts) — this script no longer sets up a "high-level
// temple" for headroom, it just uses the Capital directly.
import { createGameState, spawnUnit, getPopulationCap, getPopulationCount, getCurrentPlayer, getUnitAt, getPlayerCapital, endTurn, chooseFaction } from '../src/game';
import { hexNeighbors } from '../src/hex';
import type { GameState, HexCoord } from '../src/types';

function freeAdjacent(state: GameState, pos: HexCoord): HexCoord | null {
  for (const n of hexNeighbors(pos)) {
    const dist = Math.max(Math.abs(n.q), Math.abs(n.r), Math.abs(-n.q - n.r));
    if (dist <= state.mapRadius && !getUnitAt(state, n) && !state.walls.has(`${n.q},${n.r}`) && !state.hills.has(`${n.q},${n.r}`))
      return n;
  }
  return null;
}

// Fast-forward through the Founding Round + faction reveal (§5-6) — recruiting
// is banned until both are done.
function skipFoundingRound(state: GameState): void {
  endTurn(state);
  endTurn(state);
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
}

const state = createGameState();
skipFoundingRound(state);
const me = getCurrentPlayer(state);
// Clear the board of everyone's units so we start from a clean slate.
state.units = [];
const capital = getPlayerCapital(state, me.id)!;
me.aura = 999;

const cap = getPopulationCap(state, me.id);
console.log(`Population cap (flat, phase-3 placeholder) = ${cap}`);
console.log(`Starting count = ${getPopulationCount(state, me.id)}\n`);

console.log('=== Spawning repeatedly from ONE Capital within a SINGLE turn (no endTurn) ===');
let spawned = 0;
for (let i = 0; i < 20; i++) {
  const ok = spawnUnit(state, capital.id, 'warrior');
  const count = getPopulationCount(state, me.id);
  console.log(`  attempt ${i + 1}: spawnUnit -> ${ok}  | pop ${count}/${cap}`);
  if (!ok) { console.log('  → blocked (expected once population cap is reached)\n'); break; }
  spawned++;
  // Move the freshly spawned unit off the Capital tile so the next spawn is
  // allowed (occupancy rule from change #2). This is the chosen multi-spawn UX.
  const fresh = getUnitAt(state, capital.pos)!;
  const dest = freeAdjacent(state, capital.pos);
  if (dest) fresh.pos = dest;
}
console.log(`Spawned ${spawned} units from ONE Capital in ONE turn (per-turn gate lifted: ${spawned > 1 ? 'YES ✓' : 'NO ✗'})`);
console.log(`Final pop ${getPopulationCount(state, me.id)}/${cap} — cap still enforced: ${getPopulationCount(state, me.id) <= cap ? 'YES ✓' : 'NO ✗'}`);

console.log('\n=== Occupancy still blocks a stacked spawn (tile not cleared) ===');
// Fresh game; spawn once (unit stays on tile), spawn again immediately.
const s2 = createGameState();
skipFoundingRound(s2);
const p2 = getCurrentPlayer(s2);
s2.units = [];
const cap2 = getPlayerCapital(s2, p2.id)!;
p2.aura = 999;
const a = spawnUnit(s2, cap2.id, 'warrior');      // lands on Capital tile
const b = spawnUnit(s2, cap2.id, 'warrior');      // tile occupied → should fail
console.log(`  first spawn: ${a} (expect true)`);
console.log(`  second spawn without moving: ${b} (expect false — tile occupied) ${b === false ? '✓' : '✗'}`);
