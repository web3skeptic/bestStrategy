// AI 2.0 Phase 2 — canonical action representation + safe simulation
// (src/aiSearch.ts) verification. Exercises applyAiAction/simulateAction
// end-to-end against the real engine (createGameState, chooseFaction,
// selectUnit/moveUnit/attackUnit/etc.) — no forked logic, no AI-only
// simplified combat, per §32/§85 of the AI 2.0 brief.
//
// Run with: npx tsx scripts/verify-ai-search.ts
import {
  createGameState, chooseFaction, createUnit, getPlayerCapital, getStructureAt,
  getValidFarmHexes, canStartFarm, getValidRoadHexes, canBuildRoad, getOwnedStructures,
  endTurn,
} from '../src/game';
import { applyAiAction, simulateAction, describeAction, type AiAction } from '../src/aiSearch';
import { hexNeighbors, hexEqual, hexDistance } from '../src/hex';
import type { GameState } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function setup(f0: 'agrar' | 'temple' = 'agrar', f1: 'agrar' | 'temple' = 'temple'): GameState {
  const state = createGameState();
  chooseFaction(state, 0, f0);
  chooseFaction(state, 1, f1);
  for (const p of state.players) p.aura = 200;
  state.currentPlayerIndex = 0;
  return state;
}

// A guaranteed-on-map, guaranteed-passable chain of `len` mutually-adjacent
// hexes starting from `from` — Capital placement is randomized per game
// and can land near the map edge (where a raw hexNeighbors(pos)[0] can
// silently be off-map) AND a Capital's own open-approach guarantee is only
// "most of a wide radius", not "every one of its 6 immediate neighbours",
// so one of those neighbours can legitimately be an impassable mountain.
function onMapChain(state: GameState, from: { q: number; r: number }, len: number): { q: number; r: number }[] {
  const chain = [from];
  while (chain.length < len) {
    const last = chain[chain.length - 1]!;
    const next = hexNeighbors(last).find(h =>
      hexDistance({ q: 0, r: 0 }, h) <= state.mapRadius
      && !state.walls.has(`${h.q},${h.r}`)
      && !chain.some(c => hexEqual(c, h)));
    if (!next) break;
    chain.push(next);
  }
  return chain;
}

console.log('\n=== applyAiAction: move ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const unit = createUnit('warrior', 0, onMapChain(state, cap.pos, 2)[1]!, state.playerTech[0], 'agrar');
  state.units.push(unit);
  const dest = onMapChain(state, unit.pos, 2)[1]!;
  const action: AiAction = { kind: 'move', unitId: unit.id, to: dest };
  check('describeAction produces a readable label', describeAction(action).includes(unit.id));
  const applied = applyAiAction(state, action);
  check('move applies via the real engine (unit actually relocated)', applied && hexEqual(unit.pos, dest));
}

console.log('\n=== applyAiAction: attack ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chainA = onMapChain(state, cap.pos, 3);
  const attacker = createUnit('warrior', 0, chainA[1]!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chainA[2]!, state.playerTech[1], 'temple');
  state.units.push(attacker, target);
  const before = target.hp;
  const applied = applyAiAction(state, { kind: 'attack', unitId: attacker.id, targetPos: target.pos });
  check('attack applies via the real engine (target took real damage)', applied && target.hp < before);
}

console.log('\n=== applyAiAction: moveAttack ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 3);
  const attacker = createUnit('horserider', 0, chain[2]!, state.playerTech[0], 'agrar');
  const mid = chain[1]!;
  const targetPos = hexNeighbors(mid).find(h =>
    !hexEqual(h, chain[2]!) && hexDistance({ q: 0, r: 0 }, h) <= state.mapRadius && !state.walls.has(`${h.q},${h.r}`))!;
  const target = createUnit('warrior', 1, targetPos, state.playerTech[1], 'temple');
  state.units.push(attacker, target);
  const before = target.hp;
  const applied = applyAiAction(state, { kind: 'moveAttack', unitId: attacker.id, to: mid, targetPos: target.pos });
  check('moveAttack both relocates the unit and lands a real hit',
    applied && hexEqual(attacker.pos, mid) && target.hp < before,
    `applied=${applied} pos=${JSON.stringify(attacker.pos)} hp=${target.hp}`);
}

console.log('\n=== applyAiAction: recruit / research ===');
{
  const state = setup('agrar', 'temple');
  const cap = getPlayerCapital(state, 0)!;
  const before = state.trainingQueue.length;
  const recruited = applyAiAction(state, { kind: 'recruit', structureId: cap.id, unitType: 'warrior' });
  check('recruit queues a real TrainingOrder via spawnUnit', recruited && state.trainingQueue.length === before + 1);

  const researched = applyAiAction(state, { kind: 'research', techId: 'command_1' });
  check('research starts via the real researchTech', researched && !!state.playerTech[0]!.researching);
}

console.log('\n=== applyAiAction: buildFarm / buildRoad (Agrar only) ===');
{
  const state = setup('agrar', 'agrar');
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, onMapChain(state, cap.pos, 2)[1]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  const farmHex = getValidFarmHexes(state, builder).find(h => canStartFarm(state, builder, h))!;
  const applied = applyAiAction(state, { kind: 'buildFarm', unitId: builder.id, pos: farmHex });
  check('buildFarm starts a real Farm via startFarm', applied && state.farms.some(f => hexEqual(f.pos, farmHex)));

  const state2 = setup('agrar', 'agrar');
  const cap2 = getPlayerCapital(state2, 0)!;
  const builder2 = createUnit('founder', 0, onMapChain(state2, cap2.pos, 2)[1]!, state2.playerTech[0], 'agrar');
  state2.units.push(builder2);
  const roadHex = getValidRoadHexes(state2, builder2).find(h => canBuildRoad(state2, builder2, h))!;
  const appliedRoad = applyAiAction(state2, { kind: 'buildRoad', unitId: builder2.id, path: [roadHex] });
  check('buildRoad lays a real Road via buildRoadPath', appliedRoad && state2.roads.some(r => hexEqual(r.pos, roadHex)));
}

console.log('\n=== applyAiAction: endActivation / endTurn ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const unit = createUnit('warrior', 0, onMapChain(state, cap.pos, 2)[1]!, state.playerTech[0], 'agrar');
  state.units.push(unit);
  const posBefore = { ...unit.pos };
  const applied = applyAiAction(state, { kind: 'endActivation', unitId: unit.id });
  check('endActivation spends the unit\'s turn without moving/attacking',
    applied && hexEqual(unit.pos, posBefore) && unit.hasMoved && unit.hasAttacked);

  const beforePlayer = state.currentPlayerIndex;
  applyAiAction(state, { kind: 'endTurn' });
  check('endTurn actually advances the active player', state.currentPlayerIndex !== beforePlayer);
}

console.log('\n=== applyAiAction: illegal actions are safe no-ops, never throw ===');
{
  const state = setup();
  const applied = applyAiAction(state, { kind: 'move', unitId: 'unit_does_not_exist', to: { q: 0, r: 0 } });
  check('a move for a nonexistent unit returns false, not a throw', applied === false);
  const applied2 = applyAiAction(state, { kind: 'recruit', structureId: 'nonexistent', unitType: 'warrior' });
  check('a recruit at a nonexistent structure returns false, not a throw', applied2 === false);
}

console.log('\n=== simulateAction never mutates the live state ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const unit = createUnit('warrior', 0, onMapChain(state, cap.pos, 2)[1]!, state.playerTech[0], 'agrar');
  state.units.push(unit);
  const livePosBefore = { ...unit.pos };
  const dest = onMapChain(state, unit.pos, 2)[1]!;
  const { state: sim, applied } = simulateAction(state, { kind: 'move', unitId: unit.id, to: dest });
  check('the simulated clone reflects the action', applied && hexEqual(sim.units.find(u => u.id === unit.id)!.pos, dest));
  check('the LIVE unit never moved', hexEqual(unit.pos, livePosBefore));
  check('the clone is a genuinely different object graph (mutating one never touches the other)',
    sim.units !== state.units && sim !== state);
}

console.log('\n=== endTurn end-to-end still behaves exactly like the live game flow ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const unit = createUnit('warrior', 0, onMapChain(state, cap.pos, 2)[1]!, state.playerTech[0], 'agrar');
  unit.hasMoved = true; unit.hasAttacked = true;
  state.units.push(unit);
  applyAiAction(state, { kind: 'endTurn' });
  applyAiAction(state, { kind: 'endTurn' });
  check('activation flags reset the same way a real endTurn/endTurn round-trip always has',
    !unit.hasMoved && !unit.hasAttacked);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
