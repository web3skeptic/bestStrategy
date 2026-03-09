// Simulation runner + analyzer
// Usage: npx tsx simulation/runner.ts [--aura=N] [--games=N]
// Defaults: --aura=15 --games=5000

import * as fs   from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { enumerateArmies, ArmyComposition } from './armies.ts';
import { simulateBattle } from './battle.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI args ─────────────────────────────────────────────────────────────────

function getArg(name: string, fallback: number): number {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? parseInt(arg.split('=')[1], 10) : fallback;
}

const AURA_CAP    = getArg('aura',  15);
const TARGET_GAMES = getArg('games', 5000);

// ── Types ─────────────────────────────────────────────────────────────────────

interface MatchupRecord {
  compA: string;
  compB: string;
  winsA: number;
  winsB: number;
  draws: number;
  games: number;
}

interface CompStats {
  label: string;
  totalAura: number;
  unitCounts: Record<string, number>;
  researchRequired: string[];
  wins: number;
  losses: number;
  draws: number;
  games: number;
  winRate: number;
  avgSurvivorHpWin: number;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function run() {
  const armies = enumerateArmies(AURA_CAP);
  const N = armies.length;
  console.log(`\nAura cap: ${AURA_CAP}  →  ${N} distinct army compositions.\n`);

  if (N === 0) { console.error('No compositions found.'); process.exit(1); }

  if (N <= 30) {
    armies.forEach((a, i) => {
      const r = a.researchRequired.length ? ` [research: ${a.researchRequired.join(',')}]` : '';
      console.log(`  ${String(i+1).padStart(3)}. [${a.totalAura}⚡] ${a.label}${r}`);
    });
  } else {
    console.log(`  (too many to list — use --aura=10 to see all)\n`);
  }

  const numMatchups    = N * (N - 1) / 2;
  const gamesPerMatchup = Math.max(4, Math.ceil(TARGET_GAMES / numMatchups));
  const totalGames     = numMatchups * gamesPerMatchup;

  console.log(`${numMatchups} matchups × ${gamesPerMatchup} games = ${totalGames} total battles.\n`);

  // ── Tournament ────────────────────────────────────────────────────────────

  const matchupMap = new Map<string, MatchupRecord>();
  const statMap    = new Map<string, CompStats>();

  for (const a of armies) {
    statMap.set(a.label, {
      label: a.label, totalAura: a.totalAura, unitCounts: a.unitCounts,
      researchRequired: a.researchRequired,
      wins: 0, losses: 0, draws: 0, games: 0, winRate: 0, avgSurvivorHpWin: 0,
    });
  }

  let completed = 0;
  let winHpAccum = new Map<string, number>(); // for averaging
  armies.forEach(a => winHpAccum.set(a.label, 0));

  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const a = armies[i];
      const b = armies[j];

      const rec: MatchupRecord = { compA: a.label, compB: b.label, winsA: 0, winsB: 0, draws: 0, games: gamesPerMatchup };

      for (let g = 0; g < gamesPerMatchup; g++) {
        const flip = g % 2 === 1;
        const result = simulateBattle(
          flip ? b.units : a.units,
          flip ? a.units : b.units,
        );
        const raw = result.winner;
        const winner: 'a' | 'b' | null =
          raw === null ? null
          : !flip ? (raw === 0 ? 'a' : 'b')
          :          (raw === 0 ? 'b' : 'a');

        if (winner === 'a') {
          rec.winsA++;
          winHpAccum.set(a.label, (winHpAccum.get(a.label) ?? 0) + result.survivorHp[flip ? 1 : 0]);
        } else if (winner === 'b') {
          rec.winsB++;
          winHpAccum.set(b.label, (winHpAccum.get(b.label) ?? 0) + result.survivorHp[flip ? 0 : 1]);
        } else {
          rec.draws++;
        }
      }

      matchupMap.set(`${a.label}|||${b.label}`, rec);

      const sa = statMap.get(a.label)!;
      const sb = statMap.get(b.label)!;
      sa.wins += rec.winsA; sa.losses += rec.winsB; sa.draws += rec.draws; sa.games += rec.games;
      sb.wins += rec.winsB; sb.losses += rec.winsA; sb.draws += rec.draws; sb.games += rec.games;

      completed++;
      if (completed % 50 === 0 || completed === numMatchups) {
        process.stdout.write(`\r  Simulating... ${completed}/${numMatchups} matchups`);
      }
    }
  }

  console.log('\n');

  // ── Finalize ──────────────────────────────────────────────────────────────

  const stats = Array.from(statMap.values()).map(s => {
    s.winRate = s.games > 0 ? s.wins / s.games : 0;
    s.avgSurvivorHpWin = s.wins > 0 ? (winHpAccum.get(s.label) ?? 0) / s.wins : 0;
    return s;
  }).sort((a, b) => b.winRate - a.winRate);

  // ── Report ────────────────────────────────────────────────────────────────

  const lines: string[] = [];
  const p = (s: string) => { lines.push(s); console.log(s); };

  p('═══════════════════════════════════════════════════════════════════════════════');
  p(`  ARMY SIMULATION REPORT  |  aura=${AURA_CAP}  |  ${totalGames} battles  |  ${gamesPerMatchup} games/matchup`);
  p('═══════════════════════════════════════════════════════════════════════════════');

  // ── Overall rankings ──────────────────────────────────────────────────────
  p('');
  p('RANKINGS (all compositions)');
  p('─────────────────────────────────────────────────────────────────────────────');
  p(`  ${'#'.padEnd(4)} ${'Win%'.padStart(6)}  ${'W'.padStart(5)} ${'L'.padStart(5)} ${'D'.padStart(4)}  ${'AvgHP'.padStart(7)}  Army`);
  p('  ' + '─'.repeat(76));

  stats.forEach((s, rank) => {
    const r = s.researchRequired.length ? `  [↑${s.researchRequired.map(t => t[0]).join('')}]` : '';
    p(`  ${String(rank+1).padEnd(4)} ${(s.winRate*100).toFixed(1).padStart(6)}%  ${String(s.wins).padStart(5)} ${String(s.losses).padStart(5)} ${String(s.draws).padStart(4)}  ${s.avgSurvivorHpWin.toFixed(1).padStart(7)}  ${s.label}${r}`);
  });

  // ── Top lopsided matchups ──────────────────────────────────────────────────
  p('');
  p('MOST DOMINANT MATCHUPS (highest win-rate gap)');
  p('─────────────────────────────────────────────────────────────────────────────');

  const matchups = Array.from(matchupMap.values())
    .map(m => {
      const gap = Math.abs(m.winsA - m.winsB) / m.games;
      const winner = m.winsA > m.winsB ? m.compA : m.winsB > m.winsA ? m.compB : 'DRAW';
      const loser  = m.winsA > m.winsB ? m.compB : m.winsB > m.winsA ? m.compA : 'DRAW';
      const wWins  = Math.max(m.winsA, m.winsB);
      return { winner, loser, wWins, total: m.games, gap };
    })
    .sort((a, b) => b.gap - a.gap);

  matchups.slice(0, 15).forEach(m => {
    p(`  ${(m.gap*100).toFixed(0).padStart(3)}%  ${m.winner}  >  ${m.loser}  (${m.wWins}/${m.total})`);
  });

  // ── Unit type analysis ────────────────────────────────────────────────────
  p('');
  p('UNIT TYPE CONTRIBUTION');
  p(`  Avg win rate of all armies containing at least 1 of this unit type.`);
  p('─────────────────────────────────────────────────────────────────────────────');

  const unitTypes = Object.keys(require('./defs.ts').UNIT_DEFS ?? {});
  // fallback: derive from stats
  const allTypes = new Set<string>();
  stats.forEach(s => Object.keys(s.unitCounts).forEach(t => allTypes.add(t)));

  for (const utype of allTypes) {
    const containing = stats.filter(s => (s.unitCounts[utype] ?? 0) > 0);
    if (containing.length === 0) continue;
    const avgWr = containing.reduce((s, c) => s + c.winRate, 0) / containing.length;
    const best  = containing[0];
    const worst = containing[containing.length - 1];
    p(`  ${utype.padEnd(14)} avg ${(avgWr*100).toFixed(1).padStart(5)}%   ${containing.length} armies   best: ${best.label} (${(best.winRate*100).toFixed(1)}%)   worst: ${worst.label} (${(worst.winRate*100).toFixed(1)}%)`);
  }

  p('');
  p('═══════════════════════════════════════════════════════════════════════════════');

  // ── Save outputs ──────────────────────────────────────────────────────────
  const suffix = `_aura${AURA_CAP}`;
  const reportPath = path.join(__dirname, `report${suffix}.txt`);
  const jsonPath   = path.join(__dirname, `results${suffix}.json`);

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({
    config: { auraCap: AURA_CAP, gamesPerMatchup, totalGames, armyCount: N },
    rankings: stats,
    topMatchups: matchups.slice(0, 50),
  }, null, 2), 'utf8');

  console.log(`\nSaved: ${reportPath}`);
  console.log(`Saved: ${jsonPath}\n`);
}

run();
