// Phase 8 verification: Zone of Control (design brief §26). Exercises both
// the low-level pathfinding primitive (hex.ts) and the real engine's wiring
// of it end-to-end (no forked logic) — createGameState, chooseFaction,
// selectUnit, updateHighlights (via selectUnit's state.moveHexes).
//
// Run with: npx tsx scripts/verify-zoc.ts
import { getReachableHexes, hexNeighbors, hexKey, hexDistance } from '../src/hex';
import {
  createGameState, endTurn, chooseFaction, selectUnit,
  unitProjectsZoc, getZocHexes, createUnit,
} from '../src/game';
import type { GameState, UnitType } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A fresh 2-player game with factions chosen immediately (phase 11 — no more
// Founding Round to skip past). These tests exercise ZOC mechanics directly,
// not the recruit-then-wait training queue itself (see verify-opening-flow.ts
// for that) — place a Builder/Acolyte + a Warrior + an Archer for each player
// straight onto the board.
function setup(): GameState {
  const state = createGameState();
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
  for (const p of state.players) p.aura = 100;
  for (const player of state.players) {
    const capital = state.capitals.find(c => c.playerId === player.id)!;
    const neighbors = hexNeighbors(capital.pos);
    const tech = state.playerTech[player.id];
    state.units.push(createUnit('founder', player.id, neighbors[0]!, tech, player.faction));
    state.units.push(createUnit('warrior', player.id, neighbors[1]!, tech, player.faction));
    state.units.push(createUnit('archer', player.id, neighbors[2]!, tech, player.faction));
  }
  return state;
}

// Force every hex within `radius` of `pos` to be empty, passable plain
// terrain, and free of any capital/site/farm/unit — a wider-radius variant
// of the identical helper (and its rationale) in verify-roads.ts. The
// end-to-end movement test below walks a unit several hexes across this
// area, so the whole path (not just the immediate neighbours) must be clear.
function clearArea(state: GameState, pos: { q: number; r: number }, radius = 1): void {
  const far = state.mapRadius * 5;
  for (const c of state.capitals) if (hexDistance(c.pos, pos) <= radius) c.pos = { q: far, r: far };
  for (const s of state.strategicSites) if (hexDistance(s.pos, pos) <= radius) s.pos = { q: far, r: far };
  for (const f of state.farms) if (hexDistance(f.pos, pos) <= radius) f.pos = { q: far, r: far };
  for (const u of state.units) if (hexDistance(u.pos, pos) <= radius) u.pos = { q: far, r: far };
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      const key = hexKey({ q: pos.q + dq, r: pos.r + dr });
      state.hills.delete(key);
      state.walls.delete(key);
      state.forests.delete(key);
    }
  }
}

// ── Which classes project ZOC (§26) ──
console.log('\n=== Unit classes that project ZOC (§26) ===');
{
  const state = setup();
  const byType = (type: UnitType) => ({ ...state.units.find(u => u.type === 'warrior')!, type });
  const PROJECTS: UnitType[] = ['warrior', 'spearsman', 'horserider', 'heavyknight'];
  const NOT: UnitType[] = ['archer', 'catapult', 'healer', 'damageBooster', 'rangeBooster', 'founder'];
  for (const t of PROJECTS) check(`${t} projects ZOC`, unitProjectsZoc(byType(t)));
  for (const t of NOT) check(`${t} does NOT project ZOC`, !unitProjectsZoc(byType(t)));
}

// ── getZocHexes: visibility gating ──
console.log('\n=== getZocHexes respects visibility (§26) ===');
{
  const state = setup();
  const center = { q: 0, r: 0 };
  clearArea(state, center);
  const enemyWarrior = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  enemyWarrior.pos = { ...center };
  // Give P0 an eye on the hex — a friendly unit right next to it (a cleared,
  // guaranteed-empty neighbour of the enemy's hex).
  const myScout = state.units.find(u => u.playerId === 0)!;
  myScout.pos = { ...hexNeighbors(center)[0]! };
  const zoc = getZocHexes(state, 0);
  const neighborKeys = hexNeighbors(center).map(hexKey);
  check('a visible enemy warrior projects ZOC onto all 6 neighbours', neighborKeys.every(k => zoc.has(k)));
}
{
  const state = setup();
  const enemyArcher = state.units.find(u => u.playerId === 1 && u.type === 'archer')!;
  const center = { q: 0, r: 0 };
  clearArea(state, center);
  enemyArcher.pos = { ...center };
  const zoc = getZocHexes(state, 0);
  const neighborKeys = hexNeighbors(center).map(hexKey);
  check('a non-ZOC class (archer) projects no ZOC even when visible', neighborKeys.every(k => !zoc.has(k)));
}
{
  const state = setup();
  const center = { q: 0, r: 0 };
  clearArea(state, center);
  state.forests.add(hexKey(center)); // stand the enemy in a forest, out of reveal range
  const enemyWarrior = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  enemyWarrior.pos = { ...center };
  // Move every P0 unit/structure far away so nothing reveals the forest tile.
  for (const u of state.units) if (u.playerId === 0) u.pos = { q: state.mapRadius * 5, r: state.mapRadius * 5 };
  const zoc = getZocHexes(state, 0);
  check('a hidden-in-forest enemy warrior projects NO ZOC (not revealed)', zoc.size === 0, `zoc size=${zoc.size}`);
}

// ── Raw pathfinding: entering a ZOC hex ends movement (hex.ts) ──
console.log('\n=== getReachableHexes: ZOC truncates further movement ===');
{
  const enemyPos = { q: 0, r: 0 };
  const start = { q: 3, r: 0 };
  const speed = 5;
  const mapRadius = 8;
  const occupied = [enemyPos];
  const zocHexes = new Set(hexNeighbors(enemyPos).map(hexKey));

  const unrestricted = getReachableHexes(start, speed, mapRadius, occupied);
  const restricted = getReachableHexes(start, speed, mapRadius, occupied, undefined, zocHexes);

  const approachHex = { q: 2, r: 0 };   // 1 step out, not yet in ZOC
  const zocEntryHex = { q: 1, r: 0 };   // adjacent to the enemy -> IS a ZOC hex
  const beyondHex = { q: -1, r: 0 };    // past the enemy, only reachable by continuing through ZOC

  const has = (hexes: typeof unrestricted, h: typeof approachHex) => hexes.some(x => x.q === h.q && x.r === h.r);

  check('sanity: without ZOC, the far hex IS reachable (speed allows it)', has(unrestricted, beyondHex));
  check('the approach hex (not yet in ZOC) is reachable under ZOC', has(restricted, approachHex));
  check('the ZOC entry hex itself IS reachable (you can enter it)', has(restricted, zocEntryHex));
  check('the hex beyond the ZOC entry is NOT reachable (movement ends on entry)', !has(restricted, beyondHex));
}
{
  // A unit that STARTS inside a ZOC hex is not frozen — it can still move,
  // just not further past ANOTHER newly-entered ZOC hex.
  const enemyPos = { q: 0, r: 0 };
  const start = { q: 1, r: 0 }; // already adjacent to the enemy (in ZOC)
  const speed = 3;
  const mapRadius = 8;
  const occupied = [enemyPos];
  const zocHexes = new Set(hexNeighbors(enemyPos).map(hexKey));
  const reachable = getReachableHexes(start, speed, mapRadius, occupied, undefined, zocHexes);
  const has = (h: { q: number; r: number }) => reachable.some(x => x.q === h.q && x.r === h.r);

  // Stepping AWAY from the enemy leaves ZOC — movement should continue for
  // the remaining budget (up to speed 3 total from start).
  const awayHex1 = { q: 2, r: 0 };
  const awayHex2 = { q: 3, r: 0 };
  const awayHex3 = { q: 4, r: 0 };
  check('starting in ZOC does not prevent moving away', has(awayHex1));
  check('movement continues past the first step once clear of ZOC', has(awayHex2));
  check('full remaining speed budget is usable once clear of ZOC', has(awayHex3));
}

// ── End-to-end: real engine wiring via selectUnit -> state.moveHexes ──
console.log('\n=== End-to-end engine wiring (selectUnit -> state.moveHexes) ===');
{
  const state = setup();
  const center = { q: 0, r: 0 };
  clearArea(state, center, 4); // wide enough to cover the whole path used below
  const enemyWarrior = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  enemyWarrior.pos = { ...center };

  const myWarrior = state.units.find(u => u.playerId === 0 && u.type === 'warrior')!;
  myWarrior.pos = { q: 3, r: 0 };
  myWarrior.stats = { ...myWarrior.stats, speed: 5, vision: 5 }; // generous, deterministic budget + sight
  myWarrior.hasMoved = false; myWarrior.hasAttacked = false;
  state.currentPlayerIndex = 0;

  selectUnit(state, myWarrior.id);
  const has = (h: { q: number; r: number }) => state.moveHexes.some(x => x.q === h.q && x.r === h.r);
  check('engine: the ZOC entry hex is reachable', has({ q: 1, r: 0 }));
  check('engine: the hex beyond the ZOC entry is NOT reachable', !has({ q: -1, r: 0 }));
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
