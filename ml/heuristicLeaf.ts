// Hand-coded material/economy leaf evaluator — a training-free baseline the
// value net V is benchmarked against (plan §1.2.7 / M0.2). Returns a scalar in
// (-1, 1) from `botId`'s point of view, sign = who is ahead. Uses only the same
// public accessors the engine/AI use — no forked rules, no cloning.
import { GameState, TEMPLE_AURA_PER_LEVEL, templeEconomyLevel, UNIT_COSTS, UnitType } from '../src/types';

function income(state: GameState, pid: number): number {
  return state.temples.filter(t => t.ownerId === pid)
    .reduce((s, t) => s + templeEconomyLevel(t.level) * TEMPLE_AURA_PER_LEVEL, 0);
}

// Cost-weighted army value scaled by current HP fraction (a hurt unit is worth
// less than a fresh one). Uses recruit cost as the value proxy.
function armyValue(state: GameState, pid: number): number {
  let v = 0;
  for (const u of state.units) {
    if (u.hp <= 0 || u.playerId !== pid) continue;
    const cost = UNIT_COSTS[u.type as UnitType] ?? 3;
    const maxHp = u.stats?.maxHp ?? u.hp;
    const frac = maxHp > 0 ? Math.max(0, Math.min(1, u.hp / maxHp)) : 1;
    v += cost * frac;
  }
  return v;
}

// Leaf value from botId's POV. Terminal states short-circuit to ±1 (a decided
// game dominates any material heuristic).
export function heuristicLeaf(state: GameState, botId: number): number {
  if (state.phase !== 'playing') {
    return state.winner ? (state.winner.id === botId ? 1 : -1) : 0;
  }
  const others = state.players.filter(p => p.id !== botId).map(p => p.id);
  const myTemples = state.temples.filter(t => t.ownerId === botId).length;
  const themTemples = state.temples.filter(t => t.ownerId !== null && t.ownerId !== botId).length;
  const myInc = income(state, botId);
  const themInc = others.reduce((s, id) => s + income(state, id), 0);
  const myArmy = armyValue(state, botId);
  const themArmy = others.reduce((s, id) => s + armyValue(state, id), 0);
  const myPop = state.units.filter(u => u.hp > 0 && u.playerId === botId).length;
  const themPop = state.units.reduce((s, u) => s + (u.hp > 0 && others.includes(u.playerId) ? 1 : 0), 0);

  // Weighted advantage; weights favour temples (win condition) > economy > army.
  const score =
    1.20 * (myTemples - themTemples) +
    0.10 * (myInc - themInc) +
    0.06 * (myArmy - themArmy) +
    0.05 * (myPop - themPop);
  return Math.tanh(score / 3);
}
