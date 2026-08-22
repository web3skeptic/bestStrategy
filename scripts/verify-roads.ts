// Phase 7 verification: Agrar-only physical Roads (design brief §23-25).
// Exercises the real engine mutators end-to-end (no forked logic) —
// createGameState, chooseFaction, buildRoad, selectUnit, moveUnit.
//
// Run with: npx tsx scripts/verify-roads.ts
import {
  createGameState, endTurn, chooseFaction, canBuildRoad, buildRoad, getRoadAt,
  getEffectiveSpeed, selectUnit, moveUnit, getPlayerCapital, getStructureAt,
  createUnit,
} from '../src/game';
import { ROAD_COST_PER_HEX, ROAD_MOVEMENT_BONUS, ROAD_PILLAGE_REBUILD_COST } from '../src/factions';
import { hexNeighbors, hexEqual, hexKey } from '../src/hex';
import type { GameState } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A fresh 2-player game with factions chosen immediately (phase 11 — no more
// Founding Round to skip past), with generous aura for testing. These tests
// exercise Road mechanics directly, not the recruit-then-wait training queue
// itself (see verify-opening-flow.ts for that) — place a Builder/Acolyte + a
// Warrior for each player straight onto the board.
function setup(): GameState {
  const state = createGameState();
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
  for (const p of state.players) p.aura = 100;
  for (const player of state.players) {
    const capital = state.capitals.find(c => c.playerId === player.id)!;
    const [n0, n1] = hexNeighbors(capital.pos);
    const tech = state.playerTech[player.id];
    state.units.push(createUnit('founder', player.id, n0!, tech, player.faction));
    state.units.push(createUnit('warrior', player.id, n1!, tech, player.faction));
  }
  return state;
}

function founderOf(state: GameState, playerId: number) {
  return state.units.find(u => u.playerId === playerId && u.type === 'founder')!;
}

// Places playerId's founder on a hex far from any structure/other unit, with
// a fresh activation, and makes it that player's turn. Off-map coordinates
// are fine here — canBuildRoad doesn't bounds-check — but any test that later
// needs a unit to WALK onto this hex (pillage tests) must use an in-bounds
// pos and clearHex() instead.
function primeBuilder(state: GameState, playerId: number, pos = { q: 20, r: 20 }) {
  const founder = founderOf(state, playerId);
  founder.pos = { ...pos };
  founder.hasMoved = false; founder.hasAttacked = false;
  state.currentPlayerIndex = playerId;
  return founder;
}

// Force a specific in-bounds hex AND its neighbours to be empty, passable
// plain terrain: relocate any capital/site/farm/unit occupying them far
// off-map, and strip any wall/hill/forest. Used by the pillage tests, which
// need getReachableHexes (bounded by mapRadius, blocked by walls) to
// actually walk a unit onto (and through, from an adjacent hex) the road hex
// — real gameplay could never place a unit ON a wall (movement always
// avoids them), but this test does via a raw `.pos =` write, so it must
// clear the terrain explicitly rather than relying on normal move validation.
function clearHex(state: GameState, pos: { q: number; r: number }): void {
  const far = state.mapRadius * 5;
  for (const c of state.capitals) if (hexEqual(c.pos, pos)) c.pos = { q: far, r: far };
  for (const s of state.strategicSites) if (hexEqual(s.pos, pos)) s.pos = { q: far, r: far };
  for (const f of state.farms) if (hexEqual(f.pos, pos)) f.pos = { q: far, r: far };
  for (const u of state.units) if (hexEqual(u.pos, pos)) u.pos = { q: far, r: far };
  for (const hex of [pos, ...hexNeighbors(pos)]) {
    const key = hexKey(hex);
    state.hills.delete(key);
    state.walls.delete(key);
    state.forests.delete(key);
  }
}

// ── Faction exclusivity (§25) ──
console.log('\n=== Faction exclusivity (§25) ===');
{
  const state = setup();
  const builder = primeBuilder(state, 0);
  check('Agrar Builder CAN build a road', canBuildRoad(state, builder));
  const built = buildRoad(state, builder.id);
  check('buildRoad succeeds for Agrar', built);
  check('road now exists at the hex', !!getRoadAt(state, builder.pos));
}
{
  const state = setup();
  const acolyte = primeBuilder(state, 1);
  check('Temple Acolyte CANNOT build a road (no equivalent, §25)', !canBuildRoad(state, acolyte));
  const built = buildRoad(state, acolyte.id);
  check('buildRoad fails for Temple', !built);
  check('no road was created', !getRoadAt(state, acolyte.pos));
}
{
  const state = setup();
  const warrior = state.units.find(u => u.playerId === 0 && u.type === 'warrior')!;
  warrior.pos = { q: 20, r: 20 };
  warrior.hasMoved = false; warrior.hasAttacked = false;
  state.currentPlayerIndex = 0;
  check('a non-Builder Agrar unit cannot build a road', !canBuildRoad(state, warrior));
}

// ── Cost + activation (§23) ──
console.log('\n=== Cost + activation (§23) ===');
{
  const state = setup();
  const builder = primeBuilder(state, 0);
  const player = state.players[0]!;
  const before = player.aura;
  buildRoad(state, builder.id);
  check('buildRoad charges ROAD_COST_PER_HEX', player.aura === before - ROAD_COST_PER_HEX, `aura ${before}->${player.aura}`);
  check('building consumes the whole activation', builder.hasMoved && builder.hasAttacked);
}
{
  const state = setup();
  const builder = primeBuilder(state, 0);
  state.players[0]!.aura = ROAD_COST_PER_HEX - 1;
  check('cannot build without enough aura', !canBuildRoad(state, builder));
}
{
  const state = setup();
  const builder = primeBuilder(state, 0);
  buildRoad(state, builder.id);
  // Same hex, fresh activation, still a road there -> cannot double-build.
  builder.hasMoved = false; builder.hasAttacked = false;
  check('cannot build a road where one already exists', !canBuildRoad(state, builder));
}
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const builder = primeBuilder(state, 0, cap.pos);
  check('cannot build a road under a structure (Capital)', !canBuildRoad(state, builder));
  check('getStructureAt confirms the Capital occupies that hex', getStructureAt(state, cap.pos)?.kind === 'capital');
}

// ── Movement bonus (§23, phase 7; Agrar-only phase 11 §26) ──
console.log('\n=== Movement bonus applies to Agrar units ONLY (§26) ===');
{
  const state = setup();
  const builder = primeBuilder(state, 0);
  buildRoad(state, builder.id);
  const roadPos = { ...builder.pos };

  const agrarWarrior = state.units.find(u => u.playerId === 0 && u.type === 'warrior')!;
  const baseSpeed = agrarWarrior.stats.speed;
  agrarWarrior.pos = { q: roadPos.q + 50, r: roadPos.r + 50 }; // off any road
  check('off-road speed is the base stat', getEffectiveSpeed(state, agrarWarrior) === baseSpeed);
  agrarWarrior.pos = { ...roadPos };
  check('an Agrar unit on the road gets +ROAD_MOVEMENT_BONUS', getEffectiveSpeed(state, agrarWarrior) === baseSpeed + ROAD_MOVEMENT_BONUS);

  const templeWarrior = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  const templeBaseSpeed = templeWarrior.stats.speed;
  templeWarrior.pos = { ...roadPos };
  check('a Temple unit standing on the SAME road gets NO bonus — treats it as normal terrain (§26)', getEffectiveSpeed(state, templeWarrior) === templeBaseSpeed);
}

// ── Pillage (§25) ──
// Uses an in-bounds hex (map center) so getReachableHexes (bounded by
// mapRadius) can actually walk a unit onto the road, unlike the off-map
// coordinates the earlier tests use as a cheap "definitely empty" trick.
console.log('\n=== Pillage (§25) ===');
const PILLAGE_TEST_POS = { q: 0, r: 0 };
{
  const state = setup();
  clearHex(state, PILLAGE_TEST_POS);
  const builder = primeBuilder(state, 0, PILLAGE_TEST_POS);
  buildRoad(state, builder.id);
  const roadPos = { ...builder.pos };
  builder.pos = { q: state.mapRadius * 5, r: state.mapRadius * 5 }; // clear the hex
  check('setup: road exists, owned by P0', getRoadAt(state, roadPos)?.ownerId === 0);

  // A Temple unit walks onto the road.
  const templeWarrior = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  templeWarrior.pos = { ...hexNeighbors(roadPos)[0]! };
  templeWarrior.hasMoved = false; templeWarrior.hasAttacked = false;
  state.currentPlayerIndex = 1;
  selectUnit(state, templeWarrior.id);
  const moved = moveUnit(state, roadPos);
  check('the enemy unit successfully moves onto the road', moved.moved && hexEqual(templeWarrior.pos, roadPos));
  check('the road is destroyed on arrival (auto-pillage)', !getRoadAt(state, roadPos));
  check('the hex is now marked as pillaged (cheaper to rebuild)', state.pillagedRoadHexes.has(`${roadPos.q},${roadPos.r}`));
}
{
  // An owner's OWN unit walking across its own road never pillages it.
  const state = setup();
  clearHex(state, PILLAGE_TEST_POS);
  const builder = primeBuilder(state, 0, PILLAGE_TEST_POS);
  buildRoad(state, builder.id);
  const roadPos = { ...builder.pos };
  builder.pos = { q: state.mapRadius * 5, r: state.mapRadius * 5 }; // clear the hex

  const agrarWarrior = state.units.find(u => u.playerId === 0 && u.type === 'warrior')!;
  agrarWarrior.pos = { ...hexNeighbors(roadPos)[0]! };
  agrarWarrior.hasMoved = false; agrarWarrior.hasAttacked = false;
  state.currentPlayerIndex = 0;
  selectUnit(state, agrarWarrior.id);
  const moved = moveUnit(state, roadPos);
  check('the owner\'s own unit successfully moves onto its own road', moved.moved && hexEqual(agrarWarrior.pos, roadPos));
  check('the owner\'s own unit does NOT pillage its own road', !!getRoadAt(state, roadPos));
}
{
  // Rebuilding a pillaged hex is cheaper than building fresh.
  const state = setup();
  clearHex(state, PILLAGE_TEST_POS);
  const builder = primeBuilder(state, 0, PILLAGE_TEST_POS);
  buildRoad(state, builder.id);
  const roadPos = { ...builder.pos };
  builder.pos = { q: state.mapRadius * 5, r: state.mapRadius * 5 }; // clear the hex

  const templeWarrior = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  templeWarrior.pos = { ...hexNeighbors(roadPos)[0]! };
  templeWarrior.hasMoved = false; templeWarrior.hasAttacked = false;
  state.currentPlayerIndex = 1;
  selectUnit(state, templeWarrior.id);
  moveUnit(state, roadPos);
  check('setup: road is pillaged', !getRoadAt(state, roadPos));

  // Move the Temple unit off, then rebuild with the Agrar Builder.
  templeWarrior.pos = { q: state.mapRadius * 5, r: state.mapRadius * 5 - 1 };
  const rebuilder = primeBuilder(state, 0, roadPos);
  const player = state.players[0]!;
  const before = player.aura;
  const rebuilt = buildRoad(state, rebuilder.id);
  check('rebuilding a pillaged hex succeeds', rebuilt);
  check('rebuilding charges ROAD_PILLAGE_REBUILD_COST, not the fresh-build cost', player.aura === before - ROAD_PILLAGE_REBUILD_COST, `aura ${before}->${player.aura}`);
  check('the hex is no longer marked pillaged', !state.pillagedRoadHexes.has(`${roadPos.q},${roadPos.r}`));
  check('the road is restored', !!getRoadAt(state, roadPos));
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
