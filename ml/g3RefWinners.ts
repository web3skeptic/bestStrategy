// Ground-truth winners array from the UNMODIFIED gate path (evalPool, exact G3
// config). Used to assert g3LossBuckets' instrumented replay reproduces the same
// per-game W/L (non-perturbation + faithful gate reproduction). Emits JSON:
//   { winners:[...], botSlot:[...], losingGameIds:[...], wins, losses }
import { evalPool } from './evalPool';
import { BotSpec } from './botSpec';
import * as fs from 'fs';

(async () => {
  const bot: BotSpec = { kind: 'policy-search', weights: 'ml/weights/policy-g2.json',
    valueWeights: 'ml/weights/value-net-v2mc-best.json', K: 12, temp: 1, leaf: 'blend', depth: 1 };
  const r = await evalPool({ bot, opp: { kind: 'hard' }, n: 100, seedBase: 800000,
    workers: Number(process.env.ML_WORKERS ?? 3) });
  // botSlot mirrors evalPool internal: even gameId → slot0, odd → slot1.
  const botSlot = r.winners.map((_, i) => i % 2);
  const losingGameIds: number[] = [];
  r.winners.forEach((w, i) => { if (w !== botSlot[i]) losingGameIds.push(i); });
  const out = { winners: r.winners, botSlot, losingGameIds, wins: r.wins, losses: r.losses, draws: r.draws };
  fs.writeFileSync('/tmp/g3buckets/ref-winners.json', JSON.stringify(out, null, 0));
  console.log(`REF ${r.wins}W ${r.losses}L ${r.draws}D  losing gameIds=[${losingGameIds.join(',')}]`);
})().catch(e => { console.error(e); process.exit(1); });
