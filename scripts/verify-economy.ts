// Phase 10/11 verification, plus the economy/pacing balance pass: the
// macro-economy correction — "Agrar controls area (Farms), Temple controls
// points (Temples)" — the phase 11 Builder-adjacency Farm placement, the
// slowed-down Energy scale (3 base income / 3 starting, 7 max instead of
// 6/6/10), and Agrar Territory split back into two distinct, single-purpose
// radii (infrastructure reach vs shrine-denial cultivation), with the
// territory defense bonus removed entirely. Exercises the real engine
// mutators end-to-end (no forked logic) — createGameState, startFounding,
// startFarm, endTurn, buyDevotion, attackStructure.
//
// Run with: npx tsx scripts/verify-economy.ts
import {
  createGameState, endTurn, chooseFaction, startFounding, canStartFounding,
  getPlayerIncome, getProductionSlots,
  canStartFarm, startFarm, getValidFarmHexes, getAgrarTerritory, getAgrarCultivation,
  canBuyDevotion, buyDevotion,
  selectUnit, attackStructure, getStructureAt, getEffectiveDefense,
  createUnit,
} from '../src/game';
import {
  BASE_INCOME_PER_ROUND, AGRAR_FARM_COST, AGRAR_FARM_INCOME, MAX_ACTIVE_FARMS,
  AGRAR_TERRITORY_RADIUS, CULTIVATION_RADIUS, FARM_MIN_SPACING, SITE_ESTABLISH_COST,
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

// Founds AND fully develops (Devotion I + II) a Temple for playerId.
function foundFullTemple(state: GameState, playerId: number, siteIndex = 0) {
  const site = foundTemple(state, playerId, siteIndex);
  state.currentPlayerIndex = playerId;
  buyDevotion(state, site.id);
  state.currentPlayerIndex = playerId;
  buyDevotion(state, site.id);
  return site;
}

// ── Base income (§1) ──
console.log('\n=== Base income (§1) ===');
{
  const state = createGameState();
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
  const p0 = state.players[0]!;
  const before = p0.aura;
  endTurn(state); // p0's turn ends; p1 starts (no income change for p0 yet)
  endTurn(state); // p1's turn ends; p0 starts -> gains income
  check('base income granted every round regardless of structures', p0.aura === before + BASE_INCOME_PER_ROUND, `aura ${before}->${p0.aura}`);
  check('BASE_INCOME_PER_ROUND is 3 (was 6)', BASE_INCOME_PER_ROUND === 3, `got ${BASE_INCOME_PER_ROUND}`);
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

// ── Agrar Farms: construction (§3) ──
console.log('\n=== Agrar Farms: construction (§3) ===');
{
  const state = setup();
  clearFarmArea(state, 0);
  check('AGRAR_FARM_COST is 6 (was 5)', AGRAR_FARM_COST === 6, `got ${AGRAR_FARM_COST}`);
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
  check('income is still flat while founding', getPlayerIncome(state, 0) === BASE_INCOME_PER_ROUND);
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

// ── Agrar Farms: placement rules — Builder-adjacency AND infrastructure territory ──
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
  // exactly FARM_MIN_SPACING is still fine (and still within reach).
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
  // A Farm can NOT be started far from the Capital or any existing Farm,
  // even if the Builder physically travels there: the network only grows
  // as a connected bunker (AGRAR_TERRITORY_RADIUS reach).
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
  check('the next spot is beyond the Capital\'s own reach', hexDistance(builder.pos, capital.pos) > AGRAR_TERRITORY_RADIUS);
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

// ── Territory grants NO combat bonus (§9) ──
console.log('\n=== Agrar Territory grants NO defense bonus (§9) ===');
{
  const state = setup();
  clearFarmArea(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const builder = founderOf(state, 0);
  const hex = getValidFarmHexes(state, builder)[0]!;
  foundFarm(state, 0, hex);
  const farm = state.farms.find(f => hexEqual(f.pos, hex))!;

  const defender = state.units.find(u => u.playerId === 0 && u.type === 'warrior')!;
  const baseDef = defender.stats.defense;
  defender.pos = { q: 500, r: 500 }; // far off any territory
  check('off-territory defense is the base stat', getEffectiveDefense(state, defender) === baseDef);
  defender.pos = { ...farm.pos }; // standing on its own Farm's hex
  check('an Agrar unit on its OWN Farm hex gets NO defense bonus', getEffectiveDefense(state, defender) === baseDef, `got ${getEffectiveDefense(state, defender)}, base=${baseDef}`);
  defender.pos = { ...capital.pos }; // standing on its own Capital
  check('an Agrar unit on its OWN Capital hex gets NO defense bonus', getEffectiveDefense(state, defender) === baseDef);
  check('effective DEF equals base DEF + terrain/support only (no territory term)', getEffectiveDefense(state, defender) === defender.stats.defense);
}

// ── Temple Devotion (§4) ──
console.log('\n=== Temple Devotion (§4) ===');
{
  const state = setup();
  const temple = foundTemple(state, 1, 0);
  check('founding produces a Temple for the Temple faction', temple.state === 'temple', `got ${temple.state}`);
  const player = state.players[1]!;
  check('flat income with Devotion 0', getPlayerIncome(state, 1) === BASE_INCOME_PER_ROUND, `income=${getPlayerIncome(state, 1)}`);
  check('TEMPLE_DEVOTION_COST is 4 (was 3)', TEMPLE_DEVOTION_COST === 4, `got ${TEMPLE_DEVOTION_COST}`);

  state.currentPlayerIndex = 1;
  const auraBefore = player.aura;
  const bought = buyDevotion(state, temple.id);
  check('buyDevotion succeeds at level 0', bought);
  check('buyDevotion charges TEMPLE_DEVOTION_COST', player.aura === auraBefore - TEMPLE_DEVOTION_COST, `aura=${player.aura}`);
  check('devotionLevel increments', temple.devotionLevel === 1);
  check('income increases by TEMPLE_DEVOTION_INCOME per level', getPlayerIncome(state, 1) === BASE_INCOME_PER_ROUND + TEMPLE_DEVOTION_INCOME, `income=${getPlayerIncome(state, 1)}`);
  check('a partially-developed (Devotion I) Temple grants no production slot', getProductionSlots(state, 1) === 2, `got ${getProductionSlots(state, 1)}`);

  for (let i = temple.devotionLevel; i < TEMPLE_DEVOTION_MAX_LEVEL; i++) buyDevotion(state, temple.id);
  check(`Devotion caps at TEMPLE_DEVOTION_MAX_LEVEL (${TEMPLE_DEVOTION_MAX_LEVEL})`, temple.devotionLevel === TEMPLE_DEVOTION_MAX_LEVEL);
  check('cannot buy Devotion past the level cap', !canBuyDevotion(state, temple.id));
  check('income at full Devotion development', getPlayerIncome(state, 1) === BASE_INCOME_PER_ROUND + TEMPLE_DEVOTION_MAX_LEVEL * TEMPLE_DEVOTION_INCOME, `income=${getPlayerIncome(state, 1)}`);
  check('a fully-developed (Devotion II) Temple grants +1 production slot', getProductionSlots(state, 1) === 3, `got ${getProductionSlots(state, 1)}`);
}

// ── §27-28 Economic symmetry curve + macro-investment-equality invariants ──
console.log('\n=== Agrar economic curve (§27) ===');
{
  const state = setup();
  clearFarmArea(state, 0);
  const expectedIncome = [3, 4, 5, 6, 7];
  const expectedSlots = [2, 2, 3, 3, 4];
  check(`0 Farms = ${expectedIncome[0]} income`, getPlayerIncome(state, 0) === expectedIncome[0], `got ${getPlayerIncome(state, 0)}`);
  check(`0 Farms = ${expectedSlots[0]} production`, getProductionSlots(state, 0) === expectedSlots[0], `got ${getProductionSlots(state, 0)}`);
  for (let i = 0; i < MAX_ACTIVE_FARMS; i++) {
    foundFarm(state, 0, FARM_RING[i]!);
    const n = i + 1;
    check(`${n} Farm(s) = ${expectedIncome[n]} income`, getPlayerIncome(state, 0) === expectedIncome[n], `got ${getPlayerIncome(state, 0)}`);
    check(`${n} Farm(s) = ${expectedSlots[n]} production`, getProductionSlots(state, 0) === expectedSlots[n], `got ${getProductionSlots(state, 0)}`);
  }
}
console.log('\n=== Temple economic curve (§27) ===');
{
  const state = setup();
  check('0 full neutral Temples = 3 income', getPlayerIncome(state, 1) === 3, `got ${getPlayerIncome(state, 1)}`);
  const t0 = foundTemple(state, 1, 0);
  check('Temple + no Devotion = +0 income', getPlayerIncome(state, 1) === 3, `got ${getPlayerIncome(state, 1)}`);
  state.currentPlayerIndex = 1;
  buyDevotion(state, t0.id);
  check('Devotion I = +1 income (total 4)', getPlayerIncome(state, 1) === 4, `got ${getPlayerIncome(state, 1)}`);
  state.currentPlayerIndex = 1;
  buyDevotion(state, t0.id);
  check('Devotion II = +2 income (total 5)', getPlayerIncome(state, 1) === 5, `got ${getPlayerIncome(state, 1)}`);
  check('1 Devotion-II Temple = 5 income', getPlayerIncome(state, 1) === 5);
  check('1 Devotion-II Temple = 3 production', getProductionSlots(state, 1) === 3, `got ${getProductionSlots(state, 1)}`);
  if (state.strategicSites.length > 1) {
    foundFullTemple(state, 1, 1);
    check('2 Devotion-II Temples = 7 income', getPlayerIncome(state, 1) === 7, `got ${getPlayerIncome(state, 1)}`);
    check('2 Devotion-II Temples = 4 production', getProductionSlots(state, 1) === 4, `got ${getProductionSlots(state, 1)}`);
  }
}
console.log('\n=== Macro investment equality (§28) ===');
{
  // Raw sticker prices, computed from the constants directly (NOT by
  // measuring aura drift across foundFarm/foundTemple — those helpers
  // advance real rounds, so base/Devotion income would accrue in between
  // and confound a "spent" measurement).
  const cost2Farms = AGRAR_FARM_COST * 2;
  const cost4Farms = AGRAR_FARM_COST * 4;
  const cost1Temple = SITE_ESTABLISH_COST + TEMPLE_DEVOTION_COST * TEMPLE_DEVOTION_MAX_LEVEL;
  const cost2Temples = cost1Temple * 2;
  check('2 Agrar Farms cost exactly 12⚡', cost2Farms === 12, `got ${cost2Farms}`);
  check('4 Agrar Farms cost exactly 24⚡', cost4Farms === 24, `got ${cost4Farms}`);
  check('1 fully-developed Temple costs exactly 12⚡ (4 found + 4 + 4 Devotion)', cost1Temple === 12, `got ${cost1Temple}`);
  check('2 fully-developed Temples cost exactly 24⚡', cost2Temples === 24, `got ${cost2Temples}`);
  check('2 Farms and 1 fully-developed Temple represent EQUAL macro investment (cost)', cost2Farms === cost1Temple);
  check('4 Farms and 2 fully-developed Temples represent EQUAL macro investment (cost)', cost4Farms === cost2Temples);

  const stateA = setup();
  clearFarmArea(stateA, 0);
  stateA.players[0]!.aura = 200;
  const before = getPlayerIncome(stateA, 0);
  const beforeSlots = getProductionSlots(stateA, 0);
  foundFarm(stateA, 0, FARM_RING[0]!);
  foundFarm(stateA, 0, FARM_RING[1]!);
  check('2 Agrar Farms: income gain = +2', getPlayerIncome(stateA, 0) - before === 2, `got ${getPlayerIncome(stateA, 0) - before}`);
  check('2 Agrar Farms: production gain = +1', getProductionSlots(stateA, 0) - beforeSlots === 1, `got ${getProductionSlots(stateA, 0) - beforeSlots}`);
  foundFarm(stateA, 0, FARM_RING[2]!);
  foundFarm(stateA, 0, FARM_RING[3]!);
  check('4 Agrar Farms: income gain = +4', getPlayerIncome(stateA, 0) - before === 4, `got ${getPlayerIncome(stateA, 0) - before}`);
  check('4 Agrar Farms: production gain = +2', getProductionSlots(stateA, 0) - beforeSlots === 2, `got ${getProductionSlots(stateA, 0) - beforeSlots}`);

  const stateT = setup();
  stateT.players[1]!.aura = 200;
  const beforeT = getPlayerIncome(stateT, 1);
  const beforeSlotsT = getProductionSlots(stateT, 1);
  foundFullTemple(stateT, 1, 0);
  check('1 fully-developed Temple: income gain = +2', getPlayerIncome(stateT, 1) - beforeT === 2, `got ${getPlayerIncome(stateT, 1) - beforeT}`);
  check('1 fully-developed Temple: production gain = +1', getProductionSlots(stateT, 1) - beforeSlotsT === 1, `got ${getProductionSlots(stateT, 1) - beforeSlotsT}`);
  if (stateT.strategicSites.length > 1) {
    foundFullTemple(stateT, 1, 1);
    check('2 fully-developed Temples: income gain = +4', getPlayerIncome(stateT, 1) - beforeT === 4, `got ${getPlayerIncome(stateT, 1) - beforeT}`);
    check('2 fully-developed Temples: production gain = +2', getProductionSlots(stateT, 1) - beforeSlotsT === 2, `got ${getProductionSlots(stateT, 1) - beforeSlotsT}`);
  }

  check('2 Farms and 1 fully-developed Temple represent EQUAL macro investment (income)', (getPlayerIncome(stateA, 0) - before) === (getPlayerIncome(stateT, 1) - beforeT));
}

// ── Equal MAXIMUM development invariant — both cap at 7⚡ income ──
console.log('\n=== Equal maximum development invariant ===');
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
    foundFullTemple(stateT, 1, i);
  }
  const templeIncome = getPlayerIncome(stateT, 1);

  check(`Agrar reached MAX_ACTIVE_FARMS (${MAX_ACTIVE_FARMS}) active Farms`, agrarFarms === MAX_ACTIVE_FARMS, `got ${agrarFarms}`);
  check('a fully-developed Agrar network and a fully-developed Temple network yield equal MAXIMUM income', agrarIncome === templeIncome, `agrar=${agrarIncome} temple=${templeIncome}`);
  check('the maximum income is exactly 7 (not 10)', agrarIncome === 7 && templeIncome === 7, `agrar=${agrarIncome} temple=${templeIncome}`);
}

// ── Production symmetry ──
console.log('\n=== Production symmetry ===');
{
  const state = setup();
  const agrarSlots = getProductionSlots(state, 0);
  const templeSlots = getProductionSlots(state, 1);
  check('both factions start at the same production base', agrarSlots === templeSlots, `agrar=${agrarSlots} temple=${templeSlots}`);
}

// ── Infrastructure Territory (§10) — placement reach only, NOT area denial ──
console.log('\n=== Agrar Territory: infrastructure reach only, no area-denial (§10) ===');
{
  // The Capital itself ALWAYS projects infrastructure territory, with zero
  // Farms built — no economy investment required to expand from home.
  const state = setup();
  clearFarmArea(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const territory = getAgrarTerritory(state, 0);
  check('the Capital hex itself is (infrastructure) territory', territory.has(hexKey(capital.pos)));
  check(`a hex exactly AGRAR_TERRITORY_RADIUS (${AGRAR_TERRITORY_RADIUS}) from the Capital is territory`, territory.has(hexKey({ q: capital.pos.q + AGRAR_TERRITORY_RADIUS, r: capital.pos.r })));
  check('a hex beyond AGRAR_TERRITORY_RADIUS of the Capital, with no Farms, is NOT territory', !territory.has(hexKey({ q: capital.pos.q + AGRAR_TERRITORY_RADIUS + 1, r: capital.pos.r })));
}
{
  // Crucially: being inside the Capital's infrastructure territory (radius 2)
  // does NOT block Temple founding — only the tighter, farm-only cultivation
  // radius does (§10-11). A hex just outside cultivation range (radius 1 of
  // any Farm) but still inside the Capital's radius-2 territory is foundable.
  const state = setup();
  clearFarmArea(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const site = state.strategicSites[0]!;
  // Note the r-axis here, not q — clearFarmArea parks the Agrar Builder at
  // {q:2,r:0}, so a site along the q-axis would collide with it (which would
  // itself block founding as "enemy on site", confounding this test).
  site.pos = { q: capital.pos.q, r: capital.pos.r + AGRAR_TERRITORY_RADIUS }; // inside territory, no Farm anywhere
  check('setup: the site is inside the Capital\'s infrastructure territory', getAgrarTerritory(state, 0).has(hexKey(site.pos)));
  check('the site is NOT inside any cultivation (no Farms exist)', !getAgrarCultivation(state, 0).has(hexKey(site.pos)));

  const acolyte = founderOf(state, 1);
  acolyte.pos = { ...site.pos };
  acolyte.hasMoved = false; acolyte.hasAttacked = false;
  state.currentPlayerIndex = 1;
  check('Temple CAN found on a site merely inside Agrar\'s infrastructure territory (Capital alone never blocks founding)', canStartFounding(state, acolyte) !== null);
}

// ── Cultivated Influence (§11, §30) — shrine denial only, farm-radius-1 ──
console.log('\n=== Cultivated Influence: shrine denial, radius 1, farms only (§11/§30) ===');
{
  check('CULTIVATION_RADIUS is 1 (tighter than AGRAR_TERRITORY_RADIUS 2)', CULTIVATION_RADIUS === 1 && CULTIVATION_RADIUS < AGRAR_TERRITORY_RADIUS);
  const state = setup();
  clearFarmArea(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  // The Capital projects NO cultivation at all, even with zero Farms.
  const cultivationNoFarms = getAgrarCultivation(state, 0);
  check('the Capital itself projects NO cultivation', cultivationNoFarms.size === 0, `got ${cultivationNoFarms.size}`);

  const site = state.strategicSites[0]!;
  const farmHex = { q: capital.pos.q + AGRAR_TERRITORY_RADIUS, r: capital.pos.r };
  foundFarm(state, 0, farmHex);
  site.pos = { ...farmHex };

  const cultivated = getAgrarCultivation(state, 0);
  check('the active Farm cultivates its own hex + 6 neighbours (radius 1)', cultivated.size === 7, `got ${cultivated.size}`);
  check('the site hex (the Farm\'s own hex) is inside the cultivated set', cultivated.has(hexKey(site.pos)));

  const acolyte = founderOf(state, 1);
  acolyte.pos = { ...site.pos };
  acolyte.hasMoved = false; acolyte.hasAttacked = false;
  state.currentPlayerIndex = 1;
  check('Temple cannot start founding on a site inside enemy Farm cultivation', canStartFounding(state, acolyte) === null);
}
{
  // Do not let a Farm block Temple founding from two hexes away.
  const state = setup();
  clearFarmArea(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const site = state.strategicSites[0]!;
  const farmHex = { q: capital.pos.q + AGRAR_TERRITORY_RADIUS, r: capital.pos.r };
  foundFarm(state, 0, farmHex);
  const twoAway = { q: farmHex.q + CULTIVATION_RADIUS + 1, r: farmHex.r }; // distance 2 from the Farm
  check('setup: the site really is 2 hexes from the Farm', hexDistance(twoAway, farmHex) === CULTIVATION_RADIUS + 1);
  site.pos = { ...twoAway };
  check('a shrine 2 hexes from the Farm is NOT cultivated', !getAgrarCultivation(state, 0).has(hexKey(site.pos)));

  const acolyte = founderOf(state, 1);
  acolyte.pos = { ...site.pos };
  acolyte.hasMoved = false; acolyte.hasAttacked = false;
  state.currentPlayerIndex = 1;
  check('Temple CAN found a shrine 2 hexes from the Farm — cultivation does not reach that far', canStartFounding(state, acolyte) !== null);
}
{
  // A FOUNDING (not yet active) Farm does not cultivate anything.
  const state = setup();
  clearFarmArea(state, 0);
  const site = state.strategicSites[0]!;
  const far = { q: state.mapRadius * 6, r: state.mapRadius * 6 };
  site.pos = far;
  const builder = founderOf(state, 0);
  const hex = getValidFarmHexes(state, builder)[0]!;
  builder.hasMoved = false; builder.hasAttacked = false;
  state.currentPlayerIndex = 0;
  startFarm(state, builder.id, hex); // NOT advanced — still founding
  site.pos = hex;
  check('a still-founding Farm projects no cultivation', getAgrarCultivation(state, 0).size === 0);
}
{
  // Destroying the blocking Farm removes the cultivation and unblocks founding.
  const state = setup();
  clearFarmArea(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const site = state.strategicSites[0]!;
  const far = { q: state.mapRadius * 6, r: state.mapRadius * 6 };
  site.pos = far;
  const hex = { q: capital.pos.q + AGRAR_TERRITORY_RADIUS, r: capital.pos.r };
  foundFarm(state, 0, hex);
  site.pos = hex;
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
  // cultivation — it only blocks founding/rebuilding, not an active Temple.
  const state = setup();
  const temple = foundTemple(state, 1, 0);
  state.currentPlayerIndex = 1;
  buyDevotion(state, temple.id);
  const incomeBefore = getPlayerIncome(state, 1);
  check('Temple is active and earning', temple.state === 'temple' && incomeBefore > BASE_INCOME_PER_ROUND);
  // (No Agrar Farm can legally land ON the Temple hex itself — getValidFarmHexes
  // already excludes any hex with a strategic site — so proximity alone can
  // never flip an active Temple off; nothing further to build here.)
  check('an active Temple is structurally immune to cultivation (no state field ties it to Farms)', temple.ownerId === 1 && temple.state === 'temple');
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
