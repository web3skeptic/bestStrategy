// Action featurizer (plan M2.2): encode a candidate micro as a fixed ~40-dim
// vector WITHOUT cloning the state. A per-decision context (buildActionCtx)
// precomputes the few O(units) quantities once (effective atk/def, capturable
// temples, enemy positions), so per-candidate cost is a handful of hex-distance
// ops. Concatenated with the state features, this is the policy net's input.
import { GameState, Unit, Temple, HexCoord, UnitType, TechId, UNIT_COSTS, templeUpgradeCost, TECH_COST, TECH_NODES } from '../src/types';
import { getEffectiveAttack, getEffectiveDefense, getUnitTypeMultiplier } from '../src/game';
import { hexDistance, hexKey } from '../src/hex';
import { Micro } from './gameEnv';

const UNIT_TYPES: UnitType[] = ['warrior', 'archer', 'catapult', 'horserider', 'heavyknight', 'spearsman', 'healer', 'damageBooster', 'rangeBooster'];
const ACTION_TYPES = ['move', 'attack', 'capture', 'recruit', 'upgrade-temple', 'research', 'build-teleport', 'end-turn'];
const utIdx = new Map(UNIT_TYPES.map((t, i) => [t, i]));
const atIdx = new Map(ACTION_TYPES.map((t, i) => [t, i]));
const techIdx = new Map(TECH_NODES.map((n, i) => [n.id, i]));

export const ACTION_DIM = ACTION_TYPES.length + UNIT_TYPES.length + UNIT_TYPES.length + 14; // 8+9+9+14 = 40

export interface ActionCtx {
  pid: number; R: number; aura: number;
  capturable: HexCoord[];         // temples not owned by pid
  enemies: HexCoord[];            // alive enemy unit positions
  unitById: Map<string, Unit>;
  templeById: Map<string, Temple>;
  effAtk: Map<string, number>;    // acting player's units
  effDef: Map<string, number>;    // enemy units (attack targets)
}

export function buildActionCtx(state: GameState, pid: number): ActionCtx {
  const unitById = new Map<string, Unit>();
  const templeById = new Map<string, Temple>();
  const effAtk = new Map<string, number>();
  const effDef = new Map<string, number>();
  const enemies: HexCoord[] = [];
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    unitById.set(u.id, u);
    if (u.playerId === pid) effAtk.set(u.id, getEffectiveAttack(state, u));
    else { enemies.push(u.pos); effDef.set(u.id, getEffectiveDefense(state, u)); }
  }
  const capturable: HexCoord[] = [];
  for (const t of state.temples) { templeById.set(t.id, t); if (t.ownerId !== pid) capturable.push(t.pos); }
  return { pid, R: state.mapRadius, aura: state.players[pid]!.aura, capturable, enemies, unitById, templeById, effAtk, effDef };
}

function nearestDist(pos: HexCoord, list: HexCoord[], fallback: number): number {
  let m = Infinity;
  for (const p of list) { const d = hexDistance(pos, p); if (d < m) m = d; }
  return m === Infinity ? fallback : m;
}

// Fill `out` (length ACTION_DIM) with the features of `micro`. Returns `out`.
export function actionFeatures(state: GameState, ctx: ActionCtx, micro: Micro, out?: Float64Array): Float64Array {
  const f = out ?? new Float64Array(ACTION_DIM);
  f.fill(0);
  const p = micro.params as Record<string, unknown>;
  let i = 0;
  // action-type one-hot (8)
  const ai = atIdx.get(micro.action); if (ai !== undefined) f[i + ai] = 1; i += ACTION_TYPES.length;
  // actor unit type one-hot (9)
  const actor = typeof p.unitId === 'string' ? ctx.unitById.get(p.unitId) : undefined;
  if (actor) { const k = utIdx.get(actor.type); if (k !== undefined) f[i + k] = 1; } i += UNIT_TYPES.length;
  // recruit type one-hot (9)
  if (micro.action === 'recruit' && typeof p.unitType === 'string') { const k = utIdx.get(p.unitType as UnitType); if (k !== undefined) f[i + k] = 1; } i += UNIT_TYPES.length;

  // scalars (14)
  const R = ctx.R;
  const s = f.subarray(i); // 14 slots
  // 0,1: move approach Δ to nearest capturable temple / nearest enemy (from - to)/R
  if (micro.action === 'move' && actor && p.to) {
    const to = p.to as HexCoord;
    const dT_from = nearestDist(actor.pos, ctx.capturable, R), dT_to = nearestDist(to, ctx.capturable, R);
    const dE_from = nearestDist(actor.pos, ctx.enemies, R), dE_to = nearestDist(to, ctx.enemies, R);
    s[0] = Math.max(-1, Math.min(1, (dT_from - dT_to) / R));
    s[1] = Math.max(-1, Math.min(1, (dE_from - dE_to) / R));
    // 2,3,4: dest is/adj capturable temple, dest on hill
    s[2] = ctx.capturable.some(t => t.q === to.q && t.r === to.r) ? 1 : 0;
    s[3] = ctx.capturable.some(t => hexDistance(t, to) <= 1) ? 1 : 0;
    s[4] = state.hills.has(hexKey(to)) ? 1 : 0;
  }
  // 5: actor hp fraction
  if (actor) s[5] = actor.stats.maxHp > 0 ? actor.hp / actor.stats.maxHp : 0;
  // 6,7,8: attack target hp frac, est damage frac, kill flag
  if (micro.action === 'attack' && actor && typeof p.targetId === 'string') {
    const tgt = ctx.unitById.get(p.targetId);
    if (tgt) {
      const atk = ctx.effAtk.get(actor.id) ?? actor.stats.attack;
      const def = ctx.effDef.get(tgt.id) ?? tgt.stats.defense;
      const bonus = getUnitTypeMultiplier(actor.type, tgt.type);
      const est = Math.max(0, atk * bonus - def);
      s[6] = tgt.stats.maxHp > 0 ? tgt.hp / tgt.stats.maxHp : 0;
      s[7] = tgt.hp > 0 ? Math.min(1, est / tgt.hp) : 1;
      s[8] = est >= tgt.hp ? 1 : 0;
    }
  }
  // 9: spend fraction of aura (recruit cost / upgrade cost / tech cost) / aura
  const aura = Math.max(1, ctx.aura);
  if (micro.action === 'recruit' && typeof p.unitType === 'string') s[9] = Math.min(1, (UNIT_COSTS[p.unitType as UnitType] ?? 3) / aura);
  else if (micro.action === 'upgrade-temple' && typeof p.templeId === 'string') { const t = ctx.templeById.get(p.templeId); const c = t ? templeUpgradeCost(t.level) : null; s[9] = c ? Math.min(1, c / aura) : 0; }
  else if (micro.action === 'research') s[9] = Math.min(1, TECH_COST / aura);
  // 10: temple level frac (upgrade)
  if (micro.action === 'upgrade-temple' && typeof p.templeId === 'string') { const t = ctx.templeById.get(p.templeId); s[10] = t ? t.level / 5 : 0; }
  // 11: tech index bucket (research)
  if (micro.action === 'research' && typeof p.techId === 'string') { const ti = techIdx.get(p.techId as TechId); s[11] = ti !== undefined ? (ti + 1) / (TECH_NODES.length + 1) : 0; }
  // 12: current aura context (shared)
  s[12] = Math.min(1, ctx.aura / 30);
  // 13: end-turn flag
  s[13] = micro.action === 'end-turn' ? 1 : 0;
  return f;
}
