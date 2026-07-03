// Training pipeline for the value-net game bot.
//   Phase A — warm-start: regress V on outcomes of hard-AI-vs-hard-AI games.
//   Phase B — DAgger/self-play: generate games where the NN bot plays (vs hard
//             and vs itself, with exploration), add labelled states, retrain.
// Logs win-rate-vs-hard over time to docs/best-strategy-rl/training-curve.txt and
// checkpoints to ml/weights/. All counts configurable via env vars for tuning.
import { appendFileSync, writeFileSync, existsSync } from 'fs';
import { MLP } from './mlp';
import { runGame, hardTurn, makeValueBot, Sample, TurnFn } from './play';
import { evalVsHard } from './eval';
import { makeStream } from './rng';

const env = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const CURVE = '/Users/mark/Work/Personal/myAI/docs/best-strategy-rl/training-curve.txt';
const CKPT_DIR = 'ml/weights';
const TAG = process.env.TAG ?? 'v1';

const CFG = {
  hidden: [Number(process.env.H1 ?? 96), Number(process.env.H2 ?? 64)],
  lr: env('LR', 1e-3),
  warmGames: env('WARM_GAMES', 1500),
  iters: env('ITERS', 8),
  iterGames: env('ITER_GAMES', 220),
  epochsWarm: env('EPOCHS_WARM', 25),
  epochsIter: env('EPOCHS_ITER', 12),
  batch: env('BATCH', 256),
  evalN: env('EVAL_N', 80),
  bufferCap: env('BUFFER_CAP', 800000),
  // NB: use EXPLORE_TEMP, not TEMP — `TEMP` is the system temp-dir var that tsx
  // reads (setting it creates stray `<value>/tsx-0` cache dirs). Kept TEMP as a
  // fallback for older invocations.
  temp: env('EXPLORE_TEMP', env('TEMP', 0.05)),
  targetWR: env('TARGET_WR', 0.58),
};

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(CURVE, line + '\n');
}

process.on('uncaughtException', (e) => { try { appendFileSync(CURVE, `UNCAUGHT: ${e?.stack ?? e}\n`); } catch { /* */ } process.exit(1); });
process.on('unhandledRejection', (e) => { try { appendFileSync(CURVE, `UNHANDLED: ${(e as Error)?.stack ?? e}\n`); } catch { /* */ } process.exit(1); });

// Ring buffer of samples (store x as Float32 to halve memory).
class Buffer {
  xs: Float32Array[] = [];
  ys: number[] = [];
  cap: number;
  constructor(cap: number) { this.cap = cap; }
  add(samples: Sample[]) {
    for (const s of samples) { this.xs.push(Float32Array.from(s.x)); this.ys.push(s.y); }
    const over = this.xs.length - this.cap;
    if (over > 0) { this.xs.splice(0, over); this.ys.splice(0, over); }
  }
  get size() { return this.xs.length; }
}

function train(net: MLP, buf: Buffer, epochs: number, batch: number, rng: () => number): number {
  const N = buf.size;
  const idx = Array.from({ length: N }, (_, i) => i);
  let lastLoss = 0;
  for (let e = 0; e < epochs; e++) {
    // Fisher–Yates shuffle
    for (let i = N - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = idx[i]!; idx[i] = idx[j]!; idx[j] = t; }
    let loss = 0, nb = 0;
    for (let b = 0; b < N; b += batch) {
      const xs: Float64Array[] = [], ys: number[] = [];
      for (let k = b; k < Math.min(N, b + batch); k++) { xs.push(buf.xs[idx[k]!]! as unknown as Float64Array); ys.push(buf.ys[idx[k]!]!); }
      loss += net.trainBatch(xs, ys); nb++;
    }
    lastLoss = loss / nb;
  }
  return lastLoss;
}

async function main() {
  writeFileSync(CURVE, `# Best-Strategy value-net training (${TAG})\n# ${new Date().toISOString()}\n# cfg=${JSON.stringify(CFG)}\n`);
  const net = new MLP([73, ...CFG.hidden, 1], CFG.lr);
  const buf = new Buffer(CFG.bufferCap);
  const genRng = makeStream(12345);

  // ── Phase A: warm-start on hard-vs-hard outcomes ──
  log(`Phase A: generating ${CFG.warmGames} hard-vs-hard games...`);
  let tA = Date.now();
  for (let g = 0; g < CFG.warmGames; g++) {
    const r = runGame({ seed: 10000 + g, nPlayers: 2, forceFirst: g % 2, turns: [hardTurn, hardTurn], collect: true });
    buf.add(r.samples);
  }
  log(`Phase A: ${buf.size} samples in ${((Date.now() - tA) / 1000).toFixed(0)}s. Training ${CFG.epochsWarm} epochs...`);
  const l0 = train(net, buf, CFG.epochsWarm, CFG.batch, genRng);
  net.save(`${CKPT_DIR}/ckpt-${TAG}-warm.json`);
  let r = evalVsHard(net, CFG.evalN, 700000);
  log(`warm-start: loss=${l0.toFixed(4)} | NN-vs-hard ${r.wins}/${r.games} = ${(r.winRate * 100).toFixed(1)}% CI[${(r.ciLow * 100).toFixed(1)},${(r.ciHigh * 100).toFixed(1)}]`);
  let best = r.winRate; net.save(`${CKPT_DIR}/value-net-${TAG}.json`);

  // ── Phase B: DAgger / self-play refinement ──
  for (let it = 1; it <= CFG.iters; it++) {
    const tI = Date.now();
    const explore = makeValueBot(net, { temp: CFG.temp, rng: makeStream(9000 + it) });
    let gen = 0;
    for (let g = 0; g < CFG.iterGames; g++) {
      // Mix: 60% NN(explore) vs hard (both sides), 40% self-play NN vs NN
      const seed = 200000 + it * 10000 + g;
      const mode = g % 5;
      let turns: TurnFn[];
      if (mode < 2) turns = [explore, hardTurn];
      else if (mode < 4) turns = [hardTurn, explore];
      else turns = [explore, explore];
      const rr = runGame({ seed, nPlayers: 2, forceFirst: g % 2, turns, collect: true, collectEvery: 1 });
      buf.add(rr.samples); gen += rr.samples.length;
    }
    const loss = train(net, buf, CFG.epochsIter, CFG.batch, genRng);
    net.save(`${CKPT_DIR}/ckpt-${TAG}-it${it}.json`);
    r = evalVsHard(net, CFG.evalN, 700000);
    log(`iter ${it}: +${gen} samples (buf ${buf.size}), loss=${loss.toFixed(4)} | NN-vs-hard ${r.wins}/${r.games} = ${(r.winRate * 100).toFixed(1)}% CI[${(r.ciLow * 100).toFixed(1)},${(r.ciHigh * 100).toFixed(1)}] (${((Date.now() - tI) / 1000).toFixed(0)}s)`);
    if (r.winRate > best) { best = r.winRate; net.save(`${CKPT_DIR}/value-net-${TAG}.json`); net.save(`${CKPT_DIR}/value-net.json`); log(`  ↑ new best ${(best * 100).toFixed(1)}% → saved value-net.json`); }
    if (r.ciLow > 0.5 && r.winRate >= CFG.targetWR) { log(`TARGET reached at iter ${it} (winRate ${(r.winRate * 100).toFixed(1)}%, CI-low ${(r.ciLow * 100).toFixed(1)}%). Continuing to consolidate.`); }
  }
  log(`DONE. best small-eval win-rate = ${(best * 100).toFixed(1)}%. Final weights: ${CKPT_DIR}/value-net-${TAG}.json`);
}

main();
