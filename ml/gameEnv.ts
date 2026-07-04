// ─────────────────────────────────────────────────────────────────────────────
// RL environment over the EXISTING Best-Strategy game. No forked rules: every
// mutation goes through the shared server/actionDispatcher.ts executeAction (the
// same authoritative path the interactive game + headless REST transport use).
//
// Gym-like surface:
//   reset(opts) -> GameState (mid-game, someone to move)
//   legalMicros(state) -> Micro[]         (the discrete action set + mask; every
//                                           entry is legal by construction)
//   applyMicro(state, micro) -> boolean   (step; mutates state in place)
//   cloneState(state) -> GameState        (fast copy for 1-ply lookahead)
//
// A "Micro" is one UnifiedAction the dispatcher accepts. A player's TURN is a
// sequence of micros ending in 'end-turn'. Episodes are capped (maxRounds) so
// they never hang.
// ─────────────────────────────────────────────────────────────────────────────
import { GameState, UnitType, HexCoord } from '../src/types';
import { TECH_NODES, UNIT_COSTS } from '../src/types';
import {
  createGameState, PlayerConfig,
  getUnitAt, canAfford, canUpgradeTemple, canResearch,
  getUnlockedUnits, getPopulationCap, getPopulationCount,
  canBuildTeleportPair, getValidTeleportHexes, getValidTeleportHexesForOtherTemples,
} from '../src/game';
import { executeAction, computeUnitActions, UnifiedActionName } from '../server/actionDispatcher';
import { hexDistance } from '../src/hex';
import { setSeed, installSeededRandom } from './rng';

// Node-only: swap in the seeded RNG so headless episodes are deterministic. In
// the browser (the RL "Hard AI" reuses this env for turn search) we must NOT
// clobber the game's global Math.random — the live game relies on native RNG for
// map gen and combat rolls — so this is guarded to Node (no `window`).
if (typeof window === 'undefined') installSeededRandom();

export interface Micro {
  action: UnifiedActionName;
  params: Record<string, unknown>;
}

export interface ResetOpts {
  seed: number;
  nPlayers?: number;               // default 2
  names?: string[];
  forceFirst?: number;             // force which slot moves first (cancel first-move bias)
}

const COLORS = ['#ff4444', '#4488ff', '#44cc55', '#ffcc33', '#cc55dd', '#ff8833'];

export function reset(opts: ResetOpts): GameState {
  setSeed(opts.seed);
  const n = opts.nPlayers ?? 2;
  const configs: PlayerConfig[] = Array.from({ length: n }, (_, i) => ({
    name: opts.names?.[i] ?? `P${i}`,
    color: COLORS[i % COLORS.length]!,
  }));
  const state = createGameState(configs);
  if (opts.forceFirst !== undefined) {
    state.currentPlayerIndex = opts.forceFirst % n;
    state.firstPlayerIndex = state.currentPlayerIndex;
  }
  return state;
}

// Enumerate every legal micro-action for the player to move. This IS the
// discrete action space + legality mask (each entry is guaranteed legal).
export function legalMicros(state: GameState): Micro[] {
  const out: Micro[] = [];
  if (state.phase !== 'playing') return out;
  const pid = state.currentPlayerIndex;

  // Unit actions (move / attack / capture) — from the shared dispatcher helper.
  for (const unit of state.units.filter(u => u.hp > 0 && u.playerId === pid)) {
    for (const a of computeUnitActions(state, unit)) {
      if (a.type === 'move') out.push({ action: 'move', params: { unitId: unit.id, to: a.to } });
      else if (a.type === 'attack') out.push({ action: 'attack', params: { unitId: unit.id, targetId: a.targetId } });
      else if (a.type === 'capture') out.push({ action: 'capture', params: { unitId: unit.id } });
    }
  }

  // Recruit: for each owned, unoccupied temple, each unlocked+affordable unit type
  // (population cap permitting).
  const unlocked = getUnlockedUnits(state.playerTech[pid]!);
  const underCap = getPopulationCount(state, pid) < getPopulationCap(state, pid);
  if (underCap) {
    for (const temple of state.temples.filter(t => t.ownerId === pid)) {
      if (getUnitAt(state, temple.pos)) continue;
      for (const type of unlocked) {
        if (canAfford(state, type)) out.push({ action: 'recruit', params: { unitType: type as UnitType, templeId: temple.id } });
      }
    }
  }

  // Upgrade temple.
  for (const temple of state.temples.filter(t => t.ownerId === pid)) {
    if (canUpgradeTemple(state, temple.id) !== null) out.push({ action: 'upgrade-temple', params: { templeId: temple.id } });
  }

  // Research.
  for (const tech of TECH_NODES) {
    if (canResearch(state, tech.id)) out.push({ action: 'research', params: { techId: tech.id } });
  }

  // Build teleport — one representative pair per eligible temple (connect the two
  // most distant temples), to keep the branching factor sane.
  for (const temple of state.temples.filter(t => t.ownerId === pid)) {
    if (!canBuildTeleportPair(state, temple.id)) continue;
    const a = getValidTeleportHexes(state, temple.id);
    const bs = getValidTeleportHexesForOtherTemples(state, temple.id);
    if (a.length === 0 || bs.length === 0) continue;
    let posB = bs[0]!; let bd = -1;
    for (const h of bs) { const d = hexDistance(temple.pos, h); if (d > bd) { bd = d; posB = h; } }
    out.push({ action: 'build-teleport', params: { templeId: temple.id, pos: a[0]!, targetPos: posB } });
  }

  // End turn is always legal.
  out.push({ action: 'end-turn', params: {} });
  return out;
}

// Step: apply one micro (via the authoritative dispatcher). Returns whether it
// mutated state (executeAction validates; illegal → false, state unchanged).
export function applyMicro(state: GameState, micro: Micro): boolean {
  const res = executeAction(state, state.currentPlayerIndex, micro.action, micro.params);
  return res.ok;
}

// Fast clone for 1-ply lookahead. Terrain sets are immutable during a game →
// shared by reference. Unit/temple/player objects use shallow spreads because no
// action mutates their nested objects in place (pos/stats are REPLACED on move/
// research, never mutated). Only the acting player's `explored` set is mutated
// this turn (move reveals), so only that one is copied.
export function cloneState(s: GameState): GameState {
  const cur = s.currentPlayerIndex;
  return {
    players: s.players.map(p => ({ ...p })),
    units: s.units.map(u => ({ ...u })),
    temples: s.temples.map(t => ({ ...t })),
    hills: s.hills, walls: s.walls, forests: s.forests,
    explored: s.explored.map((e, i) => (i === cur ? new Set(e) : e)),
    currentPlayerIndex: s.currentPlayerIndex,
    firstPlayerIndex: s.firstPlayerIndex,
    phase: s.phase,
    mapRadius: s.mapRadius,
    winner: s.winner,
    turnNumber: s.turnNumber,
    selectedUnitId: null, selectedTempleId: null, selectionMode: null,
    moveHexes: [], attackHexes: [], supportHexes: [], buildHexes: [],
    spawnedTempleIds: new Set(s.spawnedTempleIds),
    playerTech: s.playerTech.map(pt => ({ researched: new Set(pt.researched) })),
    teleportBuildings: s.teleportBuildings.map(tp => ({ ...tp })),
  };
}

export function isAlive(state: GameState, pid: number): boolean {
  return state.units.some(u => u.hp > 0 && u.playerId === pid)
    || state.temples.some(t => t.ownerId === pid);
}

export { setSeed };
export type { HexCoord };
