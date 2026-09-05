// AI 2.0 Phase 5 — transposition table + move ordering verification.
// Exercises searchBestAction end-to-end (the TT lives entirely inside it —
// there's no separate public API to unit test in isolation), checking that
// it measurably reduces node visits without changing search CORRECTNESS
// (still finds the same kind of decisive move a plain search would).
//
// Run with: npx tsx scripts/verify-ai-search-tt.ts
import { createGameState, chooseFaction, createUnit, getPlayerCapital } from '../src/game';
import { searchBestAction } from '../src/aiSearch';
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

function busyBoard(): { state: GameState; mine: ReturnType<typeof createUnit>[] } {
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 6);
  const mine = [
    createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar'),
    createUnit('archer', 0, chain[2]!, state.playerTech[0], 'agrar'),
    createUnit('horserider', 0, chain[3]!, state.playerTech[0], 'agrar'),
  ];
  const theirs = [
    createUnit('warrior', 1, chain[4]!, state.playerTech[1], 'temple'),
    createUnit('pikeman', 1, chain[5]!, state.playerTech[1], 'temple'),
    createUnit('archer', 1, onMapChain(state, chain[5]!, 2)[1]!, state.playerTech[1], 'temple'),
  ];
  state.units.push(...mine, ...theirs);
  return { state, mine };
}

console.log('\n=== search still finds a free kill with the TT enabled ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 3);
  const attacker = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  target.hp = 1;
  state.units.push(attacker, target);
  const outcome = searchBestAction(state, attacker, 0, 'expert');
  check('the free kill is still found', !!outcome
    && (outcome.action.kind === 'attack' || outcome.action.kind === 'moveAttack')
    && 'targetPos' in outcome.action && hexEqual(outcome.action.targetPos, target.pos));
}

console.log('\n=== deeper iterative-deepening passes reuse the TT (nodes/depth should not blow up) ===');
{
  const { state, mine } = busyBoard();
  const outcome = searchBestAction(state, mine[0]!, 0, 'expert', mine.slice(1));
  check('an outcome is returned', !!outcome);
  check('at least depth 2 completed', !!outcome && outcome.depthReached >= 2, outcome ? `depthReached=${outcome.depthReached}` : '');
  // A crude but meaningful sanity bound: without ANY pruning/caching, node
  // count grows roughly as width^depth: even a narrow width=3 non-root
  // branching at depth 6 is 3^6=729 per root candidate, times up to
  // ~10-16 root candidates — thousands of nodes. Alpha-beta + a working TT
  // should keep the actually-visited count well under a naive full-tree
  // count for the SAME depth reached.
  const naiveUpperBound = 16 * Math.pow(3, (outcome?.depthReached ?? 2));
  check(`nodesVisited (${outcome?.nodesVisited}) is well under a naive unpruned upper bound (${naiveUpperBound})`,
    !!outcome && outcome.nodesVisited < naiveUpperBound);
}

console.log('\n=== search never mutates the live state, even with the TT active across depths ===');
{
  const { state, mine } = busyBoard();
  const before = state.units.map(u => ({ id: u.id, pos: { ...u.pos }, hp: u.hp }));
  searchBestAction(state, mine[0]!, 0, 'expert', mine.slice(1));
  const after = state.units.map(u => ({ id: u.id, pos: { ...u.pos }, hp: u.hp }));
  check('every unit is exactly where/how it was before search ran', JSON.stringify(before) === JSON.stringify(after));
}

console.log('\n=== repeated calls on the same position are consistent (TT does not introduce nondeterminism) ===');
{
  const { state, mine } = busyBoard();
  const first = searchBestAction(state, mine[0]!, 0, 'hard', mine.slice(1));
  const second = searchBestAction(state, mine[0]!, 0, 'hard', mine.slice(1));
  check('two searches over the identical position pick the identical action',
    !!first && !!second && JSON.stringify(first.action) === JSON.stringify(second.action));
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
