// AI difficulty system verification (first stage — see src/ai.ts's header
// comment for the current architecture and what's deliberately deferred:
// full minimax/beam search, formation/group objects, an AI-vs-AI simulation
// harness with telemetry, and deterministic seeded randomness are NOT covered
// here yet). Exercises the real engine + AI end-to-end (no forked logic) —
// createGameState, chooseFaction, endTurn, runAiTurn.
//
// Run with: npx tsx scripts/verify-ai-difficulty.ts
import { createGameState, chooseFaction, endTurn, getCurrentPlayer, getPlayerCapital, createUnit } from '../src/game';
import { runAiTurn, evaluateState, anyEnemyHasLethalShot, AI_DIFFICULTY, AiDifficulty } from '../src/ai';
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
  return state;
}

// ── Difficulty config sanity ──
console.log('\n=== Difficulty config sanity ===');
{
  check('easy has no resource reservation', !AI_DIFFICULTY.easy.useResourceReservation);
  check('easy has no threat map', !AI_DIFFICULTY.easy.useThreatMap);
  check('easy has no strategic planning', !AI_DIFFICULTY.easy.useStrategicPlanning);
  check('easy has search depth 0', AI_DIFFICULTY.easy.searchDepth === 0);
  check('normal has resource reservation', AI_DIFFICULTY.normal.useResourceReservation);
  check('normal has a threat map', AI_DIFFICULTY.normal.useThreatMap);
  check('normal has NO strategic planning (Hard+ only)', !AI_DIFFICULTY.normal.useStrategicPlanning);
  check('hard has strategic planning', AI_DIFFICULTY.hard.useStrategicPlanning);
  check('hard has shallow lookahead (search depth > 0)', AI_DIFFICULTY.hard.searchDepth > 0);
  check('expert searches deeper than hard', AI_DIFFICULTY.expert.searchDepth > AI_DIFFICULTY.hard.searchDepth);
  check('expert has the widest candidate pool', AI_DIFFICULTY.expert.candidateLimit >= AI_DIFFICULTY.hard.candidateLimit);
  check('randomness strictly decreases easy > normal > hard >= expert',
    AI_DIFFICULTY.easy.randomness > AI_DIFFICULTY.normal.randomness
    && AI_DIFFICULTY.normal.randomness > AI_DIFFICULTY.hard.randomness
    && AI_DIFFICULTY.hard.randomness >= AI_DIFFICULTY.expert.randomness);
}

// ── Resource reservation (§9, "mandatory" test §46) ──
console.log('\n=== Resource reservation: Normal+ saves instead of always spending ===');
{
  const state = setup('agrar', 'agrar');
  state.currentPlayerIndex = 0;
  // agrar_siegecraft (first on the plan, no prereqs) costs 16 — set aura just
  // short of it. The mandatory first Builder recruit (cost 2) is exempt.
  state.players[0]!.aura = 15;
  runAiTurn(state, 'normal');
  check('Normal AI does NOT blow past the reservation on a discretionary recruit',
    state.players[0]!.aura >= 13, `aura=${state.players[0]!.aura}`);
  check('Normal AI did NOT prematurely research a cheaper, lower-priority tech',
    !state.playerTech[0]!.researching);
  check('Normal AI DID recruit its mandatory (exempt) first Builder',
    state.trainingQueue.some(o => o.playerId === 0 && o.unitType === 'founder'));

  const state2 = setup('agrar', 'agrar');
  state2.currentPlayerIndex = 0;
  state2.players[0]!.aura = 16; // now affordable
  runAiTurn(state2, 'normal');
  check('Normal AI starts the reserved-for tech once it IS affordable',
    !!state2.playerTech[0]!.researching);
}

// ── Easy AI: no reservation, spends freely ──
console.log('\n=== Easy AI does not reserve ===');
{
  const state = setup('agrar', 'agrar');
  state.currentPlayerIndex = 0;
  state.players[0]!.aura = 15;
  runAiTurn(state, 'easy');
  check('Easy AI has no research plan / reservation concept (never starts research at all)',
    !state.playerTech[0]!.researching);
}

// ── Evaluator sanity (§23-25) ──
console.log('\n=== evaluateState: monotonic in material/aura/Capital HP ===');
{
  const state = setup();
  const base = evaluateState(state, 0);
  const withAura = { ...state, players: state.players.map(p => p.id === 0 ? { ...p, aura: p.aura + 50 } : p) };
  check('more aura for the evaluated player raises their score', evaluateState(withAura, 0) > base);

  const capital = getPlayerCapital(state, 0)!;
  const healthyScore = evaluateState(state, 0);
  const damagedState: GameState = JSON.parse(JSON.stringify(state));
  damagedState.capitals.find(c => c.playerId === 0)!.hp = Math.round(capital.maxHp * 0.2);
  const damagedScore = evaluateState(damagedState, 0);
  check('a Capital critically low on HP scores much worse than a healthy one',
    healthyScore - damagedScore > 100, `healthy=${healthyScore} damaged=${damagedScore}`);

  check('evaluateState is symmetric (viewer\'s own score negated is the opponent\'s)',
    Math.abs(evaluateState(state, 0) + evaluateState(state, 1)) < 1e-9);
}

// ── §49 lethal-exposure detection (Hard/Expert lookahead) + §34 fog-of-war ──
console.log('\n=== anyEnemyHasLethalShot: detects guaranteed kills, respects fog ===');
{
  const state = setup('agrar', 'temple');
  const tech0 = state.playerTech[0], tech1 = state.playerTech[1];
  const target = createUnit('heavyknight', 0, { q: 0, r: 0 }, tech0, 'agrar');
  const attacker = createUnit('heavyknight', 1, { q: 1, r: 0 }, tech1, 'temple'); // adjacent, in range
  target.hp = 1; // guaranteed one-shot regardless of exact damage numbers
  state.units.push(target, attacker);
  check('an adjacent enemy that can one-shot the target IS detected',
    anyEnemyHasLethalShot(state, target, 0));

  attacker.pos = { q: 6, r: 0 }; // far outside any unit's range
  check('an enemy far out of range is NOT flagged as a lethal threat',
    !anyEnemyHasLethalShot(state, target, 0));

  // Fog of war: a RANGED lethal attacker sitting in a forest 2 hexes away
  // (in range, but not adjacent — a melee attacker adjacent to the target
  // would always incidentally reveal itself via the target's own presence,
  // so this needs distance) with nothing of player 0's within 1 hex of the
  // forest tile to reveal it — must NOT be "seen" by the lookahead (§34 —
  // no hidden-information cheating).
  state.units.length = 0;
  const target2 = createUnit('heavyknight', 0, { q: -6, r: 0 }, tech0, 'agrar');
  const archer = createUnit('archer', 1, { q: 2, r: 0 }, tech1, 'temple'); // range 2, well clear of target2
  archer.hp = archer.stats.maxHp;
  target2.pos = { q: 0, r: 0 }; // now 2 hexes from the archer — in its range
  target2.hp = 1;
  state.units.push(target2, archer);
  const forestKey = `${archer.pos.q},${archer.pos.r}`;
  state.forests.add(forestKey);
  check('sanity: this archer WOULD be a lethal threat if visible',
    anyEnemyHasLethalShot({ ...state, forests: new Set() }, target2, 0));
  check('the same lethal archer hidden in an unrevealed forest is NOT detected (no fog cheating)',
    !anyEnemyHasLethalShot(state, target2, 0));
}

// ── Regression: the Agrar Builder must not permanently block its own
// Capital from ever deploying another recruit. Building Farms/Roads never
// requires moving away from wherever the Builder is standing, so once it
// deploys onto the Capital it had (before this fix) no reason to ever leave
// — permanently occupying the one tile resolveTrainingForPlayer requires be
// free, capping Agrar's population at whatever it queued in round 1 for the
// rest of the game NO MATTER how much aura piled up. This was, by a wide
// margin, the single biggest contributor found to Agrar-controlled-AI
// consistently losing to Temple-controlled-AI. ──
console.log('\n=== Agrar Builder must not permanently block Capital recruiting ===');
{
  const state = setup('agrar', 'agrar');
  state.currentPlayerIndex = 0;
  state.players[0]!.aura = 200; // never Energy-constrained — isolate the occupancy bug specifically
  let rounds = 0;
  while (rounds < 20) {
    rounds++;
    runAiTurn(state, 'hard', getCurrentPlayer(state).id);
    endTurn(state);
  }
  const armySize = state.units.filter(u => u.hp > 0 && u.playerId === 0).length;
  // The bug this guards against capped the army at EXACTLY 3 forever
  // (founder + whatever 2 units were queued before the Capital tile got
  // permanently blocked) no matter how many rounds passed or how much aura
  // was available — so armySize > 3 is the precise "is this actually
  // fixed" signal, not just "did it grow at all".
  check('with unlimited Energy, Agrar\'s army grows past the old permanently-stuck-at-3 ceiling',
    armySize > 3, `army size = ${armySize}`);
  check('the training queue is not permanently jammed (empties out at some point)',
    state.trainingQueue.filter(o => o.playerId === 0).length < 3);
}

// ── No cheating: all 4 difficulties only ever act through canonical engine mutators ──
// (structural check — every AIAction is produced by moveUnit/attackUnit/spawnUnit/
// etc., which already validate legality; this just confirms a full turn never
// throws and never leaves impossible state behind.)
console.log('\n=== Full turns across all difficulties never crash / never leave illegal state ===');
{
  const DIFFS: AiDifficulty[] = ['easy', 'normal', 'hard', 'expert'];
  let crashed = false;
  for (const d of DIFFS) {
    const state = setup(d === 'easy' || d === 'hard' ? 'agrar' : 'temple', d === 'easy' || d === 'hard' ? 'temple' : 'agrar');
    try {
      for (let i = 0; i < 20 && state.phase === 'playing'; i++) {
        runAiTurn(state, d, getCurrentPlayer(state).id);
        endTurn(state);
      }
      const overCap = state.players.some(p => {
        const cap = getPlayerCapital(state, p.id);
        return cap && cap.hp < 0;
      });
      check(`${d} AI: 20 turns run cleanly, Capital HP never goes negative`, !overCap);
    } catch (err) {
      crashed = true;
      check(`${d} AI: 20 turns run cleanly`, false, (err as Error).message);
    }
  }
  check('no difficulty crashed across the smoke run', !crashed);
}

console.log(failures === 0 ? `\nPASS: 0 failing check(s)` : `\nFAIL: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
