// AI 2.0 Phase 1 — rich evaluator (src/aiEval.ts) verification. Exercises
// evaluateStateDetailed directly against constructed states (not full game
// flow — the engine mutators that PRODUCE these states, like Temple
// founding/upgrade or Farm construction, are already covered by
// verify-strategic-sites.ts/verify-economy.ts; this file is purely about
// whether the EVALUATOR correctly judges a given position).
//
// Run with: npx tsx scripts/verify-ai-eval.ts
import { createGameState, chooseFaction, createUnit, getPlayerCapital } from '../src/game';
import { evaluateState, evaluateStateDetailed } from '../src/ai';
import type { GameState, StrategicSite } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function setup(f0: 'agrar' | 'temple' = 'agrar', f1: 'agrar' | 'temple' = 'temple'): GameState {
  const state = createGameState();
  chooseFaction(state, 0, f0);
  chooseFaction(state, 1, f1);
  return state;
}

function makeTempleSite(pos: { q: number; r: number }, ownerId: number, level: 1 | 2, upgrading = false): StrategicSite {
  return {
    id: `site_test_${Math.random()}`, pos, state: upgrading ? 'upgradingTemple' : 'temple', ownerId,
    founding: null, upgrade: null, hp: 26, maxHp: 26, defense: 5, templeLevel: level,
  } as StrategicSite;
}

// ── §29 — breakdown must always sum to the total (otherwise every other
// test in this file is meaningless: the detailed view has to actually BE
// the number search/decisions use) ──
console.log('\n=== evaluateStateDetailed breakdown sums to evaluateState\'s total ===');
{
  const state = setup();
  state.units.push(createUnit('warrior', 0, { q: 1, r: 0 }, state.playerTech[0], 'agrar'));
  state.units.push(createUnit('archer', 1, { q: -1, r: 0 }, state.playerTech[1], 'temple'));
  const detailed = evaluateStateDetailed(state, 0);
  const plain = evaluateState(state, 0);
  check('detailed.total matches evaluateState', Math.abs(detailed.total - plain) < 1e-9, `${detailed.total} vs ${plain}`);
  const sumOfParts = detailed.terminal + detailed.material + detailed.threatenedMaterial + detailed.capitalSafety
    + detailed.income + detailed.energy + detailed.production + detailed.command + detailed.tech + detailed.farms
    + detailed.temples + detailed.fertileSites + detailed.roads + detailed.mobility + detailed.boardControl
    + detailed.formation + detailed.support + detailed.encirclement + detailed.tempo;
  check('every named term sums to the total (no silent extra term)', Math.abs(sumOfParts - detailed.total) < 1e-9);
}

// ── §6 — terminal states dominate everything else ──
console.log('\n=== Terminal states dominate material/economy ===');
{
  const state = setup();
  // Stack player 0 with a huge material/economy advantage...
  for (let i = 0; i < 10; i++) state.units.push(createUnit('heavyknight', 0, { q: i, r: 0 }, state.playerTech[0], 'agrar'));
  state.players[0]!.aura = 500;
  // ...then have player 1 win anyway (Capital destroyed).
  state.phase = 'gameOver';
  state.winner = state.players[1]!;
  check('a lost game scores very negatively for the loser regardless of material',
    evaluateState(state, 0) < -50000);
  check('a lost game scores very positively for the winner regardless of the loser\'s material',
    evaluateState(state, 1) > 50000);
}

console.log('\n=== Terminal states prefer a faster win / slower loss ===');
{
  const state = setup();
  state.phase = 'gameOver';
  state.winner = state.players[0]!;
  const fasterWin = evaluateState(state, 0, 2);
  const slowerWin = evaluateState(state, 0, 10);
  check('a win found sooner (fewer plies from root) scores higher', fasterWin > slowerWin);

  const state2 = setup();
  state2.phase = 'gameOver';
  state2.winner = state2.players[1]!;
  const fasterLoss = evaluateState(state2, 0, 2);
  const slowerLoss = evaluateState(state2, 0, 10);
  check('a loss delayed further out (more plies from root) scores higher (less bad)', slowerLoss > fasterLoss);
}

// ── §90 — Temple II must be worth substantially more than Temple I ──
console.log('\n=== Temple II scores clearly higher than Temple I, all else equal ===');
{
  const stateI = setup('temple', 'temple');
  stateI.strategicSites.push(makeTempleSite({ q: 3, r: 0 }, 0, 1));
  const stateII = setup('temple', 'temple');
  stateII.strategicSites.push(makeTempleSite({ q: 3, r: 0 }, 0, 2));
  const scoreI = evaluateState(stateI, 0);
  const scoreII = evaluateState(stateII, 0);
  check('Temple II scores meaningfully higher than Temple I', scoreII > scoreI + 5, `I=${scoreI} II=${scoreII}`);
}

// ── §91 — a Road network that actually connects Capital to Farms/frontline
// beats the same number of disconnected segments ──
console.log('\n=== Connected Road artery scores higher than disconnected segments ===');
{
  const disconnected = setup('agrar', 'agrar');
  const cap = getPlayerCapital(disconnected, 0)!;
  disconnected.roads.push(
    { pos: { q: cap.pos.q + 6, r: cap.pos.r + 6 }, ownerId: 0 },
    { pos: { q: cap.pos.q + 6, r: cap.pos.r + 7 }, ownerId: 0 },
    { pos: { q: cap.pos.q - 6, r: cap.pos.r - 6 }, ownerId: 0 },
  );

  const connected = setup('agrar', 'agrar');
  const cap2 = getPlayerCapital(connected, 0)!;
  connected.farms.push({ id: 'farm_test', pos: { q: cap2.pos.q + 3, r: cap2.pos.r }, ownerId: 0, state: 'farm', founding: null, hp: 18, maxHp: 18, defense: 5 });
  connected.roads.push(
    { pos: { q: cap2.pos.q + 1, r: cap2.pos.r }, ownerId: 0 },
    { pos: { q: cap2.pos.q + 2, r: cap2.pos.r }, ownerId: 0 },
    { pos: { q: cap2.pos.q + 3, r: cap2.pos.r + 1 }, ownerId: 0 }, // near the Farm
  );

  const scoreDisconnected = evaluateState(disconnected, 0);
  const scoreConnected = evaluateState(connected, 0);
  check('a Capital<->Farm connected artery scores higher than isolated segments',
    scoreConnected > scoreDisconnected, `disconnected=${scoreDisconnected} connected=${scoreConnected}`);
}

// ── §92 — a screened backline beats an exposed one ──
console.log('\n=== Pike screening an Archer scores higher than an exposed Archer ===');
{
  const exposed = setup('agrar', 'temple');
  const archer = createUnit('archer', 0, { q: 0, r: 0 }, exposed.playerTech[0], 'agrar');
  const enemy = createUnit('warrior', 1, { q: 1, r: 0 }, exposed.playerTech[1], 'temple');
  exposed.units.push(archer, enemy);

  const screened = setup('agrar', 'temple');
  const archer2 = createUnit('archer', 0, { q: 0, r: 0 }, screened.playerTech[0], 'agrar');
  const pike2 = createUnit('spearsman', 0, { q: 1, r: 0 }, screened.playerTech[0], 'agrar');
  const enemy2 = createUnit('warrior', 1, { q: 2, r: 0 }, screened.playerTech[1], 'temple');
  screened.units.push(archer2, pike2, enemy2);

  const scoreExposed = evaluateState(exposed, 0);
  const scoreScreened = evaluateState(screened, 0);
  check('a Pike-screened Archer position scores higher than an exposed one (material aside)',
    evaluateStateDetailed(screened, 0).formation > evaluateStateDetailed(exposed, 0).formation,
    `exposed formation=${evaluateStateDetailed(exposed, 0).formation} screened formation=${evaluateStateDetailed(screened, 0).formation}`);
  void scoreExposed; void scoreScreened;
}

// ── §93 — research further along scores higher than research just started ──
console.log('\n=== Research closer to completion scores higher than research just started ===');
{
  const justStarted = setup('agrar', 'agrar');
  justStarted.turnNumber = 5;
  justStarted.playerTech[0]!.researching = { techId: 'agrar_siegecraft', startedRound: 5, completesRound: 7 };

  const almostDone = setup('agrar', 'agrar');
  almostDone.turnNumber = 6;
  almostDone.playerTech[0]!.researching = { techId: 'agrar_siegecraft', startedRound: 5, completesRound: 7 };

  const scoreStart = evaluateState(justStarted, 0);
  const scoreAlmost = evaluateState(almostDone, 0);
  check('research 1 round from completion scores higher than research just begun',
    scoreAlmost > scoreStart, `start=${scoreStart} almostDone=${scoreAlmost}`);
}

// ── §94/§27 — activation tempo: unactivated valuable units are worth more
// than the same units after they've already acted ──
console.log('\n=== Unactivated units score higher than the same units already spent ===');
{
  const fresh = setup('agrar', 'temple');
  const u1 = createUnit('heavyknight', 0, { q: 0, r: 0 }, fresh.playerTech[0], 'agrar');
  const u2 = createUnit('heavyknight', 0, { q: 1, r: 0 }, fresh.playerTech[0], 'agrar');
  fresh.units.push(u1, u2);

  const spent = setup('agrar', 'temple');
  const u3 = createUnit('heavyknight', 0, { q: 0, r: 0 }, spent.playerTech[0], 'agrar');
  const u4 = createUnit('heavyknight', 0, { q: 1, r: 0 }, spent.playerTech[0], 'agrar');
  u3.hasMoved = true; u3.hasAttacked = true;
  u4.hasMoved = true; u4.hasAttacked = true;
  spent.units.push(u3, u4);

  check('units that can still act score a tempo advantage over the same units already spent',
    evaluateStateDetailed(fresh, 0).tempo > evaluateStateDetailed(spent, 0).tempo);
}

// ── Threatened material — a hanging unit should already cost evaluation
// value before it's actually captured ──
console.log('\n=== A guaranteed-to-die unit is already penalized before the kill happens ===');
{
  const safe = setup('agrar', 'temple');
  const target = createUnit('heavyknight', 0, { q: 0, r: 0 }, safe.playerTech[0], 'agrar');
  const farEnemy = createUnit('warrior', 1, { q: 6, r: 0 }, safe.playerTech[1], 'temple');
  safe.units.push(target, farEnemy);

  const hanging = setup('agrar', 'temple');
  const target2 = createUnit('heavyknight', 0, { q: 0, r: 0 }, hanging.playerTech[0], 'agrar');
  target2.hp = 1; // guaranteed one-shot regardless of exact damage numbers
  const nearEnemy = createUnit('horserider', 1, { q: 1, r: 0 }, hanging.playerTech[1], 'temple');
  hanging.units.push(target2, nearEnemy);

  check('a unit a revealed enemy can one-shot right now scores worse than a safe one',
    evaluateState(hanging, 0) < evaluateState(safe, 0) - 5,
    `safe=${evaluateState(safe, 0)} hanging=${evaluateState(hanging, 0)}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
