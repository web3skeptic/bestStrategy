// Child-process worker pool for running game jobs in parallel. Persistent workers
// (spawned once) each hold ≤1 in-flight job → clean load-balancing and strict
// per-worker sequential execution (required for RNG determinism). Robust to jobs
// of very different cost (big-K search vs greedy). Worker count = ML_WORKERS env
// (default 3 on this 4-core box).
import { spawn, ChildProcess } from 'child_process';
import readline from 'readline';
import { existsSync } from 'fs';
import { BotSpec } from './botSpec';

export interface GameJob {
  id: number; seed: number; forceFirst?: number; slots: BotSpec[];
  maxRounds?: number; maxDecisions?: number; nPlayers?: number;
  collect?: boolean; collectEvery?: number;
}
export interface GameResult {
  id: number; winner: number | null; rounds: number; halfTurns: number;
  samples?: number[][]; error?: string;
}

const REPO = '/opt/best-strategy';
const TSX = `${REPO}/node_modules/.bin/tsx`;

function spawnWorker(): ChildProcess {
  const bin = existsSync(TSX) ? TSX : 'npx';
  const args = existsSync(TSX) ? ['ml/poolWorker.ts'] : ['tsx', 'ml/poolWorker.ts'];
  return spawn(bin, args, { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'] });
}

// Run all jobs across a pool. job.id MUST equal its index in `jobs`. Resolves to
// results aligned by index. `onResult` fires as each completes (for progress).
export function runJobsPool(
  jobs: GameJob[],
  opts: { workers?: number; onResult?: (r: GameResult, doneCount: number) => void } = {},
): Promise<GameResult[]> {
  const W = Math.max(1, Math.min(opts.workers ?? Number(process.env.ML_WORKERS ?? 3), jobs.length || 1));
  return new Promise((resolve, reject) => {
    const results: GameResult[] = new Array(jobs.length);
    let next = 0, done = 0, settled = false;
    const workers: ChildProcess[] = [];

    const cleanup = () => { for (const cp of workers) { try { cp.stdin?.end(); } catch {} try { cp.kill(); } catch {} } };
    const finish = () => { if (settled) return; settled = true; cleanup(); resolve(results); };
    const fail = (e: unknown) => { if (settled) return; settled = true; cleanup(); reject(e instanceof Error ? e : new Error(String(e))); };

    const feed = (cp: ChildProcess) => {
      if (next < jobs.length) { cp.stdin!.write(JSON.stringify(jobs[next]) + '\n'); next++; }
      else { try { cp.stdin!.end(); } catch {} }
    };

    for (let w = 0; w < W; w++) {
      const cp = spawnWorker();
      workers.push(cp);
      const rl = readline.createInterface({ input: cp.stdout! });
      rl.on('line', (raw) => {
        const line = raw.trim();
        if (!line) return;
        let r: GameResult;
        try { r = JSON.parse(line); } catch (e) { return fail(e); }
        if (r.error) return fail(new Error(`worker job ${r.id}: ${r.error}`));
        results[r.id] = r; done++;
        try { opts.onResult?.(r, done); } catch {}
        if (done >= jobs.length) return finish();
        feed(cp);
      });
      cp.on('error', fail);
      cp.on('exit', (code) => { if (!settled && code && code !== 0) fail(new Error(`worker exited ${code}`)); });
    }
    // Prime: one job per worker.
    for (let w = 0; w < W; w++) feed(workers[w]!);
  });
}
