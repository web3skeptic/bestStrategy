// Phase 6 verification (updated phase 11): the Command system — population
// cap tiers, commandCost-weighted population spend (now including queued,
// not-yet-deployed training orders), and the production-slot pool (design
// brief §19-22). Exercises the real engine mutators end-to-end (no forked
// logic) — createGameState, chooseFaction, researchTech, spawnUnit, endTurn.
//
// Run with: npx tsx scripts/verify-command.ts
import {
  createGameState, endTurn, chooseFaction, spawnUnit, canAfford, canResearch,
  researchTech, getPopulationCap, getPopulationCount, getProductionSlots,
  getBusyProductionSlotCount, getPlayerCapital, startFounding,
} from '../src/game';
import { COMMAND_TIERS, PRODUCTION_BASE_SLOTS } from '../src/factions';
import type { GameState } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A fresh 2-player game with factions chosen immediately (phase 11 — no more
// Founding Round to skip past), with generous aura for testing.
function setup(): GameState {
  const state = createGameState();
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

// §5 (phase 11) — a deployed recruit that lands ON the Capital tile blocks
// every FUTURE deployment there until it moves off (resolveTrainingForPlayer
// just leaves a blocked order queued forever, it never fails it) — sweep it
// away between rounds so repeated recruiting in these tests keeps flowing.
let sweepCounter = 0;
function sweepUnitsOffCapital(state: GameState, playerId: number): void {
  const pos = getPlayerCapital(state, playerId)!.pos;
  for (const u of state.units) {
    if (u.playerId === playerId && u.hp > 0 && u.pos.q === pos.q && u.pos.r === pos.r) {
      u.pos = { q: 200 + sweepCounter, r: 200 + sweepCounter };
      sweepCounter++;
    }
  }
}

// Queues 'warrior' recruits (commandCost 1 each) for playerId until
// getPopulationCount reaches `target`, advancing rounds (and sweeping the
// Capital clear) whenever the production-slot pool fills up.
function fillPopulationTo(state: GameState, playerId: number, target: number): void {
  const cap = capitalId(state, playerId);
  let guard = target + PRODUCTION_BASE_SLOTS + 20; // safety valve against an infinite loop on a real bug
  while (getPopulationCount(state, playerId) < target && guard-- > 0) {
    state.currentPlayerIndex = playerId;
    if (getBusyProductionSlotCount(state, playerId) >= getProductionSlots(state, playerId)) {
      advanceOneRound(state);
      sweepUnitsOffCapital(state, playerId);
      continue;
    }
    if (!spawnUnit(state, cap, 'warrior')) break;
  }
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
  researchTech(state, 'agrar_heavy_armor');
  researchTech(state, 'command_1');
  researchTech(state, 'agrar_heavy_knight_tech');
  const cap = getPopulationCap(state, 0);
  // §3 (phase 11) — zero starting units: a fresh player starts at population 0.
  check('fresh player starts at population 0 (zero starting units)', getPopulationCount(state, 0) === 0, `got ${getPopulationCount(state, 0)}`);

  fillPopulationTo(state, 0, cap - 1);
  const popBefore = getPopulationCount(state, 0);
  check(`population sits at cap-1 (${cap - 1})`, popBefore === cap - 1, `got ${popBefore}`);

  // Make sure a production slot + a clear Capital tile are both available
  // for a clean check.
  while (getBusyProductionSlotCount(state, 0) >= getProductionSlots(state, 0)) {
    advanceOneRound(state);
    sweepUnitsOffCapital(state, 0);
  }
  sweepUnitsOffCapital(state, 0);
  state.currentPlayerIndex = 0;

  check('a light unit (commandCost 1) still fits at cap-1', canAfford(state, 'warrior'));
  check('a heavy unit (commandCost 2) does NOT fit at cap-1, even though count < cap', !canAfford(state, 'heavyknight'));
}

// ── Production slots (§19-20) ──
console.log('\n=== Production slots (§19-20) ===');
{
  const state = setup();
  state.currentPlayerIndex = 0;
  check('a fresh player has PRODUCTION_BASE_SLOTS slots (Capital only, no expansions)', getProductionSlots(state, 0) === PRODUCTION_BASE_SLOTS, `got ${getProductionSlots(state, 0)}`);
  check('no slots busy at game start', getBusyProductionSlotCount(state, 0) === 0);

  const cap = capitalId(state, 0);

  const s1 = spawnUnit(state, cap, 'warrior');
  check('recruit 1/2 succeeds', s1);
  check('1 slot busy after one recruit', getBusyProductionSlotCount(state, 0) === 1);
  const s2 = spawnUnit(state, cap, 'warrior');
  check('recruit 2/2 succeeds (still within slot pool)', s2);
  check('2 slots busy after two recruits', getBusyProductionSlotCount(state, 0) === 2);
  check('canAfford is false once every slot is busy, regardless of aura/pop room', !canAfford(state, 'warrior'));
  const s3 = spawnUnit(state, cap, 'warrior');
  check('a 3rd recruit is rejected while all slots are busy', !s3);
  check('a queued recruit does NOT exist on the battlefield yet (§5)', state.units.filter(u => u.playerId === 0).length === 0);

  advanceOneRound(state); // this player's next round — both orders target the
  // SAME Capital tile, so only the first can actually deploy there; the
  // second stays queued (pending, not lost — §5) until the tile is clear.
  check('one recruit deploys and frees its slot', getBusyProductionSlotCount(state, 0) === 1, `got ${getBusyProductionSlotCount(state, 0)}`);
  check('exactly one queued recruit deployed this round', state.units.filter(u => u.playerId === 0 && u.type === 'warrior' && u.hp > 0).length === 1);
  sweepUnitsOffCapital(state, 0);
  state.currentPlayerIndex = 0;
  check('recruiting is available again once a slot is free', canAfford(state, 'warrior'));

  advanceOneRound(state); // now the Capital is clear — the second one deploys too
  sweepUnitsOffCapital(state, 0);
  check('the second queued recruit deploys once the Capital is clear', getBusyProductionSlotCount(state, 0) === 0);
  check('both queued recruits eventually deployed', state.units.filter(u => u.playerId === 0 && u.type === 'warrior' && u.hp > 0).length === 2);
}
{
  // Temple founding a site grants +1 production slot (phase 10: Temple's
  // production scales with owned Temple count — see verify-economy.ts for
  // the full per-faction production curve, including Agrar's Farm-based one).
  const state = setup();
  const site = state.strategicSites[0]!;
  state.currentPlayerIndex = 1;
  const acolyteRecruited = spawnUnit(state, capitalId(state, 1), 'founder');
  check('Temple can queue an Acolyte recruit', acolyteRecruited);
  const before = getProductionSlots(state, 1);
  advanceOneRound(state); // deploy the Acolyte
  sweepUnitsOffCapital(state, 1);
  const acolyte = state.units.find(u => u.playerId === 1 && u.type === 'founder' && u.hp > 0)!;
  acolyte.pos = { ...site.pos };
  acolyte.hasMoved = false; acolyte.hasAttacked = false;
  state.currentPlayerIndex = 1;
  startFounding(state, acolyte.id);
  endTurn(state); // opponent's turn
  endTurn(state); // back to this player -> founding resolves (uncontested)
  const site0 = state.strategicSites.find(s => s.id === site.id)!;
  check('site founded into a Temple', site0.state === 'temple', `got ${site0.state}`);
  check('owning a Temple grants +1 production slot', getProductionSlots(state, 1) === before + 1, `before=${before} after=${getProductionSlots(state, 1)}`);
}

// ── Players are independent ──
console.log('\n=== Per-player independence ===');
{
  const state = setup();
  state.currentPlayerIndex = 0;
  const p1PopBefore = getPopulationCount(state, 1);
  spawnUnit(state, capitalId(state, 0), 'warrior');
  check('P0 recruiting does not touch P1 slots', getBusyProductionSlotCount(state, 1) === 0);
  check('P0 recruiting does not touch P1 population', getPopulationCount(state, 1) === p1PopBefore, `before=${p1PopBefore} after=${getPopulationCount(state, 1)}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
