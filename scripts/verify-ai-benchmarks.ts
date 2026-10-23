// AI 2.0 Phase 7 — benchmark-position regression suite. A small, growable
// set of hand-built tactical positions, each checked against what a
// competent player would consider ACCEPTABLE and what would be
// CATASTROPHIC — the goal isn't "does the AI play optimally" (that's what
// the eval/search unit tests are for), it's "does it ever do something
// obviously wrong that a real search regression could introduce silently."
// Run this whenever the evaluator, candidate generator, or search changes.
// To add a new benchmark: build a position, call searchBestAction, assert
// acceptable/catastrophic — same shape as every block below.
//
// Run with: npx tsx scripts/verify-ai-benchmarks.ts
import { createGameState, chooseFaction, createUnit, getPlayerCapital } from '../src/game';
import { searchBestAction, describeAction } from '../src/aiSearch';
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

// A straight-line chain in one of the 6 fixed hex directions (never
// wobbling between directions mid-chain), so hexDistance between any two
// links is EXACTLY the index difference — needed for benchmarks that
// depend on precise range math (e.g. "exactly at range 2, exactly out of
// range 3"). Falls back through all 6 directions to find one that stays
// on-map and off walls the whole way (random Capital placement means not
// every direction is open).
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
  throw new Error('no open straight direction found for this benchmark — regenerate the map');
}

// `count` distinct on-map, off-wall neighbours of `pos` (optionally
// excluding specific hexes, e.g. a Capital's own tile) — used wherever a
// benchmark needs a couple of open tiles around a unit but doesn't care
// which exact direction they're in (unlike straightChain, where the exact
// direction/distance matters).
function openNeighbors(state: GameState, pos: HexCoord, count: number, exclude: HexCoord[] = []): HexCoord[] {
  const found = hexNeighbors(pos).filter(h =>
    hexDistance({ q: 0, r: 0 }, h) <= state.mapRadius
    && !state.walls.has(`${h.q},${h.r}`)
    && !exclude.some(e => hexEqual(e, h)));
  if (found.length < count) throw new Error('not enough open neighbours for this benchmark — regenerate the map');
  return found.slice(0, count);
}

console.log('\n=== Benchmark: take a free kill sitting right in front of you ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = straightChain(state, cap.pos, 3);
  const attacker = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  const target = createUnit('warrior', 1, chain[2]!, state.playerTech[1], 'temple');
  target.hp = 1;
  state.units.push(attacker, target);
  const outcome = searchBestAction(state, attacker, 0, 'hard');
  check('an outcome is returned', !!outcome);
  check(`does NOT settle for doing nothing (chose: ${outcome ? describeAction(outcome.action) : 'n/a'})`,
    !!outcome && outcome.action.kind !== 'endActivation' && outcome.action.kind !== 'move');
  check('takes the kill', !!outcome && (outcome.action.kind === 'attack' || outcome.action.kind === 'moveAttack'));
}

console.log('\n=== Benchmark: do not walk a fragile unit into a static enemy archer\'s range when a safe option exists ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = straightChain(state, cap.pos, 5);
  // hp=1 makes ANY hit lethal regardless of the exact damage formula — the
  // point being tested is range awareness, not combat math.
  const mine = createUnit('warrior', 0, chain[1]!, state.playerTech[0], 'agrar');
  mine.hp = 1;
  const archer = createUnit('archer', 1, chain[4]!, state.playerTech[1], 'temple');
  state.units.push(mine, archer);
  const outcome = searchBestAction(state, mine, 0, 'hard');
  check('an outcome is returned', !!outcome);
  const catastrophic = !!outcome && outcome.action.kind === 'move' && hexDistance(outcome.action.to, archer.pos) <= 2;
  check(`does NOT walk into the archer's range (chose: ${outcome ? describeAction(outcome.action) : 'n/a'})`, !catastrophic);
}

console.log('\n=== Benchmark: finish the enemy Capital instead of settling for a trivial unit kill ===');
{
  const state = setup();
  const cap1 = getPlayerCapital(state, 1)!;
  cap1.hp = 1;
  const attackerPos = openNeighbors(state, cap1.pos, 1)[0]!;
  const distractionPos = openNeighbors(state, attackerPos, 1, [cap1.pos])[0]!;
  const attacker = createUnit('warrior', 0, attackerPos, state.playerTech[0], 'agrar');
  const distraction = createUnit('warrior', 1, distractionPos, state.playerTech[1], 'temple');
  distraction.hp = 1;
  state.units.push(attacker, distraction);
  check('setup sanity: the attacker is adjacent to both the Capital and the distraction',
    hexDistance(attacker.pos, cap1.pos) === 1 && hexDistance(attacker.pos, distraction.pos) === 1);
  const outcome = searchBestAction(state, attacker, 0, 'hard');
  check('an outcome is returned', !!outcome);
  check(`chooses attackStructure over the trivial unit kill (chose: ${outcome ? describeAction(outcome.action) : 'n/a'})`,
    !!outcome && outcome.action.kind === 'attackStructure');
}

console.log('\n=== Benchmark: prefer the higher-value guaranteed kill when more than one is available ===');
{
  const state = setup();
  const cap = getPlayerCapital(state, 0)!;
  const chain = straightChain(state, cap.pos, 2);
  const attacker = createUnit('archer', 0, chain[1]!, state.playerTech[0], 'agrar');
  // Already spent its move (hasMoved=true) — isolates "which of two
  // EQUALLY reachable targets do I attack" from "is repositioning ALSO
  // worth it", since a moveAttack elsewhere can legitimately net enough
  // extra board-control/formation value to outscore the smaller material
  // difference between a warrior and a horserider — a real, intentional
  // part of how the evaluator weighs position, not a bug, but it makes
  // "which target" impossible to isolate if movement is still on the table.
  attacker.hasMoved = true;
  const [cheapPos, valuablePos] = openNeighbors(state, chain[1]!, 2);
  const cheap = createUnit('warrior', 1, cheapPos!, state.playerTech[1], 'temple');
  cheap.hp = 1;
  const valuable = createUnit('horserider', 1, valuablePos!, state.playerTech[1], 'temple');
  valuable.hp = 1;
  state.units.push(attacker, cheap, valuable);
  const outcome = searchBestAction(state, attacker, 0, 'hard');
  check('an outcome is returned', !!outcome);
  const targetsValuable = !!outcome && outcome.action.kind === 'attack' && hexEqual(outcome.action.targetPos, valuable.pos);
  const targetsCheap = !!outcome && outcome.action.kind === 'attack' && hexEqual(outcome.action.targetPos, cheap.pos);
  check(`attacks the more valuable target, not the cheap one (chose: ${outcome ? describeAction(outcome.action) : 'n/a'})`,
    targetsValuable && !targetsCheap);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
