// Runs match jobs across a pool of worker processes (one per core by default).
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { MatchJob } from './worker';
import type { MatchResult } from './match';

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));

export class MatchPool {
  private workers: ChildProcess[] = [];
  private idle: ChildProcess[] = [];
  private queue: MatchJob[] = [];
  private pending = new Map<number, { resolve: (r: MatchResult) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor(size = Math.max(1, cpus().length - 1)) {
    for (let i = 0; i < size; i++) {
      const w = spawn(process.execPath, ['--import', 'tsx', WORKER], { stdio: ['pipe', 'pipe', 'inherit'] });
      createInterface({ input: w.stdout! }).on('line', line => this.onResult(w, line));
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  run(job: Omit<MatchJob, 'id'>): Promise<MatchResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.queue.push({ ...job, id });
      this.pump();
    });
  }

  runAll(jobs: Omit<MatchJob, 'id'>[]): Promise<MatchResult[]> {
    return Promise.all(jobs.map(j => this.run(j)));
  }

  close(): void {
    for (const w of this.workers) w.stdin!.end();
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!;
      w.stdin!.write(JSON.stringify(this.queue.shift()) + '\n');
    }
  }

  private onResult(w: ChildProcess, line: string): void {
    const msg = JSON.parse(line) as { id: number; result?: MatchResult; error?: string };
    const p = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    this.idle.push(w);
    this.pump();
    if (!p) return;
    if (msg.result) p.resolve(msg.result); else p.reject(new Error(msg.error));
  }
}
