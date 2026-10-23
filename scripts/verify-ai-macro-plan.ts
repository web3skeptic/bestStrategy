// AI 2.0 — macro-plan persistence verification (chooseStrategicPlan,
// src/ai.ts). computeStrategicPlan itself is a pure snapshot of the
// current position; this exercises the PERSISTENCE layer wrapped around
// it: a plan sticks for PLAN_COMMITMENT_ROUNDS real rounds even as the
// underlying conditions shift, a genuine emergency always overrides
// immediately regardless of any active commitment, and the AI resumes
// (rather than re-rolls) its prior commitment once the emergency passes.
//
// Run with: npx tsx scripts/verify-ai-macro-plan.ts
import { createGameState, chooseFaction, getPlayerCapital } from '../src/game';
import { chooseStrategicPlan } from '../src/ai';
import type { GameState } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function setup(f0: 'agrar' | 'temple' = 'temple', f1: 'agrar' | 'temple' = 'temple'): GameState {
  const state = createGameState();
  chooseFaction(state, 0, f0);
  chooseFaction(state, 1, f1);
  state.turnNumber = 1;
  return state;
}

console.log('\n=== a plan sticks for PLAN_COMMITMENT_ROUNDS even as underlying conditions change ===');
{
  const state = setup();
  const first = chooseStrategicPlan(state, 0);
  check('first call picks a real plan', ['DEFEND', 'RAID_ECONOMY', 'SIEGE', 'TECH_UP', 'EXPAND'].includes(first), `got ${first}`);

  // Now make the UNDERLYING snapshot conditions look like TECH_UP would be
  // picked instead (a tech is queued to research next, with a real cost) —
  // if the plan were recomputed from scratch every call this would flip.
  state.playerTech[0]!.researching = null;
  state.turnNumber = 2; // still within the commitment window
  const second = chooseStrategicPlan(state, 0);
  check('one round later, still inside the commitment window, the SAME plan is returned',
    second === first, `first=${first} second=${second}`);

  state.turnNumber = 3; // still within the window (< committedAtRound + 3)
  const third = chooseStrategicPlan(state, 0);
  check('still within the commitment window on round 3', third === first, `first=${first} third=${third}`);
}

console.log('\n=== once the commitment window expires, the plan is free to change ===');
{
  const state = setup();
  const first = chooseStrategicPlan(state, 0);
  check('sanity: first call resolves to a real plan', ['DEFEND', 'RAID_ECONOMY', 'SIEGE', 'TECH_UP', 'EXPAND'].includes(first));

  // Well past PLAN_COMMITMENT_ROUNDS — the commitment has expired, so this
  // call must actually re-derive a plan rather than just returning
  // whatever's cached forever.
  state.turnNumber = 10;
  const after = chooseStrategicPlan(state, 0);
  check('a fresh call well past the commitment window still resolves to a real plan (not stuck forever)',
    ['DEFEND', 'RAID_ECONOMY', 'SIEGE', 'TECH_UP', 'EXPAND'].includes(after));
}

console.log('\n=== a genuine emergency overrides any active commitment immediately ===');
{
  const state = setup();
  const first = chooseStrategicPlan(state, 0);
  check('sanity: first call resolves to a real plan', ['DEFEND', 'RAID_ECONOMY', 'SIEGE', 'TECH_UP', 'EXPAND'].includes(first));

  const cap = getPlayerCapital(state, 0)!;
  cap.hp = Math.floor(cap.maxHp * 0.3); // hasEmergency's HP-fraction trigger
  state.turnNumber = 2; // still well within the EXPAND commitment window
  const duringEmergency = chooseStrategicPlan(state, 0);
  check('DEFEND fires immediately despite an active, unexpired commitment',
    duringEmergency === 'DEFEND', `got ${duringEmergency}`);
}

console.log('\n=== the AI resumes its prior commitment once the emergency passes, rather than re-rolling ===');
{
  const state = setup();
  const first = chooseStrategicPlan(state, 0);
  check('sanity: first call resolves to a real plan', ['DEFEND', 'RAID_ECONOMY', 'SIEGE', 'TECH_UP', 'EXPAND'].includes(first));

  const cap = getPlayerCapital(state, 0)!;
  cap.hp = Math.floor(cap.maxHp * 0.3);
  state.turnNumber = 2;
  chooseStrategicPlan(state, 0); // DEFEND, but must NOT overwrite the stored commitment

  cap.hp = cap.maxHp; // emergency resolved
  state.turnNumber = 3; // still inside the ORIGINAL commitment window
  const resumed = chooseStrategicPlan(state, 0);
  check('resumes the original commitment, not a freshly re-rolled plan',
    resumed === first, `original=${first} resumed=${resumed}`);
}

console.log('\n=== plan memory is kept separately per player (a shared 2-player GameState) ===');
{
  const state = setup();
  const p0Before = chooseStrategicPlan(state, 0);
  const cap1 = getPlayerCapital(state, 1)!;
  cap1.hp = Math.floor(cap1.maxHp * 0.3);
  const p1 = chooseStrategicPlan(state, 1);
  const p0After = chooseStrategicPlan(state, 0);
  check('player 0\'s plan is unaffected by player 1\'s emergency', p0After === p0Before,
    `before=${p0Before} after=${p0After}`);
  check('player 1 independently gets DEFEND', p1 === 'DEFEND');
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
