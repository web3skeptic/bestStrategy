// Resumable, self-documenting run infrastructure (plan M1.2). Every training/eval
// run gets runs/<tag>/ with: meta.json (config + git rev + seed ranges + host),
// a 60s heartbeat, per-iteration checkpoints, and progress.json for --resume.
// Checkpoint + progress writes are ATOMIC (write tmp → rename) so a kill -9 never
// leaves a half-written file — resume always lands on the last COMPLETE iteration.
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, appendFileSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';

const REPO = '/opt/best-strategy';

export interface RunHandle { dir: string; tag: string; }

export function initRun(tag: string, config: unknown, seedRanges?: unknown): RunHandle {
  const dir = `${REPO}/runs/${tag}`;
  mkdirSync(dir, { recursive: true });
  const metaPath = `${dir}/meta.json`;
  if (!existsSync(metaPath)) {
    let gitRev = 'unknown';
    try { gitRev = execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim(); } catch { /* ignore */ }
    writeFileSync(metaPath, JSON.stringify({
      tag, config, gitRev, seedRanges, host: os.hostname(),
      node: process.version, startedAt: new Date().toISOString(),
    }, null, 2));
  }
  return { dir, tag };
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path); // atomic on same filesystem
}

export function heartbeat(h: RunHandle, info: Record<string, unknown>): void {
  const line = { t: new Date().toISOString(), ...info };
  atomicWrite(`${h.dir}/heartbeat.json`, JSON.stringify(line));
  appendFileSync(`${h.dir}/heartbeat.log`, JSON.stringify(line) + '\n');
}

export function logLine(h: RunHandle, msg: string): void {
  appendFileSync(`${h.dir}/run.log`, `${new Date().toISOString()} ${msg}\n`);
}

// Save a named JSON checkpoint atomically (e.g. progress, metrics). For MLP
// weights use MLP.save to a tmp path then this rename helper via saveWeights.
export function saveJSON(h: RunHandle, name: string, obj: unknown): void {
  atomicWrite(`${h.dir}/${name}`, JSON.stringify(obj));
}

export function readJSON<T = unknown>(h: RunHandle, name: string): T | null {
  const p = `${h.dir}/${name}`;
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; }
}

// Progress used by --resume: {iter, ...}. saveProgress is the LAST thing written
// per iteration, AFTER the iteration's weights checkpoint, so its presence proves
// that iteration completed.
export function saveProgress(h: RunHandle, progress: Record<string, unknown>): void {
  saveJSON(h, 'progress.json', progress);
}
export function readProgress(h: RunHandle): Record<string, unknown> | null {
  return readJSON<Record<string, unknown>>(h, 'progress.json');
}

export function checkpointPath(h: RunHandle, name: string): string {
  return `${h.dir}/${name}`;
}
