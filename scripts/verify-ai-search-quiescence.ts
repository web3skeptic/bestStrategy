// AI 2.0 Phase 6 — quiescence search (src/aiSearch.ts quiescence)
// verification. Tests the function directly (rather than trying to
// engineer an exact multi-ply horizon scenario through the full opaque
// search) — the same way generateCandidateActions/applyAiAction are
// tested directly elsewhere in this module.
//
// Run with: npx tsx scripts/verify-ai-search-quiescence.ts
import { createGameState, chooseFaction, createUnit, getPlayerCapital } from '../src/game';
import {
  quiescence, makeSearchCtx, searchBestAction, QUIESCENCE_MAX_PLIES, SEARCH_CONFIG,
} from '../src/aiSearch';
import { evaluateState } from '../src/ai';
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

console.log('\n=== quiescence with 0 plies left just returns the stand-pat evaluation ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 3);
  const a = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  const b = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  state.units.push(a, b);
  const ctx = makeSearchCtx(0, 'expert');
  const q = quiescence(state, ctx, -Infinity, Infinity, 'me', a.pos, [], 0);
  const flat = evaluateState(state, 0);
  check('matches a plain evaluateState call', q === flat, `q=${q} flat=${flat}`);
}

console.log('\n=== quiescence extends through an unresolved free kill left at the horizon ===');
{
  // A root search artificially cut off at plyLeft<=0 right as MY unit
  // still has an obviously free kill sitting in front of it — the whole
  // point of quiescence is that this should NOT be scored as if that kill
  // will never happen.
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 3);
  const attacker = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  target.hp = 1;
  state.units.push(attacker, target);
  const ctx = makeSearchCtx(0, 'expert');
  const flat = evaluateState(state, 0);
  const extended = quiescence(state, ctx, -Infinity, Infinity, 'me', attacker.pos, [], QUIESCENCE_MAX_PLIES);
  check('quiescence scores at least as good as the flat (horizon-blind) evaluation',
    extended >= flat, `extended=${extended} flat=${flat}`);
}

console.log('\n=== quiescence is bounded by its own ply budget, even on a busy board ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 6);
  const mine = [
    createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar'),
    createUnit('archer', 0, chain[2]!, state.playerTech[0], 'agrar'),
  ];
  const theirs = [
    createUnit('warrior', 1, chain[3]!, state.playerTech[1], 'temple'),
    createUnit('pikeman', 1, chain[4]!, state.playerTech[1], 'temple'),
    createUnit('archer', 1, chain[5]!, state.playerTech[1], 'temple'),
  ];
  state.units.push(...mine, ...theirs);
  const ctx = makeSearchCtx(0, 'expert', 2000);
  const before = ctx.nodes;
  const start = Date.now();
  quiescence(state, ctx, -Infinity, Infinity, 'me', mine[0]!.pos, [mine[1]!], QUIESCENCE_MAX_PLIES);
  const elapsed = Date.now() - start;
  check('runs quickly (well under the 2s test budget)', elapsed < 1000, `elapsed=${elapsed}ms`);
  check('visited a bounded, non-zero number of nodes', ctx.nodes > before, `nodes=${ctx.nodes}`);
}

console.log('\n=== quiescence never mutates the live state ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 3);
  const attacker = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  target.hp = 1;
  state.units.push(attacker, target);
  const before = state.units.map(u => ({ id: u.id, pos: { ...u.pos }, hp: u.hp }));
  const ctx = makeSearchCtx(0, 'expert');
  quiescence(state, ctx, -Infinity, Infinity, 'me', attacker.pos, [], QUIESCENCE_MAX_PLIES);
  const after = state.units.map(u => ({ id: u.id, pos: { ...u.pos }, hp: u.hp }));
  check('units are exactly where/how they were before', JSON.stringify(before) === JSON.stringify(after));
}

console.log('\n=== end-to-end: searchBestAction (which now calls quiescence at every leaf) still finds the free kill and stays within budget ===');
for (const difficulty of ['hard', 'expert'] as const) {
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 3);
  const attacker = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  target.hp = 1;
  state.units.push(attacker, target);
  const budget = SEARCH_CONFIG[difficulty].timeBudgetMs;
  const start = Date.now();
  const outcome = searchBestAction(state, attacker, 0, difficulty);
  const elapsed = Date.now() - start;
  check(`${difficulty}: the free kill is still found`, !!outcome
    && (outcome.action.kind === 'attack' || outcome.action.kind === 'moveAttack')
    && 'targetPos' in outcome.action && hexEqual(outcome.action.targetPos, target.pos));
  check(`${difficulty}: still within its time budget + slack (elapsed=${elapsed}ms, budget=${budget}ms)`,
    elapsed <= budget + 500);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
