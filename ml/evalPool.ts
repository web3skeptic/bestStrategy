// Pooled NN-vs-opponent evaluation with side + first-move alternation (same
// protocol as ml/eval.ts) but parallelised over the worker pool. The standard
// eval/probe tool for M1+. Deterministic per seed → single- vs multi-worker runs
// are identical (verify with --check).
import { runJobsPool, GameJob, GameResult } from './pool';
import { BotSpec } from './botSpec';
import { wilson } from './eval';

export interface EvalPoolOpts {
  bot: BotSpec; opp?: BotSpec; n: number; seedBase: number; workers?: number;
  maxRounds?: number; maxDecisions?: number;
  onProgress?: (done: number, total: number, wins: number) => void;
}
export interface EvalPoolResult {
  wins: number; losses: number; draws: number; games: number;
  winRate: number; ciLow: number; ciHigh: number; winners: (number | null)[];
}

export async function evalPool(o: EvalPoolOpts): Promise<EvalPoolResult> {
  const opp = o.opp ?? { kind: 'hard' as const };
  const jobs: GameJob[] = [];
  const botSlot: number[] = [];
  const pairs = Math.ceil(o.n / 2);
  let idx = 0;
  for (let i = 0; i < pairs && idx < o.n; i++) {
    const seed = o.seedBase + i;
    const forceFirst = i % 2;
    jobs.push({ id: idx, seed, forceFirst, slots: [o.bot, opp], maxRounds: o.maxRounds, maxDecisions: o.maxDecisions ?? 1e9 });
    botSlot[idx] = 0; idx++;
    if (idx >= o.n) break;
    jobs.push({ id: idx, seed, forceFirst, slots: [opp, o.bot], maxRounds: o.maxRounds, maxDecisions: o.maxDecisions ?? 1e9 });
    botSlot[idx] = 1; idx++;
  }
  let wins = 0;
  const results = await runJobsPool(jobs, {
    workers: o.workers,
    onResult: (r: GameResult, done: number) => {
      if (r.winner === botSlot[r.id]) wins++;
      o.onProgress?.(done, jobs.length, wins);
    },
  });
  wins = 0; let losses = 0, draws = 0;
  const winners: (number | null)[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const w = results[i]!.winner;
    winners.push(w);
    if (w === botSlot[i]) wins++; else if (w === null) draws++; else losses++;
  }
  const games = wins + losses + draws;
  const [lo, hi] = wilson(wins, games);
  return { wins, losses, draws, games, winRate: wins / games, ciLow: lo, ciHigh: hi, winners };
}

// ── CLI ──
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function buildSpec(): BotSpec {
  const mode = arg('mode', 'search')!;
  const weights = arg('weights', 'ml/weights/value-net-main.json')!;
  if (mode === 'greedy') return { kind: 'greedy', weights, margin: Number(arg('margin', '0')) };
  if (mode === 'policy') return { kind: 'policy', weights, temp: Number(arg('temp', '0')) };
  if (mode === 'policy-search') return { kind: 'policy-search', weights, valueWeights: arg('vweights', 'ml/weights/value-net-main.json'),
    K: Number(arg('K', '8')), temp: Number(arg('temp', '1.0')), leaf: (arg('leaf', 'V') as 'V' | 'H' | 'blend'), depth: Number(arg('depth', '1')) };
  return { kind: 'search', weights, K: Number(arg('K', '6')), margin: Number(arg('margin', '0')),
    temp: Number(arg('temp', '0.12')), leaf: (arg('leaf', 'V') as 'V' | 'H' | 'blend') };
}

if (process.argv[1] && process.argv[1].endsWith('evalPool.ts')) {
  (async () => {
    const bot = buildSpec();
    const n = Number(arg('n', '200'));
    const seedBase = Number(arg('seed', '700000'));
    const workers = Number(arg('workers', process.env.ML_WORKERS ?? '3'));
    const check = process.argv.includes('--check');
    const t0 = Date.now();
    if (check) {
      const nCheck = Number(arg('n', '20'));
      const a = await evalPool({ bot, n: nCheck, seedBase, workers: 1 });
      const b = await evalPool({ bot, n: nCheck, seedBase, workers: 3 });
      const same = JSON.stringify(a.winners) === JSON.stringify(b.winners);
      console.log(`DETERMINISM CHECK (n=${nCheck}): W1 winners == W3 winners ? ${same ? 'IDENTICAL ✓' : 'DIFFER ✗'}`);
      console.log(`  W1: ${a.wins}W ${a.losses}L ${a.draws}D  ${JSON.stringify(a.winners)}`);
      console.log(`  W3: ${b.wins}W ${b.losses}L ${b.draws}D  ${JSON.stringify(b.winners)}`);
      process.exit(same ? 0 : 1);
    }
    let last = 0;
    const r = await evalPool({ bot, n, seedBase, workers, onProgress: (done, total, wins) => {
      if (done - last >= 20 || done === total) { last = done; console.log(`  ... ${done}/${total} (W${wins}) ${((Date.now() - t0) / 1000).toFixed(0)}s`); }
    } });
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`\nEVAL ${JSON.stringify(bot)}`);
    console.log(`NN vs opp: ${r.wins}W ${r.losses}L ${r.draws}D / ${r.games} = ${(r.winRate * 100).toFixed(1)}%  Wilson95 [${(r.ciLow * 100).toFixed(1)}, ${(r.ciHigh * 100).toFixed(1)}]  in ${secs}s (${workers}w)`);
    console.log(r.ciLow > 0.5 ? 'RESULT: beats opponent (CI-low > 50%)' : 'RESULT: not proven > 50%');
  })().catch(e => { console.error(e); process.exit(1); });
}
