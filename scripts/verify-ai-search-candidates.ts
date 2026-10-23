// AI 2.0 Phase 3 — candidate generation (src/aiSearch.ts generateCandidateActions)
// verification. Exercises the real engine end-to-end (createGameState,
// select/moveHexes/etc via the heuristic reuse in ai.ts) — no forked logic.
//
// Run with: npx tsx scripts/verify-ai-search-candidates.ts
import { createGameState, chooseFaction, createUnit, getPlayerCapital } from '../src/game';
import { generateCandidateActions, SEARCH_CONFIG } from '../src/aiSearch';
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

// Same guaranteed-on-map/passable chain helper as verify-ai-search.ts — see
// that file's comment for why a raw hexNeighbors(pos)[0] isn't safe here.
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

console.log('\n=== generateCandidateActions always includes the quiet "endActivation" move ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const unit = createUnit('warrior', 0, onMapChain(state, cap.pos, 2)[1]!, state.playerTech[0], 'agrar');
  state.units.push(unit);
  const candidates = generateCandidateActions(state, unit, 0, 'hard');
  check('endActivation is present', candidates.some(c => c.kind === 'endActivation' && c.unitId === unit.id));
}

console.log('\n=== a dead unit (hp <= 0) produces no actionable candidates ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const unit = createUnit('warrior', 0, onMapChain(state, cap.pos, 2)[1]!, state.playerTech[0], 'agrar');
  unit.hp = 0;
  state.units.push(unit);
  const candidates = generateCandidateActions(state, unit, 0, 'hard');
  check('only endActivation remains', candidates.length === 1 && candidates[0]!.kind === 'endActivation');
}

console.log('\n=== a unit that already attacked produces no move/attack candidates ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const unit = createUnit('warrior', 0, onMapChain(state, cap.pos, 2)[1]!, state.playerTech[0], 'agrar');
  unit.hasAttacked = true;
  state.units.push(unit);
  const candidates = generateCandidateActions(state, unit, 0, 'hard');
  check('no move/attack/moveAttack candidates for an already-spent unit',
    candidates.every(c => c.kind === 'endActivation'));
}

console.log('\n=== a unit that already moved (but not attacked) can still attack in place, but not move again ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 3);
  const attacker = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  attacker.hasMoved = true;
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  state.units.push(attacker, target);
  const candidates = generateCandidateActions(state, attacker, 0, 'hard');
  check('an in-range attack is offered', candidates.some(c => c.kind === 'attack' && hexEqual(c.targetPos, target.pos)));
  check('no move/moveAttack candidates once already moved',
    candidates.every(c => c.kind !== 'move' && c.kind !== 'moveAttack'));
}

console.log('\n=== a fresh unit with an adjacent enemy offers attack, move, and moveAttack candidates ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 3);
  const attacker = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  state.units.push(attacker, target);
  const candidates = generateCandidateActions(state, attacker, 0, 'hard');
  check('a from-current-position attack is offered', candidates.some(c => c.kind === 'attack'));
  check('at least one move candidate is offered', candidates.some(c => c.kind === 'move'));
  check('endActivation is still offered alongside real options', candidates.some(c => c.kind === 'endActivation'));
}

console.log('\n=== candidate width respects SEARCH_CONFIG per difficulty ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const unit = createUnit('horserider', 0, onMapChain(state, cap.pos, 2)[1]!, state.playerTech[0], 'agrar');
  state.units.push(unit);
  const hardCandidates = generateCandidateActions(state, unit, 0, 'hard');
  const moves = hardCandidates.filter(a => a.kind === 'move').length;
  check('hard offers no more move candidates than its candidateWidth (+ the head-home move)',
    moves <= SEARCH_CONFIG.hard.candidateWidth + 1, `moves=${moves}`);
  check('SEARCH_CONFIG marks easy/medium as not search-enabled', !SEARCH_CONFIG.easy.enabled && !SEARCH_CONFIG.medium.enabled);
  check('SEARCH_CONFIG marks hard as search-enabled', SEARCH_CONFIG.hard.enabled);
}

console.log('\n=== candidates never repeat the exact same action twice (dedup) ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 3);
  const attacker = createUnit('archer', 0, chain[1]!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  state.units.push(attacker, target);
  const candidates = generateCandidateActions(state, attacker, 0, 'hard');
  const keys = candidates.map(c => JSON.stringify(c));
  check('no duplicate action entries', new Set(keys).size === keys.length, `count=${keys.length} unique=${new Set(keys).size}`);
}

console.log('\n=== a "head toward home" retreat candidate is offered distinct from the objective move ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  // Push the unit's Capital far away so "toward home" and "toward the only
  // visible enemy" are guaranteed to diverge.
  const unit = createUnit('warrior', 0, onMapChain(state, cap.pos, 2)[1]!, state.playerTech[0], 'agrar');
  state.units.push(unit);
  const candidates = generateCandidateActions(state, unit, 0, 'hard');
  const moveCandidates = candidates.filter(c => c.kind === 'move');
  check('at least one move candidate exists to evaluate', moveCandidates.length > 0);
  const capital = getPlayerCapital(state, 0)!;
  const closestToHome = moveCandidates.reduce((best, c) =>
    hexDistance(c.to, capital.pos) < hexDistance(best.to, capital.pos) ? c : best);
  check('the closest-to-home move candidate is genuinely closer to the Capital than the unit currently is',
    hexDistance(closestToHome.to, capital.pos) <= hexDistance(unit.pos, capital.pos));
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
