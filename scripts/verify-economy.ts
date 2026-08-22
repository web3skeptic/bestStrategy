// Phase 4 verification: Farms/Devotion economy (design brief §12-18). Exercises
// the real engine mutators end-to-end (no forked logic) — createGameState,
// startFounding, endTurn, buildFarm, buyDevotion, attackStructure.
//
// Run with: npx tsx scripts/verify-economy.ts
import {
  createGameState, endTurn, chooseFaction, startFounding,
  getPlayerIncome, getCityFarms,
  canBuildFarm, buildFarm, getValidFarmHexes,
  canBuyDevotion, buyDevotion,
  selectUnit, attackStructure, getStructureAt,
} from '../src/game';
import {
  BASE_INCOME_PER_ROUND, AGRAR_FARM_COST, AGRAR_FARM_INCOME, FARM_SLOTS_PER_CITY,
  FARM_DISTANCE_FROM_CITY, TEMPLE_DEVOTION_COST, TEMPLE_DEVOTION_INCOME, TEMPLE_DEVOTION_MAX_LEVEL,
} from '../src/factions';
import { hexDistance, hexNeighbors } from '../src/hex';
import type { GameState, StrategicSite } from '../src/types';

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
  for (const p of state.players) p.aura = 30;
  return state;
}

function founderOf(state: GameState, playerId: number) {
  return state.units.find(u => u.playerId === playerId && u.type === 'founder')!;
}

function advanceOneRound(state: GameState): void {
  endTurn(state);
  endTurn(state);
}

// Map generation randomizes terrain/site placement each call. Most tests here
// don't care (founding only checks unit occupancy), but the Farm-ring tests
// need every FARM_DISTANCE_FROM_CITY hex around the target site to actually
// be buildable — which a site placed near the map edge, or near another
// site/capital, can't guarantee. Relocate the target site to the map center
// and clear terrain/other structures away from its ring so results are
// deterministic regardless of the random layout.
function centerAndClearSite(state: GameState, siteIndex = 0): StrategicSite {
  const site = state.strategicSites[siteIndex]!;
  state.hills.clear(); state.walls.clear(); state.forests.clear();
  site.pos = { q: 0, r: 0 };
  const far = state.mapRadius * 3;
  for (const s of state.strategicSites) if (s.id !== site.id) s.pos = { q: far, r: far };
  for (const c of state.capitals) c.pos = { q: c.pos.q + far, r: c.pos.r + far };
  return site;
}

// Founds site[siteIndex] to completion for playerId (must be that player's
// faction-correct target) and returns the resulting site.
function foundSite(state: GameState, playerId: number, siteIndex = 0): StrategicSite {
  const site = state.strategicSites[siteIndex]!;
  const founder = founderOf(state, playerId);
  founder.pos = { ...site.pos };
  founder.hasMoved = false;
  founder.hasAttacked = false;
  state.currentPlayerIndex = playerId;
  startFounding(state, founder.id);
  advanceOneRound(state);
  return site;
}

// ── Base income ──
console.log('\n=== Base income (§12) ===');
{
  const state = createGameState();
  const p0 = state.players[0]!;
  const before = p0.aura;
  endTurn(state); // p0's turn ends; p1 starts (no income change for p0 yet)
  endTurn(state); // p1's turn ends; p0 starts -> gains income
  check('base income granted every round regardless of structures', p0.aura === before + BASE_INCOME_PER_ROUND, `aura ${before}->${p0.aura}`);
}

// ── Agrar Farms ──
console.log('\n=== Agrar Farms (§13-14) ===');
{
  const state = setup();
  centerAndClearSite(state, 0);
  const city = foundSite(state, 0, 0);
  check('founding produces a City for Agrar', city.state === 'city', `got ${city.state}`);
  const player = state.players[0]!;
  check('flat income with no Farms yet', getPlayerIncome(state, 0) === BASE_INCOME_PER_ROUND, `income=${getPlayerIncome(state, 0)}`);

  const hexes = getValidFarmHexes(state, city.id);
  check('valid farm hexes exist', hexes.length > 0);
  check('valid farm hexes are exactly FARM_DISTANCE_FROM_CITY away, never adjacent', hexes.every(h => hexDistance(h, city.pos) === FARM_DISTANCE_FROM_CITY));

  const auraBefore = player.aura;
  state.currentPlayerIndex = 0;
  const hex = hexes[0]!;
  const built = buildFarm(state, city.id, hex);
  check('buildFarm succeeds at a valid hex', built);
  check('buildFarm charges AGRAR_FARM_COST', player.aura === auraBefore - AGRAR_FARM_COST, `aura=${player.aura}`);
  check('income increases by AGRAR_FARM_INCOME per Farm', getPlayerIncome(state, 0) === BASE_INCOME_PER_ROUND + AGRAR_FARM_INCOME, `income=${getPlayerIncome(state, 0)}`);
  check('getCityFarms reflects the new Farm', getCityFarms(state, city.id).length === 1);

  // Fill the remaining slot(s), then verify the slot cap.
  for (let i = 1; i < FARM_SLOTS_PER_CITY; i++) {
    const h = getValidFarmHexes(state, city.id).find(x => canBuildFarm(state, city.id, x))!;
    buildFarm(state, city.id, h);
  }
  check(`City caps at FARM_SLOTS_PER_CITY (${FARM_SLOTS_PER_CITY}) Farms`, getCityFarms(state, city.id).length === FARM_SLOTS_PER_CITY);
  const overCapHex = getValidFarmHexes(state, city.id).find(x => !state.farms.some(f => hexDistance(f.pos, x) === 0));
  check('cannot build a Farm past the slot cap', overCapHex ? !canBuildFarm(state, city.id, overCapHex) : true);
  check('income at full Farm development', getPlayerIncome(state, 0) === BASE_INCOME_PER_ROUND + FARM_SLOTS_PER_CITY * AGRAR_FARM_INCOME, `income=${getPlayerIncome(state, 0)}`);
}
{
  // Insufficient aura blocks the build.
  const state = setup();
  centerAndClearSite(state, 0);
  const city = foundSite(state, 0, 0);
  state.players[0]!.aura = AGRAR_FARM_COST - 1;
  state.currentPlayerIndex = 0;
  const hex = getValidFarmHexes(state, city.id)[0]!;
  check('cannot build a Farm without enough aura', !canBuildFarm(state, city.id, hex));
}
{
  // A Farm is a real, independently-attackable structure.
  const state = setup();
  centerAndClearSite(state, 0);
  const city = foundSite(state, 0, 0);
  state.currentPlayerIndex = 0;
  const hex = getValidFarmHexes(state, city.id)[0]!;
  buildFarm(state, city.id, hex);
  const farm = state.farms.find(f => hexDistance(f.pos, hex) === 0)!;

  const attacker = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  attacker.pos = { ...hexNeighbors(farm.pos)[0]! };
  attacker.hasMoved = false; attacker.hasAttacked = false;
  state.currentPlayerIndex = 1;
  selectUnit(state, attacker.id);
  const ref = getStructureAt(state, farm.pos);
  check('Farm is independently targetable via getStructureAt', ref?.kind === 'farm');
  const beforeHp = farm.hp;
  const result = attackStructure(state, farm.pos);
  check('Farm can be attacked and damaged', !!result && farm.hp < beforeHp, `hp ${beforeHp}->${farm.hp}`);
  check('City itself is untouched by a Farm attack', city.hp === city.maxHp, `city hp=${city.hp}/${city.maxHp}`);
  check('destroying a Farm does not end the game', state.phase === 'playing');
}

// ── Temple Devotion ──
console.log('\n=== Temple Devotion (§15-16) ===');
{
  const state = setup();
  const temple = foundSite(state, 1, 0);
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
{
  const state = setup();
  const temple = foundSite(state, 1, 0);
  state.players[1]!.aura = TEMPLE_DEVOTION_COST - 1;
  state.currentPlayerIndex = 1;
  check('cannot buy Devotion without enough aura', !canBuyDevotion(state, temple.id));
}

// ── Equal development (§76) ──
console.log('\n=== Equal development invariant (§76) ===');
{
  const stateA = setup();
  centerAndClearSite(stateA, 0);
  const city = foundSite(stateA, 0, 0);
  stateA.players[0]!.aura = 100;
  stateA.currentPlayerIndex = 0;
  for (let i = 0; i < FARM_SLOTS_PER_CITY; i++) {
    const h = getValidFarmHexes(stateA, city.id).find(x => canBuildFarm(stateA, city.id, x))!;
    buildFarm(stateA, city.id, h);
  }
  const agrarIncome = getPlayerIncome(stateA, 0);

  const stateT = setup();
  const temple = foundSite(stateT, 1, 0);
  stateT.players[1]!.aura = 100;
  stateT.currentPlayerIndex = 1;
  for (let i = 0; i < TEMPLE_DEVOTION_MAX_LEVEL; i++) buyDevotion(stateT, temple.id);
  const templeIncome = getPlayerIncome(stateT, 1);

  check('a fully-developed City and a fully-developed Temple yield equal income', agrarIncome === templeIncome, `agrar=${agrarIncome} temple=${templeIncome}`);
}

// ── Investment persistence across Ruins (§17-18) ──
console.log('\n=== Investment persistence (§17-18) ===');
{
  // Conquest does not transfer investment: the ORIGINAL owner invests, then a
  // DIFFERENT player founds the same (ruined) site -> investment wiped.
  const state = setup();
  centerAndClearSite(state, 0);
  const city = foundSite(state, 0, 0);
  state.currentPlayerIndex = 0;
  const hex = getValidFarmHexes(state, city.id)[0]!;
  buildFarm(state, city.id, hex);
  check('setup: P0 has invested a Farm', getCityFarms(state, city.id).length === 1);

  // Destroy the City down to Ruins.
  city.hp = 1;
  const attacker = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  attacker.pos = { ...hexNeighbors(city.pos)[0]! };
  attacker.hasMoved = false; attacker.hasAttacked = false;
  state.currentPlayerIndex = 1;
  selectUnit(state, attacker.id);
  attackStructure(state, city.pos);
  check('City reduced to Ruins', city.state === 'ruins', `got ${city.state}`);
  check('Farm survives the City becoming Ruins (still on the map)', getCityFarms(state, city.id).length === 1);
  check('investmentOwnerId is retained through Ruins', city.investmentOwnerId === 0);
  attacker.pos = { q: attacker.pos.q + 20, r: attacker.pos.r + 20 }; // clear the site

  // A DIFFERENT player (P1, Temple) re-founds the ruined site. The original
  // (P0) founder is still standing on the site from foundSite() — move it off
  // first, since a hostile unit occupying the site blocks founding.
  const founder0Old = founderOf(state, 0);
  founder0Old.pos = { q: founder0Old.pos.q - 20, r: founder0Old.pos.r - 20 };
  const founder1 = founderOf(state, 1);
  founder1.pos = { ...city.pos };
  founder1.hasMoved = false; founder1.hasAttacked = false;
  state.currentPlayerIndex = 1;
  startFounding(state, founder1.id);
  advanceOneRound(state);
  check('foreign re-founding converts the site to the new founder\'s target', city.state === 'temple', `got ${city.state}`);
  check('foreign re-founding wipes the old owner\'s Farms', state.farms.filter(f => f.citySiteId === city.id).length === 0);
  check('foreign re-founding resets devotionLevel to 0', city.devotionLevel === 0);
  check('investmentOwnerId now belongs to the new founder', city.investmentOwnerId === 1);
}
{
  // Recapture (SAME investing player re-founds their own former site) restores it.
  const state = setup();
  centerAndClearSite(state, 0);
  const city = foundSite(state, 0, 0);
  state.currentPlayerIndex = 0;
  const hex = getValidFarmHexes(state, city.id)[0]!;
  buildFarm(state, city.id, hex);

  city.hp = 1;
  const attacker = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  attacker.pos = { ...hexNeighbors(city.pos)[0]! };
  attacker.hasMoved = false; attacker.hasAttacked = false;
  state.currentPlayerIndex = 1;
  selectUnit(state, attacker.id);
  attackStructure(state, city.pos);
  check('City reduced to Ruins', city.state === 'ruins');
  attacker.pos = { q: attacker.pos.q + 20, r: attacker.pos.r + 20 }; // clear the site

  // The SAME player (P0) re-founds it. Its founder is still standing on the
  // site from foundSite() — reset its activation and found again.
  const founder0 = founderOf(state, 0);
  founder0.pos = { ...city.pos };
  founder0.hasMoved = false; founder0.hasAttacked = false;
  state.currentPlayerIndex = 0;
  startFounding(state, founder0.id);
  advanceOneRound(state);
  check('recapture by the SAME investing player restores the site', city.state === 'city', `got ${city.state}`);
  check('recapture restores the Farm investment', getCityFarms(state, city.id).length === 1);
  check('income reflects the restored Farm', getPlayerIncome(state, 0) === BASE_INCOME_PER_ROUND + AGRAR_FARM_INCOME, `income=${getPlayerIncome(state, 0)}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
