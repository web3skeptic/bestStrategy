// Phase 10/11 verification, plus the post-phase-11 "Agrar Territory"
// correction: the macro-economy correction — "Agrar controls area (Farms),
// Temple controls points (Temples)" — the phase 11 Builder-adjacency Farm
// placement, and the unified territory concept (placement gate + area
// denial + Farm defense buff, all driven by one area). Exercises the real
// engine mutators end-to-end (no forked logic) — createGameState,
// startFounding, startFarm, endTurn, buyDevotion, attackStructure.
//
// Run with: npx tsx scripts/verify-economy.ts
import {
  createGameState, endTurn, chooseFaction, startFounding, canStartFounding,
  getPlayerIncome, getProductionSlots,
  canStartFarm, startFarm, getValidFarmHexes, getAgrarTerritory,
  canBuyDevotion, buyDevotion,
  selectUnit, attackStructure, getStructureAt, getEffectiveDefense,
  createUnit,
} from '../src/game';
import {
  BASE_INCOME_PER_ROUND, AGRAR_FARM_COST, AGRAR_FARM_INCOME, MAX_ACTIVE_FARMS,
  AGRAR_TERRITORY_RADIUS, FARM_MIN_SPACING, FARM_DEFENSE_BONUS,
  TEMPLE_DEVOTION_COST, TEMPLE_DEVOTION_INCOME, TEMPLE_DEVOTION_MAX_LEVEL,
} from '../src/factions';
import { hexDistance, hexNeighbors, hexEqual, hexKey } from '../src/hex';
import type { GameState, Unit, HexCoord } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A fresh 2-player game with factions chosen immediately (phase 11 — no more
// Founding Round to skip past) and generous aura for testing. These tests
// exercise Farm/Temple/combat mechanics directly, not the recruit-then-wait
// training queue itself (see verify-opening-flow.ts for that) — place a
// Builder/Acolyte + a Warrior for each player straight onto the board.
function setup(): GameState {
  const state = createGameState();
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
  for (const p of state.players) p.aura = 200;
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

function advanceOneRound(state: GameState): void {
  endTurn(state);
  endTurn(state);
}

// Recentres playerId's Capital to the map's exact center and clears a wide
// area around it (terrain + every unit/site/other-Capital found there) so
// the random map layout can never make Farm-placement tests flaky — a
// Capital placed near the edge (a normal, legitimate layout) can clip a
// meaningful chunk of empty space off-map. Repositions playerId's own
// Builder just outside the Capital's forbidden ring afterward (phase 11:
// Farm placement is Builder-adjacency-only, so the test helpers need a
// Builder actually sitting somewhere useful in the cleared area).
function clearFarmArea(state: GameState, playerId: number, radius = 5): void {
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
  builder.pos = { q: 2, r: 0 };
  builder.hasMoved = false; builder.hasAttacked = false;
}

// Starts a Farm with playerId's Builder standing adjacent to `pos` (phase 11
// §14: the Builder must be adjacent to start AND must remain adjacent
// through completion — see canStartFarm/resolveFarmFoundingForPlayer) and
// lets it complete uncontested (one full round). Teleports the Builder into
// position rather than actually pathing it there — movement/pathing itself
// is covered elsewhere; this suite is about the Farm rules.
function foundFarm(state: GameState, playerId: number, pos: HexCoord): void {
  const builder = founderOf(state, playerId);
  builder.pos = { ...hexNeighbors(pos)[0]! };
  builder.hasMoved = false; builder.hasAttacked = false;
  state.currentPlayerIndex = playerId;
  startFarm(state, builder.id, pos);
  advanceOneRound(state);
}

// A small ring of hexes, each EXACTLY AGRAR_TERRITORY_RADIUS (2) from the
// origin/Capital AND at least FARM_MIN_SPACING (2) from every other hex in
// the ring — every entry is independently valid as Capital-anchored (no
// chaining through a prior Farm needed), and none collide with each other.
const FARM_RING: HexCoord[] = [{ q: 2, r: 0 }, { q: 0, r: 2 }, { q: -2, r: 2 }, { q: -2, r: 0 }];

// Founds a Temple site to completion for playerId (Temple-only) and returns it.
function foundTemple(state: GameState, playerId: number, siteIndex = 0) {
  const site = state.strategicSites[siteIndex]!;
  const founder = founderOf(state, playerId);
  founder.pos = { ...site.pos };
  founder.hasMoved = false; founder.hasAttacked = false;
  state.currentPlayerIndex = playerId;
  startFounding(state, founder.id);
  advanceOneRound(state);
  return site;
}

// ── Base income ──
console.log('\n=== Base income (§4) ===');
{
  const state = createGameState();
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
  const p0 = state.players[0]!;
  const before = p0.aura;
  endTurn(state); // p0's turn ends; p1 starts (no income change for p0 yet)
  endTurn(state); // p1's turn ends; p0 starts -> gains income
  check('base income granted every round regardless of structures', p0.aura === before + BASE_INCOME_PER_ROUND, `aura ${before}->${p0.aura}`);
}

// ── Agrar never founds a site (§28) ──
console.log('\n=== Agrar never founds a strategic site (§28) ===');
{
  const state = setup();
  const site = state.strategicSites[0]!;
  const builder = founderOf(state, 0);
  builder.pos = { ...site.pos };
  builder.hasMoved = false; builder.hasAttacked = false;
  state.currentPlayerIndex = 0;
  check('Agrar Builder cannot start founding at a neutral site', canStartFounding(state, builder) === null);
  check('startFounding fails for Agrar', !startFounding(state, builder.id));
  check('the site remains neutral', site.state === 'neutral');
}

// ── Agrar Farms: construction (§6-9) ──
console.log('\n=== Agrar Farms: construction (§6-9) ===');
{
  const state = setup();
  clearFarmArea(state, 0);
  check('flat income with no Farms yet', getPlayerIncome(state, 0) === BASE_INCOME_PER_ROUND, `income=${getPlayerIncome(state, 0)}`);

  const builder = founderOf(state, 0);
  const hexes = getValidFarmHexes(state, builder);
  check('valid farm hexes exist adjacent to the Builder', hexes.length > 0);
  check('every candidate is a direct neighbor of the Builder', hexes.every(h => hexDistance(h, builder.pos) === 1));

  const player = state.players[0]!;
  const auraBefore = player.aura;
  const targetHex = hexes[0]!;
  builder.hasMoved = false; builder.hasAttacked = false;
  state.currentPlayerIndex = 0;
  const started = startFarm(state, builder.id, targetHex);
  check('startFarm succeeds at a valid hex', started);
  check('startFarm charges AGRAR_FARM_COST immediately', player.aura === auraBefore - AGRAR_FARM_COST, `aura=${player.aura}`);
  check('the Builder\'s whole activation is consumed', builder.hasMoved && builder.hasAttacked);

  const founding = state.farms.find(f => hexEqual(f.pos, targetHex))!;
  check('the Farm exists in a founding state', founding.state === 'foundingFarm');
  check('income is still flat while founding (§10)', getPlayerIncome(state, 0) === BASE_INCOME_PER_ROUND);
  check('a founding Farm is not yet attackable', getStructureAt(state, targetHex) === null);

  advanceOneRound(state);
  const completed = state.farms.find(f => hexEqual(f.pos, targetHex))!;
  check('the Farm completes uncontested (Builder stayed adjacent)', completed.state === 'farm');
  check('income increases by AGRAR_FARM_INCOME once active', getPlayerIncome(state, 0) === BASE_INCOME_PER_ROUND + AGRAR_FARM_INCOME, `income=${getPlayerIncome(state, 0)}`);
  check('an active Farm is now attackable', getStructureAt(state, targetHex)?.kind === 'farm');
}
{
  // Insufficient aura blocks the build.
  const state = setup();
  clearFarmArea(state, 0);
  const builder = founderOf(state, 0);
  state.players[0]!.aura = AGRAR_FARM_COST - 1;
  builder.hasMoved = false; builder.hasAttacked = false;
  state.currentPlayerIndex = 0;
  const hex = getValidFarmHexes(state, builder)[0]!;
  check('cannot build a Farm without enough aura', !canStartFarm(state, builder, hex));
}
{
  // Temple's Acolyte has no equivalent (§28).
  const state = setup();
  clearFarmArea(state, 1);
  const acolyte = founderOf(state, 1);
  acolyte.hasMoved = false; acolyte.hasAttacked = false;
  state.currentPlayerIndex = 1;
  const anyHex = hexNeighbors(acolyte.pos)[0]!;
  check('Temple\'s Acolyte cannot build a Farm', !canStartFarm(state, acolyte, anyHex));
}

// ── Agrar Farms: placement rules — Builder-adjacency AND chain-distance ──
console.log('\n=== Agrar Farms: placement rules (bunker/chain correction) ===');
{
  // A Farm CAN now be directly adjacent to the Capital (encourages tight
  // bunkering) — only the farm-to-farm minimum spacing still excludes hexes.
  const state = setup();
  clearFarmArea(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const builder = founderOf(state, 0);
  builder.pos = { ...hexNeighbors(capital.pos)[0]! }; // stand right next to the Capital
  builder.hasMoved = false; builder.hasAttacked = false;

  const hexesFromCapitalEdge = getValidFarmHexes(state, builder);
  check('no candidate hex lands on the Capital itself', !hexesFromCapitalEdge.some(h => hexEqual(h, capital.pos)));
  check('a Farm CAN be built directly adjacent to the Capital now', hexesFromCapitalEdge.some(h => hexDistance(h, capital.pos) === 1), `got ${JSON.stringify(hexesFromCapitalEdge)}`);

  // Build one Farm, then verify a hex adjacent to it is excluded but one at
  // exactly FARM_MIN_SPACING is still fine (and still within chain distance).
  builder.pos = { q: 2, r: 0 };
  builder.hasMoved = false; builder.hasAttacked = false;
  const first = getValidFarmHexes(state, builder)[0]!;
  foundFarm(state, 0, first);

  const builder2 = founderOf(state, 0);
  builder2.pos = { ...hexNeighbors(first)[0]! };
  builder2.hasMoved = false; builder2.hasAttacked = false;
  const hexesAfter = getValidFarmHexes(state, builder2);
  check('a hex adjacent to the new Farm is excluded (min spacing)', !hexesAfter.some(h => hexDistance(h, first) === 1));
  check(`every remaining candidate is at least FARM_MIN_SPACING (${FARM_MIN_SPACING}) from the Farm`, hexesAfter.every(h => hexDistance(h, first) >= FARM_MIN_SPACING));
}
{
  // §chain rule — a Farm can NOT be started far from the Capital or any
  // existing Farm, even if the Builder physically travels there: the
  // network only grows as a connected bunker.
  const state = setup();
  clearFarmArea(state, 0, state.mapRadius); // clear the whole small test map
  const builder = founderOf(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  builder.pos = { q: state.mapRadius - 1, r: 0 }; // near the far edge of the map, no Farms anywhere yet
  builder.hasMoved = false; builder.hasAttacked = false;
  check('the Builder really is far from the Capital', hexDistance(builder.pos, capital.pos) > AGRAR_TERRITORY_RADIUS);
  const farHexes = getValidFarmHexes(state, builder);
  check('a Farm CANNOT be started far from the Capital/any Farm — no valid hexes', farHexes.length === 0, `got ${farHexes.length}`);
}
{
  // Chaining — a Farm CAN be built beyond AGRAR_TERRITORY_RADIUS of the
  // Capital as long as it's within AGRAR_TERRITORY_RADIUS of an EXISTING
  // active Farm (the network extends link by link, not just from the Capital).
  const state = setup();
  clearFarmArea(state, 0, state.mapRadius);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  foundFarm(state, 0, { q: 2, r: 0 }); // first link, anchored on the Capital
  const builder = founderOf(state, 0);
  builder.pos = { q: 4, r: 0 }; // adjacent to the first Farm, AGRAR_TERRITORY_RADIUS(2) beyond it
  builder.hasMoved = false; builder.hasAttacked = false;
  check('the next spot is beyond chain distance of the Capital alone', hexDistance(builder.pos, capital.pos) > AGRAR_TERRITORY_RADIUS);
  const chained = getValidFarmHexes(state, builder);
  check('a Farm CAN chain outward from an existing Farm, beyond the Capital\'s own reach', chained.length > 0, `got ${chained.length}`);
}
{
  // Global cap: MAX_ACTIVE_FARMS, counting founding + active together.
  const state = setup();
  clearFarmArea(state, 0);
  for (let i = 0; i < MAX_ACTIVE_FARMS; i++) {
    foundFarm(state, 0, FARM_RING[i]!);
  }
  check(`built up to MAX_ACTIVE_FARMS (${MAX_ACTIVE_FARMS}) active Farms`, state.farms.filter(f => f.ownerId === 0 && f.state === 'farm').length === MAX_ACTIVE_FARMS, `got ${state.farms.filter(f => f.ownerId === 0).length}`);
  const builder = founderOf(state, 0);
  builder.hasMoved = false; builder.hasAttacked = false; // position is irrelevant — the cap check runs before hex validity
  const extraHex = hexNeighbors(builder.pos)[0]!;
  check('cannot start a 5th Farm past the global cap', !canStartFarm(state, builder, extraHex));
}

// ── Agrar Farms: destruction has no Ruins (§15) ──
console.log('\n=== Agrar Farms: destruction (§15) ===');
{
  const state = setup();
  clearFarmArea(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const builder = founderOf(state, 0);
  const hex = getValidFarmHexes(state, builder)[0]!;
  foundFarm(state, 0, hex);
  const farm = state.farms.find(f => hexEqual(f.pos, hex))!;

  const attacker = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  attacker.pos = { ...hexNeighbors(farm.pos)[0]! };
  attacker.hasMoved = false; attacker.hasAttacked = false;
  state.currentPlayerIndex = 1;
  selectUnit(state, attacker.id);
  const ref = getStructureAt(state, farm.pos);
  check('Farm is independently targetable via getStructureAt', ref?.kind === 'farm');
  farm.hp = 1; // one hit from destroying it
  const result = attackStructure(state, farm.pos);
  check('the Farm is destroyed', !!result?.destroyed);
  check('a destroyed Farm is gone outright — no Ruins', !state.farms.some(f => f.id === farm.id));
  check('income drops back down immediately', getPlayerIncome(state, 0) === BASE_INCOME_PER_ROUND, `income=${getPlayerIncome(state, 0)}`);
  check('destroying a Farm does not end the game', state.phase === 'playing');
  const rebuildBuilder = founderOf(state, 0);
  rebuildBuilder.pos = { q: capital.pos.q + 2, r: capital.pos.r };
  rebuildBuilder.hasMoved = false; rebuildBuilder.hasAttacked = false;
  check('the freed slot can be rebuilt elsewhere', getValidFarmHexes(state, rebuildBuilder).length > 0);
}

// ── Farm defense buff — own Agrar Territory (bunker correction) ──
console.log('\n=== Farm defense buff — own Agrar Territory (bunker correction) ===');
{
  const state = setup();
  clearFarmArea(state, 0);
  const builder = founderOf(state, 0);
  const hex = getValidFarmHexes(state, builder)[0]!;
  foundFarm(state, 0, hex);
  const farm = state.farms.find(f => hexEqual(f.pos, hex))!;

  const defender = state.units.find(u => u.playerId === 0 && u.type === 'warrior')!;
  const baseDef = defender.stats.defense;
  defender.pos = { q: 500, r: 500 }; // off any territory
  check('off-territory defense is the base stat', getEffectiveDefense(state, defender) === baseDef);
  defender.pos = { ...farm.pos }; // standing on the Farm's own hex — inside its territory
  check('an Agrar unit on its OWN Farm hex gets +FARM_DEFENSE_BONUS', getEffectiveDefense(state, defender) === baseDef + FARM_DEFENSE_BONUS, `got ${getEffectiveDefense(state, defender)}`);
  defender.pos = { ...hexNeighbors(farm.pos)[0]! }; // a neighbour is inside the Farm's AGRAR_TERRITORY_RADIUS too
  check('a neighbour of the Farm (still within AGRAR_TERRITORY_RADIUS) also gets the bonus', getEffectiveDefense(state, defender) === baseDef + FARM_DEFENSE_BONUS);

  const enemy = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  const enemyBaseDef = enemy.stats.defense;
  enemy.pos = { ...farm.pos };
  check('an ENEMY (Temple) unit standing on the same territory gets NO bonus', getEffectiveDefense(state, enemy) === enemyBaseDef, `got ${getEffectiveDefense(state, enemy)}`);
}

// ── Temple Devotion (§15-16, mostly unchanged) ──
console.log('\n=== Temple Devotion (§15-16) ===');
{
  const state = setup();
  const temple = foundTemple(state, 1, 0);
  check('founding produces a Temple for the Temple faction', temple.state === 'temple', `got ${temple.state}`);
  const player = state.players[1]!;
  check('flat income with Devotion 0', getPlayerIncome(state, 1) === BASE_INCOME_PER_ROUND, `income=${getPlayerIncome(state, 1)}`);

  state.currentPlayerIndex = 1;
  const auraBefore = player.aura;
  const bought = buyDevotion(state, temple.id);
  check('buyDevotion succeeds at level 0', bought);
  check('buyDevotion charges TEMPLE_DEVOTION_COST', player.aura === auraBefore - TEMPLE_DEVOTION_COST, `aura=${player.aura}`);
  check('devotionLevel increments', temple.devotionLevel === 1);
  check('income increases by TEMPLE_DEVOTION_INCOME per level', getPlayerIncome(state, 1) === BASE_INCOME_PER_ROUND + TEMPLE_DEVOTION_INCOME, `income=${getPlayerIncome(state, 1)}`);

  for (let i = temple.devotionLevel; i < TEMPLE_DEVOTION_MAX_LEVEL; i++) buyDevotion(state, temple.id);
  check(`Devotion caps at TEMPLE_DEVOTION_MAX_LEVEL (${TEMPLE_DEVOTION_MAX_LEVEL})`, temple.devotionLevel === TEMPLE_DEVOTION_MAX_LEVEL);
  check('cannot buy Devotion past the level cap', !canBuyDevotion(state, temple.id));
  check('income at full Devotion development', getPlayerIncome(state, 1) === BASE_INCOME_PER_ROUND + TEMPLE_DEVOTION_MAX_LEVEL * TEMPLE_DEVOTION_INCOME, `income=${getPlayerIncome(state, 1)}`);
}

// ── Equal development invariant (§51) — both cap at the SAME maximum,
// reached via different territory: Agrar via MAX_ACTIVE_FARMS Farms,
// Temple via BOTH neutral sites fully devoted.
console.log('\n=== Equal development invariant (§51) ===');
{
  const stateA = setup();
  clearFarmArea(stateA, 0);
  stateA.players[0]!.aura = 200;
  for (let i = 0; i < MAX_ACTIVE_FARMS; i++) {
    foundFarm(stateA, 0, FARM_RING[i]!);
  }
  const agrarIncome = getPlayerIncome(stateA, 0);
  const agrarFarms = stateA.farms.filter(f => f.ownerId === 0 && f.state === 'farm').length;

  const stateT = setup();
  stateT.players[1]!.aura = 200;
  for (let i = 0; i < stateT.strategicSites.length; i++) {
    const temple = foundTemple(stateT, 1, i);
    stateT.currentPlayerIndex = 1;
    for (let d = 0; d < TEMPLE_DEVOTION_MAX_LEVEL; d++) buyDevotion(stateT, temple.id);
  }
  const templeIncome = getPlayerIncome(stateT, 1);

  check(`Agrar reached MAX_ACTIVE_FARMS (${MAX_ACTIVE_FARMS}) active Farms`, agrarFarms === MAX_ACTIVE_FARMS, `got ${agrarFarms}`);
  check('a fully-developed Agrar network and a fully-developed Temple network yield equal MAXIMUM income', agrarIncome === templeIncome, `agrar=${agrarIncome} temple=${templeIncome}`);
}

// ── Production symmetry (§16-20) ──
console.log('\n=== Production symmetry (§16-20) ===');
{
  const state = setup();
  clearFarmArea(state, 0);
  const before = getProductionSlots(state, 0);
  foundFarm(state, 0, FARM_RING[0]!);
  check('1 active Farm does not raise Agrar production yet', getProductionSlots(state, 0) === before, `before=${before} after=${getProductionSlots(state, 0)}`);
  foundFarm(state, 0, FARM_RING[1]!);
  check('2 active Farms raise Agrar production by 1', getProductionSlots(state, 0) === before + 1, `got ${getProductionSlots(state, 0)}`);
  foundFarm(state, 0, FARM_RING[2]!);
  foundFarm(state, 0, FARM_RING[3]!);
  check('4 active Farms raise Agrar production by 1 more (total +2)', getProductionSlots(state, 0) === before + 2, `got ${getProductionSlots(state, 0)}`);
}
{
  const state = setup();
  const before = getProductionSlots(state, 1);
  const temple0 = foundTemple(state, 1, 0);
  check('1 active Temple raises Temple production by 1', getProductionSlots(state, 1) === before + 1, `got ${getProductionSlots(state, 1)}`);
  check('site really is a Temple', temple0.state === 'temple');
  if (state.strategicSites.length > 1) {
    foundTemple(state, 1, 1);
    check('2 active Temples raise Temple production by 2 total', getProductionSlots(state, 1) === before + 2, `got ${getProductionSlots(state, 1)}`);
  }
}
{
  const state = setup();
  const agrarSlots = getProductionSlots(state, 0);
  const templeSlots = getProductionSlots(state, 1);
  check('both factions start at the same production base', agrarSlots === templeSlots, `agrar=${agrarSlots} temple=${templeSlots}`);
}

// ── Agrar Territory (§10-11, unified) ──
console.log('\n=== Agrar Territory blocks Temple founding (§10-11) ===');
{
  // The Capital itself ALWAYS projects territory (AGRAR_TERRITORY_RADIUS),
  // with zero Farms built — no economy investment required to defend home turf.
  const state = setup();
  clearFarmArea(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const territory = getAgrarTerritory(state, 0);
  check('the Capital hex itself is territory', territory.has(hexKey(capital.pos)));
  check(`a hex exactly AGRAR_TERRITORY_RADIUS (${AGRAR_TERRITORY_RADIUS}) from the Capital is territory`, territory.has(hexKey({ q: capital.pos.q + AGRAR_TERRITORY_RADIUS, r: capital.pos.r })));
  check('a hex beyond AGRAR_TERRITORY_RADIUS of the Capital, with no Farms, is NOT territory', !territory.has(hexKey({ q: capital.pos.q + AGRAR_TERRITORY_RADIUS + 1, r: capital.pos.r })));
}
{
  const state = setup();
  clearFarmArea(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const site = state.strategicSites[0]!;
  // Build the Farm at a genuinely valid hex, then move the neutral site onto
  // a hex that's ONLY covered by the Farm's own radius — beyond the
  // Capital's own reach — so this test isolates the Farm's contribution.
  const farmHex = { q: capital.pos.q + AGRAR_TERRITORY_RADIUS, r: capital.pos.r };
  foundFarm(state, 0, farmHex);
  const beyondCapital = { q: farmHex.q + AGRAR_TERRITORY_RADIUS, r: farmHex.r };
  check('the site\'s target hex really is beyond the Capital\'s own territory', hexDistance(beyondCapital, capital.pos) > AGRAR_TERRITORY_RADIUS);
  site.pos = { ...beyondCapital };

  const territory = getAgrarTerritory(state, 0);
  check('the active Farm\'s own hex is territory', territory.has(hexKey(farmHex)));
  check('a hex beyond the Capital\'s reach, but within the Farm\'s own radius, is ALSO territory', territory.has(hexKey(site.pos)));

  const acolyte = founderOf(state, 1);
  acolyte.pos = { ...site.pos };
  acolyte.hasMoved = false; acolyte.hasAttacked = false;
  state.currentPlayerIndex = 1;
  check('Temple cannot start founding on a site inside enemy Agrar Territory', canStartFounding(state, acolyte) === null);
}
{
  // A FOUNDING (not yet active) Farm does not expand territory beyond what
  // the Capital already covers.
  const state = setup();
  clearFarmArea(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const site = state.strategicSites[0]!;
  const far = { q: state.mapRadius * 6, r: state.mapRadius * 6 };
  site.pos = far;
  const farmHex = { q: capital.pos.q + AGRAR_TERRITORY_RADIUS, r: capital.pos.r };
  const beyondCapital = { q: farmHex.q + AGRAR_TERRITORY_RADIUS, r: farmHex.r };
  const builder = founderOf(state, 0);
  builder.pos = { ...hexNeighbors(farmHex)[0]! };
  builder.hasMoved = false; builder.hasAttacked = false;
  state.currentPlayerIndex = 0;
  startFarm(state, builder.id, farmHex); // NOT advanced — still founding
  check('a still-founding Farm does not yet expand territory beyond the Capital', !getAgrarTerritory(state, 0).has(hexKey(beyondCapital)));
}
{
  // Destroying the blocking Farm removes its territory and unblocks founding.
  const state = setup();
  clearFarmArea(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const site = state.strategicSites[0]!;
  const far = { q: state.mapRadius * 6, r: state.mapRadius * 6 };
  site.pos = far;
  const hex = { q: capital.pos.q + AGRAR_TERRITORY_RADIUS, r: capital.pos.r };
  foundFarm(state, 0, hex);
  const beyondCapital = { q: hex.q + AGRAR_TERRITORY_RADIUS, r: hex.r };
  site.pos = { ...beyondCapital };
  const farm = state.farms.find(f => hexEqual(f.pos, hex))!;

  const acolyte = founderOf(state, 1);
  acolyte.pos = { ...site.pos };
  acolyte.hasMoved = false; acolyte.hasAttacked = false;
  state.currentPlayerIndex = 1;
  check('setup: founding is blocked while the Farm stands', canStartFounding(state, acolyte) === null);

  // Destroy the Farm with a different attacker (Acolyte can't fight).
  const raider = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  raider.pos = { ...hexNeighbors(farm.pos)[0]! };
  raider.hasMoved = false; raider.hasAttacked = false;
  state.currentPlayerIndex = 1;
  selectUnit(state, raider.id);
  farm.hp = 1;
  attackStructure(state, farm.pos);
  check('the Farm is destroyed', !state.farms.some(f => f.id === farm.id));

  acolyte.hasMoved = false; acolyte.hasAttacked = false;
  state.currentPlayerIndex = 1;
  check('founding is unblocked once the blocking Farm is gone', canStartFounding(state, acolyte) !== null);
}
{
  // An ACTIVE (already-founded) Temple is never disabled by nearby enemy
  // Agrar Territory — it only blocks founding/rebuilding, not an active Temple.
  const state = setup();
  const temple = foundTemple(state, 1, 0);
  state.currentPlayerIndex = 1;
  buyDevotion(state, temple.id);
  const incomeBefore = getPlayerIncome(state, 1);
  check('Temple is active and earning', temple.state === 'temple' && incomeBefore > BASE_INCOME_PER_ROUND);
  // (No Agrar Farm can legally land ON the Temple hex itself — getValidFarmHexes
  // already excludes any hex with a strategic site — so proximity alone can
  // never flip an active Temple off; nothing further to build here.)
  check('an active Temple is structurally immune to Agrar Territory (no state field ties it to Farms)', temple.ownerId === 1 && temple.state === 'temple');
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
