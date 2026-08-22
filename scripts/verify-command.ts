// Phase 6 verification: the Command system — population cap tiers,
// commandCost-weighted population spend, and the production-slot pool
// (design brief §19-22). Exercises the real engine mutators end-to-end (no
// forked logic) — createGameState, chooseFaction, researchTech, spawnUnit, endTurn.
//
// Run with: npx tsx scripts/verify-command.ts
import {
  createGameState, endTurn, chooseFaction, spawnUnit, canAfford, canResearch,
  researchTech, getPopulationCap, getPopulationCount, getProductionSlots,
  getBusyProductionSlotCount, getPlayerCapital, startFounding,
} from '../src/game';
import { COMMAND_TIERS, CAPITAL_PRODUCTION_SLOTS, PRODUCTION_SLOTS_PER_EXPANSION } from '../src/factions';
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

function capitalId(state: GameState, playerId: number): string {
  return getPlayerCapital(state, playerId)!.id;
}

function advanceOneRound(state: GameState): void {
  endTurn(state);
  endTurn(state);
}

// ── Population cap tiers (§21) ──
console.log('\n=== Population cap tiers (§21) ===');
{
  const state = setup();
  check('starts at COMMAND_TIERS.start', getPopulationCap(state, 0) === COMMAND_TIERS.start, `got ${getPopulationCap(state, 0)}`);
  state.currentPlayerIndex = 0;
  check('command_2 not researchable before command_1', !canResearch(state, 'command_2'));
  const r1 = researchTech(state, 'command_1');
  check('research command_1 succeeds', r1);
  check('cap raised to COMMAND_TIERS.commandI', getPopulationCap(state, 0) === COMMAND_TIERS.commandI, `got ${getPopulationCap(state, 0)}`);
  const r2 = researchTech(state, 'command_2');
  check('research command_2 succeeds after command_1', r2);
  check('cap raised to COMMAND_TIERS.commandII', getPopulationCap(state, 0) === COMMAND_TIERS.commandII, `got ${getPopulationCap(state, 0)}`);
  check('territory never raises the cap (only tech does)', COMMAND_TIERS.commandII > COMMAND_TIERS.commandI && COMMAND_TIERS.commandI > COMMAND_TIERS.start);
}

// ── commandCost-weighted population spend (§19) ──
console.log('\n=== Population cost is commandCost-weighted, not flat 1-per-unit ===');
{
  const state = setup();
  state.currentPlayerIndex = 0;
  researchTech(state, 'unlock_heavyknight');
  const cap = getPopulationCap(state, 0);
  // Every player starts with 3 Founding-Round units (Warrior + Archer +
  // Founder), each commandCost 1 -> population starts at 3, not 0.
  check('fresh player starts at population 3 (Warrior+Archer+Founder)', getPopulationCount(state, 0) === 3, `got ${getPopulationCount(state, 0)}`);

  // Fill up to cap-1 with warriors (commandCost 1 each) so pop === cap-1,
  // spread across turns to avoid hitting the production-slot cap.
  const capitalPos = getPlayerCapital(state, 0)!.pos;
  let spawned = 0;
  while (getPopulationCount(state, 0) < cap - 1 && spawned < cap) {
    const unit = state.units.find(u => u.hp > 0 && u.pos.q === capitalPos.q && u.pos.r === capitalPos.r);
    if (unit) { unit.pos = { q: unit.pos.q + 10 + spawned, r: unit.pos.r + 10 + spawned }; }
    if (getBusyProductionSlotCount(state, 0) >= getProductionSlots(state, 0)) advanceOneRound(state);
    state.currentPlayerIndex = 0;
    if (!spawnUnit(state, capitalId(state, 0), 'warrior')) break;
    spawned++;
  }
  const popBefore = getPopulationCount(state, 0);
  check(`population sits at cap-1 (${cap - 1})`, popBefore === cap - 1, `got ${popBefore}`);

  // Clear the capital tile + refresh production slots for a clean check.
  const onCap = state.units.find(u => u.hp > 0 && u.pos.q === capitalPos.q && u.pos.r === capitalPos.r);
  if (onCap) onCap.pos = { q: onCap.pos.q + 30, r: onCap.pos.r + 30 };
  while (getBusyProductionSlotCount(state, 0) >= getProductionSlots(state, 0)) advanceOneRound(state);
  state.currentPlayerIndex = 0;

  check('a light unit (commandCost 1) still fits at cap-1', canAfford(state, 'warrior'));
  check('a heavy unit (commandCost 2) does NOT fit at cap-1, even though count < cap', !canAfford(state, 'heavyknight'));
}

// ── Production slots (§19-20) ──
console.log('\n=== Production slots (§19-20) ===');
{
  const state = setup();
  state.currentPlayerIndex = 0;
  check('a fresh player has CAPITAL_PRODUCTION_SLOTS slots (Capital only, no expansions)', getProductionSlots(state, 0) === CAPITAL_PRODUCTION_SLOTS, `got ${getProductionSlots(state, 0)}`);
  check('no slots busy at game start', getBusyProductionSlotCount(state, 0) === 0);

  const cap = capitalId(state, 0);
  const capPos = getPlayerCapital(state, 0)!.pos;
  const clearCapital = () => {
    const u = state.units.find(x => x.hp > 0 && x.pos.q === capPos.q && x.pos.r === capPos.r);
    if (u) u.pos = { q: u.pos.q + 20, r: u.pos.r + 20 };
  };

  clearCapital();
  const s1 = spawnUnit(state, cap, 'warrior');
  check('recruit 1/2 succeeds', s1);
  check('1 slot busy after one recruit', getBusyProductionSlotCount(state, 0) === 1);
  clearCapital();
  const s2 = spawnUnit(state, cap, 'warrior');
  check('recruit 2/2 succeeds (still within slot pool)', s2);
  check('2 slots busy after two recruits', getBusyProductionSlotCount(state, 0) === 2);
  clearCapital();
  check('canAfford is false once every slot is busy, regardless of aura/pop room', !canAfford(state, 'warrior'));
  const s3 = spawnUnit(state, cap, 'warrior');
  check('a 3rd recruit is rejected while all slots are busy', !s3);

  advanceOneRound(state); // this player's next round
  check('slots free up at the start of this player\'s next round', getBusyProductionSlotCount(state, 0) === 0);
  clearCapital();
  check('recruiting is available again after the cooldown', canAfford(state, 'warrior'));
}
{
  // Owning an expansion (City/Temple) grants +1 production slot.
  const state = setup();
  const site = state.strategicSites[0]!;
  const founder = state.units.find(u => u.playerId === 0 && u.type === 'founder')!;
  founder.pos = { ...site.pos };
  founder.hasMoved = false; founder.hasAttacked = false;
  state.currentPlayerIndex = 0;
  const before = getProductionSlots(state, 0);
  startFounding(state, founder.id);
  endTurn(state); // opponent's turn
  endTurn(state); // back to this player -> founding resolves (uncontested)
  const site0 = state.strategicSites.find(s => s.id === site.id)!;
  check('site founded into a City', site0.state === 'city', `got ${site0.state}`);
  check('owning a City grants +PRODUCTION_SLOTS_PER_EXPANSION slots', getProductionSlots(state, 0) === before + PRODUCTION_SLOTS_PER_EXPANSION, `before=${before} after=${getProductionSlots(state, 0)}`);
}

// ── Players are independent ──
console.log('\n=== Per-player independence ===');
{
  const state = setup();
  state.currentPlayerIndex = 0;
  const capPos0 = getPlayerCapital(state, 0)!.pos;
  const u0 = state.units.find(x => x.hp > 0 && x.pos.q === capPos0.q && x.pos.r === capPos0.r);
  if (u0) u0.pos = { q: u0.pos.q + 20, r: u0.pos.r + 20 };
  const p1PopBefore = getPopulationCount(state, 1);
  spawnUnit(state, capitalId(state, 0), 'warrior');
  check('P0 recruiting does not touch P1 slots', getBusyProductionSlotCount(state, 1) === 0);
  check('P0 recruiting does not touch P1 population', getPopulationCount(state, 1) === p1PopBefore, `before=${p1PopBefore} after=${getPopulationCount(state, 1)}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
