// Capture-accuracy diagnostic for the BC policy head (plan M2.3 / G2 triage).
//
// The BC trainer reports every action type at 25–65% top-1 EXCEPT `capture`,
// stuck at 0–1%. This tool loads a policy checkpoint and, over a SMALL number of
// hard-vs-hard games (default --n 5, so it's cheap when a core frees), measures
// the policy's behaviour AT EACH EXPERT DECISION against the hard-AI's choice:
//   • total decisions, and the count/fraction whose ground-truth type is capture
//   • capture top-1 AND top-3 accuracy (denominator = #expert-capture decisions)
//   • a confusion breakdown — when ground-truth is capture, what action type the
//     policy actually argmax-picks instead.
//
// Scores the FULL legal candidate set (no CAP), i.e. exactly what makePolicyBot
// would face at inference — so the confusion reflects real deployment behaviour.
//
// Usage: npx tsx ml/diagCapture.ts [--weights ml/weights/policy-bc1.json]
//                                  [--tag bc1] [--n 5] [--seed 900000]
// This REPLAYS games (forward passes) — do NOT run it while cores are saturated.
import { MLP } from './mlp';
import { scoreCandidates } from './policy';
import { legalMicros, Micro } from './gameEnv';
import { GameState } from '../src/types';
import { streamHardDecisions, matchMicro } from './bcRecord';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

// Indices of the `k` largest logits (k small → simple partial selection).
function topK(logits: Float64Array, k: number): number[] {
  const idx = Array.from(logits.keys());
  idx.sort((a, b) => logits[b]! - logits[a]!);
  return idx.slice(0, k);
}

(async () => {
  const tag = arg('tag', 'bc1')!;
  const weightsPath = arg('weights', `ml/weights/policy-${tag}.json`)!;
  const nGames = Number(arg('n', '5'));
  const seedBase = Number(arg('seed', '900000'));
  const net = MLP.load(weightsPath);

  let decisions = 0, unmatched = 0;
  const perType = new Map<string, { top1: number; top3: number; n: number }>();
  const captureConfusion = new Map<string, number>(); // GT=capture → π's argmax action type
  const t0 = Date.now();

  const scratch = { input: new Float64Array(net.sizes[0]!), act: new Float64Array(40) };

  const onMicro = (state: GameState, micro: Micro, pid: number) => {
    const cands = legalMicros(state);
    const eIdx = matchMicro(cands, micro);
    if (eIdx < 0) { unmatched++; return; }         // ≈never (fidelity=100%)
    decisions++;
    const logits = scoreCandidates(net, state, pid, cands, scratch);
    const top = topK(logits, 3);
    const hit1 = top[0] === eIdx ? 1 : 0;
    const hit3 = top.includes(eIdx) ? 1 : 0;
    const gt = micro.action;
    const pt = perType.get(gt) ?? { top1: 0, top3: 0, n: 0 };
    pt.top1 += hit1; pt.top3 += hit3; pt.n += 1; perType.set(gt, pt);
    if (gt === 'capture') {
      const picked = cands[top[0]!]!.action;
      captureConfusion.set(picked, (captureConfusion.get(picked) ?? 0) + 1);
    }
  };

  for (let g = 0; g < nGames; g++) {
    streamHardDecisions(seedBase + g, onMicro);
    console.log(`[diag] game ${g + 1}/${nGames} decisions=${decisions} captures=${perType.get('capture')?.n ?? 0} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  const cap = perType.get('capture') ?? { top1: 0, top3: 0, n: 0 };
  const capFrac = decisions ? cap.n / decisions : 0;
  console.log('\n===== CAPTURE DIAGNOSTIC =====');
  console.log(`weights=${weightsPath}  games=${nGames}  totalDecisions=${decisions}  unmatched=${unmatched}`);
  console.log(`capture decisions: ${cap.n}  (${(100 * capFrac).toFixed(2)}% of all decisions)`);
  console.log(`capture top-1: ${cap.n ? (100 * cap.top1 / cap.n).toFixed(1) : 'n/a'}%   top-3: ${cap.n ? (100 * cap.top3 / cap.n).toFixed(1) : 'n/a'}%   (denom=${cap.n})`);
  console.log('\nper-type top-1 / top-3 (denominator):');
  for (const [k, v] of [...perType.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(15)} top1=${(100 * v.top1 / v.n).toFixed(1).padStart(5)}%  top3=${(100 * v.top3 / v.n).toFixed(1).padStart(5)}%  (n=${v.n})`);
  }
  console.log('\nwhen GROUND-TRUTH=capture, policy actually picks:');
  for (const [k, c] of [...captureConfusion.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(15)} ${c}  (${cap.n ? (100 * c / cap.n).toFixed(1) : '0'}%)`);
  }
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch(e => { console.error(e); process.exit(1); });
