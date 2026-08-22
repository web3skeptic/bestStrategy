// Hand-coded material/economy leaf evaluator — a training-free baseline the
// value net V is benchmarked against (plan §1.2.7 / M0.2). Returns a scalar in
// (-1, 1) from `botId`'s point of view, sign = who is ahead. Uses only the same
// public accessors the engine/AI use — no forked rules, no cloning.
import { GameState, UNIT_COSTS, UnitType } from '../src/types';
import { getOwnedStructures, getPlayerIncome } from '../src/game';

function income(state: GameState, pid: number): number {
  return getPlayerIncome(state, pid);
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
  const myTemples = getOwnedStructures(state, botId).length;
  const themTemples = others.reduce((s, id) => s + getOwnedStructures(state, id).length, 0);
  // §11 — Capital HP is now the ACTUAL win condition, not just a proxy, so it
  // gets the heaviest weight of anything here (normalized to maxHp=40).
  const myCapitalHp = (state.capitals.find(c => c.playerId === botId)?.hp ?? 0) / 40;
  const themCapitalHp = others.reduce((s, id) => s + (state.capitals.find(c => c.playerId === id)?.hp ?? 0) / 40, 0)
    / Math.max(1, others.length);
  const myInc = income(state, botId);
  const themInc = others.reduce((s, id) => s + income(state, id), 0);
  const myArmy = armyValue(state, botId);
  const themArmy = others.reduce((s, id) => s + armyValue(state, id), 0);
  const myPop = state.units.filter(u => u.hp > 0 && u.playerId === botId).length;
  const themPop = state.units.reduce((s, u) => s + (u.hp > 0 && others.includes(u.playerId) ? 1 : 0), 0);

  // Weighted advantage; weights favour Capital HP (the actual win condition)
  // > owned structures > economy > army.
  const score =
    1.50 * (myCapitalHp - themCapitalHp) +
    0.80 * (myTemples - themTemples) +
    0.10 * (myInc - themInc) +
    0.06 * (myArmy - themArmy) +
    0.05 * (myPop - themPop);
  return Math.tanh(score / 3);
}
