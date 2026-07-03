import { reset, legalMicros, applyMicro, cloneState, isAlive, Micro } from './gameEnv';
import { featurize, FEATURE_DIM } from './features';
import { runHardAITurn } from '../src/ai';
import { endTurn, getPopulationCap, getPopulationCount } from '../src/game';
import { GameState } from '../src/types';
import { makeStream } from './rng';

type Policy = (s: GameState) => void; // plays ONE full turn incl. end-turn

const randomPolicy = (rng: () => number): Policy => (s) => {
  for (let k = 0; k < 30; k++) {
    const micros = legalMicros(s);
    if (micros.length === 0) break;
    const m = micros[Math.floor(rng() * micros.length)]!;
    applyMicro(s, m);
    if (m.action === 'end-turn' || s.phase !== 'playing') return;
  }
  if (s.phase === 'playing') endTurn(s); // safety cap → force end
};

const hardPolicy: Policy = (s) => { runHardAITurn(s); if (s.phase === 'playing') endTurn(s); };

interface GameResult { winner: number | null; rounds: number; halfTurns: number; micros: number; violations: string[]; }

function playGame(seed: number, policies: Policy[], maxRounds = 300): GameResult {
  const s = reset({ seed, nPlayers: policies.length });
  const violations: string[] = [];
  let half = 0, micros = 0;
  const elim = new Set<number>();
  const check = (w: string) => {
    for (const p of s.players) if (p.aura < 0) violations.push(`${w}: p${p.id} aura<0`);
    for (const u of s.units) if (u.hp < 0) violations.push(`${w}: unit hp<0`);
    for (const p of s.players) { if (!isAlive(s, p.id)) elim.add(p.id); else if (elim.has(p.id)) violations.push(`${w}: p${p.id} revived`); }
    if (s.phase === 'playing' && !isAlive(s, s.currentPlayerIndex)) violations.push(`${w}: curIdx dead`);
  };
  while (s.phase === 'playing' && s.turnNumber <= maxRounds) {
    const before = micros;
    const pol = policies[s.currentPlayerIndex]!;
    // count micros for random/hard via legalMicros length proxy is hard; approximate by turn.
    pol(s);
    micros = before + 1;
    half++;
    check('turn');
    if (half > maxRounds * policies.length) { violations.push('did not terminate'); break; }
  }
  return { winner: s.winner ? s.winner.id : null, rounds: s.turnNumber, halfTurns: half, micros, violations };
}

console.log('=== STEP 0: RL env verification ===');
console.log('FEATURE_DIM =', FEATURE_DIM);

// 1) Determinism: same seed → identical result twice (hard vs hard)
{
  const a = playGame(123, [hardPolicy, hardPolicy]);
  const b = playGame(123, [hardPolicy, hardPolicy]);
  const same = a.winner === b.winner && a.rounds === b.rounds && a.halfTurns === b.halfTurns;
  console.log(`determinism(hard,seed123): ${same ? 'OK' : 'FAIL'} (a=${JSON.stringify(a.winner)}/${a.rounds}, b=${JSON.stringify(b.winner)}/${b.rounds})`);
}

// 2) Invariants over hard-vs-hard games (terminate fast) + a few short random games
{
  let viol = 0, term = 0, games = 0;
  for (let g = 0; g < 16; g++) {
    const r = playGame(2000 + g, [hardPolicy, hardPolicy], 200);
    games++; viol += r.violations.length; if (r.violations.length === 0) term++;
    if (r.violations.length) console.log('  hard viol:', r.violations.slice(0, 3));
  }
  for (let g = 0; g < 4; g++) {
    const r = playGame(1000 + g, [randomPolicy(makeStream(g * 3 + 1)), randomPolicy(makeStream(g * 3 + 2))], 40);
    games++; viol += r.violations.length; if (r.violations.length === 0) term++;
    if (r.violations.length) console.log('  random viol:', r.violations.slice(0, 3));
  }
  console.log(`invariants: ${viol === 0 ? 'ALL OK' : viol + ' VIOLATIONS'} over ${games} games (${term} clean/terminated)`);
}

// 3) Clone correctness: clone, apply an action, original must be unchanged
{
  const s = reset({ seed: 55, nPlayers: 2 });
  const micros = legalMicros(s);
  const before = JSON.stringify({ aura: s.players.map(p => p.aura), units: s.units.length, cur: s.currentPlayerIndex });
  const c = cloneState(s);
  // apply several micros on the clone
  for (let k = 0; k < 5; k++) { const m = legalMicros(c); if (!m.length) break; applyMicro(c, m[0]!); if (c.phase !== 'playing') break; }
  const after = JSON.stringify({ aura: s.players.map(p => p.aura), units: s.units.length, cur: s.currentPlayerIndex });
  console.log(`clone isolation: ${before === after ? 'OK (original untouched)' : 'FAIL (mutated original)'}`);
}

// 4a) Speed: full hard-vs-hard games/sec (training/eval will use hard + NN turns)
{
  const t0 = Date.now();
  let gc = 0, half = 0;
  while (Date.now() - t0 < 2000) { const r = playGame(9000 + gc, [hardPolicy, hardPolicy], 200); half += r.halfTurns; gc++; }
  const secs = (Date.now() - t0) / 1000;
  console.log(`speed(games): ${(gc / secs).toFixed(0)} hard-vs-hard games/s, ${(half / secs).toFixed(0)} turns/s`);
}
// 4b) Speed: the lookahead primitive — clone + applyMicro throughput
{
  const s = reset({ seed: 42, nPlayers: 2 });
  for (let k = 0; k < 6; k++) hardPolicy(s); // advance to a busy mid-game
  const micros = legalMicros(s);
  const t0 = Date.now(); let n = 0;
  while (Date.now() - t0 < 1500) { const c = cloneState(s); applyMicro(c, micros[n % micros.length]!); n++; }
  const secs = (Date.now() - t0) / 1000;
  console.log(`speed(lookahead): ${(n / secs / 1000).toFixed(1)}k clone+apply/s  (mid-game legalMicros=${micros.length})`);
}

// 5) Feature sanity: no NaN, finite
{
  const s = reset({ seed: 3, nPlayers: 2 });
  runHardAITurn(s); // advance a bit
  const f0 = featurize(s, 0), f1 = featurize(s, 1);
  const bad = [...f0, ...f1].some(x => !Number.isFinite(x));
  const mag = Math.max(...[...f0, ...f1].map(Math.abs));
  console.log(`features: ${bad ? 'HAS NaN/Inf' : 'finite OK'}, max|feat|=${mag.toFixed(2)}, dim=${f0.length}`);
}
console.log('=== done ===');
