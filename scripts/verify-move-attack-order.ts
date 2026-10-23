// Move/attack order agnosticism: a unit gets exactly one move and one attack
// per round, but the ORDER between them is free — move-then-attack and
// attack-then-move must both work identically. Previously attacking
// unconditionally spent the move too (attacker.hasMoved = true), so only
// move-then-attack (or attack-only) was ever possible; attack-then-move was
// silently blocked. Exercises the real engine mutators end-to-end (no forked
// logic) — createGameState, selectUnit, moveUnit, attackUnit,
// attackStructure.
//
// Run with: npx tsx scripts/verify-move-attack-order.ts
import {
  createGameState, chooseFaction, createUnit, selectUnit, moveUnit,
  attackUnit, attackStructure, getPlayerCapital, updateVisibility,
} from '../src/game';
import { hexDistance, hexNeighbors } from '../src/hex';
import type { GameState, HexCoord, Unit } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Capitals sit out near the map's edge, so a fixed "+N on q" offset can walk
// clean off the board depending on which side a given match randomly placed
// them on — always step toward the board's center instead.
function neighborTowardCenter(pos: HexCoord): HexCoord {
  return hexNeighbors(pos).reduce((best, h) =>
    hexDistance({ q: 0, r: 0 }, h) < hexDistance({ q: 0, r: 0 }, best) ? h : best);
}

// Two full-HP Warriors, adjacent to each other, on open ground with room to
// step into on either side — nothing else (ZOC, terrain, occupancy) should
// interfere with either combat order.
function setup(): { state: GameState; attacker: Unit; defender: Unit } {
  const state = createGameState();
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
  for (const p of state.players) p.aura = 20;
  const cap = getPlayerCapital(state, 0)!;
  const attackerPos = neighborTowardCenter(cap.pos);
  const defenderPos = neighborTowardCenter(attackerPos);
  const attacker = createUnit('warrior', 0, attackerPos, state.playerTech[0], 'agrar');
  const defender = createUnit('warrior', 1, defenderPos, state.playerTech[1], 'temple');
  state.units.push(attacker, defender);
  updateVisibility(state, 0);
  updateVisibility(state, 1);
  state.currentPlayerIndex = 0;
  return { state, attacker, defender };
}

console.log("=== Setup sanity: attacker and defender are adjacent (range-1 warriors) ===");
{
  const { attacker, defender } = setup();
  check('attacker and defender are exactly 1 hex apart', hexDistance(attacker.pos, defender.pos) === 1);
}

console.log("\n=== Attack then move (previously impossible — attacking used to spend the move too) ===");
{
  const { state, attacker, defender } = setup();
  defender.hp = defender.stats.maxHp; // survives the hit, no follow-through repositioning
  selectUnit(state, attacker.id);
  const before = { q: attacker.pos.q, r: attacker.pos.r };
  const result = attackUnit(state, defender.pos);
  check('the attack landed', !!result);
  check('the attacker did not reposition (defender survived, no follow-through)', attacker.pos.q === before.q && attacker.pos.r === before.r);
  check('hasAttacked is now true', attacker.hasAttacked === true);
  check('hasMoved is still false — the move was NOT spent by attacking', attacker.hasMoved === false, `hasMoved=${attacker.hasMoved}`);

  selectUnit(state, attacker.id);
  check('a move is still offered after attacking', state.moveHexes.length > 0, `moveHexes.length=${state.moveHexes.length}`);
  const dest = state.moveHexes[0]!;
  const moveResult = moveUnit(state, dest);
  check('the unit can actually move after attacking', moveResult.moved === true);
  check('hasMoved is now true after moving', attacker.hasMoved === true);

  // Only one attack and one move are ever allowed, regardless of order.
  selectUnit(state, attacker.id);
  check('no further move is offered once both are spent', state.moveHexes.length === 0);
  check('no further attack is offered once already attacked', state.attackHexes.length === 0);
}

console.log("\n=== Move then attack (already worked — must keep working) ===");
{
  const { state, attacker, defender } = setup();
  defender.hp = defender.stats.maxHp;
  selectUnit(state, attacker.id);
  const dest = state.moveHexes.find(h => hexDistance(h, defender.pos) === 1);
  check('setup: found a move destination that stays adjacent to the defender', !!dest);
  const moveResult = moveUnit(state, dest!);
  check('the move landed', moveResult.moved === true);
  check('hasMoved is now true, hasAttacked still false', attacker.hasMoved === true && attacker.hasAttacked === false);

  selectUnit(state, attacker.id);
  check('an attack is still offered after moving', state.attackHexes.length > 0);
  const result = attackUnit(state, defender.pos);
  check('the attack landed after moving', !!result);
  check('hasAttacked is now true', attacker.hasAttacked === true);
}

console.log("\n=== A melee kill's follow-through repositioning DOES spend the move (it's a real move) ===");
{
  const { state, attacker, defender } = setup();
  defender.hp = 1; // guaranteed kill
  selectUnit(state, attacker.id);
  const result = attackUnit(state, defender.pos);
  check('the attack killed the defender', !!result && result.targetKilled === true);
  check('the attacker followed through onto the killed unit\'s tile', attacker.pos.q === defender.pos.q && attacker.pos.r === defender.pos.r);
  check('hasMoved is true — the follow-through repositioning spent the move', attacker.hasMoved === true);
  selectUnit(state, attacker.id);
  check('no further move is offered — the follow-through already spent it', state.moveHexes.length === 0);
}

console.log("\n=== Attacking a structure never repositions the attacker — the move stays available ===");
{
  const { state, attacker } = setup();
  const enemyCap = getPlayerCapital(state, 1)!;
  attacker.pos = neighborTowardCenter(enemyCap.pos);
  updateVisibility(state, 0);
  selectUnit(state, attacker.id);
  check('setup: the enemy Capital is offered as an attack target', state.structureAttackHexes.some(h => hexDistance(h, enemyCap.pos) === 0));
  const before = { ...attacker.pos };
  const result = attackStructure(state, enemyCap.pos);
  check('the structure attack landed', !!result);
  check('the attacker never moves when striking a structure', attacker.pos.q === before.q && attacker.pos.r === before.r);
  check('hasMoved is still false after attacking a structure', attacker.hasMoved === false);

  selectUnit(state, attacker.id);
  check('a move is still offered after attacking a structure', state.moveHexes.length > 0);
  const moveResult = moveUnit(state, state.moveHexes[0]!);
  check('the unit can move after attacking a structure', moveResult.moved === true);
}

if (failures > 0) {
  console.log(`\nFAIL: ${failures} failing check(s)`);
  process.exit(1);
} else {
  console.log('\nPASS: 0 failing check(s)');
}
