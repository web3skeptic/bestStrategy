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
// actCombatUnit itself already uses for the heuristic fallback (Normal and
// below) — the search layer just gets to see MORE of the ranked candidates
// and compare their simulated outcomes instead of committing to the
// single top-ranked one outright.
import {
  pickObjective, scoreMoveHex, select, currentAttackTargets, currentStructureAttackHexes,
  chooseStrategicPlan, computeThreatMap, revealedEnemies, effectiveDest,
  AI_DIFFICULTY, type AiDifficulty,
} from './ai';
import { hexDistance } from './hex';
import type { Unit } from './types';

// Search-specific tuning, deliberately separate from AI_DIFFICULTY (which
// still drives the existing heuristic fallback/lookahead unchanged) — the
// AI 2.0 brief wants noticeably wider candidate pools than the old
// candidateLimit (3/6) provided (§35-36: Hard 8-12, Expert 12-20 BEFORE
// pruning). Every number search/candidate-generation cares about lives
// here, not scattered through ai.ts.
export const SEARCH_CONFIG: Record<AiDifficulty, {
  enabled: boolean; candidateWidth: number; maxDepthPlies: number; timeBudgetMs: number;
}> = {
  easy:   { enabled: false, candidateWidth: 0, maxDepthPlies: 0, timeBudgetMs: 0 },
  normal: { enabled: false, candidateWidth: 0, maxDepthPlies: 0, timeBudgetMs: 0 },
  hard:   { enabled: true, candidateWidth: 10, maxDepthPlies: 4, timeBudgetMs: 400 },
  expert: { enabled: true, candidateWidth: 16, maxDepthPlies: 6, timeBudgetMs: 1200 },
};

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

  const cfg = AI_DIFFICULTY[difficulty];
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
