// Verifies redefined change #1: a single temple can spawn MORE THAN ONE unit in
// the SAME turn (no per-turn gate), still bounded by the population cap + aura +
// tile occupancy. Uses the real engine functions.
import { createGameState, spawnUnit, getPopulationCap, getPopulationCount, getCurrentPlayer, getUnitAt } from '../src/game';
import { hexNeighbors } from '../src/hex';
import type { GameState } from '../src/types';

function freeAdjacent(state: GameState, pos: any): any {
  for (const n of hexNeighbors(pos)) {
    const dist = Math.max(Math.abs(n.q), Math.abs(n.r), Math.abs(-n.q - n.r));
    if (dist <= state.mapRadius && !getUnitAt(state, n) && !state.walls.has(`${n.q},${n.r}`) && !state.hills.has(`${n.q},${n.r}`))
      return n;
  }
  return null;
}

const state = createGameState();
const me = getCurrentPlayer(state);
// Clear the board of everyone's units so we start from a clean slate.
state.units = [];
// Give this player a temple with headroom and plenty of aura.
const temple = state.temples.find(t => t.ownerId === me.id)!;
temple.level = 3;                 // pop cap = 3 * 2 = 6
me.aura = 999;

const cap = getPopulationCap(state, me.id);
console.log(`Population cap (temple lv${temple.level}) = ${cap}`);
console.log(`Starting count = ${getPopulationCount(state, me.id)}\n`);

console.log('=== Spawning repeatedly from ONE temple within a SINGLE turn (no endTurn) ===');
let spawned = 0;
for (let i = 0; i < 20; i++) {
  const ok = spawnUnit(state, temple.id, 'warrior');
  const count = getPopulationCount(state, me.id);
  console.log(`  attempt ${i + 1}: spawnUnit -> ${ok}  | pop ${count}/${cap}`);
  if (!ok) { console.log('  → blocked (expected once population cap is reached)\n'); break; }
  spawned++;
  // Move the freshly spawned unit off the temple tile so the next spawn is allowed
  // (occupancy rule from change #2). This is the chosen multi-spawn UX.
  const fresh = getUnitAt(state, temple.pos)!;
  const dest = freeAdjacent(state, temple.pos);
  if (dest) fresh.pos = dest;
}
console.log(`Spawned ${spawned} units from ONE temple in ONE turn (per-turn gate lifted: ${spawned > 1 ? 'YES ✓' : 'NO ✗'})`);
console.log(`Final pop ${getPopulationCount(state, me.id)}/${cap} — cap still enforced: ${getPopulationCount(state, me.id) <= cap ? 'YES ✓' : 'NO ✗'}`);

console.log('\n=== Occupancy still blocks a stacked spawn (tile not cleared) ===');
// Fresh temple with headroom; spawn once (unit stays on tile), spawn again immediately.
const s2 = createGameState();
const p2 = getCurrentPlayer(s2);
s2.units = [];
const t2 = s2.temples.find(t => t.ownerId === p2.id)!;
t2.level = 3; p2.aura = 999;
const a = spawnUnit(s2, t2.id, 'warrior');      // lands on temple tile
const b = spawnUnit(s2, t2.id, 'warrior');      // tile occupied → should fail
console.log(`  first spawn: ${a} (expect true)`);
console.log(`  second spawn without moving: ${b} (expect false — tile occupied) ${b === false ? '✓' : '✗'}`);
