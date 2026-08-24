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
  canAfford, canResearch,
  getUnlockedUnits, getPopulationCap, getPopulationCount,
  getOwnedStructures,
  canBuildTeleportPair, getValidTeleportHexes, getValidTeleportHexesForOtherTemples,
  canBuyDevotion,
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

  // Unit actions (move / attack / attack-structure / found) — from the shared
  // dispatcher helper.
  for (const unit of state.units.filter(u => u.hp > 0 && u.playerId === pid)) {
    for (const a of computeUnitActions(state, unit)) {
      if (a.type === 'move') out.push({ action: 'move', params: { unitId: unit.id, to: a.to } });
      else if (a.type === 'attack') out.push({ action: 'attack', params: { unitId: unit.id, targetId: a.targetId } });
      else if (a.type === 'attack-structure') out.push({ action: 'attack-structure', params: { unitId: unit.id, targetPos: a.targetPos } });
      else if (a.type === 'found') out.push({ action: 'found', params: { unitId: unit.id } });
      else if (a.type === 'build-road') out.push({ action: 'build-road', params: { unitId: unit.id } });
      else if (a.type === 'build-farm') out.push({ action: 'build-farm', params: { unitId: unit.id, pos: a.targetPos } });
    }
  }

  // Recruit: for each owned structure (Capital or completed Temple), each
  // unlocked+affordable unit type (population cap permitting). §5 (phase 11)
  // — recruiting only QUEUES a TrainingOrder; tile occupancy is checked at
  // deployment time (resolveTrainingForPlayer), not here, so a structure
  // with a unit standing on it is still a legal recruit target.
  const unlocked = getUnlockedUnits(state.playerTech[pid]!, state.players[pid]?.faction);
  const underCap = getPopulationCount(state, pid) < getPopulationCap(state, pid);
  if (underCap) {
    for (const structure of getOwnedStructures(state, pid)) {
      for (const type of unlocked) {
        if (canAfford(state, type)) out.push({ action: 'recruit', params: { unitType: type as UnitType, templeId: structure.id } });
      }
    }
  }

  // Research.
  for (const tech of TECH_NODES) {
    if (canResearch(state, tech.id)) out.push({ action: 'research', params: { techId: tech.id } });
  }

  // Build teleport — one representative pair per eligible structure (connect the
  // two most distant structures), to keep the branching factor sane.
  for (const structure of getOwnedStructures(state, pid)) {
    if (!canBuildTeleportPair(state, structure.id)) continue;
    const a = getValidTeleportHexes(state, structure.id);
    const bs = getValidTeleportHexesForOtherTemples(state, structure.id);
    if (a.length === 0 || bs.length === 0) continue;
    let posB = bs[0]!; let bd = -1;
    for (const h of bs) { const d = hexDistance(structure.pos, h); if (d > bd) { bd = d; posB = h; } }
    out.push({ action: 'build-teleport', params: { templeId: structure.id, pos: a[0]!, targetPos: posB } });
  }

  // Devotion — a purchase for each owned Temple below max level. Farms are
  // handled above (Builder-driven, via computeUnitActions' 'build-farm').
  for (const site of state.strategicSites) {
    if (site.ownerId !== pid) continue;
    if (site.state === 'temple' && canBuyDevotion(state, site.id)) {
      out.push({ action: 'buy-devotion', params: { templeId: site.id } });
    }
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
    strategicSites: s.strategicSites.map(site => ({ ...site, founding: site.founding ? { ...site.founding } : null })),
    capitals: s.capitals.map(c => ({ ...c })),
    farms: s.farms.map(f => ({ ...f })),
    trainingQueue: s.trainingQueue.map(o => ({ ...o })),
    roads: s.roads.map(r => ({ ...r })),
    pillagedRoadHexes: new Set(s.pillagedRoadHexes),
    hills: s.hills, walls: s.walls, forests: s.forests,
    explored: s.explored.map((e, i) => (i === cur ? new Set(e) : e)),
    currentPlayerIndex: s.currentPlayerIndex,
    firstPlayerIndex: s.firstPlayerIndex,
    phase: s.phase,
    mapRadius: s.mapRadius,
    winner: s.winner,
    turnNumber: s.turnNumber,
    selectedUnitId: null, selectedSiteId: null, selectionMode: null,
    moveHexes: [], attackHexes: [], structureAttackHexes: [], supportHexes: [], buildHexes: [],
    spawnedSiteIds: new Set(s.spawnedSiteIds),
    playerTech: s.playerTech.map(pt => ({ researched: new Set(pt.researched), researching: pt.researching ? { ...pt.researching } : null })),
    teleportBuildings: s.teleportBuildings.map(tp => ({ ...tp })),
  };
}

// §11 — a Capital is permanent until destroyed, and destruction already ends
// the match, so this is always true pre-gameOver in practice.
export function isAlive(state: GameState, pid: number): boolean {
  const capital = state.capitals.find(c => c.playerId === pid);
  return !!capital && capital.hp > 0;
}

export { setSeed };
export type { HexCoord };
