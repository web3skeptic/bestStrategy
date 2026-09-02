// Phase 7 verification, plus the post-phase-11 adjacency + network-
// connectivity correction: Agrar-only physical Roads (design brief §23-25;
// movement bonus restricted to Agrar §26; a new Road hex must now be
// adjacent to the Builder AND itself adjacent to the Capital/a Farm/an
// existing Road). Exercises the real engine mutators end-to-end (no forked
// logic) — createGameState, chooseFaction, buildRoad, selectUnit, moveUnit.
//
// Run with: npx tsx scripts/verify-roads.ts
import {
  createGameState, endTurn, chooseFaction, canBuildRoad, buildRoad, getRoadAt, getValidRoadHexes,
  getEffectiveSpeed, selectUnit, moveUnit, getPlayerCapital, getStructureAt,
  createUnit, canStartFarm, startFarm, canPillageRoad, pillageRoad,
} from '../src/game';
import { ROAD_COST_PER_HEX, ROAD_MOVEMENT_BONUS, ROAD_PILLAGE_REBUILD_COST, AGRAR_FARM_COST } from '../src/factions';
import { hexNeighbors, hexEqual, hexKey, hexDistance } from '../src/hex';
import type { GameState, Unit } from '../src/types';

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

function founderOf(state: GameState, playerId: number): Unit {
  return state.units.find(u => u.playerId === playerId && u.type === 'founder')!;
}

// Recentres playerId's Capital to the map's exact center and clears a wide
// area around it (terrain + every unit/site/other-Capital found there), same
// rationale as the identical helper in verify-economy.ts — a Capital placed
// near the edge (a normal, legitimate layout) can clip the empty space a
// Road-adjacency/connectivity test needs. Places the Builder directly
// adjacent to the Capital afterward — guarantees at least one valid Road
// target exists (a hex that's a neighbour of BOTH the Builder and the
// Capital — see getValidRoadHexes).
function clearRoadArea(state: GameState, playerId: number, radius = 5): Unit {
  const capital = state.capitals.find(c => c.playerId === playerId)!;
  capital.pos = { q: 0, r: 0 };
  const far = state.mapRadius * 6;
  let offset = 0;
  for (const c of state.capitals) if (c.playerId !== playerId && hexDistance(c.pos, capital.pos) <= radius) c.pos = { q: far, r: far + offset++ };
  for (const s of state.strategicSites) if (hexDistance(s.pos, capital.pos) <= radius) s.pos = { q: far, r: far + offset++ };
  for (const u of state.units) if (hexDistance(u.pos, capital.pos) <= radius) u.pos = { q: far, r: far + offset++ };
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      const key = hexKey({ q: capital.pos.q + dq, r: capital.pos.r + dr });
      state.hills.delete(key); state.walls.delete(key); state.forests.delete(key);
    }
  }
  const builder = founderOf(state, playerId);
  builder.pos = { ...hexNeighbors(capital.pos)[0]! };
  builder.hasMoved = false; builder.hasAttacked = false;
  return builder;
}

// ── Faction exclusivity (§25) ──
console.log('\n=== Faction exclusivity (§25) ===');
{
  const state = setup();
  const builder = clearRoadArea(state, 0);
  const hex = getValidRoadHexes(state, builder)[0]!;
  check('Agrar Builder CAN build a road adjacent to the Capital', canBuildRoad(state, builder, hex));
  const built = buildRoad(state, builder.id, hex);
  check('buildRoad succeeds for Agrar', built);
  check('road now exists at the hex', !!getRoadAt(state, hex));
}
{
  const state = setup();
  const acolyte = clearRoadArea(state, 1);
  const anyHex = hexNeighbors(acolyte.pos)[0]!;
  check('Temple Acolyte CANNOT build a road (no equivalent, §25)', !canBuildRoad(state, acolyte, anyHex));
  const built = buildRoad(state, acolyte.id, anyHex);
  check('buildRoad fails for Temple', !built);
  check('no road was created', !getRoadAt(state, anyHex));
}
{
  const state = setup();
  clearRoadArea(state, 0);
  const warrior = state.units.find(u => u.playerId === 0 && u.type === 'warrior')!;
  const capital = state.capitals.find(c => c.playerId === 0)!;
  warrior.pos = { ...hexNeighbors(capital.pos)[0]! };
  warrior.hasMoved = false; warrior.hasAttacked = false;
  state.currentPlayerIndex = 0;
  const anyHex = hexNeighbors(warrior.pos)[0]!;
  check('a non-Builder Agrar unit cannot build a road', !canBuildRoad(state, warrior, anyHex));
}

// ── Placement: adjacency + network connectivity (correction) ──
console.log('\n=== Placement: adjacent to Builder AND to Capital/Farm/Road ===');
{
  const state = setup();
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const builder = clearRoadArea(state, 0);
  const hexes = getValidRoadHexes(state, builder);
  check('valid road hexes exist adjacent to a Builder standing next to the Capital', hexes.length > 0);
  check('every candidate is a direct neighbor of the Builder', hexes.every(h => hexDistance(h, builder.pos) === 1));
  check('every candidate is a direct neighbor of the Capital (or a Farm/Road — none built yet)', hexes.every(h => hexDistance(h, capital.pos) === 1));
  check('no candidate hex lands on the Capital itself', !hexes.some(h => hexEqual(h, capital.pos)));
}
{
  // A Builder standing far from the Capital, with no Farms/Roads anywhere,
  // has NO valid Road target — the network can't appear out of nowhere.
  const state = setup();
  clearRoadArea(state, 0, state.mapRadius);
  const builder = founderOf(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  builder.pos = { q: state.mapRadius - 1, r: 0 };
  builder.hasMoved = false; builder.hasAttacked = false;
  check('the Builder really is far from the Capital', hexDistance(builder.pos, capital.pos) > 2);
  check('no valid Road hex exists that far from any Agrar infrastructure', getValidRoadHexes(state, builder).length === 0);
}
{
  // The network extends link by link: a Road built adjacent to the Capital
  // lets the NEXT Road be adjacent to IT instead, reaching further out.
  const state = setup();
  const builder = clearRoadArea(state, 0, state.mapRadius);
  const first = getValidRoadHexes(state, builder)[0]!;
  buildRoad(state, builder.id, first);
  builder.pos = { ...first };
  builder.hasMoved = false; builder.hasAttacked = false;
  const chained = getValidRoadHexes(state, builder);
  check('a Road CAN extend from an existing Road, not just the Capital', chained.some(h => hexDistance(h, first) === 1 && !hexEqual(h, first)));
}
{
  // A Farm also counts as network infrastructure for Road placement.
  const state = setup();
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const builder = clearRoadArea(state, 0);
  state.players[0]!.aura = 200;
  const farmHex = { q: capital.pos.q + 2, r: capital.pos.r };
  builder.pos = { ...hexNeighbors(farmHex)[0]! };
  builder.hasMoved = false; builder.hasAttacked = false;
  state.currentPlayerIndex = 0;
  check('setup: the Farm hex is legitimately buildable', canStartFarm(state, builder, farmHex));
  startFarm(state, builder.id, farmHex);
  endTurn(state); endTurn(state); // resolve the Farm's founding
  builder.pos = { ...hexNeighbors(farmHex)[0]! };
  builder.hasMoved = false; builder.hasAttacked = false;
  state.currentPlayerIndex = 0;
  const nearFarm = getValidRoadHexes(state, builder);
  check('a Road hex adjacent to the (now active) Farm is valid too', nearFarm.some(h => hexDistance(h, farmHex) === 1));
}

// ── Cost + activation (§23) ──
console.log('\n=== Cost + activation (§23) ===');
{
  const state = setup();
  const builder = clearRoadArea(state, 0);
  const hex = getValidRoadHexes(state, builder)[0]!;
  const player = state.players[0]!;
  const before = player.aura;
  buildRoad(state, builder.id, hex);
  check('buildRoad charges ROAD_COST_PER_HEX', player.aura === before - ROAD_COST_PER_HEX, `aura ${before}->${player.aura}`);
  check('building consumes the whole activation', builder.hasMoved && builder.hasAttacked);
}
{
  const state = setup();
  const builder = clearRoadArea(state, 0);
  const hex = getValidRoadHexes(state, builder)[0]!;
  state.players[0]!.aura = ROAD_COST_PER_HEX - 1;
  check('cannot build without enough aura', !canBuildRoad(state, builder, hex));
}
{
  const state = setup();
  const builder = clearRoadArea(state, 0);
  const hex = getValidRoadHexes(state, builder)[0]!;
  buildRoad(state, builder.id, hex);
  // Same hex, fresh activation, still a road there -> cannot double-build.
  builder.hasMoved = false; builder.hasAttacked = false;
  check('cannot build a road where one already exists', !getValidRoadHexes(state, builder).some(h => hexEqual(h, hex)));
}
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const builder = clearRoadArea(state, 0);
  check('cannot build a road under a structure (Capital)', !canBuildRoad(state, builder, cap.pos));
  check('getStructureAt confirms the Capital occupies that hex', getStructureAt(state, cap.pos)?.kind === 'capital');
}

// ── Movement bonus (§23, phase 7; Agrar-only phase 11 §26) ──
console.log('\n=== Movement bonus applies to Agrar units ONLY (§26) ===');
{
  const state = setup();
  const builder = clearRoadArea(state, 0);
  const roadPos = getValidRoadHexes(state, builder)[0]!;
  buildRoad(state, builder.id, roadPos);

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

// ── Pillage (§25; v14 — a real action, not automatic-on-move) ──
console.log('\n=== Pillage (§25, v14) ===');
{
  const state = setup();
  const builder = clearRoadArea(state, 0);
  const roadPos = getValidRoadHexes(state, builder)[0]!;
  buildRoad(state, builder.id, roadPos);
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
  check('v14 — merely ending a move on it does NOT destroy the road', !!getRoadAt(state, roadPos));
  check('v14 — merely ending a move on it does NOT mark it pillaged', !state.pillagedRoadHexes.has(`${roadPos.q},${roadPos.r}`));

  // It takes a deliberate, separate action — and a fully unused activation
  // (the unit already spent its move, but hasn't attacked, so it still has one).
  check('the enemy unit CAN pillage it as a separate action', canPillageRoad(state, templeWarrior));
  const pillaged = pillageRoad(state, templeWarrior.id);
  check('pillageRoad succeeds', pillaged);
  check('the road is now destroyed', !getRoadAt(state, roadPos));
  check('the hex is now marked as pillaged (cheaper to rebuild)', state.pillagedRoadHexes.has(`${roadPos.q},${roadPos.r}`));
  check('pillaging consumed the unit\'s whole activation', templeWarrior.hasMoved && templeWarrior.hasAttacked);
}
{
  // An owner's OWN unit walking across its own road never pillages it, and
  // can't use the pillage action on it either.
  const state = setup();
  const builder = clearRoadArea(state, 0);
  const roadPos = getValidRoadHexes(state, builder)[0]!;
  buildRoad(state, builder.id, roadPos);
  builder.pos = { q: state.mapRadius * 5, r: state.mapRadius * 5 }; // clear the hex

  const agrarWarrior = state.units.find(u => u.playerId === 0 && u.type === 'warrior')!;
  agrarWarrior.pos = { ...hexNeighbors(roadPos)[0]! };
  agrarWarrior.hasMoved = false; agrarWarrior.hasAttacked = false;
  state.currentPlayerIndex = 0;
  selectUnit(state, agrarWarrior.id);
  const moved = moveUnit(state, roadPos);
  check('the owner\'s own unit successfully moves onto its own road', moved.moved && hexEqual(agrarWarrior.pos, roadPos));
  check('the owner\'s own unit does NOT pillage its own road', !!getRoadAt(state, roadPos));
  check('the owner cannot use pillage-road on their own Road', !canPillageRoad(state, agrarWarrior));
}
{
  // A unit that has already fully acted this turn cannot pillage.
  const state = setup();
  const builder = clearRoadArea(state, 0);
  const roadPos = getValidRoadHexes(state, builder)[0]!;
  buildRoad(state, builder.id, roadPos);
  builder.pos = { q: state.mapRadius * 5, r: state.mapRadius * 5 };

  const templeWarrior = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  templeWarrior.pos = { ...roadPos };
  templeWarrior.hasMoved = true; templeWarrior.hasAttacked = true; // already fully acted
  state.currentPlayerIndex = 1;
  check('an already-acted unit cannot pillage', !canPillageRoad(state, templeWarrior));
  check('pillageRoad rejects it too', !pillageRoad(state, templeWarrior.id));
  check('the road survives', !!getRoadAt(state, roadPos));
}
{
  // Rebuilding a pillaged hex is cheaper than building fresh.
  const state = setup();
  const builder = clearRoadArea(state, 0);
  const roadPos = getValidRoadHexes(state, builder)[0]!;
  buildRoad(state, builder.id, roadPos);
  builder.pos = { q: state.mapRadius * 5, r: state.mapRadius * 5 }; // clear the hex

  const templeWarrior = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  templeWarrior.pos = { ...roadPos };
  templeWarrior.hasMoved = false; templeWarrior.hasAttacked = false;
  state.currentPlayerIndex = 1;
  pillageRoad(state, templeWarrior.id);
  check('setup: road is pillaged', !getRoadAt(state, roadPos));

  // Move the Temple unit off, then rebuild with the Agrar Builder standing
  // on the Capital itself — always adjacent to any of the Capital's own
  // neighbours, including the pillaged hex.
  templeWarrior.pos = { q: state.mapRadius * 5, r: state.mapRadius * 5 - 1 };
  const rebuilder = founderOf(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  rebuilder.pos = { ...capital.pos };
  rebuilder.hasMoved = false; rebuilder.hasAttacked = false;
  state.currentPlayerIndex = 0;
  check('setup: the Builder is adjacent to the pillaged hex', hexDistance(rebuilder.pos, roadPos) === 1);
  const player = state.players[0]!;
  const before = player.aura;
  const rebuilt = buildRoad(state, rebuilder.id, roadPos);
  check('rebuilding a pillaged hex succeeds', rebuilt);
  check('rebuilding charges ROAD_PILLAGE_REBUILD_COST, not the fresh-build cost', player.aura === before - ROAD_PILLAGE_REBUILD_COST, `aura ${before}->${player.aura}`);
  check('the hex is no longer marked pillaged', !state.pillagedRoadHexes.has(`${roadPos.q},${roadPos.r}`));
  check('the road is restored', !!getRoadAt(state, roadPos));
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
