// STEP-0 feed-forward (M4): bucket g2-search's Gate-G3 losses by RECOVERY PATH.
// Reproduces the EXACT G3 gate games (policy-search g2, K=12/temp=1/depth=1,
// leaf=blend, V=v2mc-best, vs hard, seed-800k, 100 games via evalPool's pairing)
// and instruments the bot's turns to record, at each bot decision:
//   • turn-start capture OPPORTUNITIES (units already on a capturable temple) + stakes
//   • temples owned before/after the committed turn → captures actually performed
// Determinism: the wrapper only READS state (no Math.random calls) and invokes the
// real search TurnFn exactly once per turn, so the RNG stream is bit-identical to the
// gate run (reset(seed) reseeds the global stream per game).
//
// Buckets (m4-planning-notes 3-bucket scheme) applied to each LOST game:
//   1 SAMPLING  — a PIVOTAL-WIN capture was available at a turn-start but not
//                 converted → search-sampling/terminal-short-circuit failed to emit it
//   2 V-MISRANK — no missed pivotal-win, but a valuable non-terminal capture
//                 (HIGH / PIVOTAL-ELIM) was available and not taken → V ranked the
//                 non-capturing turn higher
//   3 GENERAL   — no capture opportunity missed → lost on general/positional play
//
// Usage: npx tsx ml/g3LossBuckets.ts --lo 0 --hi 50 --out /tmp/g3buckets/shard.jsonl
//   (--lo/--hi are PAIR indices, 0..50; each pair = 2 games, matching evalPool)
import { runGame } from './play';
import { hardTurn } from './play';
import { makePolicySearchBot } from './searchPolicy';
import { MLP } from './mlp';
import { featurize } from './features';
import { heuristicLeaf } from './heuristicLeaf';
import { canCaptureTemple } from '../src/game';
import { GameState } from '../src/types';
import { TurnFn } from './play';
import * as fs from 'fs';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const POLICY = 'ml/weights/policy-g2.json';
const VALUE = 'ml/weights/value-net-v2mc-best.json';
const K = 12, TEMP = 1, DEPTH = 1;
const SEED_BASE = 800000;

interface CapOpp { klass: string; level: number; templeId: string }
interface TurnRow { turn: number; myBefore: number; myAfter: number; total: number; capOpps: CapOpp[] }

function classify(s: GameState, pid: number, capOpps: CapOpp[]): void {
  const total = s.temples.length;
  const myBefore = s.temples.filter(t => t.ownerId === pid).length;
  for (const u of s.units) {
    if (u.hp <= 0 || u.playerId !== pid) continue;
    const t = canCaptureTemple(s, u);
    if (!t) continue;
    const winsGame = myBefore + 1 === total;
    const prevOwner = t.ownerId;
    const prevCount = prevOwner === null ? 0 : s.temples.filter(x => x.ownerId === prevOwner).length;
    const prevLast = prevOwner !== null && prevCount === 1;
    const klass = winsGame ? 'PIVOTAL-WIN' : prevLast ? 'PIVOTAL-ELIM' : t.level >= 2 ? 'HIGH' : 'MINOR';
    capOpps.push({ klass, level: t.level, templeId: t.id });
  }
}

function makeInstrumentedBot(botId: number, rows: TurnRow[]): TurnFn {
  const pnet = MLP.load(POLICY);
  const vnet = MLP.load(VALUE);
  const leaf = (st: GameState, b: number) => 0.5 * vnet.value(featurize(st, b)) + 0.5 * heuristicLeaf(st, b);
  const real = makePolicySearchBot(pnet, vnet, hardTurn, { K, temp: TEMP, leaf, depth: DEPTH });
  return (s) => {
    const pid = s.currentPlayerIndex; // == botId
    const total = s.temples.length;
    const myBefore = s.temples.filter(t => t.ownerId === pid).length;
    const capOpps: CapOpp[] = [];
    classify(s, pid, capOpps);
    const turn = s.turnNumber;
    real(s); // consume RNG exactly as the gate did (Object.assign mutates s in place)
    const myAfter = s.temples.filter(t => t.ownerId === pid).length;
    rows.push({ turn, myBefore, myAfter, total, capOpps });
  };
}

interface GameRec {
  gameId: number; seed: number; forceFirst: number; botSlot: number;
  winner: number | null; won: boolean; rows: TurnRow[];
}

function runOne(gameId: number, seed: number, forceFirst: number, botSlot: number): GameRec {
  const rows: TurnRow[] = [];
  const bot = makeInstrumentedBot(botSlot, rows);
  const turns: TurnFn[] = botSlot === 0 ? [bot, hardTurn] : [hardTurn, bot];
  const r = runGame({ seed, forceFirst, turns, maxRounds: 90, maxDecisions: 1e9 });
  return { gameId, seed, forceFirst, botSlot, winner: r.winner, won: r.winner === botSlot, rows };
}

(function main() {
  const lo = Number(arg('lo', '0'));
  const hi = Number(arg('hi', '50'));
  const out = arg('out', '/tmp/g3buckets/shard.jsonl')!;
  fs.mkdirSync(require('path').dirname(out), { recursive: true });
  const fd = fs.openSync(out, 'w');
  // Mirror evalPool pairing exactly: pair i → seed=SEED_BASE+i, forceFirst=i%2,
  // game 2i = [bot,hard] (botSlot 0), game 2i+1 = [hard,bot] (botSlot 1).
  for (let i = lo; i < hi; i++) {
    const seed = SEED_BASE + i;
    const forceFirst = i % 2;
    for (const botSlot of [0, 1]) {
      const gameId = 2 * i + botSlot;
      const rec = runOne(gameId, seed, forceFirst, botSlot);
      fs.writeSync(fd, JSON.stringify(rec) + '\n');
      process.stderr.write(`  game ${gameId} seed=${seed} slot=${botSlot} → ${rec.won ? 'W' : 'L'}\n`);
    }
  }
  fs.closeSync(fd);
  process.stderr.write(`DONE lo=${lo} hi=${hi} → ${out}\n`);
})();
