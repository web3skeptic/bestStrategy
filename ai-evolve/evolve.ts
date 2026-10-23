// Evolves an AI genome by self-play (a generational genetic algorithm).
//
//   npx tsx ai-evolve/evolve.ts --run=hard-a --gens=30 --pop=16 --games=16 \
//     --opponents=normal,hard,champion --pin=tactics.search=0
//
// Each generation every candidate plays the same set of games (same seeds,
// maps and faction matchups, both seats) against the opponent pool, so
// candidates are compared on equal terms; the seeds change every generation
// so nothing overfits one map. Fitness is the mean match score: 1 per win,
// 0 per loss, 0.4–0.6 for a game that hit the round cap (by material).
//
// Opponents: a difficulty name (its built-in genome), `champion` (the best
// genome of the previous generations — so the bar keeps rising), or
// `file:<path>` (a stored genome played at Hard).
//
// Output in ai-evolve/out/<run>/: log.txt, gen-<n>.json (population with
// fitness) and best.json (the current champion). --resume continues a run.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MatchPool } from './pool';
import type { SideSpec, MatchResult } from './match';
import {
  DEFAULT_GENOME, GENE_SPECS, cloneGenome, getGene, setGene, normalizeGenome, type AiGenome,
} from '../src/aiGenome';
import type { AiDifficulty } from '../src/ai';
import type { FactionId } from '../src/types';
import { mulberry32 } from '../ml/rng';

const args: Record<string, string> = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]!] = m[2] ?? 'true';
}
const RUN = args.run ?? 'run';
const GENS = Number(args.gens ?? 20);
const POP = Number(args.pop ?? 16);
const GAMES = Number(args.games ?? 16);        // per candidate per opponent (even)
const ELITE = Number(args.elite ?? 4);
const SIGMA = Number(args.sigma ?? 0.12);      // mutation step, as a fraction of each gene's range
const MUT_P = Number(args.mutp ?? 0.25);       // per-gene mutation probability
const MAX_ROUNDS = Number(args.maxRounds ?? 70);
const DIFFICULTY = (args.difficulty ?? 'hard') as AiDifficulty;
const OPPONENTS = (args.opponents ?? 'normal,champion').split(',');
const PINS: [string, number][] = (args.pin ?? '').split(',').filter(Boolean).map(p => {
  const [k, v] = p.split('=');
  return [k!, Number(v)];
});
const OUT = fileURLToPath(new URL(`./out/${RUN}/`, import.meta.url));
mkdirSync(OUT, { recursive: true });

const rng = mulberry32(Number(args.seed ?? 7));
const gauss = () => Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());

function log(line: string): void {
  console.log(line);
  appendFileSync(OUT + 'log.txt', line + '\n');
}

function pin(g: AiGenome): AiGenome {
  for (const [k, v] of PINS) setGene(g, k, v);
  return normalizeGenome(g);
}

// Mutation in each gene's normalized [0,1] space (log-scaled genes in log space).
function toUnit(spec: typeof GENE_SPECS[number], v: number): number {
  return spec.log ? Math.log(v / spec.min) / Math.log(spec.max / spec.min) : (v - spec.min) / (spec.max - spec.min);
}
function fromUnit(spec: typeof GENE_SPECS[number], u: number): number {
  u = Math.min(1, Math.max(0, u));
  return spec.log ? spec.min * Math.pow(spec.max / spec.min, u) : spec.min + u * (spec.max - spec.min);
}

function mutate(g: AiGenome, sigma = SIGMA, p = MUT_P): AiGenome {
  const out = cloneGenome(g);
  for (const spec of GENE_SPECS) {
    if (rng() > p) continue;
    // Integer genes need a bigger kick to ever move one step.
    const s = spec.integer ? Math.max(sigma, 0.6 / (spec.max - spec.min)) : sigma;
    setGene(out, spec.path, fromUnit(spec, toUnit(spec, getGene(out, spec.path)) + gauss() * s));
  }
  return pin(out);
}

function crossover(a: AiGenome, b: AiGenome): AiGenome {
  const out = cloneGenome(a);
  for (const spec of GENE_SPECS) {
    const r = rng();
    // Uniform crossover, with occasional blending for continuous genes.
    if (r < 0.4) setGene(out, spec.path, getGene(b, spec.path));
    else if (r < 0.6 && !spec.integer) setGene(out, spec.path, (getGene(a, spec.path) + getGene(b, spec.path)) / 2);
  }
  return pin(out);
}

interface Scored { genome: AiGenome; fitness: number; wins: number; losses: number; games: number }

const MATCHUPS: [FactionId, FactionId][] = [['agrar', 'temple'], ['temple', 'agrar'], ['agrar', 'agrar'], ['temple', 'temple']];

function opponentSpec(name: string, champion: AiGenome): SideSpec {
  if (name === 'champion') return { difficulty: DIFFICULTY, genome: champion };
  if (name.startsWith('file:')) return { difficulty: DIFFICULTY, genome: normalizeGenome(JSON.parse(readFileSync(name.slice(5), 'utf8'))) };
  return { difficulty: name as AiDifficulty };
}

async function evaluate(pool: MatchPool, genomes: AiGenome[], champion: AiGenome, gen: number): Promise<Scored[]> {
  const seedBase = 100000 + gen * 1000;
  const tasks: Promise<{ i: number; result: MatchResult; seat: 0 | 1 }>[] = [];
  genomes.forEach((genome, i) => {
    const me: SideSpec = { difficulty: DIFFICULTY, genome };
    for (const opp of OPPONENTS) {
      const them = opponentSpec(opp, champion);
      for (let g = 0; g < GAMES; g++) {
        const seat = (g % 2) as 0 | 1;
        const pair = Math.floor(g / 2);
        const factions = MATCHUPS[pair % MATCHUPS.length]!;
        const sides: [SideSpec, SideSpec] = seat === 0 ? [me, them] : [them, me];
        const f: [FactionId, FactionId] = seat === 0 ? factions : [factions[1], factions[0]];
        tasks.push(pool.run({ seed: seedBase + pair * 7 + OPPONENTS.indexOf(opp), sides, factions: f, maxRounds: MAX_ROUNDS })
          .then(result => ({ i, result, seat })));
      }
    }
  });
  const results = await Promise.all(tasks);
  return genomes.map((genome, i) => {
    const mine = results.filter(r => r.i === i);
    let fitness = 0, wins = 0, losses = 0;
    for (const { result, seat } of mine) {
      fitness += seat === 0 ? result.score0 : 1 - result.score0;
      if (result.winner === seat) wins++;
      else if (result.winner !== null) losses++;
    }
    return { genome, fitness: fitness / mine.length, wins, losses, games: mine.length };
  });
}

function tournament(pop: Scored[], k = 3): Scored {
  let best: Scored | null = null;
  for (let i = 0; i < k; i++) {
    const c = pop[Math.floor(rng() * pop.length)]!;
    if (!best || c.fitness > best.fitness) best = c;
  }
  return best!;
}

function describe(g: AiGenome): string {
  const top = (f: 'agrar' | 'temple') => Object.entries(g[f].mix).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v.toFixed(2)}`).join(' ');
  const t = g.tactics;
  return `agrar[${top('agrar')} atk${g.agrar.attackAtPop.toFixed(2)} press${g.agrar.pressRatio.toFixed(1)}] ` +
    `temple[${top('temple')} atk${g.temple.attackAtPop.toFixed(2)} press${g.temple.pressRatio.toFixed(1)} raid${g.temple.raiders}] ` +
    `plan${t.planning} look${t.lookahead} search${t.search} guards${t.guards}`;
}

async function main(): Promise<void> {
  const pool = new MatchPool(args.workers ? Number(args.workers) : undefined);
  let population: AiGenome[];
  let champion: AiGenome;
  let startGen = 0;
  const seedGenome = pin(args.from ? normalizeGenome(JSON.parse(readFileSync(args.from, 'utf8'))) : cloneGenome(DEFAULT_GENOME));

  if (args.resume && existsSync(OUT + 'state.json')) {
    const saved = JSON.parse(readFileSync(OUT + 'state.json', 'utf8')) as { gen: number; population: AiGenome[]; champion: AiGenome };
    population = saved.population.map(normalizeGenome);
    champion = normalizeGenome(saved.champion);
    startGen = saved.gen + 1;
    log(`resuming ${RUN} at generation ${startGen}`);
  } else {
    champion = seedGenome;
    population = [seedGenome, ...Array.from({ length: POP - 1 }, () => mutate(seedGenome, SIGMA * 2, 0.5))];
    log(`run ${RUN}: pop ${POP}, ${GAMES} games x ${OPPONENTS.join('/')} each, difficulty ${DIFFICULTY}, pins ${args.pin ?? 'none'}, ${GENE_SPECS.length} genes`);
  }

  for (let gen = startGen; gen < GENS; gen++) {
    const t0 = Date.now();
    const scored = (await evaluate(pool, population, champion, gen)).sort((a, b) => b.fitness - a.fitness);
    const best = scored[0]!;
    // Elites are re-scored every generation on fresh maps, so a genome that
    // only got lucky once doesn't stay on top.
    champion = best.genome;
    writeFileSync(OUT + `gen-${gen}.json`, JSON.stringify(scored.map(s => ({ fitness: s.fitness, wins: s.wins, losses: s.losses, genome: s.genome })), null, 1));
    writeFileSync(OUT + 'best.json', JSON.stringify(champion, null, 2));
    const mean = scored.reduce((s, x) => s + x.fitness, 0) / scored.length;
    log(`gen ${gen}: best ${best.fitness.toFixed(3)} (${best.wins}W ${best.losses}L / ${best.games}) mean ${mean.toFixed(3)} ` +
      `[${((Date.now() - t0) / 1000).toFixed(0)}s] ${describe(best.genome)}`);

    const next: AiGenome[] = scored.slice(0, ELITE).map(s => s.genome);
    while (next.length < POP) {
      const a = tournament(scored), b = tournament(scored);
      next.push(mutate(rng() < 0.7 ? crossover(a.genome, b.genome) : a.genome));
    }
    population = next;
    writeFileSync(OUT + 'state.json', JSON.stringify({ gen, population, champion }));
  }
  pool.close();
}

main();
