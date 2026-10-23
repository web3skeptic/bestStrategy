// ── AI 2.0 Phase 2 — canonical action representation + safe simulation ────
//
// Every AI decision (search or heuristic) should be expressible as one of
// these, and every one of them resolves through the EXACT canonical engine
// mutators (game.ts) — no AI-only simplified combat/movement, per the AI
// 2.0 brief's §31-32. This module owns "what actions exist and how do I
// apply one to a state"; it does not decide which action is good (that's
// candidate generation/heuristics in ai.ts, and eventually search).
import type { GameState, HexCoord, TechId, UnitType } from './types';
import {
  selectUnit, moveUnit, attackUnit, attackStructure, spawnUnit, researchTech,
  startFarm, buildRoadPath, startFounding, startTempleUpgrade, claimFertileSite, pillageRoad,
  endTurn, getPlayerCapital,
} from './game';
import { cloneStateForSim } from './ai';

export type AiAction =
  | { kind: 'move'; unitId: string; to: HexCoord }
  | { kind: 'attack'; unitId: string; targetPos: HexCoord }
  | { kind: 'moveAttack'; unitId: string; to: HexCoord; targetPos: HexCoord }
  | { kind: 'attackStructure'; unitId: string; targetPos: HexCoord }
  | { kind: 'recruit'; structureId: string; unitType: UnitType }
  | { kind: 'research'; techId: TechId }
  | { kind: 'buildFarm'; unitId: string; pos: HexCoord }
  | { kind: 'buildRoad'; unitId: string; path: HexCoord[] }
  | { kind: 'foundSite'; unitId: string }
  | { kind: 'upgradeTemple'; siteId: string }
  | { kind: 'claimFertileSite'; unitId: string }
  | { kind: 'pillageRoad'; unitId: string }
  | { kind: 'endActivation'; unitId: string }
  | { kind: 'endTurn' };

// Human-readable label — used by telemetry/debug output and move-ordering
// logs, never by game logic.
export function describeAction(action: AiAction): string {
  switch (action.kind) {
    case 'move': return `move ${action.unitId} -> (${action.to.q},${action.to.r})`;
    case 'attack': return `attack from ${action.unitId} -> (${action.targetPos.q},${action.targetPos.r})`;
    case 'moveAttack': return `${action.unitId} move->(${action.to.q},${action.to.r}) then attack (${action.targetPos.q},${action.targetPos.r})`;
    case 'attackStructure': return `${action.unitId} attacks structure at (${action.targetPos.q},${action.targetPos.r})`;
    case 'recruit': return `recruit ${action.unitType} at ${action.structureId}`;
    case 'research': return `research ${action.techId}`;
    case 'buildFarm': return `${action.unitId} builds Farm at (${action.pos.q},${action.pos.r})`;
    case 'buildRoad': return `${action.unitId} builds ${action.path.length} Road segment(s)`;
    case 'foundSite': return `${action.unitId} founds/reconstructs the site under it`;
    case 'upgradeTemple': return `upgrade Temple ${action.siteId}`;
    case 'claimFertileSite': return `${action.unitId} claims the Fertile Site under it`;
    case 'pillageRoad': return `${action.unitId} pillages the Road under it`;
    case 'endActivation': return `${action.unitId} ends its activation without acting`;
    case 'endTurn': return 'end turn';
  }
}

// Applies `action` to `state` via the real engine mutators — this IS the
// only place search/heuristics are allowed to mutate a GameState. Returns
// whether the action actually took effect (an illegal/no-longer-legal
// action is a no-op, never a throw — mirrors every engine mutator's own
// boolean-return convention).
export function applyAiAction(state: GameState, action: AiAction): boolean {
  switch (action.kind) {
    case 'move': {
      selectUnit(state, action.unitId);
      if (state.selectedUnitId !== action.unitId) return false;
      return moveUnit(state, action.to).moved;
    }
    case 'attack': {
      selectUnit(state, action.unitId);
      if (state.selectedUnitId !== action.unitId) return false;
      return !!attackUnit(state, action.targetPos);
    }
    case 'moveAttack': {
      selectUnit(state, action.unitId);
      if (state.selectedUnitId !== action.unitId) return false;
      if (!moveUnit(state, action.to).moved) return false;
      return !!attackUnit(state, action.targetPos);
    }
    case 'attackStructure': {
      selectUnit(state, action.unitId);
      if (state.selectedUnitId !== action.unitId) return false;
      return !!attackStructure(state, action.targetPos);
    }
    case 'recruit':
      return spawnUnit(state, action.structureId, action.unitType);
    case 'research':
      return researchTech(state, action.techId);
    case 'buildFarm':
      return startFarm(state, action.unitId, action.pos);
    case 'buildRoad':
      return buildRoadPath(state, action.unitId, action.path).length > 0;
    case 'foundSite':
      return startFounding(state, action.unitId);
    case 'upgradeTemple':
      return startTempleUpgrade(state, action.siteId);
    case 'claimFertileSite':
      return claimFertileSite(state, action.unitId);
    case 'pillageRoad':
      return pillageRoad(state, action.unitId);
    case 'endActivation': {
      // No canonical "pass" mutator exists (a human just clicks a different
      // unit) — search needs one so "do nothing productive right now" is
      // itself a real, comparable candidate (§37's "quiet moves", §4's
      // "hold defensive position"). Marking both flags spent is exactly
      // what every other action already does at the end of an activation.
      const unit = state.units.find(u => u.id === action.unitId && u.hp > 0);
      if (!unit) return false;
      unit.hasMoved = true;
      unit.hasAttacked = true;
      return true;
    }
    case 'endTurn':
      endTurn(state);
      return true;
  }
}

// Clone `state`, apply `action` to the clone, and return both the clone and
// whether the action actually took effect — never mutates the live state.
export function simulateAction(state: GameState, action: AiAction): { state: GameState; applied: boolean } {
  const sim = cloneStateForSim(state);
  const applied = applyAiAction(sim, action);
  return { state: sim, applied };
}

// ── AI 2.0 Phase 3 — candidate generation ──────────────────────────────────
//
// Scope decision: search-based candidate generation (this section) and the
// negamax search built on top of it (Phase 4) apply to COMBAT UNIT
// activations only — move/attack/hold decisions, where "simulate a few
// plies and see which is actually better" is the whole point (this is also
// exactly what the AI 2.0 brief's own test scenarios §86-89 exercise:
// kills, quiet defense, activation order, horizon effects — all tactical).
// Founder-type units (recruiting, research, Farms, Roads, Temple founding/
// upgrade, Fertile Sites) keep using the existing heuristic AI in ai.ts
// completely unchanged — those decisions are much more deterministic
// ("build the next Farm the moment it's affordable" doesn't benefit from
// adversarial search the way "which of 3 units to attack with first" does)
// and are already reasonably tuned. Nothing here disturbs them.
//
// Reuses the EXISTING heuristics as generators rather than reinventing
// "which move is plausible" (§3, §33): pickObjective/scoreMoveHex/
// chooseStrategicPlan/computeThreatMap are the exact same functions
// actCombatUnit itself already uses for the heuristic fallback (Medium and
// below) — the search layer just gets to see MORE of the ranked candidates
// and compare their simulated outcomes instead of committing to the
// single top-ranked one outright.
import {
  pickObjective, scoreMoveHex, select, currentAttackTargets, currentStructureAttackHexes,
  chooseStrategicPlan, computeThreatMap, revealedEnemies, effectiveDest,
  difficultyConfig, type AiDifficulty, evaluateState,
} from './ai';
import { activeGenome } from './aiGenome';
import { hexDistance } from './hex';
import type { Unit } from './types';

// Search-specific tuning, deliberately separate from AI_DIFFICULTY (which
// still drives the existing heuristic fallback/lookahead unchanged) — the
// AI 2.0 brief wants noticeably wider candidate pools than the old
// candidateLimit (3/6) provided (§35-36: Hard 8-12, Expert 12-20 BEFORE
// pruning). Every number search/candidate-generation cares about lives
// here, not scattered through ai.ts.
// perTurnBudgetMs is the hard ceiling on TOTAL search time across an
// entire AI turn (every activation-order call plus every per-unit call
// combined) — timeBudgetMs alone only bounds a single call, and a turn can
// call search many times (one per eligible unit, plus the activation-order
// pre-pass), which could otherwise stack up to several times timeBudgetMs
// on a busy board. See runTurn's turnSearchDeadline plumbing in ai.ts.
//
// Tuned down from an initial 1300/2600 after the macro-plan persistence
// layer (chooseStrategicPlan committing to one plan for several rounds
// instead of re-rolling every turn) turned out to keep noticeably MORE
// units in sustained mutual contact for MANY consecutive turns during a
// real fight — every one of those units legitimately qualifies for
// search's tactical-content gate at once, so the shared per-turn budget
// was reliably being fully spent turn after turn instead of just
// occasionally, a real and measured (not hypothetical) live-server cost
// increase. These values keep worst-case per-turn latency bounded to
// roughly what a human would tolerate as "AI is thinking" even when that
// sustained-combat pattern is the norm for a long stretch of a real game,
// not just an occasional spike.
export const SEARCH_CONFIG: Record<AiDifficulty, {
  enabled: boolean; candidateWidth: number; maxDepthPlies: number; timeBudgetMs: number; perTurnBudgetMs: number;
}> = {
  easy:   { enabled: false, candidateWidth: 0, maxDepthPlies: 0, timeBudgetMs: 0, perTurnBudgetMs: 0 },
  medium: { enabled: false, candidateWidth: 0, maxDepthPlies: 0, timeBudgetMs: 0, perTurnBudgetMs: 0 },
  hard:   { enabled: true, candidateWidth: 10, maxDepthPlies: 4, timeBudgetMs: 400, perTurnBudgetMs: 700 },
};

// Search runs when the difficulty allows it and the genome in effect hasn't
// switched it off.
export function searchOn(difficulty: AiDifficulty): boolean {
  return SEARCH_CONFIG[difficulty].enabled && activeGenome().tactics.search >= 0.5;
}

function actionKey(a: AiAction): string {
  switch (a.kind) {
    case 'move': return `move:${a.unitId}:${a.to.q},${a.to.r}`;
    case 'attack': return `attack:${a.unitId}:${a.targetPos.q},${a.targetPos.r}`;
    case 'moveAttack': return `moveAttack:${a.unitId}:${a.to.q},${a.to.r}:${a.targetPos.q},${a.targetPos.r}`;
    case 'attackStructure': return `attackStructure:${a.unitId}:${a.targetPos.q},${a.targetPos.r}`;
    case 'recruit': return `recruit:${a.structureId}:${a.unitType}`;
    case 'research': return `research:${a.techId}`;
    case 'buildFarm': return `buildFarm:${a.unitId}:${a.pos.q},${a.pos.r}`;
    case 'buildRoad': return `buildRoad:${a.unitId}:${a.path.map(p => `${p.q},${p.r}`).join('|')}`;
    case 'foundSite': return `foundSite:${a.unitId}`;
    case 'upgradeTemple': return `upgradeTemple:${a.siteId}`;
    case 'claimFertileSite': return `claimFertileSite:${a.unitId}`;
    case 'pillageRoad': return `pillageRoad:${a.unitId}`;
    case 'endActivation': return `endActivation:${a.unitId}`;
    case 'endTurn': return 'endTurn';
  }
}

// §34 — count equivalent final states once, not once per path/permutation
// that reaches them. Candidates here are already destination-hex-based
// (not raw movement paths), so an exact-key dedup is enough: two entries
// only collide when they really do describe the identical action.
function dedupeActions(actions: AiAction[]): AiAction[] {
  const seen = new Set<string>();
  const result: AiAction[] = [];
  for (const a of actions) {
    const key = actionKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(a);
  }
  return result;
}

// Generates a bounded, meaningful set of candidate actions for one combat
// unit's activation — categories per §33: best immediate kill, best
// favorable attack (current position), best objective/pressure move (top-K
// toward pickObjective's target, each with a move+attack variant when it
// would put an enemy in range), best retreat/defensive move (explicitly a
// DISTINCT alternative, not just whatever the objective already picked —
// §37's "quiet moves" need to be genuinely reachable by search, not just
// theoretically possible), and always, unconditionally, holding still
// (§37, endActivation) as the baseline "quiet move" every other candidate
// is measured against.
export function generateCandidateActions(state: GameState, unit: Unit, aiPlayerId: number, difficulty: AiDifficulty): AiAction[] {
  const candidates: AiAction[] = [{ kind: 'endActivation', unitId: unit.id }];
  if (unit.hp <= 0 || unit.hasAttacked) return dedupeActions(candidates);
  if (!select(state, unit)) return dedupeActions(candidates);

  for (const target of currentAttackTargets(state)) {
    candidates.push({ kind: 'attack', unitId: unit.id, targetPos: target.pos });
  }
  for (const targetPos of currentStructureAttackHexes(state)) {
    candidates.push({ kind: 'attackStructure', unitId: unit.id, targetPos });
  }

  if (unit.hasMoved) return dedupeActions(candidates);

  const cfg = difficultyConfig(difficulty);
  const searchCfg = SEARCH_CONFIG[difficulty];
  const plan = cfg.useStrategicPlanning ? chooseStrategicPlan(state, aiPlayerId) : null;
  const threatMap = cfg.useThreatMap ? computeThreatMap(state, aiPlayerId) : null;
  const objective = pickObjective(state, unit, aiPlayerId, plan, cfg);
  const enemies = revealedEnemies(state, aiPlayerId);
  const capital = getPlayerCapital(state, aiPlayerId);
  const moveHexes = [...state.moveHexes];
  if (moveHexes.length === 0) return dedupeActions(candidates);

  const ranked = moveHexes
    .map(hex => ({ hex, score: scoreMoveHex(state, unit, aiPlayerId, hex, objective, enemies, threatMap) }))
    .sort((a, b) => b.score - a.score);

  const width = Math.max(1, searchCfg.candidateWidth || moveHexes.length);
  for (const { hex } of ranked.slice(0, width)) {
    candidates.push({ kind: 'move', unitId: unit.id, to: hex });
    const dest = effectiveDest(state, hex);
    const rng = unit.stats.range;
    const reachableTarget = enemies.find(e => {
      const d = hexDistance(dest, e.pos);
      return d >= 1 && d <= rng;
    });
    if (reachableTarget) candidates.push({ kind: 'moveAttack', unitId: unit.id, to: hex, targetPos: reachableTarget.pos });
  }

  // Always offer "head toward home" as its own candidate, distinct from
  // whatever pickObjective committed to — otherwise search can only ever
  // discover a retreat when the heuristic objective ALREADY happens to be
  // retreat-shaped, defeating the point of comparing alternatives at all.
  if (capital) {
    const towardHome = moveHexes.reduce((best, h) =>
      hexDistance(effectiveDest(state, h), capital.pos) < hexDistance(effectiveDest(state, best), capital.pos) ? h : best);
    candidates.push({ kind: 'move', unitId: unit.id, to: towardHome });
  }

  return dedupeActions(candidates);
}

// ── AI 2.0 Phase 9 — search telemetry/profiling ────────────────────────────
//
// Always-on, always-cheap in-memory aggregates per difficulty (calls,
// nodes, timing, timeout rate, depth reached) — recorded once per REAL
// search call (the trivial "0/1 candidates, no search needed" early-outs
// in searchBestAction/searchBestActivation don't count, they're not a
// search sample). Plus an optional observer hook, same convention as
// ai.ts's own `observe`/`setAIObserver`, for anyone who wants per-call
// detail rather than just the rolling summary — both default to a no-op,
// so normal play pays only the cost of a few counter increments.
export interface SearchTelemetryEvent {
  kind: 'searchBestAction' | 'searchBestActivation';
  difficulty: AiDifficulty;
  aiPlayerId: number;
  depthReached: number;
  nodesVisited: number;
  timedOut: boolean;
  elapsedMs: number;
}
let searchObserver: ((event: SearchTelemetryEvent) => void) | null = null;
export function setSearchObserver(fn: ((event: SearchTelemetryEvent) => void) | null): void { searchObserver = fn; }

interface DifficultyTelemetry {
  calls: number;
  totalNodes: number;
  totalElapsedMs: number;
  maxElapsedMs: number;
  timeouts: number;
  depthReachedSum: number;
}
function emptyTelemetry(): DifficultyTelemetry {
  return { calls: 0, totalNodes: 0, totalElapsedMs: 0, maxElapsedMs: 0, timeouts: 0, depthReachedSum: 0 };
}
const telemetry: Record<AiDifficulty, DifficultyTelemetry> = {
  easy: emptyTelemetry(), medium: emptyTelemetry(), hard: emptyTelemetry(),
};

export interface SearchTelemetrySummary {
  calls: number;
  avgNodesVisited: number;
  avgElapsedMs: number;
  maxElapsedMs: number;
  timeoutRate: number;
  avgDepthReached: number;
}
export function getSearchTelemetry(difficulty: AiDifficulty): SearchTelemetrySummary {
  const t = telemetry[difficulty];
  return {
    calls: t.calls,
    avgNodesVisited: t.calls ? t.totalNodes / t.calls : 0,
    avgElapsedMs: t.calls ? t.totalElapsedMs / t.calls : 0,
    maxElapsedMs: t.maxElapsedMs,
    timeoutRate: t.calls ? t.timeouts / t.calls : 0,
    avgDepthReached: t.calls ? t.depthReachedSum / t.calls : 0,
  };
}
export function resetSearchTelemetry(): void {
  for (const key of Object.keys(telemetry) as AiDifficulty[]) telemetry[key] = emptyTelemetry();
}

function recordSearchTelemetry(
  kind: SearchTelemetryEvent['kind'], difficulty: AiDifficulty, aiPlayerId: number,
  depthReached: number, nodesVisited: number, timedOut: boolean, elapsedMs: number,
): void {
  const t = telemetry[difficulty];
  t.calls++;
  t.totalNodes += nodesVisited;
  t.totalElapsedMs += elapsedMs;
  if (elapsedMs > t.maxElapsedMs) t.maxElapsedMs = elapsedMs;
  if (timedOut) t.timeouts++;
  t.depthReachedSum += depthReached;
  if (searchObserver) searchObserver({ kind, difficulty, aiPlayerId, depthReached, nodesVisited, timedOut, elapsedMs });
}

// ── AI 2.0 Phase 4 — negamax-style minimax with alpha-beta, iterative
// deepening, and a hard wall-clock/node budget ─────────────────────────────
//
// This runs synchronously inside a live Express/WebSocket process, not a
// browser Web Worker — there is no way to cancel a runaway search except by
// never starting one that can run away. Every recursive call re-checks the
// deadline AND a node-count backstop (Date.now() itself has overhead and
// isn't free to call before every single clone), and a timeout during a
// depth always discards that depth's partial result in favor of the last
// FULLY completed one (§ hard safety limits + fallback-to-heuristic).
//
// Depth is counted in ACTIVATIONS (one unit choosing one action), not full
// rounds, per the brief's own definition (§ "who acts next" is explicitly
// OUT of scope for this pass — the mover sequence here is fixed: the root
// unit, then a bounded set of the opponent's nearest not-yet-acted units as
// their "plausible reply", then the root player's own other pending units,
// alternating). evaluateState is always called with the FIXED root
// perspective (aiPlayerId) — not negated per ply — so this is really
// "minimax with a perspective-stable evaluator": max nodes are the root
// player's turns to act, min nodes are the opponent's simulated replies.
export interface SearchOutcome {
  action: AiAction;
  score: number;
  depthReached: number;
  nodesVisited: number;
  timedOut: boolean;
}

// ── AI 2.0 Phase 5 — move ordering + transposition table ───────────────────
//
// Only once Phase 4 was measured and working in real play (per the brief's
// own §100 gate) — see the free-kill/reachability/time-budget checks in
// scripts/verify-ai-search-engine.ts and the Hard integration this
// builds on.
//
// The TT's hash-inclusion list is deliberately narrow: this search's action
// space (generateCandidateActions, Phase 3) only ever changes unit
// position/HP/activation flags and structure HP via move/attack/
// moveAttack/attackStructure/endActivation — it never recruits, researches,
// builds, or founds anything. So the hash only needs to cover exactly that:
// every living unit's id/pos/hp/hasMoved/hasAttacked, every Capital's and
// StrategicSite's id/hp/state, and whose turn it is at this node (the same
// board position with a different mover is a different node). Farms,
// Roads, tech, and aura are intentionally excluded — they can't change
// within this search tree, so including them would only slow hashing down
// for zero extra correctness.
type TTFlag = 'exact' | 'lower' | 'upper';
interface TTEntry { depth: number; score: number; flag: TTFlag; bestActionKey: string | null }

function hashState(state: GameState): string {
  const parts: string[] = [String(state.currentPlayerIndex)];
  for (const u of [...state.units].filter(u => u.hp > 0).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    parts.push(`u${u.id}:${u.pos.q},${u.pos.r}:${u.hp}:${u.hasMoved ? 1 : 0}${u.hasAttacked ? 1 : 0}`);
  }
  for (const c of [...state.capitals].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    parts.push(`c${c.id}:${c.hp}`);
  }
  for (const s of [...state.strategicSites].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    parts.push(`s${s.id}:${s.hp}:${s.state}`);
  }
  return parts.join('|');
}

export interface SearchCtx {
  aiPlayerId: number;
  difficulty: AiDifficulty;
  deadline: number;
  nodeBudget: number;
  nodes: number;
  tt: Map<string, TTEntry>;
}

// Builds a fresh SearchCtx the same way searchBestAction does — exported
// purely so quiescence (and other internals) can be exercised directly in
// tests without having to reconstruct this shape by hand everywhere.
export function makeSearchCtx(aiPlayerId: number, difficulty: AiDifficulty, timeBudgetMs = 1000): SearchCtx {
  return { aiPlayerId, difficulty, deadline: Date.now() + timeBudgetMs, nodeBudget: MAX_SEARCH_NODES, nodes: 0, tt: new Map() };
}

// Whichever candidate's key matches the TT's remembered best move (if any)
// goes first — the classic "try the previously-best line first" ordering
// that makes alpha-beta's pruning actually bite instead of exploring
// candidates in whatever arbitrary order they were generated.
function orderByTT(candidates: AiAction[], bestActionKey: string | null): AiAction[] {
  if (!bestActionKey) return candidates;
  const idx = candidates.findIndex(a => actionKey(a) === bestActionKey);
  if (idx <= 0) return candidates;
  const reordered = candidates.slice();
  const [best] = reordered.splice(idx, 1);
  reordered.unshift(best!);
  return reordered;
}

// Independent of wall-clock — a slow machine (or a GC pause) could blow the
// time budget on far fewer nodes than expected; this is the true hard stop.
const MAX_SEARCH_NODES = 20000;
// Checked every single node: the real per-node cost here is a full
// cloneStateForSim (a JSON round-trip of the whole GameState), which gets
// noticeably more expensive as a real game accumulates units/farms/roads/
// tech over dozens of rounds — sampling the clock only every N nodes (as
// this used to) meant a late-game turn could overshoot its own per-call
// time budget by several hundred ms before the next check even landed.
// Date.now() itself is nanoseconds; the clone is the expensive part, so
// checking every node costs nothing extra worth trading away.
const CLOCK_CHECK_INTERVAL = 4;

function timeUp(ctx: SearchCtx): boolean {
  if (ctx.nodes >= ctx.nodeBudget) return true;
  if (ctx.nodes % CLOCK_CHECK_INTERVAL !== 0) return false;
  return Date.now() >= ctx.deadline;
}

// The opponent's plausible responders to whatever just happened near
// `aroundPos` — their nearest not-yet-acted units, not the whole army; this
// keeps the min-layer's branching bounded without pretending a strong
// opponent only ever considers one specific unit.
function respondersNear(state: GameState, aiPlayerId: number, aroundPos: HexCoord, limit: number): Unit[] {
  return state.units
    .filter(u => u.playerId !== aiPlayerId && u.hp > 0 && !u.hasAttacked)
    .sort((a, b) => hexDistance(a.pos, aroundPos) - hexDistance(b.pos, aroundPos))
    .slice(0, limit);
}

// selectUnit (the real engine mutator, called deep inside select/
// generateCandidateActions) refuses to select a unit that doesn't belong to
// getCurrentPlayer(state) — a real, correct rule for actual play, but
// during search the "current player" of a cloned node needs to track
// WHICHEVER SIDE is acting at that node, not stay pinned to whoever's real
// turn it is live. Every node in this search tree is a throwaway clone
// (never the live state), so flipping this here is always safe.
function setActingPlayer(state: GameState, playerId: number): void {
  const idx = state.players.findIndex(p => p.id === playerId);
  if (idx >= 0) state.currentPlayerIndex = idx;
}

// Narrow, depth-dependent slice of a unit's own candidates for the NON-root
// plies — the root ply gets the full candidate width (that's the decision
// actually being made); deeper plies only need to be plausible enough to
// keep the root's evaluation honest, not exhaustively explored themselves.
function narrowCandidates(state: GameState, unit: Unit, forPlayerId: number, difficulty: AiDifficulty, width: number): AiAction[] {
  setActingPlayer(state, forPlayerId);
  return generateCandidateActions(state, unit, forPlayerId, difficulty).slice(0, width);
}

// ── AI 2.0 Phase 6 — quiescence search ──────────────────────────────────────
//
// The horizon effect: the main search stops at a fixed activation depth
// and evaluates whatever position it happens to land on — including one
// where a profitable attack is sitting right there unresolved, which
// evaluateState scores as if that material swing already happened (the
// `threatenedMaterial`/guaranteed-kill terms from aiEval.ts approximate it,
// but only as a discounted guess, never the real thing). A leaf that's
// mid-fight is not a fair stopping point. So instead of evaluating a leaf
// outright, keep searching ONLY attacks (never quiet moves — that's what
// keeps this bounded) until the position is actually quiet, capped by its
// own small ply budget independent of the main search's depth.
export const QUIESCENCE_MAX_PLIES = 4;
export const QUIESCENCE_WIDTH = 2;

function noisyCandidates(state: GameState, unit: Unit, forPlayerId: number, difficulty: AiDifficulty, width: number): AiAction[] {
  setActingPlayer(state, forPlayerId);
  return generateCandidateActions(state, unit, forPlayerId, difficulty)
    .filter(a => a.kind === 'attack' || a.kind === 'attackStructure' || a.kind === 'moveAttack')
    .slice(0, width);
}

export function quiescence(
  state: GameState, ctx: SearchCtx, alpha: number, beta: number,
  mover: 'me' | 'opponent', lastActedPos: HexCoord, myPendingUnits: Unit[], qPlyLeft: number,
): number {
  ctx.nodes++;
  if (state.phase === 'gameOver' || timeUp(ctx)) return evaluateState(state, ctx.aiPlayerId);
  // "Stand pat": the side to move is never forced to keep trading — if
  // every available follow-up attack is actually worse than just stopping
  // here, stopping here is a legitimate, comparable option.
  const standPat = evaluateState(state, ctx.aiPlayerId);
  if (qPlyLeft <= 0) return standPat;

  if (mover === 'opponent') {
    if (standPat <= alpha) return standPat;
    if (standPat < beta) beta = standPat;
    const responders = respondersNear(state, ctx.aiPlayerId, lastActedPos, 2);
    let value = standPat;
    outer: for (const u of responders) {
      for (const action of noisyCandidates(state, u, u.playerId, ctx.difficulty, QUIESCENCE_WIDTH)) {
        if (timeUp(ctx)) break outer;
        const { state: next, applied } = simulateAction(state, action);
        if (!applied) continue;
        const score = quiescence(next, ctx, alpha, beta, 'me', u.pos, myPendingUnits, qPlyLeft - 1);
        if (score < value) value = score;
        if (value < beta) beta = value;
        if (beta <= alpha) break outer;
      }
    }
    return value;
  }

  if (standPat >= beta) return standPat;
  if (standPat > alpha) alpha = standPat;
  let value = standPat;
  // The unit whose action led into this node already spent its attack (a
  // unit can't attack twice in one activation) — only its own STILL-PENDING
  // teammates can extend the trade further.
  for (const unit of myPendingUnits) {
    if (unit.hp <= 0) continue;
    for (const action of noisyCandidates(state, unit, ctx.aiPlayerId, ctx.difficulty, QUIESCENCE_WIDTH)) {
      if (timeUp(ctx)) break;
      const { state: next, applied } = simulateAction(state, action);
      if (!applied) continue;
      const score = quiescence(next, ctx, alpha, beta, 'opponent', unit.pos, myPendingUnits, qPlyLeft - 1);
      if (score > value) value = score;
      if (value > alpha) alpha = value;
      if (alpha >= beta) return value;
    }
  }
  return value;
}

function minimax(
  state: GameState, ctx: SearchCtx, plyLeft: number, alpha: number, beta: number,
  mover: 'me' | 'opponent', lastActedPos: HexCoord, myPendingUnits: Unit[],
): number {
  ctx.nodes++;
  if (state.phase === 'gameOver') return evaluateState(state, ctx.aiPlayerId);
  if (plyLeft <= 0 || timeUp(ctx)) {
    return quiescence(state, ctx, alpha, beta, mover, lastActedPos, myPendingUnits, QUIESCENCE_MAX_PLIES);
  }

  const origAlpha = alpha;
  const origBeta = beta;
  const hash = hashState(state);
  const cached = ctx.tt.get(hash);
  let ttBestKey: string | null = null;
  if (cached && cached.depth >= plyLeft) {
    if (cached.flag === 'exact') return cached.score;
    if (cached.flag === 'lower' && cached.score > alpha) alpha = cached.score;
    else if (cached.flag === 'upper' && cached.score < beta) beta = cached.score;
    if (alpha >= beta) return cached.score;
  }
  if (cached) ttBestKey = cached.bestActionKey;

  const store = (value: number, bestActionKey: string | null): void => {
    if (cached && cached.depth > plyLeft) return; // never overwrite a deeper, more trustworthy entry
    const flag: TTFlag = value <= origAlpha ? 'upper' : value >= origBeta ? 'lower' : 'exact';
    ctx.tt.set(hash, { depth: plyLeft, score: value, flag, bestActionKey });
  };

  if (mover === 'opponent') {
    const responders = respondersNear(state, ctx.aiPlayerId, lastActedPos, plyLeft >= 3 ? 3 : 2);
    if (responders.length === 0) {
      const v = evaluateState(state, ctx.aiPlayerId);
      store(v, null);
      return v;
    }
    let value = Infinity;
    let bestKey: string | null = null;
    outer: for (const u of responders) {
      const candidates = orderByTT(narrowCandidates(state, u, u.playerId, ctx.difficulty, 3), ttBestKey);
      for (const action of candidates) {
        if (timeUp(ctx)) break outer;
        const { state: next, applied } = simulateAction(state, action);
        if (!applied) continue;
        const score = minimax(next, ctx, plyLeft - 1, alpha, beta, 'me', u.pos, myPendingUnits);
        if (score < value) { value = score; bestKey = actionKey(action); }
        if (value < beta) beta = value;
        if (beta <= alpha) break outer;
      }
    }
    const result = value === Infinity ? evaluateState(state, ctx.aiPlayerId) : value;
    store(result, bestKey);
    return result;
  }

  // mover === 'me' — one of the root player's own still-pending units
  // continues the same turn (the root unit's own decision is handled by the
  // caller, searchBestAction, not here).
  if (myPendingUnits.length === 0) { const v = evaluateState(state, ctx.aiPlayerId); store(v, null); return v; }
  const [unit, ...rest] = myPendingUnits;
  if (!unit || unit.hp <= 0) return minimax(state, ctx, plyLeft, alpha, beta, mover, lastActedPos, rest);
  const candidates = orderByTT(narrowCandidates(state, unit, ctx.aiPlayerId, ctx.difficulty, 3), ttBestKey);
  let value = -Infinity;
  let bestKey: string | null = null;
  for (const action of candidates) {
    if (timeUp(ctx)) break;
    const { state: next, applied } = simulateAction(state, action);
    if (!applied) continue;
    const score = minimax(next, ctx, plyLeft - 1, alpha, beta, 'opponent', unit.pos, rest);
    if (score > value) { value = score; bestKey = actionKey(action); }
    if (value > alpha) alpha = value;
    if (beta <= alpha) break;
  }
  const result = value === -Infinity ? evaluateState(state, ctx.aiPlayerId) : value;
  store(result, bestKey);
  return result;
}

// Root search: chooses the best action for THIS unit's activation by
// iterative deepening (2, 4, ... activations, capped by
// SEARCH_CONFIG[difficulty].maxDepthPlies), each depth alpha-beta-pruned
// and time/node-budgeted. `otherPendingUnits` — the root player's own other
// not-yet-acted-this-turn units — lets the search look past just this one
// unit when time allows, without requiring a full "who acts next" search
// (they're considered in the fixed order given).
//
// Returns null if search is disabled for this difficulty, or if the unit
// has no real candidates to choose from at all — callers must fall back to
// the existing heuristic path in that case.
//
// `maxTimeBudgetMs`, if given, caps this call BELOW SEARCH_CONFIG's own
// per-call timeBudgetMs — used by runTurn to enforce a hard PER-TURN
// search budget across every call it makes, not just each one individually
// (see SEARCH_CONFIG's own comment on perTurnBudgetMs).
export function searchBestAction(
  state: GameState, unit: Unit, aiPlayerId: number, difficulty: AiDifficulty, otherPendingUnits: Unit[] = [],
  maxTimeBudgetMs?: number,
): SearchOutcome | null {
  const searchCfg = SEARCH_CONFIG[difficulty];
  if (!searchOn(difficulty)) return null;
  const timeBudgetMs = maxTimeBudgetMs === undefined ? searchCfg.timeBudgetMs : Math.min(searchCfg.timeBudgetMs, maxTimeBudgetMs);
  if (timeBudgetMs <= 0) return null;

  const rootCandidates = generateCandidateActions(state, unit, aiPlayerId, difficulty);
  if (rootCandidates.length === 0) return null;
  if (rootCandidates.length === 1) {
    return { action: rootCandidates[0]!, score: 0, depthReached: 0, nodesVisited: 0, timedOut: false };
  }

  // Cheap static move-ordering: a shallow (0-ply) evaluation of each root
  // candidate's resulting state, sorted best-first, so alpha-beta actually
  // has something strong to prune against from move 1 of every depth
  // (real transposition-table-driven ordering is Phase 5 — this is the
  // minimum viable version of "try the likely-best move first").
  const orderedRoots = rootCandidates
    .map(action => {
      const { state: next, applied } = simulateAction(state, action);
      return { action, staticScore: applied ? evaluateState(next, aiPlayerId) : -Infinity };
    })
    .filter(r => r.staticScore > -Infinity)
    .sort((a, b) => b.staticScore - a.staticScore)
    .map(r => r.action);
  if (orderedRoots.length === 0) return null;

  const startTime = Date.now();
  let best: SearchOutcome = { action: orderedRoots[0]!, score: -Infinity, depthReached: 0, nodesVisited: 0, timedOut: false };

  // The TT persists across the WHOLE iterative-deepening session (every
  // depth, and every branch of every depth's tree) — a shallower depth's
  // entries still help order and prune the next, deeper pass, and real
  // transpositions (the same resulting position reached via a different
  // move order) get evaluated once, not once per path that reaches them.
  const tt = new Map<string, TTEntry>();
  let rootOrder = orderedRoots;

  for (let depth = 2; depth <= searchCfg.maxDepthPlies; depth += 2) {
    const ctx: SearchCtx = {
      aiPlayerId, difficulty,
      deadline: startTime + timeBudgetMs,
      nodeBudget: MAX_SEARCH_NODES,
      nodes: 0,
      tt,
    };
    let depthBestAction: AiAction = rootOrder[0]!;
    let depthBestScore = -Infinity;
    let alpha = -Infinity;
    const beta = Infinity;
    let completed = true;
    for (const action of rootOrder) {
      if (timeUp(ctx)) { completed = false; break; }
      const { state: next, applied } = simulateAction(state, action);
      if (!applied) continue;
      const score = minimax(next, ctx, depth - 1, alpha, beta, 'opponent', unit.pos, otherPendingUnits);
      if (score > depthBestScore) { depthBestScore = score; depthBestAction = action; }
      if (depthBestScore > alpha) alpha = depthBestScore;
    }
    if (timeUp(ctx)) completed = false;
    if (completed) {
      best = { action: depthBestAction, score: depthBestScore, depthReached: depth, nodesVisited: ctx.nodes, timedOut: false };
      // Next (deeper) iteration tries this depth's winner first — the
      // principal variation is very likely still strong one ply deeper, and
      // trying it first is what lets alpha-beta prune the rest hard.
      rootOrder = orderByTT(rootOrder, actionKey(depthBestAction));
    } else {
      best.timedOut = true;
      break;
    }
    if (Date.now() >= startTime + timeBudgetMs) break;
  }
  recordSearchTelemetry('searchBestAction', difficulty, aiPlayerId, best.depthReached, best.nodesVisited, best.timedOut, Date.now() - startTime);
  return best;
}

// ── AI 2.0 Phase 8 — activation-order search ("who acts next") ─────────────
//
// searchBestAction always answers "what should THIS unit do" for whichever
// unit the caller already picked — the turn order itself was still fixed.
// This instead compares candidate actions from SEVERAL pending units at
// once at the root, so the search can discover that unit B striking first
// sets up a better follow-up for unit A than acting in the order they
// happened to be listed in. Built entirely on the same minimax/quiescence/
// TT machinery above — the only new part is the root loop iterating
// (unit, action) pairs instead of one unit's actions.
export interface ActivationOutcome {
  unitId: string;
  action: AiAction;
  score: number;
  depthReached: number;
  nodesVisited: number;
  timedOut: boolean;
}

interface RootCandidate { unit: Unit; action: AiAction }

function orderRootsByKey(candidates: RootCandidate[], key: string | null): RootCandidate[] {
  if (!key) return candidates;
  const idx = candidates.findIndex(rc => actionKey(rc.action) === key);
  if (idx <= 0) return candidates;
  const reordered = candidates.slice();
  const [best] = reordered.splice(idx, 1);
  reordered.unshift(best!);
  return reordered;
}

// Chooses both WHICH of `pendingUnits` should act and WHAT it should do,
// by combining every eligible unit's own candidates into one root pool
// (still capped to the same per-difficulty width as searchBestAction, so
// having more eligible units doesn't multiply the search's total work —
// it's the same budget spent comparing across units instead of within
// one). Returns null under the same conditions as searchBestAction
// (disabled difficulty, no candidates) — callers fall back to resolving
// units one at a time via searchBestAction/the heuristic path.
export function searchBestActivation(
  state: GameState, pendingUnits: Unit[], aiPlayerId: number, difficulty: AiDifficulty,
  maxTimeBudgetMs?: number,
): ActivationOutcome | null {
  const searchCfg = SEARCH_CONFIG[difficulty];
  if (!searchOn(difficulty)) return null;
  const timeBudgetMs = maxTimeBudgetMs === undefined ? searchCfg.timeBudgetMs : Math.min(searchCfg.timeBudgetMs, maxTimeBudgetMs);
  if (timeBudgetMs <= 0) return null;
  const eligible = pendingUnits.filter(u => u.hp > 0 && !u.hasAttacked);
  if (eligible.length === 0) return null;

  const rootCandidates: RootCandidate[] = [];
  for (const unit of eligible) {
    for (const action of generateCandidateActions(state, unit, aiPlayerId, difficulty)) {
      rootCandidates.push({ unit, action });
    }
  }
  if (rootCandidates.length === 0) return null;
  if (rootCandidates.length === 1) {
    const only = rootCandidates[0]!;
    return { unitId: only.unit.id, action: only.action, score: 0, depthReached: 0, nodesVisited: 0, timedOut: false };
  }

  const ordered = rootCandidates
    .map(rc => {
      const { state: next, applied } = simulateAction(state, rc.action);
      return { rc, staticScore: applied ? evaluateState(next, aiPlayerId) : -Infinity };
    })
    .filter(r => r.staticScore > -Infinity)
    .sort((a, b) => b.staticScore - a.staticScore)
    .map(r => r.rc)
    .slice(0, Math.max(1, searchCfg.candidateWidth));
  if (ordered.length === 0) return null;

  const startTime = Date.now();
  let best: ActivationOutcome = {
    unitId: ordered[0]!.unit.id, action: ordered[0]!.action,
    score: -Infinity, depthReached: 0, nodesVisited: 0, timedOut: false,
  };
  const tt = new Map<string, TTEntry>();
  let rootOrder = ordered;

  for (let depth = 2; depth <= searchCfg.maxDepthPlies; depth += 2) {
    const ctx: SearchCtx = {
      aiPlayerId, difficulty,
      deadline: startTime + timeBudgetMs,
      nodeBudget: MAX_SEARCH_NODES,
      nodes: 0,
      tt,
    };
    let depthBest: RootCandidate = rootOrder[0]!;
    let depthBestScore = -Infinity;
    let alpha = -Infinity;
    const beta = Infinity;
    let completed = true;
    for (const rc of rootOrder) {
      if (timeUp(ctx)) { completed = false; break; }
      const { state: next, applied } = simulateAction(state, rc.action);
      if (!applied) continue;
      // Whoever's left to consider deeper in this line: everyone else
      // eligible, PLUS this same unit again if its action didn't spend the
      // whole activation (e.g. moved but hasn't attacked yet) — resolved
      // against the SIMULATED unit so hasMoved/hasAttacked reflect what
      // actually happened, not the pre-action state.
      const simUnit = next.units.find(u => u.id === rc.unit.id);
      const stillPending = simUnit && simUnit.hp > 0 && !simUnit.hasAttacked;
      const rest = eligible.filter(u => u.id !== rc.unit.id);
      const remaining = stillPending ? [simUnit!, ...rest] : rest;
      const score = minimax(next, ctx, depth - 1, alpha, beta, 'opponent', rc.unit.pos, remaining);
      if (score > depthBestScore) { depthBestScore = score; depthBest = rc; }
      if (depthBestScore > alpha) alpha = depthBestScore;
    }
    if (timeUp(ctx)) completed = false;
    if (completed) {
      best = {
        unitId: depthBest.unit.id, action: depthBest.action,
        score: depthBestScore, depthReached: depth, nodesVisited: ctx.nodes, timedOut: false,
      };
      rootOrder = orderRootsByKey(rootOrder, actionKey(depthBest.action));
    } else {
      best.timedOut = true;
      break;
    }
    if (Date.now() >= startTime + timeBudgetMs) break;
  }
  recordSearchTelemetry('searchBestActivation', difficulty, aiPlayerId, best.depthReached, best.nodesVisited, best.timedOut, Date.now() - startTime);
  return best;
}
