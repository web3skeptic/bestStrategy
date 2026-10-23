// AI 2.0 Phase 9 — search telemetry/profiling verification. Confirms the
// always-on rolling aggregates (calls/nodes/timing/timeout rate/depth) and
// the optional per-call observer hook both work, using a short real AI-vs-
// AI run rather than synthetic calls — this is meant to reflect what a
// real game session's telemetry would actually look like.
//
// Run with: npx tsx scripts/verify-ai-search-telemetry.ts
import { createGameState, chooseFaction, getCurrentPlayer, endTurn } from '../src/game';
import { runAiTurn } from '../src/ai';
import { DEFAULT_GENOME } from '../src/aiGenome';
import {
  getSearchTelemetry, resetSearchTelemetry, setSearchObserver, SEARCH_CONFIG, type SearchTelemetryEvent,
} from '../src/aiSearch';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Search is a genome switch, and evolution may leave it off for the shipped
// Hard genome — play with one that has it on (the defaults) to exercise it.
function playTurns(difficulty: 'hard', turns: number): void {
  const state = createGameState();
  chooseFaction(state, 0, 'temple');
  chooseFaction(state, 1, 'temple');
  for (let i = 0; i < turns && state.phase === 'playing'; i++) {
    runAiTurn(state, difficulty, getCurrentPlayer(state).id, DEFAULT_GENOME);
    endTurn(state);
  }
}

console.log('\n=== telemetry starts empty and resetSearchTelemetry clears it ===');
{
  resetSearchTelemetry();
  const before = getSearchTelemetry('hard');
  check('calls=0 before any search has run', before.calls === 0);
  playTurns('hard', 60);
  const afterPlay = getSearchTelemetry('hard');
  check('calls > 0 after real play', afterPlay.calls > 0, `calls=${afterPlay.calls}`);
  resetSearchTelemetry();
  const afterReset = getSearchTelemetry('hard');
  check('reset brings calls back to 0', afterReset.calls === 0);
}

console.log('\n=== aggregates look sane after a real Hard run ===');
{
  resetSearchTelemetry();
  playTurns('hard', 120);
  const hard = getSearchTelemetry('hard');
  const budget = SEARCH_CONFIG.hard.timeBudgetMs;
  check('hard recorded at least one real search call', hard.calls > 0, `calls=${hard.calls}`);
  check('hard: avgNodesVisited is positive', hard.avgNodesVisited > 0, `avg=${hard.avgNodesVisited}`);
  check('hard: avgDepthReached is at least 2 (one full iterative-deepening pass)', hard.avgDepthReached >= 2, `avg=${hard.avgDepthReached}`);
  check(`hard: avgElapsedMs is well under its own per-call time budget (${budget}ms)`, hard.avgElapsedMs < budget, `avg=${hard.avgElapsedMs}`);
  check('hard: maxElapsedMs never exceeds its own per-call time budget by an unreasonable margin',
    hard.maxElapsedMs < budget + 700, `max=${hard.maxElapsedMs}`);
  check('timeoutRate is a fraction between 0 and 1', hard.timeoutRate >= 0 && hard.timeoutRate <= 1);
  // Easy/Medium never search — telemetry for them should stay untouched.
  const easy = getSearchTelemetry('easy');
  check('easy has zero calls (search is disabled for it)', easy.calls === 0);
}

console.log('\n=== the observer hook fires once per real search call, with a sane event shape ===');
{
  resetSearchTelemetry();
  const events: SearchTelemetryEvent[] = [];
  setSearchObserver(e => events.push(e));
  playTurns('hard', 60);
  setSearchObserver(null);
  const summary = getSearchTelemetry('hard');
  check('observer fired at least once', events.length > 0, `events=${events.length}`);
  check('observer call count matches the aggregate call count', events.length === summary.calls,
    `events=${events.length} summary.calls=${summary.calls}`);
  check('every event has a sane shape', events.every(e =>
    (e.kind === 'searchBestAction' || e.kind === 'searchBestActivation')
    && e.difficulty === 'hard' && e.nodesVisited >= 0 && e.depthReached >= 0 && e.elapsedMs >= 0));
}

console.log('\n=== setSearchObserver(null) actually detaches — no further calls after that ===');
{
  resetSearchTelemetry();
  let calls = 0;
  setSearchObserver(() => { calls++; });
  playTurns('hard', 30);
  const afterFirst = calls;
  setSearchObserver(null);
  playTurns('hard', 30);
  check('no more observer calls arrive once detached', calls === afterFirst, `before=${afterFirst} after=${calls}`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
