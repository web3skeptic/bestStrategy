// Persistent pool worker. Reads one JSON game-job per stdin line, runs the full
// game with the two (or N) bots built from serializable specs, writes one JSON
// result line to stdout. Each worker is its own process → its own seeded
// Math.random (ml/rng.ts), so results are deterministic per seed regardless of
// which worker runs a job (games run strictly one at a time per worker).
import readline from 'readline';
import { runGame } from './play';
import { buildTurnFn, BotSpec } from './botSpec';

interface JobMsg {
  id: number; seed: number; forceFirst?: number; slots: BotSpec[];
  maxRounds?: number; maxDecisions?: number; nPlayers?: number;
  collect?: boolean; collectEvery?: number;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  let job: JobMsg;
  try { job = JSON.parse(line); } catch (e) { process.stdout.write(JSON.stringify({ error: String(e) }) + '\n'); return; }
  try {
    const turns = job.slots.map(sp => buildTurnFn(sp));
    const r = runGame({
      seed: job.seed, forceFirst: job.forceFirst, turns, nPlayers: job.nPlayers,
      maxRounds: job.maxRounds, maxDecisions: job.maxDecisions ?? 1e9,
      collect: job.collect, collectEvery: job.collectEvery,
    });
    const out: Record<string, unknown> = { id: job.id, winner: r.winner, rounds: r.rounds, halfTurns: r.halfTurns };
    if (job.collect) {
      // Emit samples compactly: [ [y, ...x], ... ]. Kept off the hot eval path.
      out.samples = r.samples.map(sm => [sm.y, ...Array.from(sm.x)]);
    }
    process.stdout.write(JSON.stringify(out) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id: job.id, error: String((e as Error)?.stack ?? e) }) + '\n');
  }
});
rl.on('close', () => process.exit(0));
