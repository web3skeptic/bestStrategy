// M3.2 — policy-search sweep driver. Runs a grid of turn-search-over-π configs
// vs the hard AI (side + first-move alternation via evalPool) and appends one
// JSONL record per config. Proposer π and leaf V are fixed per run; the grid
// varies K / temp / depth / leaf. Reuses evalPool (the standard M1+ eval tool) so
// results match a single-config `ml/evalPool.ts --mode policy-search` invocation.
//
// Usage:
//   npx tsx ml/psweep.ts --proposer ml/weights/policy-g2.json \
//     --vweights ml/weights/value-net-v2mc-best.json --n 40 --seed 700000 \
//     --workers 4 --out /tmp/m32-results.jsonl
import { evalPool } from './evalPool';
import { BotSpec, describeBot } from './botSpec';
import { appendFileSync } from 'fs';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const proposer = arg('proposer', 'ml/weights/policy-g2.json')!;
const vweights = arg('vweights', 'ml/weights/value-net-v2mc-best.json')!;
const n = Number(arg('n', '40'));
const seedBase = Number(arg('seed', '700000'));
const workers = Number(arg('workers', '4'));
const out = arg('out', '/tmp/m32-results.jsonl')!;

type Cfg = { K: number; temp: number; depth: number; leaf: 'V' | 'blend' };
const grid: Cfg[] = [];
for (const leaf of ['V', 'blend'] as const)
  for (const temp of [0.5, 1.0])
    for (const K of [4, 8, 12]) {
      grid.push({ K, temp, depth: 1, leaf });
      if (K <= 4) grid.push({ K, temp, depth: 2, leaf }); // depth=2 only at K<=4
    }

(async () => {
  console.log(`M3.2 sweep: proposer=${proposer} V=${vweights} n=${n} seed=${seedBase} workers=${workers} → ${out}`);
  console.log(`${grid.length} configs`);
  const t0 = Date.now();
  for (let gi = 0; gi < grid.length; gi++) {
    const c = grid[gi]!;
    const bot: BotSpec = { kind: 'policy-search', weights: proposer, valueWeights: vweights,
      K: c.K, temp: c.temp, depth: c.depth, leaf: c.leaf };
    const ct0 = Date.now();
    const r = await evalPool({ bot, n, seedBase, workers });
    const secs = +((Date.now() - ct0) / 1000).toFixed(0);
    const rec = { proposer, vweights, K: c.K, temp: c.temp, depth: c.depth, leaf: c.leaf,
      n: r.games, wins: r.wins, losses: r.losses, draws: r.draws,
      winRate: +r.winRate.toFixed(4), ciLow: +r.ciLow.toFixed(4), ciHigh: +r.ciHigh.toFixed(4), secs };
    appendFileSync(out, JSON.stringify(rec) + '\n');
    console.log(`[${gi + 1}/${grid.length}] ${describeBot(bot)}: ${r.wins}W ${r.losses}L ${r.draws}D = ${(r.winRate * 100).toFixed(1)}%  CI[${(r.ciLow * 100).toFixed(1)},${(r.ciHigh * 100).toFixed(1)}]  ${secs}s  (elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log(`DONE sweep in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${out}`);
})().catch(e => { console.error(e); process.exit(1); });
