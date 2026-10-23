// One headless AI-vs-AI match on the real engine, with a seeded RNG and a
// per-player record of which game capabilities were actually used. Shared by
// the coverage report, the difficulty benchmark and the evolution driver.
import { createGameState, chooseFaction, endTurn, getCurrentPlayer, getPlayerIncome, getUnitCost, getCounters, resetCounters } from '../src/game';
import { runAiTurn, type AiDifficulty } from '../src/ai';
import type { FactionId, GameState, UnitType } from '../src/types';
import type { AiGenome } from '../src/aiGenome';
import { installSeededRandom, setSeed } from '../ml/rng';

export interface SideSpec {
  difficulty: AiDifficulty;
  // Overrides the difficulty's own genome (evolution candidates).
  genome?: AiGenome;
  // Play this side with the ORIGINAL AI at one of its old levels instead
  // ('easy' | 'normal' | 'hard' | 'expert'), loaded from a checkout of the
  // code before this work (see setLegacyAi / worker.ts LEGACY_AI_DIR).
  legacy?: string;
}

// The pre-evolution AI and its own copy of the engine (identical rules —
// only ai*.ts changed). Its engine keeps its own id counters, so they are
// synced around each of its turns to keep unit/farm/site ids unique.
interface LegacyModules {
  runAiTurn: (state: GameState, difficulty: string, aiPlayerId?: number) => unknown;
  getCounters: () => [number, number, number, number];
  resetCounters: (u: number, s: number, t: number, f?: number) => void;
}
let legacy: LegacyModules | null = null;
export function setLegacyAi(mods: LegacyModules): void { legacy = mods; }

function runSide(state: GameState, side: SideSpec, seat: number): void {
  if (!side.legacy) { runAiTurn(state, side.difficulty, seat, side.genome); return; }
  if (!legacy) throw new Error('legacy AI requested but LEGACY_AI_DIR is not set');
  const [u, s, t, f] = getCounters();
  legacy.resetCounters(u, s, t, f);
  legacy.runAiTurn(state, side.legacy, seat);
  const [u2, s2, t2, f2] = legacy.getCounters();
  resetCounters(u2, s2, t2, f2);
}

export interface CapabilityLog {
  recruits: Partial<Record<UnitType, number>>;
  research: string[];
  farmsStarted: number;
  roadsBuilt: number;
  roadsPillaged: number;
  fertileClaims: number;
  templesFounded: number;
  templeUpgrades: number;
  unitHits: number;
  kills: number;
  farmHits: number;
  templeHits: number;
  capitalHits: number;
}

export interface MatchResult {
  seed: number;
  factions: [FactionId, FactionId];
  winner: 0 | 1 | null;
  rounds: number;
  // In [0, 1]: 1 = decisive win for seat 0, 0 = for seat 1. Timeouts are
  // scored 0.4–0.6 from the material balance so evolution still gets a gradient.
  score0: number;
  ms: number;
  logs: [CapabilityLog, CapabilityLog];
}

function emptyLog(): CapabilityLog {
  return { recruits: {}, research: [], farmsStarted: 0, roadsBuilt: 0, roadsPillaged: 0, fertileClaims: 0,
    templesFounded: 0, templeUpgrades: 0, unitHits: 0, kills: 0, farmHits: 0, templeHits: 0, capitalHits: 0 };
}

interface Snapshot {
  queue: number;
  researching: string | null;
  farmIds: Set<string>;
  roadsMine: number;
  roadsTheirs: number;
  fertileMine: number;
  foundingMine: Set<string>;
  upgradingMine: Set<string>;
  enemyUnitHp: Map<string, number>;
  farmHp: Map<string, number>;
  templeHp: Map<string, number>;
  capitalHp: number;
}

function snapshot(state: GameState, me: number): Snapshot {
  return {
    queue: state.trainingQueue.filter(o => o.playerId === me).length,
    researching: state.playerTech[me]?.researching?.techId ?? null,
    farmIds: new Set(state.farms.filter(f => f.ownerId === me).map(f => f.id)),
    roadsMine: state.roads.filter(r => r.ownerId === me).length,
    roadsTheirs: state.roads.filter(r => r.ownerId !== me).length,
    fertileMine: state.fertileSites.filter(f => f.ownerId === me).length,
    foundingMine: new Set(state.strategicSites.filter(s => s.founding?.playerId === me).map(s => s.id)),
    upgradingMine: new Set(state.strategicSites.filter(s => s.upgrade?.playerId === me).map(s => s.id)),
    enemyUnitHp: new Map(state.units.filter(u => u.playerId !== me && u.hp > 0).map(u => [u.id, u.hp])),
    farmHp: new Map(state.farms.filter(f => f.ownerId !== me).map(f => [f.id, f.hp])),
    templeHp: new Map(state.strategicSites.filter(s => s.ownerId !== null && s.ownerId !== me).map(s => [s.id, s.hp])),
    capitalHp: state.capitals.filter(c => c.playerId !== me).reduce((s, c) => s + c.hp, 0),
  };
}

function record(state: GameState, me: number, before: Snapshot, log: CapabilityLog): void {
  const newOrders = state.trainingQueue.filter(o => o.playerId === me).slice(before.queue);
  for (const o of newOrders) log.recruits[o.unitType] = (log.recruits[o.unitType] ?? 0) + 1;
  const researching = state.playerTech[me]?.researching?.techId ?? null;
  if (researching && researching !== before.researching) log.research.push(researching);
  log.farmsStarted += state.farms.filter(f => f.ownerId === me && !before.farmIds.has(f.id)).length;
  log.roadsBuilt += Math.max(0, state.roads.filter(r => r.ownerId === me).length - before.roadsMine);
  log.roadsPillaged += Math.max(0, before.roadsTheirs - state.roads.filter(r => r.ownerId !== me).length);
  log.fertileClaims += Math.max(0, state.fertileSites.filter(f => f.ownerId === me).length - before.fertileMine);
  log.templesFounded += state.strategicSites.filter(s => s.founding?.playerId === me && !before.foundingMine.has(s.id)).length;
  log.templeUpgrades += state.strategicSites.filter(s => s.upgrade?.playerId === me && !before.upgradingMine.has(s.id)).length;
  for (const [id, hp] of before.enemyUnitHp) {
    const u = state.units.find(x => x.id === id);
    if (!u) continue;
    if (u.hp < hp) log.unitHits++;
    if (u.hp <= 0) log.kills++;
  }
  for (const [id, hp] of before.farmHp) {
    const f = state.farms.find(x => x.id === id);
    if (!f || f.hp < hp) log.farmHits++;
  }
  for (const [id, hp] of before.templeHp) {
    const s = state.strategicSites.find(x => x.id === id);
    if (s && (s.hp < hp || s.ownerId === null)) log.templeHits++;
  }
  const capitalHp = state.capitals.filter(c => c.playerId !== me).reduce((s, c) => s + c.hp, 0);
  if (capitalHp < before.capitalHp) log.capitalHits++;
}

// Material balance for a game that hit the round cap: Capital HP matters
// most (it is the win condition), then army value and income.
function materialScore(state: GameState): number {
  const side = (id: number): number => {
    const faction = state.players[id]?.faction ?? undefined;
    const capital = state.capitals.find(c => c.playerId === id);
    const army = state.units.filter(u => u.playerId === id && u.hp > 0)
      .reduce((s, u) => s + getUnitCost(u.type, faction) * (u.hp / u.stats.maxHp), 0);
    return (capital ? capital.hp / capital.maxHp : 0) * 30 + army + getPlayerIncome(state, id) * 3;
  };
  const a = side(0), b = side(1);
  // Squash into (0.4, 0.6): a decisive win must clearly beat any timeout,
  // or a passive "stay ahead on material" strategy is nearly as fit.
  return 0.5 + 0.1 * Math.tanh((a - b) / 25);
}

export function playMatch(seed: number, sides: [SideSpec, SideSpec], factions: [FactionId, FactionId], maxRounds = 80): MatchResult {
  installSeededRandom();
  setSeed(seed);
  const t0 = Date.now();
  const state = createGameState();
  chooseFaction(state, 0, factions[0]);
  chooseFaction(state, 1, factions[1]);
  const logs: [CapabilityLog, CapabilityLog] = [emptyLog(), emptyLog()];
  let turns = 0;
  while (state.phase !== 'gameOver' && state.turnNumber <= maxRounds && turns < maxRounds * 2 + 4) {
    const seat = getCurrentPlayer(state).id as 0 | 1;
    const before = snapshot(state, seat);
    runSide(state, sides[seat], seat);
    record(state, seat, before, logs[seat]);
    if (state.phase === 'playing') endTurn(state);
    turns++;
  }
  const winner = state.winner ? (state.winner.id as 0 | 1) : null;
  return {
    seed, factions, winner, rounds: state.turnNumber,
    score0: winner === 0 ? 1 : winner === 1 ? 0 : materialScore(state),
    ms: Date.now() - t0,
    logs,
  };
}
