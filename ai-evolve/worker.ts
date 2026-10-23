// Child process: reads match jobs (JSON lines) on stdin, plays each and
// writes one MatchResult per line on stdout. Spawned by pool.ts.
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playMatch, setLegacyAi, type SideSpec } from './match';
import type { FactionId } from '../src/types';

export interface MatchJob {
  id: number;
  seed: number;
  sides: [SideSpec, SideSpec];
  factions: [FactionId, FactionId];
  maxRounds: number;
}

// LEGACY_AI_DIR: a checkout of the code before the evolved AI, for
// old-vs-new matches (SideSpec.legacy).
async function loadLegacy(): Promise<void> {
  const dir = process.env.LEGACY_AI_DIR;
  if (!dir) return;
  const ai = await import(pathToFileURL(join(dir, 'src/ai.ts')).href);
  const game = await import(pathToFileURL(join(dir, 'src/game.ts')).href);
  setLegacyAi({ runAiTurn: ai.runAiTurn, getCounters: game.getCounters, resetCounters: game.resetCounters });
}

loadLegacy().then(() => {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', line => {
    if (!line.trim()) return;
    const job = JSON.parse(line) as MatchJob;
    let out: unknown;
    try {
      out = { id: job.id, result: playMatch(job.seed, job.sides, job.factions, job.maxRounds) };
    } catch (e) {
      out = { id: job.id, error: String((e as Error)?.stack ?? e) };
    }
    process.stdout.write(JSON.stringify(out) + '\n');
  });
});
