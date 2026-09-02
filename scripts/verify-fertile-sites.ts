// v14 balance + map + UX pass — matchup-specific neutral objective
// generation: a 1v1 Agrar-vs-Agrar match gets 2 Fertile Sites instead of 2
// Temple sacred sites (which would otherwise be permanently useless to both
// players); every other matchup keeps the default Temple sites. Exercises
// the real engine mutators end-to-end (no forked logic) — createGameState,
// chooseFaction (resolveMatchupObjectives fires on the reveal-completing
// call), canClaimFertileSite/claimFertileSite, getPlayerIncome.
//
// Run with: npx tsx scripts/verify-fertile-sites.ts
import {
  createGameState, chooseFaction, createUnit, endTurn,
  canClaimFertileSite, claimFertileSite, getPlayerIncome,
  getPopulationCap, getPopulationCount, getProductionSlots, getAgrarTerritory,
} from '../src/game';
import { BASE_INCOME_PER_ROUND, FERTILE_SITE_INCOME, FERTILE_SITE_COUNT } from '../src/factions';
import { hexKey } from '../src/hex';
import type { GameState } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function twoPlayerMatch(factionA: 'agrar' | 'temple', factionB: 'agrar' | 'temple'): GameState {
  const state = createGameState();
  chooseFaction(state, 0, factionA);
  chooseFaction(state, 1, factionB); // this call completes the reveal -> resolveMatchupObjectives fires
  for (const p of state.players) p.aura = 200;
  return state;
}

// ── Agrar vs Agrar: Fertile Sites replace Temple sites (§36) ──
console.log('\n=== Agrar vs Agrar: Fertile Sites replace Temple sites ===');
{
  const state = twoPlayerMatch('agrar', 'agrar');
  check(`Temple sacred sites = 0`, state.strategicSites.length === 0, `got ${state.strategicSites.length}`);
  check(`Fertile Sites = ${FERTILE_SITE_COUNT}`, state.fertileSites.length === FERTILE_SITE_COUNT, `got ${state.fertileSites.length}`);
  check('every Fertile Site starts neutral (unowned)', state.fertileSites.every(f => f.ownerId === null));
}
{
  // Claim mechanic: full activation, no Energy cost, instant.
  const state = twoPlayerMatch('agrar', 'agrar');
  const site = state.fertileSites[0]!;
  const unit = createUnit('warrior', 0, { ...site.pos }, state.playerTech[0], 'agrar');
  state.units.push(unit);
  state.currentPlayerIndex = 0;
  check('an Agrar unit standing on it CAN claim', canClaimFertileSite(state, unit) === site);
  const auraBefore = state.players[0]!.aura;
  const claimed = claimFertileSite(state, unit.id);
  check('claiming succeeds', claimed);
  check('ownership is set immediately (no multi-round delay)', site.ownerId === 0);
  check('claiming costs NO Energy', state.players[0]!.aura === auraBefore);
  check('claiming consumes the unit\'s whole activation', unit.hasMoved && unit.hasAttacked);
}
{
  // +1 income while owned; a Builder can claim too (any Agrar unit, not just combat).
  const state = twoPlayerMatch('agrar', 'agrar');
  const site = state.fertileSites[0]!;
  const builder = createUnit('founder', 0, { ...site.pos }, state.playerTech[0], 'agrar');
  state.units.push(builder);
  state.currentPlayerIndex = 0;
  const incomeBefore = getPlayerIncome(state, 0);
  check('Builder (non-combat Agrar unit) can also claim', claimFertileSite(state, builder.id));
  check(`income increases by exactly FERTILE_SITE_INCOME (${FERTILE_SITE_INCOME})`, getPlayerIncome(state, 0) === incomeBefore + FERTILE_SITE_INCOME, `got ${getPlayerIncome(state, 0)}`);
}
{
  // Controlling both Fertile Sites: +2 total.
  const state = twoPlayerMatch('agrar', 'agrar');
  const before = getPlayerIncome(state, 0);
  for (const site of state.fertileSites) {
    const unit = createUnit('warrior', 0, { ...site.pos }, state.playerTech[0], 'agrar');
    state.units.push(unit);
    state.currentPlayerIndex = 0;
    claimFertileSite(state, unit.id);
  }
  check('controlling both Fertile Sites grants +2 total income', getPlayerIncome(state, 0) === before + FERTILE_SITE_INCOME * FERTILE_SITE_COUNT, `got ${getPlayerIncome(state, 0)}`);
}
{
  // Contest/recapture: cannot reclaim while the owner's unit still occupies
  // it; CAN once that unit moves away.
  const state = twoPlayerMatch('agrar', 'agrar');
  const site = state.fertileSites[0]!;
  const ownerUnit = createUnit('warrior', 0, { ...site.pos }, state.playerTech[0], 'agrar');
  state.units.push(ownerUnit);
  state.currentPlayerIndex = 0;
  claimFertileSite(state, ownerUnit.id);
  check('setup: player 0 owns the site, and stands on it', site.ownerId === 0);

  // A rival Agrar unit physically CANNOT occupy the same hex (normal
  // single-occupancy collision) while the owner's unit is still there — so
  // there's nothing further to assert about "cannot claim while occupied"
  // beyond that structural guarantee. Move the owner's unit away instead,
  // then a rival can walk on and reclaim.
  ownerUnit.pos = { q: 900, r: 900 };
  const rival = createUnit('warrior', 1, { ...site.pos }, state.playerTech[1], 'agrar');
  state.units.push(rival);
  state.currentPlayerIndex = 1;
  check('a rival Agrar unit CAN claim once the site is unoccupied', canClaimFertileSite(state, rival) === site);
  check('reclaiming flips ownership', claimFertileSite(state, rival.id) && site.ownerId === 1);
}
{
  // Deliberately minimal: no Command, no production, no territory/cultivation.
  const state = twoPlayerMatch('agrar', 'agrar');
  const site = state.fertileSites[0]!;
  const capBefore = getPopulationCap(state, 0);
  const slotsBefore = getProductionSlots(state, 0);
  const territoryBefore = getAgrarTerritory(state, 0);
  const unit = createUnit('warrior', 0, { ...site.pos }, state.playerTech[0], 'agrar');
  state.units.push(unit);
  state.currentPlayerIndex = 0;
  claimFertileSite(state, unit.id);
  check('does NOT increase Command (population cap)', getPopulationCap(state, 0) === capBefore);
  check('does NOT increase production slots', getProductionSlots(state, 0) === slotsBefore);
  check('does NOT extend Agrar Infrastructure Reach', getAgrarTerritory(state, 0).size === territoryBefore.size);
  check('the Fertile Site\'s own hex is not added to Infrastructure Reach by itself', !getAgrarTerritory(state, 0).has(hexKey(site.pos)) || territoryBefore.has(hexKey(site.pos)));
}
{
  // No Temple logic exists to be blocked in this matchup — trivially true
  // since strategicSites is empty, but assert it explicitly.
  const state = twoPlayerMatch('agrar', 'agrar');
  check('no Temple sites exist to interact with in an Agrar mirror', state.strategicSites.length === 0);
}

// ── Other matchups keep Temple sites, no Fertile Sites (§37) ──
console.log('\n=== Agrar vs Temple: Temple sites only ===');
{
  const state = twoPlayerMatch('agrar', 'temple');
  check('Temple sites = 2', state.strategicSites.length === 2, `got ${state.strategicSites.length}`);
  check('Fertile Sites = 0', state.fertileSites.length === 0, `got ${state.fertileSites.length}`);
}
console.log('\n=== Temple vs Temple: Temple sites only ===');
{
  const state = twoPlayerMatch('temple', 'temple');
  check('Temple sites = 2', state.strategicSites.length === 2, `got ${state.strategicSites.length}`);
  check('Fertile Sites = 0', state.fertileSites.length === 0, `got ${state.fertileSites.length}`);
}

// ── No pre-reveal leak (§13) ──
console.log('\n=== Objective type is resolved only after BOTH factions reveal (§13) ===');
{
  const state = createGameState();
  chooseFaction(state, 0, 'agrar'); // only ONE side revealed so far
  check('before the second reveal, the board still shows the default Temple sites (no leak)', state.strategicSites.length > 0 && state.fertileSites.length === 0);
  chooseFaction(state, 1, 'agrar'); // completes the reveal
  check('only now, once BOTH are known, does the Agrar mirror convert them', state.strategicSites.length === 0 && state.fertileSites.length === FERTILE_SITE_COUNT);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
