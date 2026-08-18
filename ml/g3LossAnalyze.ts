// STEP-0 analysis: read g3LossBuckets JSONL shards and bucket the losses by
// recovery path. See g3LossBuckets.ts for the bucket definitions.
import * as fs from 'fs';

interface CapOpp { klass: string; level: number; templeId: string }
interface TurnRow { turn: number; myBefore: number; myAfter: number; total: number; capOpps: CapOpp[] }
interface GameRec {
  gameId: number; seed: number; forceFirst: number; botSlot: number;
  winner: number | null; won: boolean; rows: TurnRow[];
}

const files = process.argv.slice(2);
const games: GameRec[] = [];
for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const t = line.trim(); if (!t) continue;
    games.push(JSON.parse(t));
  }
}
games.sort((a, b) => a.gameId - b.gameId);

const W = games.filter(g => g.won).length;
const L = games.filter(g => !g.won && g.winner !== null).length;
const D = games.filter(g => g.winner === null).length;

function derive(g: GameRec) {
  let captures = 0, recaptured = 0, maxOwned = 0;
  let prevAfter: number | null = null;
  const capOppKlasses: string[] = [];
  let missedPivotalWin = false, missedValuable = false;
  const total = g.rows.length ? g.rows[0]!.total : 0;
  for (const r of g.rows) {
    if (prevAfter !== null && r.myBefore < prevAfter) recaptured += prevAfter - r.myBefore;
    captures += Math.max(0, r.myAfter - r.myBefore);
    maxOwned = Math.max(maxOwned, r.myBefore, r.myAfter);
    for (const c of r.capOpps) {
      capOppKlasses.push(c.klass);
      // opportunity present at turn start but temples-owned did not reach total this turn
      if (c.klass === 'PIVOTAL-WIN' && r.myAfter < r.total) missedPivotalWin = true;
      if ((c.klass === 'HIGH' || c.klass === 'PIVOTAL-ELIM') && r.myAfter <= r.myBefore) missedValuable = true;
    }
  }
  const brink = total > 0 && maxOwned >= total - 1;
  return { captures, recaptured, maxOwned, total, brink, missedPivotalWin, missedValuable, capOppKlasses };
}

function bucketLoss(g: GameRec): { bucket: string; d: ReturnType<typeof derive> } {
  const d = derive(g);
  let bucket: string;
  if (d.missedPivotalWin) bucket = '1-SAMPLING';
  else if (d.missedValuable) bucket = '2-VMISRANK';
  else if (d.brink) bucket = '1-SAMPLING(brink)'; // reached total-1 then lost, no on-temple opp seen (move-onto needed)
  else if (d.recaptured > 0) bucket = '2-VMISRANK(hold)'; // captured temples but opponent took them back → V-defense
  else bucket = '3-GENERAL';
  return { bucket, d };
}

console.log('\n===== G3 LOSS BUCKETING (100 gate games, seed-800k) =====');
console.log(`record: ${W}W ${L}L ${D}D / ${games.length}`);

const losses = games.filter(g => !g.won);
const bucketCounts = new Map<string, number>();
console.log('\n--- per-loss detail ---');
console.log('gameId seed     slot  bucket             captures recaptured maxOwned/total brink capOpps');
for (const g of losses) {
  const { bucket, d } = bucketLoss(g);
  const coarse = bucket.startsWith('1') ? '1-SAMPLING' : bucket.startsWith('2') ? '2-VMISRANK' : '3-GENERAL';
  bucketCounts.set(coarse, (bucketCounts.get(coarse) ?? 0) + 1);
  const caps = d.capOppKlasses.length ? d.capOppKlasses.join(',') : '-';
  console.log(`${String(g.gameId).padEnd(6)} ${g.seed}  ${g.botSlot}     ${bucket.padEnd(18)} ${String(d.captures).padEnd(8)} ${String(d.recaptured).padEnd(11)} ${d.maxOwned}/${d.total}            ${d.brink ? 'Y' : 'n'}     ${caps}`);
}

console.log('\n--- coarse bucket totals ---');
for (const k of ['1-SAMPLING', '2-VMISRANK', '3-GENERAL'])
  console.log(`  ${k.padEnd(12)} ${bucketCounts.get(k) ?? 0}`);

// Context: capture behavior across ALL games (wins included).
let totCaps = 0, totRecap = 0, brinkWins = 0;
for (const g of games) {
  const d = derive(g);
  totCaps += d.captures; totRecap += d.recaptured;
  if (g.won && d.brink) brinkWins++;
}
console.log(`\n--- context (all ${games.length} games) ---`);
console.log(`  total captures made by bot: ${totCaps}`);
console.log(`  total temples recaptured by opponent: ${totRecap}`);
console.log(`  wins that reached brink (owned total-1): ${brinkWins}/${W}`);
