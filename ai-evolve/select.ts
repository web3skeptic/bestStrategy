// Picks a run's final genome. A single generation's best is a noisy pick (48–72
// games), so this re-tests the top candidates of the last few generations on
// fresh maps against a fixed panel and keeps the overall best.
//
//   LEGACY_AI_DIR=<old checkout> npx tsx ai-evolve/select.ts --run=hard-b --last=5 --top=3 \
//     --panel=medium,old-normal,hard@ai-evolve/out/hard-a/best.json --games=48
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MatchPool } from './pool';
import type { SideSpec } from './match';
import { normalizeGenome, type AiGenome } from '../src/aiGenome';
import { parseSide, sideLabel } from './sides';
import type { FactionId } from '../src/types';

const args: Record<string, string> = {};
for (const a of process.argv.slice(2)) { const m = a.match(/^--([^=]+)=(.*)$/); if (m) args[m[1]!] = m[2]!; }
const RUN = args.run ?? 'run';
const DIR = fileURLToPath(new URL(`./out/${RUN}/`, import.meta.url));
const LAST = Number(args.last ?? 5);
const TOP = Number(args.top ?? 3);
const GAMES = Number(args.games ?? 48);
const MAX_ROUNDS = Number(args.maxRounds ?? 80);
const PANEL = (args.panel ?? 'medium').split(',');
const MATCHUPS: [FactionId, FactionId][] = [['agrar', 'temple'], ['temple', 'agrar'], ['agrar', 'agrar'], ['temple', 'temple']];

async function main(): Promise<void> {
  const gens: number[] = [];
  for (let g = 0; existsSync(`${DIR}gen-${g}.json`); g++) gens.push(g);
  const candidates: { label: string; genome: AiGenome }[] = [];
  const seen = new Set<string>();
  for (const g of gens.slice(-LAST)) {
    const rows = JSON.parse(readFileSync(`${DIR}gen-${g}.json`, 'utf8')) as { genome: AiGenome }[];
    rows.slice(0, TOP).forEach((r, i) => {
      const key = JSON.stringify(r.genome);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ label: `gen${g}#${i}`, genome: normalizeGenome(r.genome) });
    });
  }
  console.log(`${candidates.length} candidates x ${PANEL.length} opponents x ${GAMES} games`);
  const pool = new MatchPool(args.workers ? Number(args.workers) : undefined);
  const seedBase = Number(args.seed ?? 900000);
  const scored = await Promise.all(candidates.map(async c => {
    const me: SideSpec = { difficulty: 'hard', genome: c.genome };
    const per: string[] = [];
    let total = 0, n = 0, wins = 0, losses = 0;
    for (const opp of PANEL) {
      const them = parseSide(opp);
      const jobs = [];
      for (let g = 0; g < GAMES; g++) {
        const seat = (g % 2) as 0 | 1;
        const factions = MATCHUPS[Math.floor(g / 2) % MATCHUPS.length]!;
        const sides: [SideSpec, SideSpec] = seat === 0 ? [me, them] : [them, me];
        const f: [FactionId, FactionId] = seat === 0 ? factions : [factions[1], factions[0]];
        jobs.push(pool.run({ seed: seedBase + Math.floor(g / 2), sides, factions: f, maxRounds: MAX_ROUNDS }).then(r => ({ r, seat })));
      }
      let s = 0;
      for (const { r, seat } of await Promise.all(jobs)) {
        s += seat === 0 ? r.score0 : 1 - r.score0;
        if (r.winner === seat) wins++; else if (r.winner !== null) losses++;
      }
      per.push(`${sideLabel(opp)} ${(s / GAMES).toFixed(3)}`);
      total += s; n += GAMES;
    }
    return { ...c, fitness: total / n, wins, losses, per };
  }));
  pool.close();
  scored.sort((a, b) => b.fitness - a.fitness);
  for (const s of scored) console.log(`${s.label.padEnd(10)} ${s.fitness.toFixed(3)}  ${s.wins}W ${s.losses}L  | ${s.per.join(' | ')}`);
  writeFileSync(`${DIR}selected.json`, JSON.stringify(scored[0]!.genome, null, 2));
  console.log(`\nselected ${scored[0]!.label} -> ${DIR}selected.json`);
}

main();
