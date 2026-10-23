// Difficulty benchmark + capability coverage report.
//
//   npx tsx ai-evolve/bench.ts --pairs=hard:medium,medium:easy --games=24
//   npx tsx ai-evolve/bench.ts --coverage=hard --games=40
//
// A side is a difficulty (`hard`), a difficulty with a stored genome
// (`hard@ai-evolve/out/run/best.json`), or the original pre-evolution AI at
// one of its old levels (`old-normal`, `old-expert`; needs LEGACY_AI_DIR set
// to a checkout of that code).
//
// Every game is played twice with the same seed and map, seats swapped, across
// all four faction matchups, so neither the first-move edge nor a faction is
// baked into a win rate.
import { MatchPool } from './pool';
import type { MatchResult, CapabilityLog, SideSpec } from './match';
import { parseSide, sideLabel } from './sides';
import { TECH_NODES, type FactionId, type UnitType } from '../src/types';
import { FACTION_UNITS } from '../src/factions';

const args: Record<string, string> = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args[m[1]!] = m[2]!;
}
const games = Number(args.games ?? 16);
const maxRounds = Number(args.maxRounds ?? 80);
const seedBase = Number(args.seed ?? 1000);
const MATCHUPS: [FactionId, FactionId][] = [['agrar', 'temple'], ['temple', 'agrar'], ['agrar', 'agrar'], ['temple', 'temple']];

interface Played { result: MatchResult; a: 0 | 1 }

async function playPair(pool: MatchPool, a: SideSpec, b: SideSpec): Promise<Played[]> {
  const jobs: Promise<Played>[] = [];
  for (let g = 0; g < games; g++) {
    const factions = MATCHUPS[Math.floor(g / 2) % MATCHUPS.length]!;
    const seed = seedBase + Math.floor(g / 2);
    const swap = g % 2 === 1;
    const sides: [SideSpec, SideSpec] = swap ? [b, a] : [a, b];
    const f: [FactionId, FactionId] = swap ? [factions[1], factions[0]] : factions;
    jobs.push(pool.run({ seed, sides, factions: f, maxRounds }).then(result => ({ result, a: swap ? 1 : 0 })));
  }
  return Promise.all(jobs);
}

function pct(n: number, d: number): string {
  return d === 0 ? '  -' : `${Math.round((100 * n) / d)}%`.padStart(4);
}

function summarize(label: string, played: Played[]): void {
  let wins = 0, losses = 0, timeouts = 0, score = 0, ms = 0, rounds = 0;
  for (const { result, a } of played) {
    const s = a === 0 ? result.score0 : 1 - result.score0;
    score += s;
    if (result.winner === null) timeouts++;
    else if (result.winner === a) wins++;
    else losses++;
    ms += result.ms;
    rounds += result.rounds;
  }
  const n = played.length;
  if (args.detail) {
    const by = new Map<string, number[]>();
    for (const { result, a } of played) {
      const key = `${result.factions[a]} vs ${result.factions[1 - a]}`;
      const row = by.get(key) ?? [0, 0, 0];
      row[result.winner === null ? 2 : result.winner === a ? 0 : 1]!++;
      by.set(key, row);
    }
    for (const [k, [w, l, t]] of by) console.log(`    as ${k.padEnd(18)} W${w} L${l} T${t}`);
  }
  console.log(`${label.padEnd(22)} wins ${String(wins).padStart(3)}  losses ${String(losses).padStart(3)}  timeouts ${String(timeouts).padStart(3)}  ` +
    `score ${(score / n).toFixed(3)}  avg ${(rounds / n).toFixed(1)} rounds, ${(ms / n / 1000).toFixed(1)} s/game`);
}

// Which capabilities a side used, as the share of games it used them in.
function coverage(label: string, played: Played[]): void {
  const byFaction = new Map<FactionId, CapabilityLog[]>();
  for (const { result, a } of played) {
    const f = result.factions[a];
    if (!byFaction.has(f)) byFaction.set(f, []);
    byFaction.get(f)!.push(result.logs[a]);
  }
  for (const [faction, logs] of byFaction) {
    const n = logs.length;
    const line = (name: string, used: (l: CapabilityLog) => boolean) => {
      const k = logs.filter(used).length;
      return `${name} ${pct(k, n)}`;
    };
    console.log(`\n${label} as ${faction} (${n} games)`);
    const units = FACTION_UNITS[faction].map(u => line(u.displayName, l => (l.recruits[u.slot as UnitType] ?? 0) > 0));
    console.log('  recruit:  ' + units.join('  '));
    const techs = TECH_NODES.filter(t => !t.faction || t.faction === faction).map(t => line(t.name, l => l.research.includes(t.id)));
    console.log('  research: ' + techs.join('  '));
    const econ = faction === 'agrar'
      ? [line('farm', l => l.farmsStarted > 0), line('road', l => l.roadsBuilt > 0)]
      : [line('found temple', l => l.templesFounded > 0), line('upgrade temple', l => l.templeUpgrades > 0)];
    const rest = [line('fertile claim', l => l.fertileClaims > 0), line('pillage road', l => l.roadsPillaged > 0),
      line('hit unit', l => l.unitHits > 0), line('hit farm', l => l.farmHits > 0), line('hit temple', l => l.templeHits > 0),
      line('hit capital', l => l.capitalHits > 0)];
    console.log('  other:    ' + [...econ, ...rest].join('  '));
  }
}

async function main(): Promise<void> {
  const pool = new MatchPool(args.workers ? Number(args.workers) : undefined);
  try {
    if (args.coverage) {
      const d = args.coverage;
      const vs = args.vs ?? d;
      const played = await playPair(pool, parseSide(d), parseSide(vs));
      summarize(`${d} vs ${vs}`, played);
      coverage(d, played);
    }
    if (args.pairs) {
      for (const p of args.pairs.split(',')) {
        const [a, b] = p.split(':') as [string, string];
        summarize(`${sideLabel(a)} vs ${sideLabel(b)}`, await playPair(pool, parseSide(a), parseSide(b)));
      }
    }
  } finally {
    pool.close();
  }
}

main();
