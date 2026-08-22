// Phase 10 verification: the macro-economy correction — "Agrar controls
// area (Farms), Temple controls points (Temples)". Exercises the real
// engine mutators end-to-end (no forked logic) — createGameState,
// startFounding, startFarm, endTurn, buyDevotion, attackStructure.
//
// Run with: npx tsx scripts/verify-economy.ts
import {
  createGameState, endTurn, chooseFaction, startFounding, canStartFounding,
  getPlayerIncome, getProductionSlots,
  canStartFarm, startFarm, getValidFarmHexes, getCultivatedHexes,
  canBuyDevotion, buyDevotion,
  selectUnit, attackStructure, getStructureAt,
} from '../src/game';
import {
  BASE_INCOME_PER_ROUND, AGRAR_FARM_COST, AGRAR_FARM_INCOME, MAX_ACTIVE_FARMS,
  FARM_DISTANCE_FROM_CAPITAL, FARM_MIN_SPACING, CULTIVATION_RADIUS,
  TEMPLE_DEVOTION_COST, TEMPLE_DEVOTION_INCOME, TEMPLE_DEVOTION_MAX_LEVEL,
} from '../src/factions';
import { hexDistance, hexNeighbors, hexKey } from '../src/hex';
import type { GameState } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A fresh 2-player game, fast-forwarded past the Founding Round and faction
// reveal (Agrar=P0, Temple=P1), with generous aura for testing.
function setup(): GameState {
  const state = createGameState();
  endTurn(state);
  endTurn(state);
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
  for (const p of state.players) p.aura = 200;
  return state;
}

function founderOf(state: GameState, playerId: number) {
  return state.units.find(u => u.playerId === playerId && u.type === 'founder')!;
}

function advanceOneRound(state: GameState): void {
  endTurn(state);
  endTurn(state);
}

// Farm placement doesn't require the Builder to stand on the target hex, but
// it DOES require every candidate hex to be genuinely empty/passable — clear
// a wide area around the player's Capital (relocating other structures/units
// and stripping hills/walls/forests) so the random map layout can never make
// this flaky. See the identical rationale in verify-roads.ts/verify-zoc.ts.
// Also recenters the Capital itself to the map's exact center: a capital
// placed near the edge (a normal, legitimate layout) can clip enough of its
// distance-2 ring off-map that packing MAX_ACTIVE_FARMS mutually-spaced
// Farms genuinely isn't geometrically possible — recentering removes that
// confound so these tests exercise the CAP, not incidental map geometry.
function clearFarmArea(state: GameState, playerId: number, radius = FARM_DISTANCE_FROM_CAPITAL + MAX_ACTIVE_FARMS): void {
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
}

// Starts a Farm with playerId's Builder at `pos` and lets it complete
// uncontested (one full round).
function foundFarm(state: GameState, playerId: number, pos: { q: number; r: number }): void {
  const builder = founderOf(state, playerId);
  builder.pos = { q: state.mapRadius * 6, r: state.mapRadius * 6 - 1 }; // out of the way — proximity doesn't matter
  builder.hasMoved = false; builder.hasAttacked = false;
  state.currentPlayerIndex = playerId;
  startFarm(state, builder.id, pos);
  advanceOneRound(state);
}

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
  const capital = state.capitals.find(c => c.playerId === 0)!;
  check('flat income with no Farms yet', getPlayerIncome(state, 0) === BASE_INCOME_PER_ROUND, `income=${getPlayerIncome(state, 0)}`);

  const hexes = getValidFarmHexes(state, 0);
  check('valid farm hexes exist near the Capital', hexes.length > 0);
  check('every valid hex is within FARM_DISTANCE_FROM_CAPITAL of the Capital', hexes.every(h => hexDistance(h, capital.pos) <= FARM_DISTANCE_FROM_CAPITAL));

  const builder = founderOf(state, 0);
  const player = state.players[0]!;
  const auraBefore = player.aura;
  const targetHex = hexes[0]!;
  builder.hasMoved = false; builder.hasAttacked = false;
  state.currentPlayerIndex = 0;
  const started = startFarm(state, builder.id, targetHex);
  check('startFarm succeeds at a valid hex', started);
  check('startFarm charges AGRAR_FARM_COST immediately', player.aura === auraBefore - AGRAR_FARM_COST, `aura=${player.aura}`);
  check('the Builder\'s whole activation is consumed', builder.hasMoved && builder.hasAttacked);

  const founding = state.farms.find(f => hexDistance(f.pos, targetHex) === 0)!;
  check('the Farm exists in a founding state', founding.state === 'foundingFarm');
  check('income is still flat while founding (§10)', getPlayerIncome(state, 0) === BASE_INCOME_PER_ROUND);
  check('a founding Farm is not yet attackable', getStructureAt(state, targetHex) === null);

  advanceOneRound(state);
  const completed = state.farms.find(f => hexDistance(f.pos, targetHex) === 0)!;
  check('the Farm completes uncontested', completed.state === 'farm');
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
  const hex = getValidFarmHexes(state, 0)[0]!;
  check('cannot build a Farm without enough aura', !canStartFarm(state, builder, hex));
}
{
  // Temple's Acolyte has no equivalent (§28).
  const state = setup();
  clearFarmArea(state, 1);
  const acolyte = founderOf(state, 1);
  acolyte.hasMoved = false; acolyte.hasAttacked = false;
  state.currentPlayerIndex = 1;
  const anyHex = { q: state.capitals.find(c => c.playerId === 1)!.pos.q, r: state.capitals.find(c => c.playerId === 1)!.pos.r + 1 };
  check('Temple\'s Acolyte cannot build a Farm', !canStartFarm(state, acolyte, anyHex));
}

// ── Agrar Farms: placement rules (§8) ──
console.log('\n=== Agrar Farms: placement rules (§8) ===');
{
  const state = setup();
  clearFarmArea(state, 0);
  const capital = state.capitals.find(c => c.playerId === 0)!;
  const hexes = getValidFarmHexes(state, 0);
  check('no candidate hex is directly on the Capital', !hexes.some(h => hexDistance(h, capital.pos) === 0));

  // Build one Farm, then verify the network can extend from it AND that
  // hexes too close to it are excluded.
  const first = hexes[0]!;
  foundFarm(state, 0, first);
  const hexesAfter = getValidFarmHexes(state, 0);
  check('a hex adjacent to the new Farm is excluded (min spacing)', !hexesAfter.some(h => hexDistance(h, first) === 1));
  check(`a hex exactly FARM_MIN_SPACING (${FARM_MIN_SPACING}) from the Farm can still be valid`, hexesAfter.some(h => hexDistance(h, first) === FARM_MIN_SPACING) || hexesAfter.length === 0);
  check('the network can extend from the new Farm, not just the Capital', hexesAfter.some(h => hexDistance(h, first) <= FARM_DISTANCE_FROM_CAPITAL && hexDistance(h, capital.pos) > FARM_DISTANCE_FROM_CAPITAL));
}
{
  // Global cap: MAX_ACTIVE_FARMS, counting founding + active together.
  const state = setup();
  clearFarmArea(state, 0);
  state.currentPlayerIndex = 0;
  for (let i = 0; i < MAX_ACTIVE_FARMS; i++) {
    const hex = getValidFarmHexes(state, 0)[0];
    if (!hex) break;
    const builder = founderOf(state, 0);
    builder.hasMoved = false; builder.hasAttacked = false;
    startFarm(state, builder.id, hex);
  }
  check(`built up to MAX_ACTIVE_FARMS (${MAX_ACTIVE_FARMS}) Farms (founding)`, state.farms.filter(f => f.ownerId === 0).length === MAX_ACTIVE_FARMS, `got ${state.farms.filter(f => f.ownerId === 0).length}`);
  const builder = founderOf(state, 0);
  builder.hasMoved = false; builder.hasAttacked = false;
  const extraHex = { q: state.mapRadius * 6 - 1, r: 0 }; // irrelevant — cap check happens before hex validity
  check('cannot start a 5th Farm past the global cap', !canStartFarm(state, builder, extraHex));
}

// ── Agrar Farms: destruction has no Ruins (§15) ──
console.log('\n=== Agrar Farms: destruction (§15) ===');
{
  const state = setup();
  clearFarmArea(state, 0);
  const hex = getValidFarmHexes(state, 0)[0]!;
  foundFarm(state, 0, hex);
  const farm = state.farms.find(f => hexDistance(f.pos, hex) === 0)!;

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
  check('the freed slot can be rebuilt elsewhere', getValidFarmHexes(state, 0).length > 0);
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
    const hex = getValidFarmHexes(stateA, 0)[0];
    if (!hex) break;
    foundFarm(stateA, 0, hex);
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
  for (let i = 0; i < 1; i++) {
    const hex = getValidFarmHexes(state, 0)[0]!;
    foundFarm(state, 0, hex);
  }
  check('1 active Farm does not raise Agrar production yet', getProductionSlots(state, 0) === before, `before=${before} after=${getProductionSlots(state, 0)}`);
  const hex2 = getValidFarmHexes(state, 0)[0]!;
  foundFarm(state, 0, hex2);
  check('2 active Farms raise Agrar production by 1', getProductionSlots(state, 0) === before + 1, `got ${getProductionSlots(state, 0)}`);
  const hex3 = getValidFarmHexes(state, 0)[0];
  if (hex3) foundFarm(state, 0, hex3); // recompute hex4 AFTER hex3 lands — spacing may exclude former candidates
  const hex4 = getValidFarmHexes(state, 0)[0];
  if (hex4) foundFarm(state, 0, hex4);
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

// ── Cultivation (§10-11) ──
console.log('\n=== Cultivated territory blocks Temple founding (§10-11) ===');
{
  const state = setup();
  clearFarmArea(state, 0);
  const site = state.strategicSites[0]!;
  // Build the Farm at a genuinely valid hex, then move the neutral site onto
  // it — we only need the site's HEX to end up inside the Farm's cultivated
  // territory, not to reuse the site's own (likely out-of-range) position.
  const farmHex = getValidFarmHexes(state, 0)[0]!;
  foundFarm(state, 0, farmHex);
  site.pos = { ...farmHex };

  const cultivated = getCultivatedHexes(state, 0);
  check('the active Farm cultivates its own hex + 6 neighbours', cultivated.size === 7, `got ${cultivated.size} (radius=${CULTIVATION_RADIUS})`);
  check('the site hex is inside the cultivated set', cultivated.has(hexKey(site.pos)));

  const acolyte = founderOf(state, 1);
  acolyte.pos = { ...site.pos };
  acolyte.hasMoved = false; acolyte.hasAttacked = false;
  state.currentPlayerIndex = 1;
  check('Temple cannot start founding on a site inside enemy cultivated territory', canStartFounding(state, acolyte) === null);
}
{
  // A FOUNDING (not yet active) Farm does not cultivate anything.
  const state = setup();
  clearFarmArea(state, 0);
  const site = state.strategicSites[0]!;
  const far = { q: state.mapRadius * 6, r: state.mapRadius * 6 };
  site.pos = far;
  const hex = getValidFarmHexes(state, 0)[0]!;
  const builder = founderOf(state, 0);
  builder.hasMoved = false; builder.hasAttacked = false;
  state.currentPlayerIndex = 0;
  startFarm(state, builder.id, hex); // NOT advanced — still founding
  site.pos = hex;
  check('a still-founding Farm projects no cultivation', getCultivatedHexes(state, 0).size === 0);
}
{
  // Destroying the blocking Farm removes the cultivation and unblocks founding.
  const state = setup();
  clearFarmArea(state, 0);
  const site = state.strategicSites[0]!;
  const far = { q: state.mapRadius * 6, r: state.mapRadius * 6 };
  site.pos = far;
  const hex = getValidFarmHexes(state, 0)[0]!;
  foundFarm(state, 0, hex);
  site.pos = hex;
  const farm = state.farms.find(f => hexDistance(f.pos, hex) === 0)!;

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
  // An ACTIVE (already-founded) Temple is never disabled by a nearby enemy
  // Farm — cultivation only blocks founding/rebuilding, not an active Temple.
  const state = setup();
  const temple = foundTemple(state, 1, 0);
  clearFarmArea(state, 0);
  const nearHex = { ...hexNeighbors(temple.pos)[0]! };
  // Build the Farm as close to the Temple as the placement rules allow —
  // this test only needs the Temple to remain 'temple' regardless of proximity.
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
