// 1v1 Duel Simulator
//
// Simulates two matchups:
//   1. Heavy Knight vs Spearman
//   2. Horserider vs Spearman
//
// Spearman type bonus: 3× damage vs heavyknight and horserider (from src/game.ts)
//
// Run: npx tsx simulation/duel.ts

import { UNIT_DEFS, UnitDef } from './defs.ts';

const MOUNTED_TYPES = new Set(['heavyknight', 'horserider']);

function randomMultiplier(): number {
  // Box-Muller: Gaussian around 1.0, stddev 0.2, clamped [0.5, 1.5]
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0.5, Math.min(1.5, 1.0 + z * 0.2));
}

function calcDamage(attacker: UnitDef, target: UnitDef, verbose = false): number {
  const mult = randomMultiplier();
  const typeBonus = attacker.type === 'spearsman' && MOUNTED_TYPES.has(target.type) ? 3 : 1;
  const raw = typeBonus * (attacker.attack - target.defense);
  const dmg = Math.max(0, Math.round(mult * raw));
  if (verbose) {
    const bonusStr = typeBonus > 1 ? ` (×${typeBonus} type bonus)` : '';
    console.log(`    ${attacker.type} hits ${target.type}: ${attacker.attack} - ${target.defense} = ${raw / typeBonus}${bonusStr} × mult ${mult.toFixed(2)} = ${dmg} dmg`);
  }
  return dmg;
}

interface DuelResult {
  winner: string;  // unit type of winner, or 'draw'
  winnerHpLeft: number;
  rounds: number;
}

function simulateDuel(unitA: UnitDef, unitB: UnitDef, verbose = false): DuelResult {
  let hpA = unitA.hp;
  let hpB = unitB.hp;

  // Higher speed goes first; ties: A goes first
  const aFirst = unitA.speed >= unitB.speed;

  if (verbose) {
    console.log(`\n--- ${unitA.type} (${hpA} HP) vs ${unitB.type} (${hpB} HP) ---`);
    console.log(`  Turn order: ${aFirst ? unitA.type : unitB.type} attacks first`);
  }

  for (let round = 1; round <= 100; round++) {
    if (verbose) console.log(`  Round ${round}: ${unitA.type}=${hpA}HP, ${unitB.type}=${hpB}HP`);

    const [first, second, hpFirst, hpSecond] = aFirst
      ? [unitA, unitB, hpA, hpB]
      : [unitB, unitA, hpB, hpA];

    // First attacker hits
    const dmg1 = calcDamage(first, second, verbose);
    let newHpSecond = hpSecond - dmg1;

    if (newHpSecond <= 0) {
      // Second unit dies, no retaliation
      if (aFirst) {
        hpB = newHpSecond;
      } else {
        hpA = newHpSecond;
      }
      if (verbose) console.log(`  ${second.type} dies! ${first.type} wins with ${Math.max(0, aFirst ? hpA : hpB)} HP`);
      return { winner: first.type, winnerHpLeft: Math.max(0, aFirst ? hpA : hpB), rounds: round };
    }

    // Retaliation
    const dmg2 = calcDamage(second, first, verbose);
    let newHpFirst = hpFirst - dmg2;

    if (aFirst) {
      hpA = newHpFirst;
      hpB = newHpSecond;
    } else {
      hpB = newHpFirst;
      hpA = newHpSecond;
    }

    if (hpA <= 0 && hpB <= 0) {
      if (verbose) console.log(`  Both die! Draw.`);
      return { winner: 'draw', winnerHpLeft: 0, rounds: round };
    }
    if (hpA <= 0) {
      if (verbose) console.log(`  ${unitA.type} dies! ${unitB.type} wins with ${Math.max(0, hpB)} HP`);
      return { winner: unitB.type, winnerHpLeft: Math.max(0, hpB), rounds: round };
    }
    if (hpB <= 0) {
      if (verbose) console.log(`  ${unitB.type} dies! ${unitA.type} wins with ${Math.max(0, hpA)} HP`);
      return { winner: unitA.type, winnerHpLeft: Math.max(0, hpA), rounds: round };
    }
  }

  // Timeout — decide by HP
  if (hpA > hpB) return { winner: unitA.type, winnerHpLeft: hpA, rounds: 100 };
  if (hpB > hpA) return { winner: unitB.type, winnerHpLeft: hpB, rounds: 100 };
  return { winner: 'draw', winnerHpLeft: 0, rounds: 100 };
}

function runMatchup(unitA: UnitDef, unitB: UnitDef, runs = 10_000) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`MATCHUP: ${unitA.type.toUpperCase()} vs ${unitB.type.toUpperCase()} (${runs.toLocaleString()} runs)`);
  console.log('='.repeat(60));

  const wins: Record<string, number> = { [unitA.type]: 0, [unitB.type]: 0, draw: 0 };
  const winnerHpBuckets: Record<string, number[]> = { [unitA.type]: [], [unitB.type]: [] };

  for (let i = 0; i < runs; i++) {
    const result = simulateDuel(unitA, unitB);
    wins[result.winner] = (wins[result.winner] ?? 0) + 1;
    if (result.winner !== 'draw') {
      winnerHpBuckets[result.winner].push(result.winnerHpLeft);
    }
  }

  const pct = (n: number) => ((n / runs) * 100).toFixed(1) + '%';
  const avg = (arr: number[]) => arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

  console.log('\nWin rates:');
  for (const [name, count] of Object.entries(wins)) {
    const hpArr = winnerHpBuckets[name] ?? [];
    const avgHp = avg(hpArr).toFixed(1);
    const minHp = hpArr.length > 0 ? Math.min(...hpArr) : '-';
    const maxHp = hpArr.length > 0 ? Math.max(...hpArr) : '-';
    console.log(`  ${name.padEnd(14)} ${pct(count).padStart(6)}  (avg winner HP: ${avgHp}, min: ${minHp}, max: ${maxHp})`);
  }

  // HP distribution histogram for primary winner
  const primaryWinner = Object.entries(wins)
    .filter(([k]) => k !== 'draw')
    .sort(([, a], [, b]) => b - a)[0][0];
  const hpArr = winnerHpBuckets[primaryWinner] ?? [];
  if (hpArr.length > 0) {
    console.log(`\nHP distribution when ${primaryWinner} wins:`);
    const bucketSize = 2;
    const maxHp = Math.max(...hpArr);
    const buckets: Record<number, number> = {};
    for (const hp of hpArr) {
      const bucket = Math.floor(hp / bucketSize) * bucketSize;
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const [bucket, count] of Object.entries(buckets).sort(([a], [b]) => Number(a) - Number(b))) {
      const bar = '█'.repeat(Math.round((count / hpArr.length) * 40));
      console.log(`  HP ${String(bucket).padStart(3)}-${String(Number(bucket) + bucketSize - 1).padStart(2)}: ${bar} ${((count / hpArr.length) * 100).toFixed(1)}%`);
    }
  }

  // Sample verbose fight
  console.log('\n--- Sample fight (verbose) ---');
  simulateDuel(unitA, unitB, true);
}

const hk = UNIT_DEFS['heavyknight'];
const spearsman = UNIT_DEFS['spearsman'];
const horserider = UNIT_DEFS['horserider'];

runMatchup(hk, spearsman);
runMatchup(horserider, spearsman);
