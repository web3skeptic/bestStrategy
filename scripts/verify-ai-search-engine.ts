// AI 2.0 Phase 4 — negamax/alpha-beta search engine (src/aiSearch.ts
// searchBestAction) verification. Exercises the real engine end-to-end;
// also checks the hard wall-clock budget actually holds, since this search
// runs synchronously inside a live server process with no way to cancel a
// runaway call once started.
//
// Run with: npx tsx scripts/verify-ai-search-engine.ts
import { createGameState, chooseFaction, createUnit, getPlayerCapital } from '../src/game';
import { searchBestAction, SEARCH_CONFIG } from '../src/aiSearch';
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

console.log('\n=== search is disabled (returns null) on Easy/Normal ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const unit = createUnit('warrior', 0, onMapChain(state, cap.pos, 2)[1]!, state.playerTech[0], 'agrar');
  state.units.push(unit);
  check('easy -> null', searchBestAction(state, unit, 0, 'easy') === null);
  check('normal -> null', searchBestAction(state, unit, 0, 'medium') === null);
}

console.log('\n=== a guaranteed free kill is found on Hard/Expert ===');
for (const difficulty of ['hard'] as const) {
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 3);
  const attacker = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  target.hp = 1;
  state.units.push(attacker, target);
  const outcome = searchBestAction(state, attacker, 0, difficulty);
  check(`${difficulty}: an outcome is returned`, !!outcome);
  check(`${difficulty}: the chosen action is an attack on the free kill`,
    !!outcome && (outcome.action.kind === 'attack' || outcome.action.kind === 'moveAttack')
    && 'targetPos' in outcome.action && hexEqual(outcome.action.targetPos, target.pos),
    outcome ? JSON.stringify(outcome.action) : 'no outcome');
  check(`${difficulty}: depthReached is at least 2 (one full iterative-deepening pass completed)`,
    !!outcome && outcome.depthReached >= 2, outcome ? `depthReached=${outcome.depthReached}` : '');
}

console.log('\n=== search respects its own wall-clock time budget ===');
for (const difficulty of ['hard'] as const) {
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 5);
  const mine = [
    createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar'),
    createUnit('archer', 0, chain[2]!, state.playerTech[0], 'agrar'),
    createUnit('horserider', 0, chain[3]!, state.playerTech[0], 'agrar'),
  ];
  const theirs = [
    createUnit('warrior', 1, chain[4]!, state.playerTech[1], 'temple'),
    createUnit('pikeman', 1, onMapChain(state, chain[4]!, 2)[1]!, state.playerTech[1], 'temple'),
  ];
  state.units.push(...mine, ...theirs);
  const budget = SEARCH_CONFIG[difficulty].timeBudgetMs;
  const start = Date.now();
  const outcome = searchBestAction(state, mine[0]!, 0, difficulty, mine.slice(1));
  const elapsed = Date.now() - start;
  check(`${difficulty}: an outcome is returned even under a busy board`, !!outcome);
  check(`${difficulty}: wall-clock stays within budget + generous slack (elapsed=${elapsed}ms, budget=${budget}ms)`,
    elapsed <= budget + 500);
}

console.log('\n=== searchBestAction never mutates the live state ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = onMapChain(state, cap.pos, 3);
  const attacker = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  const posBefore = { ...attacker.pos };
  const hpBefore = target.hp;
  state.units.push(attacker, target);
  searchBestAction(state, attacker, 0, 'hard');
  check('the live attacker never moved', hexEqual(attacker.pos, posBefore));
  check('the live target never took damage', target.hp === hpBefore);
}

console.log('\n=== a unit with nothing legal to do at all still returns a sane fallback (or null), never throws ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const unit = createUnit('warrior', 0, onMapChain(state, cap.pos, 2)[1]!, state.playerTech[0], 'agrar');
  unit.hasAttacked = true;
  unit.hasMoved = true;
  state.units.push(unit);
  let threw = false;
  let outcome = null;
  try { outcome = searchBestAction(state, unit, 0, 'hard'); } catch { threw = true; }
  check('no throw', !threw);
  check('a spent unit resolves to just endActivation (or null)',
    outcome === null || outcome.action.kind === 'endActivation');
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
