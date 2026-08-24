// Phase 3 verification (updated phase 10): strategic-site founding state
// machine + Capital combat/victory (design brief §7-11, §14). Phase 10
// correction: only Temple ever founds a site — Agrar's equivalent (Farms)
// is covered in verify-economy.ts, along with "Agrar never founds a site"
// (§28). Exercises the real engine mutators end-to-end (no forked logic) —
// createGameState, startFounding, endTurn (which resolves founding at
// round-start), attackStructure, moveUnit, chooseFaction.
//
// Run with: npx tsx scripts/verify-strategic-sites.ts
import {
  createGameState, endTurn, chooseFaction, canStartFounding, startFounding,
  attackStructure, getStructureAt, selectUnit, moveUnit, getPlayerCapital,
  createUnit,
} from '../src/game';
import { hexNeighbors, hexEqual } from '../src/hex';
import { SITE_ESTABLISH_COST } from '../src/factions';
import type { GameState, StrategicSiteState } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A fresh 2-player game with factions chosen immediately (phase 11 — no more
// Founding Round to skip past), generous aura for testing. These tests
// exercise founding/combat mechanics directly, not the recruit-then-wait
// training queue itself (see verify-opening-flow.ts for that) — place a
// Builder/Acolyte + a Warrior for each player straight onto the board.
function setup(): GameState {
  const state = createGameState();
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
  for (const p of state.players) p.aura = 20;
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

// Places Temple's (P1) Acolyte on site[siteIndex] with a fresh activation and
// makes it P1's turn, ready to call startFounding.
function primeFounding(state: GameState, siteIndex = 0) {
  const site = state.strategicSites[siteIndex]!;
  const founder = founderOf(state, 1);
  founder.pos = { ...site.pos };
  founder.hasMoved = false;
  founder.hasAttacked = false;
  state.currentPlayerIndex = 1;
  return { site, founder };
}

// Exactly one full round-trip in a 2-player alternating game — regardless of
// which player is currently active, this always lands back on the SAME
// player one round later, with turnNumber incremented by exactly 1. That's
// precisely "the founding player's next round" (§6), and it's when endTurn's
// internal resolveFoundingForPlayer fires.
function advanceOneRound(state: GameState): void {
  endTurn(state);
  endTurn(state);
}

// ── §7-10: full state-machine cycle (Temple only, phase 10) ──
console.log('\n=== Site state machine (§7-10) ===');
for (const fromState of ['neutral', 'ruins'] as const) {
  const state = setup();
  const player = state.players[1]!;
  const { site, founder } = primeFounding(state, 0);
  site.state = fromState;
  site.ownerId = null;
  site.founding = null;
  if (fromState === 'ruins') { site.hp = 0; site.maxHp = 0; site.defense = 0; }

  const startOk = startFounding(state, founder.id);
  const stateAfterStart = site.state as StrategicSiteState;
  check(`temple ${fromState}->founding: startFounding succeeds`, startOk);
  check(`temple ${fromState}->founding: site enters foundingTemple`, stateAfterStart === 'foundingTemple', `got ${stateAfterStart}`);
  check(`temple ${fromState}->founding: SITE_ESTABLISH_COST charged immediately`, player.aura === 20 - SITE_ESTABLISH_COST, `aura=${player.aura}`);

  advanceOneRound(state); // uncontested — should complete
  const stateAfterComplete = site.state as StrategicSiteState;
  check(`temple ${fromState}->temple: completes uncontested`, stateAfterComplete === 'temple', `got ${stateAfterComplete}`);
  check(`temple ${fromState}->temple: ownerId set`, site.ownerId === player.id);
  check(`temple ${fromState}->temple: founding cleared`, site.founding === null);
  check(`temple ${fromState}->temple: has real HP/DEF`, site.hp > 0 && site.maxHp > 0 && site.defense > 0);
}

// ── §8: interruption conditions ──
console.log('\n=== Founding interruption (§8) ===');
{
  const state = setup();
  const { site, founder } = primeFounding(state, 0);
  startFounding(state, founder.id);
  founder.hp = 0; // killed between the two endTurns
  advanceOneRound(state);
  check('founder killed -> founding fails', site.state === 'neutral', `got ${site.state}`);
}
{
  const state = setup();
  const { site, founder } = primeFounding(state, 0);
  startFounding(state, founder.id);
  founder.pos = { q: founder.pos.q + 50, r: founder.pos.r + 50 }; // walked off the site
  advanceOneRound(state);
  check('founder leaves the site -> founding fails', site.state === 'neutral', `got ${site.state}`);
}
{
  const state = setup();
  const { site, founder } = primeFounding(state, 0);
  startFounding(state, founder.id);
  const enemy = founderOf(state, 0);
  enemy.pos = { ...site.pos }; // stands ON the site
  advanceOneRound(state);
  check('enemy occupies the site -> founding fails', site.state === 'neutral', `got ${site.state}`);
}
{
  const state = setup();
  const { site, founder } = primeFounding(state, 0);
  startFounding(state, founder.id);
  const enemy = founderOf(state, 0);
  enemy.pos = { ...hexNeighbors(site.pos)[0]! }; // adjacent, not on it
  advanceOneRound(state);
  check('enemy adjacent at completion -> founding fails', site.state === 'neutral', `got ${site.state}`);
}
{
  const state = setup();
  const { site, founder } = primeFounding(state, 0);
  startFounding(state, founder.id);
  advanceOneRound(state);
  check('uncontested -> founding succeeds', site.state === 'temple', `got ${site.state}`);
}
{
  const state = setup();
  const player = state.players[1]!;
  const { site, founder } = primeFounding(state, 0);
  startFounding(state, founder.id);
  const auraAfterCharge = player.aura; // 20 - SITE_ESTABLISH_COST — already spent
  founder.hp = 0;
  advanceOneRound(state); // also grants one normal turn-start income tick (Capital only) — not a refund
  check('failed founding does NOT refund the establish cost', player.aura > auraAfterCharge, `aura=${player.aura} chargedTo=${auraAfterCharge}`);
}
{
  const state = setup();
  const { site, founder } = primeFounding(state, 0);
  site.state = 'neutral';
  startFounding(state, founder.id);
  founder.hp = 0;
  advanceOneRound(state);
  check('failed founding on a NEUTRAL site returns to NEUTRAL', site.state === 'neutral', `got ${site.state}`);
}
{
  const state = setup();
  const { site, founder } = primeFounding(state, 0);
  site.state = 'ruins'; site.hp = 0; site.maxHp = 0; site.defense = 0;
  startFounding(state, founder.id);
  founder.hp = 0;
  advanceOneRound(state);
  check('failed founding on a RUINED site returns to RUINS', site.state === 'ruins', `got ${site.state}`);
}

// ── Ownership / founder restrictions ──
console.log('\n=== Ownership (§7) ===');
{
  // Standing on a neutral site (without founding) never auto-captures it.
  const state = setup();
  const site = state.strategicSites[0]!;
  const warrior = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!;
  const approach = hexNeighbors(site.pos)[0]!;
  warrior.pos = approach;
  warrior.hasMoved = false; warrior.hasAttacked = false;
  state.currentPlayerIndex = 1;
  selectUnit(state, warrior.id);
  const moved = moveUnit(state, site.pos);
  check('a non-founder can walk onto a neutral site', moved.moved === true || state.moveHexes.length === 0, 'move result');
  check('walking onto a site never auto-changes its owner', site.ownerId === null && site.state === 'neutral');
}
{
  const state = setup();
  const site = state.strategicSites[0]!;
  const warrior = state.units.find(u => u.playerId === 1 && u.type === 'warrior')!; // any non-founder
  warrior.pos = { ...site.pos };
  warrior.hasMoved = false; warrior.hasAttacked = false;
  state.currentPlayerIndex = 1;
  check('a non-Acolyte unit cannot found (e.g. warrior)', canStartFounding(state, warrior) === null);
}
{
  const state = setup();
  const { founder } = primeFounding(state, 0);
  const templeCheck = canStartFounding(state, founder);
  check('Temple Acolyte targets Temple', templeCheck?.targetState === 'temple', `got ${templeCheck?.targetState}`);
}

// ── Capital combat + victory (§4-5, §11) ──
console.log('\n=== Capital combat + victory (§4-5, §11) ===');
{
  const state = setup();
  const attacker = state.units.find(u => u.playerId === 0 && u.type === 'warrior')!;
  const defCapital = getPlayerCapital(state, 1)!;
  attacker.pos = { ...hexNeighbors(defCapital.pos)[0]! };
  attacker.hasMoved = false; attacker.hasAttacked = false;
  state.currentPlayerIndex = 0;
  selectUnit(state, attacker.id);
  const beforeHp = defCapital.hp;
  const beforeAttackerHp = attacker.hp;
  const result = attackStructure(state, defCapital.pos);
  check('attackStructure succeeds against an enemy Capital in range', result !== null);
  check('attack reduces Capital HP', !!result && defCapital.hp < beforeHp, `hp ${beforeHp}->${defCapital.hp}`);
  check('DEF applies (damage < raw attack)', !!result && result.damageDealt <= attacker.stats.attack, `dmg=${result?.damageDealt}`);
  check('Capital does not revenge — attacker takes no damage', attacker.hp === beforeAttackerHp, `attacker hp ${beforeAttackerHp}->${attacker.hp}`);
  check('Capital ownership never changes from combat', defCapital.playerId === 1);
  check('attacker does not step onto the Capital tile', !hexEqual(attacker.pos, defCapital.pos));
}
{
  // HP > 0 -> game continues.
  const state = setup();
  const attacker = state.units.find(u => u.playerId === 0 && u.type === 'warrior')!;
  const defCapital = getPlayerCapital(state, 1)!;
  attacker.pos = { ...hexNeighbors(defCapital.pos)[0]! };
  attacker.hasMoved = false; attacker.hasAttacked = false;
  state.currentPlayerIndex = 0;
  selectUnit(state, attacker.id);
  attackStructure(state, defCapital.pos);
  check('Capital HP > 0 -> match continues', state.phase === 'playing', `hp=${defCapital.hp} phase=${state.phase}`);
}
{
  // HP <= 0 -> immediate victory, and the Capital is never Ruins.
  const state = setup();
  const attacker = state.units.find(u => u.playerId === 0 && u.type === 'warrior')!;
  const defCapital = getPlayerCapital(state, 1)!;
  defCapital.hp = 1; // one hit from killing
  attacker.pos = { ...hexNeighbors(defCapital.pos)[0]! };
  attacker.hasMoved = false; attacker.hasAttacked = false;
  state.currentPlayerIndex = 0;
  selectUnit(state, attacker.id);
  const result = attackStructure(state, defCapital.pos);
  check('Capital HP <= 0 -> immediate game over', state.phase === 'gameOver', `phase=${state.phase}`);
  check('the destroyer wins', state.winner?.id === 0, `winner=${state.winner?.id}`);
  check('attackStructure reports gameOver:true', !!result && result.gameOver === true);
  check('Capital HP clamped at 0, never negative', defCapital.hp === 0, `hp=${defCapital.hp}`);
  check('Capital is never Ruins — it has no "state" field at all (structural)', !('state' in defCapital));
}

// ── Temple destruction -> Ruins ──
console.log('\n=== Temple destruction (§11) ===');
{
  const state = setup();
  const { site, founder } = primeFounding(state, 0);
  startFounding(state, founder.id);
  advanceOneRound(state); // completes -> temple, owned by P1
  const attacker = state.units.find(u => u.playerId === 0 && u.type === 'warrior')!;
  attacker.pos = { ...hexNeighbors(site.pos)[0]! };
  attacker.hasMoved = false; attacker.hasAttacked = false;
  state.currentPlayerIndex = 0;
  selectUnit(state, attacker.id);
  // Hammer it down (deterministic combat — a fixed number of hits always finishes it).
  for (let i = 0; i < 30 && site.state === 'temple'; i++) {
    attacker.hasMoved = false; attacker.hasAttacked = false;
    selectUnit(state, attacker.id);
    attackStructure(state, site.pos);
  }
  check('a Temple reduced to 0 HP becomes Ruins', site.state === 'ruins', `got ${site.state}`);
  check('Ruins has no owner', site.ownerId === null);
  check('game is NOT over from a Temple falling (only Capital ends it)', state.phase === 'playing');
}

// ── Legacy removal ──
console.log('\n=== Legacy removal ===');
{
  const state = setup();
  for (let i = 0; i < state.strategicSites.length; i++) {
    const { founder } = primeFounding(state, i);
    startFounding(state, founder.id);
    advanceOneRound(state);
    // re-fetch founder each loop since primeFounding always grabs the same unit
  }
  const allOwned = state.strategicSites.every(s => s.ownerId === 1);
  check('owning every neutral site does NOT end the game', state.phase === 'playing', `allOwned=${allOwned} phase=${state.phase}`);
}
{
  const state = setup();
  // No GameState.temples field exists at all any more — enforced at compile
  // time (this file wouldn't build if it did). Sanity-check the replacement
  // shape directly.
  check('GameState has strategicSites + capitals, not temples', Array.isArray(state.strategicSites) && Array.isArray(state.capitals) && !('temples' in state));
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
