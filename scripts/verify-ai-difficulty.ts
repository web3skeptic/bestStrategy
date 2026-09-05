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
import { hexDistance } from '../src/hex';
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

// Capital placement is randomized per game (and can land near the map
// edge), which made hex-direction-based test geometry flaky depending on
// which quadrant it happened to land in. Recentres playerId's Capital to
// the exact map centre and clears a wide surrounding area (terrain +
// anything else placed there) for fully deterministic test geometry —
// same rationale/shape as the identical helper in verify-roads.ts/
// verify-economy.ts.
function forceCapitalCenter(state: GameState, playerId: number, radius = 6): void {
  const capital = state.capitals.find(c => c.playerId === playerId)!;
  capital.pos = { q: 0, r: 0 };
  const far = state.mapRadius * 6;
  let offset = 0;
  // Every OTHER Capital is relocated far away unconditionally (not just if
  // within `radius`) — an enemy Capital left at its original random spot
  // could otherwise make "besiege the nearest enemy structure" pull a test
  // unit in an unpredictable direction, unrelated to whatever this specific
  // test is actually checking.
  for (const c of state.capitals) if (c.playerId !== playerId) c.pos = { q: far, r: far + offset++ };
  for (const s of state.strategicSites) if (hexDistance(s.pos, capital.pos) <= radius) s.pos = { q: far, r: far + offset++ };
  for (const u of state.units) if (hexDistance(u.pos, capital.pos) <= radius) u.pos = { q: far, r: far + offset++ };
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      const key = `${capital.pos.q + dq},${capital.pos.r + dr}`;
      state.hills.delete(key); state.walls.delete(key); state.forests.delete(key);
    }
  }
}

// Walks exactly `dist` hexes from `from`, in a single fixed axial direction
// (whichever of the 6 actual hex-neighbour steps points most toward the map
// centre) — NOT a naive (-sign(q), -sign(r)) diagonal, which isn't one of
// the 6 valid unit vectors and silently produces a hex TWICE as far away as
// `dist` would suggest (a diagonal (-1,-1) step is itself distance 2, not
// 1). Using a real unit direction keeps `dist` an accurate, on-map hex
// distance for every test below.
const HEX_UNIT_DIRS = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
function towardCenterDirIndex(from: { q: number; r: number }): number {
  let bestIdx = 0, bestDist = Infinity;
  HEX_UNIT_DIRS.forEach((d, i) => {
    const distToOrigin = hexDistance({ q: from.q + d.q, r: from.r + d.r }, { q: 0, r: 0 });
    if (distToOrigin < bestDist) { bestDist = distToOrigin; bestIdx = i; }
  });
  return bestIdx;
}
function towardCenter(from: { q: number; r: number }, dist: number): { q: number; r: number } {
  const d = HEX_UNIT_DIRS[towardCenterDirIndex(from)]!;
  return { q: from.q + d.q * dist, r: from.r + d.r * dist };
}
// A hex `dist` away from `from`, deliberately in a DIFFERENT direction than
// towardCenter would pick (rotated 120°) — used to keep a "threat" off the
// direct home path in reserve-recall tests, so the AI isn't asked to
// path straight through the very enemy it's supposedly avoiding (a real,
// separate routing concern, not what these tests are checking).
function offToTheSide(from: { q: number; r: number }, dist: number): { q: number; r: number } {
  const d = HEX_UNIT_DIRS[(towardCenterDirIndex(from) + 2) % 6]!;
  return { q: from.q + d.q * dist, r: from.r + d.r * dist };
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
  // command_1 (first on the plan, no prereqs — see HARD_RESEARCH_PLAN's own
  // comment for why it leads) costs 12 — set aura just short of it. The
  // mandatory first Builder recruit (cost 2) is exempt.
  state.players[0]!.aura = 11;
  runAiTurn(state, 'normal');
  check('Normal AI does NOT blow past the reservation on a discretionary recruit',
    state.players[0]!.aura >= 9, `aura=${state.players[0]!.aura}`);
  check('Normal AI did NOT prematurely research a cheaper, lower-priority tech',
    !state.playerTech[0]!.researching);
  check('Normal AI DID recruit its mandatory (exempt) first Builder',
    state.trainingQueue.some(o => o.playerId === 0 && o.unitType === 'founder'));

  const state2 = setup('agrar', 'agrar');
  state2.currentPlayerIndex = 0;
  state2.players[0]!.aura = 12; // now affordable
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

// ── Never leave the Capital undefended once an enemy is spotted, unless
// provably safe (no revealed enemy at all) ──
console.log('\n=== AI never leaves its Capital empty once an enemy is spotted ===');
{
  const state = setup('agrar', 'temple');
  forceCapitalCenter(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const techA = state.playerTech[0], techB = state.playerTech[1];
  // Place a lone combat unit a few hexes from home, plus a revealed enemy
  // well out of immediate engagement range — nothing to fight right now,
  // just a reason to worry.
  const farPos = towardCenter(cap.pos, 6);
  const lone = createUnit('warrior', 0, farPos, techA, 'agrar');
  const enemy = createUnit('warrior', 1, offToTheSide(farPos, 3), techB, 'temple');
  state.units.push(lone, enemy);
  state.currentPlayerIndex = 0;
  const distBefore = hexDistance(farPos, cap.pos);
  runAiTurn(state, 'hard', 0);
  const distAfter = hexDistance(lone.pos, cap.pos);
  check('the lone unit heads back toward (or stays no farther from) the empty Capital',
    distAfter <= distBefore, `before=${distBefore} after=${distAfter} finalPos=(${lone.pos.q},${lone.pos.r})`);
}

// ── AGRAR LOGISTICS PASS: mobile reserve + Road arteries (Hard/Expert only) ──

console.log('\n=== Mobile reserve: a credible fast threat pulls an uncommitted unit back toward home ===');
{
  const state = setup('agrar', 'temple');
  forceCapitalCenter(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const techA = state.playerTech[0], techB = state.playerTech[1];
  // One guard already near home (becomes the garrison), one unit off on its
  // own errand far away (the one we expect the reserve system to notice),
  // and a fast Temple Raider-equivalent (horserider) revealed partway
  // between them — close enough that only the CLOSE unit responding in
  // time isn't good enough; the far one needs to matter too.
  const nearGuard = createUnit('warrior', 0, towardCenter(cap.pos, 2), techA, 'agrar');
  const farPos = towardCenter(cap.pos, 6);
  const farUnit = createUnit('warrior', 0, farPos, techA, 'agrar');
  // Off to the side, not directly on the farUnit->Capital line — this test
  // is about whether the reserve system recalls the far unit at all, not
  // about routing around a threat that happens to block the direct path.
  const raider = createUnit('horserider', 1, offToTheSide(cap.pos, 4), techB, 'temple');
  state.units.push(nearGuard, farUnit, raider);
  state.currentPlayerIndex = 0;
  const distBefore = hexDistance(farUnit.pos, cap.pos);
  runAiTurn(state, 'hard', 0);
  const distAfter = hexDistance(farUnit.pos, cap.pos);
  check('the far, previously-uncommitted unit moves toward home rather than continuing to wander',
    distAfter < distBefore, `before=${distBefore} after=${distAfter}`);
}

console.log('\n=== Mobile reserve: does NOT overreact to a distant, slow, easily-beaten threat ===');
{
  const state = setup('agrar', 'temple');
  forceCapitalCenter(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const techA = state.playerTech[0], techB = state.playerTech[1];
  const nearGuard = createUnit('warrior', 0, towardCenter(cap.pos, 2), techA, 'agrar');
  const farPos = towardCenter(cap.pos, 6);
  const farUnit = createUnit('warrior', 0, farPos, techA, 'agrar');
  // A large-enough army that the (unrelated) "mass before attacking" rally
  // rule doesn't independently pull the far unit home regardless of any
  // specific enemy — this test needs to isolate the RESERVE system's own
  // restraint, not that other rule's.
  const filler1 = createUnit('spearsman', 0, towardCenter(cap.pos, 3), techA, 'agrar');
  const filler2 = createUnit('spearsman', 0, towardCenter(cap.pos, 4), techA, 'agrar');
  // Even Temple's warrior (speed 2, range 1 -> reach 3, the faction's
  // baseline mobility) needs 3 turns to threaten from 7 hexes out — past
  // CREDIBLE_THREAT_TURNS. No reserve should be needed just because SOME
  // enemy unit exists somewhere on the map.
  const slowEnemy = createUnit('warrior', 1, offToTheSide(cap.pos, 7), techB, 'temple');
  state.units.push(nearGuard, farUnit, filler1, filler2, slowEnemy);
  state.currentPlayerIndex = 0;
  const distBefore = hexDistance(farUnit.pos, cap.pos);
  runAiTurn(state, 'hard', 0);
  const distAfter = hexDistance(farUnit.pos, cap.pos);
  check('the far unit is NOT recalled just because an enemy exists somewhere far off and slow',
    distAfter >= distBefore, `before=${distBefore} after=${distAfter}`);
}

console.log('\n=== Road arteries: Builder lays a multi-segment connected path, not one arbitrary hex ===');
{
  const state = setup('agrar', 'agrar');
  for (const p of state.players) p.aura = 200;
  let rounds = 0;
  let sawMultiSegment = false;
  while (rounds < 30 && state.phase === 'playing' && !sawMultiSegment) {
    rounds++;
    const seat = getCurrentPlayer(state).id;
    const before = state.roads.filter(r => r.ownerId === 0).length;
    runAiTurn(state, 'hard', seat);
    const after = state.roads.filter(r => r.ownerId === 0).length;
    if (after - before > 1) sawMultiSegment = true;
    endTurn(state);
  }
  check('at least one Builder activation laid more than 1 Road segment at once',
    sawMultiSegment, `rounds checked=${rounds}`);
}

// Regression: DEFEND used to make the Builder prioritize Road over Farm —
// but DEFEND (hasEmergency) fires easily against a naturally fast opponent
// (practically any Temple unit within striking range reads as "credible"),
// so that swap meant the Farm network could stop growing for most of a
// real game, not just during a genuine emergency. Farm must always come
// first regardless of plan.
console.log('\n=== Agrar keeps building Farms even while a fast enemy is within striking range ===');
{
  const state = setup('agrar', 'temple');
  for (const p of state.players) p.aura = 200;
  let rounds = 0;
  let sawFarm = false;
  while (rounds < 30 && state.phase === 'playing' && !sawFarm) {
    rounds++;
    const seat = getCurrentPlayer(state).id;
    runAiTurn(state, 'hard', seat);
    if (state.farms.some(f => f.ownerId === 0)) sawFarm = true;
    endTurn(state);
  }
  check('a Farm gets built within the first 30 rounds even against Temple',
    sawFarm, `rounds checked=${rounds}`);
}

// Regression: pickObjective had NO priority at all for an unclaimed neutral/
// ruined strategic site — besiege/hunt only ever considered structures the
// ENEMY already owned, so a Temple unit never walked toward a neutral site
// unless it happened to already be standing on one. Confirmed via actual
// play, not just a synthetic scenario: Temple simply never captured either
// neutral site over an entire game.
console.log('\n=== Temple actively captures neutral strategic sites, not just by coincidence ===');
{
  const state = setup('temple', 'temple');
  for (const p of state.players) p.aura = 200;
  let rounds = 0;
  let firstCaptureRound: number | null = null;
  while (rounds < 60 && state.phase === 'playing' && firstCaptureRound === null) {
    rounds++;
    const seat = getCurrentPlayer(state).id;
    runAiTurn(state, 'hard', seat);
    if (state.strategicSites.some(s => s.state === 'temple' || s.founding)) firstCaptureRound = rounds;
    endTurn(state);
  }
  check('at least one neutral site is claimed or under founding within 60 rounds',
    firstCaptureRound !== null, `rounds checked=${rounds}`);
}

// Regression: neutral-site capture used to sit BELOW the mobile reserve
// check, so a merely-anticipated threat could tie up units in reserve duty
// before anyone was free to grab free income, and every unit picked its own
// individually-nearest open site with no memory — when several units
// started out clustered near the Capital, they'd all converge on the SAME
// site, leaving any other one completely unclaimed for many extra turns.
// Random Capital/site placement means a single trial occasionally lands on
// a genuinely slow/contested layout (e.g. a skirmish over the 2nd site) —
// a small batch with a majority threshold catches the real regression
// (converging on one site, leaving the other unclaimed for a very long
// time) without being flaky over legitimate one-off slow games.
console.log('\n=== Temple captures BOTH neutral sites promptly, not serially one at a time ===');
{
  const TRIALS = 5;
  let succeeded = 0;
  for (let t = 0; t < TRIALS; t++) {
    const state = setup('temple', 'temple');
    for (const p of state.players) p.aura = 200;
    let rounds = 0;
    let bothRound: number | null = null;
    while (rounds < 60 && state.phase === 'playing' && bothRound === null) {
      rounds++;
      const seat = getCurrentPlayer(state).id;
      runAiTurn(state, 'hard', seat);
      if (state.strategicSites.filter(s => s.state === 'temple' || s.founding).length >= 2) bothRound = rounds;
      endTurn(state);
    }
    if (bothRound !== null) succeeded++;
  }
  check(`both neutral sites are claimed or under founding within 60 rounds in most trials (${succeeded}/${TRIALS})`,
    succeeded >= TRIALS - 1);
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
