// The AI's tunable decision parameters ("genome") — every strategic number the
// AI acts on lives here instead of being hard-coded in ai.ts, so whole
// strategies can be evolved by self-play (see ai-evolve/evolve.ts) and each
// difficulty is just a genome plus a search/randomness config.
//
// A genome is plain JSON: per-faction macro genes (army mix, research
// priorities, economy, aggression), shared tactical genes (how a unit scores
// a move), and multipliers on the search evaluator's weights (aiEval.ts).
//
// Capability floors are part of the bounds, not the evolution's choice: every
// unit type keeps a minimum share of the army mix, every tech is eventually
// researched (priority only orders them), and each mutually exclusive tech
// branch is picked per game with every option keeping a real chance — so over
// many games the AI uses everything the rules offer.
import type { GameState, TechId } from './types';
import { TECH_NODES } from './types';
import { AI_EVAL_WEIGHTS, setActiveEvalWeights, type AiEvalWeights } from './aiEval';

export const MIX_SLOTS = ['warrior', 'archer', 'spearsman', 'horserider', 'catapult', 'heavyknight', 'healer', 'damageBooster', 'rangeBooster'] as const;
export type MixSlot = typeof MIX_SLOTS[number];

export const SUPPORT_BRANCH: TechId[] = ['unlock_healer', 'unlock_damagebooster', 'unlock_rangebooster'];
export const STAT_BRANCH: TechId[] = ['longrange_hp', 'horse_sight'];

export interface FactionGenes {
  // Target army composition (relative weights over the unlocked slots).
  mix: Record<MixSlot, number>;
  // Research order: highest priority first among what is reachable.
  tech: Record<TechId, number>;
  // Per-game odds for the mutually exclusive branches (healer/drummer/scout
  // support unlock; Fortified Ranged vs Scout Cavalry).
  supportPick: [number, number, number];
  statPick: [number, number];
  // Agrar economy: Builders to keep while Farms are being built, Farm goal.
  builders: number;
  farmTarget: number;
  // Save Energy for the next tech when it's within this many rounds of income,
  // but only once the army has at least minArmyForTech units.
  saveHorizon: number;
  minArmyForTech: number;
  // Rounds of income the AI will wait for the unit it wants most before
  // settling for a cheaper one.
  patience: number;
  // Share of the Command cap the fighting army must fill before it marches
  // into enemy land (a share, not a unit count: Agrar's elite units cost
  // 2-3 Command each, so the same count means very different armies).
  attackAtPop: number;
  // Army-strength ratio (mine / visible enemy) at which everything that
  // isn't guarding presses the enemy Capital.
  pressRatio: number;
  // How many fast units raid enemy Farms/Temples instead of joining the army.
  raiders: number;
  // 0/1 — once the army is ready, siege units go straight for the enemy
  // Capital instead of the nearest target.
  siegeCapital: number;
  // Energy kept back before starting a Temple I -> II upgrade (Temple only).
  upgradeFloor: number;
}

export interface TacticGenes {
  objectivePull: number;   // per hex closer to the objective
  retreatPenalty: number;  // per hex given up
  killBonus: number;       // landing where a kill is possible
  hitBonus: number;        // landing where a hit is possible
  hillBonus: number;
  threatWeight: number;    // threat-map exposure
  backlineShy: number;     // archers/siege keeping their distance
  screenBonus: number;     // frontline standing ahead of the backline
  commitMargin: number;    // how much closer a unit target must be to beat a structure
  guards: number;          // Capital guards once an enemy has been seen
  lookaheadThreat: number; // post-move threat in the lookahead
  lethalExposure: number;  // x unit cost, for walking into a guaranteed kill
  supportValue: number;    // support units: value of allies covered
  supportDanger: number;   // support units: enemy proximity
  capitalFocus: number;    // preference for hitting a Capital over other structures
  // Feature switches, capped by the difficulty (a genome can turn a feature
  // off, never on beyond what its difficulty allows):
  planning: number;        // 0/1 — strategic plan + mobile reserve
  lookahead: number;       // 0 = greedy moves, else candidates simulated per move
  search: number;          // 0/1 — alpha-beta tactical search
}

type EvalScalarKey = { [K in keyof AiEvalWeights]: AiEvalWeights[K] extends number ? K : never }[keyof AiEvalWeights];
export type EvalMultipliers = Record<EvalScalarKey | 'capitalPenalty', number>;

export interface AiGenome {
  agrar: FactionGenes;
  temple: FactionGenes;
  tactics: TacticGenes;
  eval: EvalMultipliers;
}

function techPriorities(order: TechId[]): Record<TechId, number> {
  const out = {} as Record<TechId, number>;
  for (const node of TECH_NODES) out[node.id] = 0.1;
  order.forEach((id, i) => { out[id] = 1 - i * 0.08; });
  return out;
}

// Reproduces the hand-written AI's choices (research order, army mix,
// constants) so evolution starts from the existing behaviour.
export const DEFAULT_GENOME: AiGenome = {
  agrar: {
    mix: { warrior: 0.25, archer: 0.15, spearsman: 0.35, horserider: 0.1, catapult: 0.25, heavyknight: 0.25, healer: 0.1, damageBooster: 0.1, rangeBooster: 0.1 },
    tech: techPriorities(['command_1', 'agrar_siegecraft', 'longrange_hp', 'unlock_damagebooster', 'agrar_siegecraft_splash', 'agrar_heavy_armor', 'agrar_heavy_knight_tech', 'command_2']),
    supportPick: [0.25, 0.5, 0.25],
    statPick: [0.6, 0.4],
    builders: 2,
    farmTarget: 4,
    saveHorizon: 1,
    minArmyForTech: 3,
    patience: 0.5,
    attackAtPop: 0.6,
    pressRatio: 2,
    raiders: 0,
    siegeCapital: 1,
    upgradeFloor: 0,
  },
  temple: {
    mix: { warrior: 0.25, archer: 0.15, spearsman: 0.3, horserider: 0.3, catapult: 0.25, heavyknight: 0.25, healer: 0.1, damageBooster: 0.1, rangeBooster: 0.1 },
    tech: techPriorities(['command_1', 'temple_mobile_siege_tech', 'longrange_hp', 'unlock_damagebooster', 'temple_mobile_siege_splash', 'temple_warrior_rite', 'temple_champion_rite', 'command_2']),
    supportPick: [0.25, 0.5, 0.25],
    statPick: [0.6, 0.4],
    builders: 0,
    farmTarget: 0,
    saveHorizon: 1,
    minArmyForTech: 3,
    patience: 0.5,
    attackAtPop: 0.6,
    pressRatio: 2,
    raiders: 1,
    siegeCapital: 1,
    upgradeFloor: 0,
  },
  tactics: {
    objectivePull: 4, retreatPenalty: 6, killBonus: 60, hitBonus: 12, hillBonus: 1.5, threatWeight: 1.5,
    backlineShy: 2, screenBonus: 2, commitMargin: 3, guards: 1, lookaheadThreat: 2, lethalExposure: 4,
    supportValue: 2, supportDanger: 3, capitalFocus: 1, planning: 1, lookahead: 3, search: 1,
  },
  eval: Object.fromEntries(
    [...Object.entries(AI_EVAL_WEIGHTS).filter(([, v]) => typeof v === 'number').map(([k]) => k), 'capitalPenalty'].map(k => [k, 1]),
  ) as EvalMultipliers,
};

// ── Bounds and flattening (used by the evolution driver) ────────────────────

export interface GeneSpec { path: string; min: number; max: number; log: boolean; integer: boolean }

function boundsFor(path: string): Omit<GeneSpec, 'path'> {
  const leaf = path.split('.').pop()!;
  if (path.includes('.mix.')) return { min: 0.05, max: 1, log: false, integer: false };
  if (path.includes('.tech.')) return { min: 0, max: 1, log: false, integer: false };
  if (path.includes('Pick.')) return { min: 0.15, max: 1, log: false, integer: false };
  if (path.startsWith('eval.')) return { min: 0.25, max: 4, log: true, integer: false };
  const table: Record<string, [number, number, boolean?, boolean?]> = {
    builders: [1, 3, false, true], farmTarget: [1, 4, false, true], saveHorizon: [0, 4], minArmyForTech: [0, 8, false, true],
    patience: [0, 3], attackAtPop: [0.2, 1], pressRatio: [1, 4], raiders: [0, 3, false, true], siegeCapital: [0, 1, false, true], upgradeFloor: [0, 8],
    objectivePull: [1, 12], retreatPenalty: [0, 15], killBonus: [10, 150], hitBonus: [0, 40], hillBonus: [0, 6], threatWeight: [0, 5],
    backlineShy: [0, 6], screenBonus: [0, 6], commitMargin: [0, 8], guards: [0, 3, false, true], lookaheadThreat: [0, 6],
    lethalExposure: [0, 10], supportValue: [0.5, 6], supportDanger: [0.5, 8], capitalFocus: [0.25, 4, true],
    planning: [0, 1, false, true], lookahead: [0, 6, false, true], search: [0, 1, false, true],
  };
  const t = table[leaf];
  if (!t) throw new Error(`no gene bounds for ${path}`);
  return { min: t[0], max: t[1], log: t[2] ?? false, integer: t[3] ?? false };
}

function leaves(obj: unknown, prefix = ''): [string, number][] {
  if (typeof obj === 'number') return [[prefix, obj]];
  const out: [string, number][] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out.push(...leaves(v, prefix ? `${prefix}.${k}` : k));
  return out;
}

export const GENE_SPECS: GeneSpec[] = leaves(DEFAULT_GENOME)
  // Temple has no Builder/Farms; Agrar has no unit in the cavalry slot.
  .filter(([p]) => !/^temple\.(builders|farmTarget)$/.test(p) && p !== 'agrar.mix.horserider' && p !== 'agrar.upgradeFloor')
  .filter(([p]) => !TECH_NODES.some(n => n.faction && p === `${n.faction === 'agrar' ? 'temple' : 'agrar'}.tech.${n.id}`))
  .map(([path]) => ({ path, ...boundsFor(path) }));

export function getGene(genome: AiGenome, path: string): number {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], genome) as number;
}

export function setGene(genome: AiGenome, path: string, value: number): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], genome) as Record<string, number>;
  parent[last] = value;
}

export function cloneGenome(g: AiGenome): AiGenome {
  return JSON.parse(JSON.stringify(g)) as AiGenome;
}

// Fills anything a stored genome lacks (e.g. a gene added after it was
// evolved) from the defaults, and clamps everything into bounds.
export function normalizeGenome(partial: unknown): AiGenome {
  const g = cloneGenome(DEFAULT_GENOME);
  const merge = (dst: Record<string, unknown>, src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src ?? {})) {
      if (!(k in dst)) continue;
      if (typeof v === 'number' && typeof dst[k] === 'number') dst[k] = v;
      else if (v && typeof v === 'object' && dst[k] && typeof dst[k] === 'object') merge(dst[k] as Record<string, unknown>, v as Record<string, unknown>);
    }
  };
  merge(g as unknown as Record<string, unknown>, partial as Record<string, unknown>);
  for (const spec of GENE_SPECS) {
    let v = Math.min(spec.max, Math.max(spec.min, getGene(g, spec.path)));
    if (spec.integer) v = Math.round(v);
    setGene(g, spec.path, v);
  }
  return g;
}

// ── The genome in effect for the turn being played ──────────────────────────

let active: AiGenome = DEFAULT_GENOME;
const evalCache = new WeakMap<AiGenome, AiEvalWeights>();

function evalWeightsFor(g: AiGenome): AiEvalWeights {
  let w = evalCache.get(g);
  if (!w) {
    const out: Record<string, unknown> = { ...AI_EVAL_WEIGHTS };
    for (const [k, mult] of Object.entries(g.eval)) {
      const base = (AI_EVAL_WEIGHTS as Record<string, unknown>)[k];
      if (typeof base === 'number') out[k] = base * mult;
      else if (Array.isArray(base)) out[k] = base.map(v => v * mult);
    }
    w = out as unknown as AiEvalWeights;
    evalCache.set(g, w);
  }
  return w;
}

export function activeGenome(): AiGenome {
  return active;
}

// Runs `fn` (one AI turn — always synchronous) with `genome` in effect, for
// both the decision code in ai.ts and the evaluator search uses.
export function withGenome<T>(genome: AiGenome, fn: () => T): T {
  const prev = active;
  active = genome;
  setActiveEvalWeights(evalWeightsFor(genome));
  try {
    return fn();
  } finally {
    active = prev;
    setActiveEvalWeights(evalWeightsFor(prev));
  }
}

// ── Per-game branch choice ──────────────────────────────────────────────────
// Which support unit / stat bonus this player commits to this game. Rolled
// once (per game state and player) from the genome's odds, with every option
// keeping at least BRANCH_FLOOR chance so all of them see play.
const BRANCH_FLOOR = 0.15;
const branchMemory = new WeakMap<GameState, Map<string, TechId>>();

function roll(options: TechId[], weights: number[]): TechId {
  const total = weights.reduce((s, w) => s + w, 0) || 1;
  const spare = 1 - BRANCH_FLOOR * options.length;
  let r = Math.random();
  for (let i = 0; i < options.length; i++) {
    r -= BRANCH_FLOOR + spare * (weights[i]! / total);
    if (r <= 0) return options[i]!;
  }
  return options[options.length - 1]!;
}

export function branchChoice(state: GameState, playerId: number, branch: 'support' | 'stat', genes: FactionGenes): TechId {
  let m = branchMemory.get(state);
  if (!m) { m = new Map(); branchMemory.set(state, m); }
  const key = `${playerId}:${branch}`;
  // A branch already researched (e.g. a loaded save) is the choice.
  const options = branch === 'support' ? SUPPORT_BRANCH : STAT_BRANCH;
  const done = options.find(id => state.playerTech[playerId]?.researched.has(id) || state.playerTech[playerId]?.researching?.techId === id);
  if (done) { m.set(key, done); return done; }
  let choice = m.get(key);
  if (!choice) {
    choice = roll(options, branch === 'support' ? genes.supportPick : genes.statPick);
    m.set(key, choice);
  }
  return choice;
}
