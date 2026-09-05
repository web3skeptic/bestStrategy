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
  endTurn, getUnitAt, getStrategicSiteAt,
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

// Every hex-under-a-structure/site "self" action (found, claim, pillage) is
// only ever legal or not depending on what's under the unit right now —
// convenient to check without duplicating each mutator's own precondition
// logic (canStartFounding/canClaimFertileSite/canPillageRoad already do
// that; this is just a quick "is there anything worth trying" filter for
// candidate generation, not a legality authority itself).
export function standingOnFoundable(state: GameState, unitId: string): boolean {
  const unit = state.units.find(u => u.id === unitId && u.hp > 0);
  if (!unit) return false;
  const site = getStrategicSiteAt(state, unit.pos);
  return !!site && (site.state === 'neutral' || site.state === 'ruins') && !site.founding;
}

export function standingOnOccupiedTile(state: GameState, pos: HexCoord): boolean {
  return !!getUnitAt(state, pos);
}
