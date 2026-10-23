// AI 2.0 Phase 8 — activation-order search ("who acts next") verification.
// Exercises searchBestActivation directly, plus the per-turn search time
// ceiling (SEARCH_CONFIG's perTurnBudgetMs) that keeps a whole AI turn from
// stacking up many individual search calls into a multi-second stall on a
// live server.
//
// Run with: npx tsx scripts/verify-ai-search-activation-order.ts
import { createGameState, chooseFaction, createUnit, getPlayerCapital } from '../src/game';
import { searchBestActivation, describeAction, SEARCH_CONFIG } from '../src/aiSearch';
import { runAiTurn } from '../src/ai';
import { DIRECTIONS, hexDistance, hexEqual, hexNeighbors } from '../src/hex';
import type { GameState, HexCoord } from '../src/types';

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

function straightChain(state: GameState, from: HexCoord, len: number): HexCoord[] {
  for (const dir of DIRECTIONS) {
    const chain: HexCoord[] = [from];
    let ok = true;
    for (let i = 1; i < len; i++) {
      const next = { q: chain[i - 1]!.q + dir.q, r: chain[i - 1]!.r + dir.r };
      if (hexDistance({ q: 0, r: 0 }, next) > state.mapRadius || state.walls.has(`${next.q},${next.r}`)) { ok = false; break; }
      chain.push(next);
    }
    if (ok) return chain;
  }
  throw new Error('no open straight direction found — regenerate the map');
}

// `exclude` matters here: hexNeighbors always returns neighbours in the
// same fixed DIRECTIONS order straightChain itself walks, so without
// excluding the chain's own next link, "the first open neighbour of
// chain[1]" can silently BE chain[2] — i.e. `idle` could land exactly on
// top of `target`, and getUnitAt (array order, no ownership check) would
// then resolve any "attack at target.pos" to whichever unit happens to be
// EARLIER in state.units instead of the real target.
function openNeighbors(state: GameState, pos: HexCoord, count: number, exclude: HexCoord[] = []): HexCoord[] {
  const found = hexNeighbors(pos).filter(h =>
    hexDistance({ q: 0, r: 0 }, h) <= state.mapRadius
    && !state.walls.has(`${h.q},${h.r}`)
    && !exclude.some(e => hexEqual(e, h)));
  if (found.length < count) throw new Error('not enough open neighbours — regenerate the map');
  return found.slice(0, count);
}

console.log('\n=== searchBestActivation is disabled on Easy/Normal, needs 2+ eligible units ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = straightChain(state, cap.pos, 3);
  const a = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  target.hp = 1;
  state.units.push(a, target);
  check('easy -> null', searchBestActivation(state, [a], 0, 'easy') === null);
  check('normal -> null', searchBestActivation(state, [a], 0, 'normal') === null);
  check('a single pending unit still resolves (not required to have 2+ to call this directly)',
    searchBestActivation(state, [a], 0, 'expert') !== null);
}

console.log('\n=== picks a free kill from whichever of several eligible units can take it ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = straightChain(state, cap.pos, 3);
  const [idlePos] = openNeighbors(state, chain[1]!, 1, [chain[2]!]);
  const attacker = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  const idle = createUnit('warrior', 0, idlePos!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  target.hp = 1;
  // Both already spent their move — isolates "which unit's IN-PLACE attack
  // is available" from "is repositioning ALSO worth it": a move that also
  // improves board-control/formation can legitimately outscore a marginal
  // kill against an already near-dead target (the same confound the
  // benchmark suite's own value-discrimination test hit), which would
  // make this test flaky for reasons that have nothing to do with
  // activation-order search itself.
  attacker.hasMoved = true;
  idle.hasMoved = true;
  state.units.push(attacker, idle, target);
  const outcome = searchBestActivation(state, [attacker, idle], 0, 'expert');
  check('an outcome is returned', !!outcome);
  check(`chooses the unit that can actually take the free kill (chose: ${outcome ? `${outcome.unitId} ${describeAction(outcome.action)}` : 'n/a'})`,
    !!outcome && outcome.unitId === attacker.id && outcome.action.kind === 'attack');
}

console.log('\n=== searchBestActivation never mutates the live state ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = straightChain(state, cap.pos, 3);
  const [idlePos] = openNeighbors(state, chain[1]!, 1, [chain[2]!]);
  const attacker = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  const idle = createUnit('warrior', 0, idlePos!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  target.hp = 1;
  state.units.push(attacker, idle, target);
  const before = state.units.map(u => ({ id: u.id, pos: { ...u.pos }, hp: u.hp, hasMoved: u.hasMoved, hasAttacked: u.hasAttacked }));
  searchBestActivation(state, [attacker, idle], 0, 'expert');
  const after = state.units.map(u => ({ id: u.id, pos: { ...u.pos }, hp: u.hp, hasMoved: u.hasMoved, hasAttacked: u.hasAttacked }));
  check('every unit is exactly as it was before the call', JSON.stringify(before) === JSON.stringify(after));
}

console.log('\n=== a maxTimeBudgetMs override is respected (per-turn search ceiling) ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = straightChain(state, cap.pos, 3);
  const [idlePos] = openNeighbors(state, chain[1]!, 1, [chain[2]!]);
  const attacker = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  const idle = createUnit('warrior', 0, idlePos!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  target.hp = 1;
  state.units.push(attacker, idle, target);
  check('a budget of 0 disables the call entirely (returns null, never throws)',
    searchBestActivation(state, [attacker, idle], 0, 'expert', 0) === null);
  const start = Date.now();
  const outcome = searchBestActivation(state, [attacker, idle], 0, 'expert', 50);
  const elapsed = Date.now() - start;
  check('a tight override budget is honored (well under the full 1200ms default)', elapsed < 500, `elapsed=${elapsed}ms`);
  check('still returns a usable outcome even under a tight budget', !!outcome);
}

console.log('\n=== end-to-end: a full AI turn never blows past its per-turn search ceiling ===');
for (const difficulty of ['hard', 'expert'] as const) {
  const state = setup('temple', 'temple');
  const cap0 = getPlayerCapital(state, 0)!;
  const cap1 = getPlayerCapital(state, 1)!;
  // A busy multi-unit skirmish near player 0's Capital — exactly the shape
  // that used to stack several search calls into a multi-second turn.
  const chain = straightChain(state, cap0.pos, 6);
  for (let i = 0; i < 3; i++) state.units.push(createUnit(i === 0 ? 'archer' : 'warrior', 0, chain[i + 1]!, state.playerTech[0], 'temple'));
  for (let i = 0; i < 3; i++) state.units.push(createUnit(i === 0 ? 'archer' : 'warrior', 1, chain[i + 3]!, state.playerTech[1], 'temple'));
  state.currentPlayerIndex = 0;
  const ceiling = SEARCH_CONFIG[difficulty].perTurnBudgetMs;
  const start = Date.now();
  runAiTurn(state, difficulty, 0);
  const elapsed = Date.now() - start;
  check(`${difficulty}: a full turn stays within its per-turn ceiling + generous slack (elapsed=${elapsed}ms, ceiling=${ceiling}ms)`,
    elapsed <= ceiling + 800);
  void cap1;
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
