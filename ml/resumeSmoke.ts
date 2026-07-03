// M1.2 acceptance smoke: a deterministic iterative "run" that checkpoints every
// iteration via ml/runs.ts. Killing it mid-run and resuming must reproduce the
// SAME final metric as an uninterrupted run (final depends only on #iters, not
// timing). Not part of the trained pipeline — just proves resumability.
import { initRun, heartbeat, saveJSON, readProgress, saveProgress, logLine } from './runs';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
// Deterministic mix so acc is a pure function of the set of iters applied.
function mix(acc: number, iter: number): number {
  let x = (acc ^ (iter * 2654435761)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0x297a2d39) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  const tag = arg('tag', 'resume-smoke')!;
  const iters = Number(arg('iters', '10'));
  const delayMs = Number(arg('delay', '300'));
  const h = initRun(tag, { iters, delayMs, kind: 'resume-smoke' });

  const prog = readProgress(h);
  let iter = prog ? Number(prog.iter) : 0;
  let acc = prog ? Number(prog.acc) : 0x9e3779b9;
  if (prog) console.log(`RESUME from iter=${iter} acc=${acc}`);

  for (; iter < iters; iter++) {
    acc = mix(acc, iter);
    // atomic checkpoint THEN progress (progress last = iter complete)
    saveJSON(h, `ckpt-it${iter}.json`, { iter, acc });
    saveProgress(h, { iter: iter + 1, acc });
    heartbeat(h, { iter: iter + 1, acc });
    logLine(h, `iter ${iter} done acc=${acc}`);
    console.log(`iter ${iter} acc=${acc}`);
    await sleep(delayMs);
  }
  console.log(`FINAL tag=${tag} iters=${iters} acc=${acc}`);
})();
