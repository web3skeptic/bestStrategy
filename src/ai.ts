import {
  GameState, HexCoord, Unit, UnitType, TechId,
  UNIT_COSTS,
  SUPPORT_RANGE,
  RANGE_BOOST_RADIUS,
  TECH_NODES,
} from './types';
import { hexDistance, hexKey, hexEqual, hexNeighbors } from './hex';
import { calculateDamage } from './combat';
import { serialize, deserialize } from './serializer';
import { TEMPLE_UPGRADE_COST, ROAD_SEGMENTS_PER_ACTIVATION, MAX_ACTIVE_FARMS, AGRAR_FARM_COST } from './factions';
import {
  getCurrentPlayer, getUnitAt,
  spawnUnit, selectUnit, moveUnit, attackUnit, deselectAll,
  canStartFounding, startFounding,
  attackStructure, getStructureAt,
  getOwnedStructures, getPlayerCapital,
  researchTech, canResearch,
  getTeleportAt,
  canStartFarm, startFarm, getValidFarmHexes, getAllValidFarmSpots, canStartTempleUpgrade, startTempleUpgrade,
  canBuildRoad, buildRoadPath, getValidRoadHexes, isLegalRoadTile, canPillageRoad, pillageRoad,
  canClaimFertileSite, claimFertileSite,
  getUnlockedUnits, getPopulationCap, getPopulationCount,
  getEffectiveRange, getEffectiveAttack, getEffectiveDefense, getEffectiveSpeed,
  calculateEncirclement, isForestUnitRevealed, endTurn,
  getUnitTypeMultiplier,
  getUnitCost,
  getPlayerIncome,
} from './game';
import { evaluateState, evaluateStateDetailed, AI_EVAL_WEIGHTS, MATE_SCORE } from './aiEval';
export { evaluateState, evaluateStateDetailed, AI_EVAL_WEIGHTS, MATE_SCORE };
// aiSearch.ts sits ABOVE this file (it imports heuristics FROM ai.ts) —
// this one import back down is the sole, deliberate exception, confined to
// actCombatUnit's search-integration point below; every binding used here
// is only ever read inside a function body (never at module-init time), so
// the resulting import cycle is safe in practice (a common, well-supported
// pattern for two tightly-coupled modules — see aiSearch.ts's own header
// comment for the layering this preserves everywhere else).
import { searchBestAction, searchBestActivation, applyAiAction, SEARCH_CONFIG, type AiAction } from './aiSearch';

export interface AIAction {
  type: 'spawn' | 'move' | 'attack' | 'move+attack' | 'upgrade';
  pos: HexCoord;
  description: string;
}

// ── Difficulty ───────────────────────────────────────────────────────────────
// Single canonical source of truth for AI strength — replaces the old
// `hard: boolean` split. Every difficulty-dependent decision anywhere in this
// file reads from an AiDifficultyConfig, never a raw string/bool comparison.
export type AiDifficulty = 'easy' | 'normal' | 'hard' | 'expert';

export interface AiDifficultyConfig {
  // Chance of taking the 2nd/3rd-best legal candidate instead of the best —
  // always still a REASONABLE legal move, never a random/self-destructive one.
  randomness: number;
  // Save Energy toward the next research/Temple-upgrade goal instead of
  // spending down to 0 on recruits every round (see computeReservation).
  useResourceReservation: boolean;
  // Weigh incoming enemy threat when scoring candidate move hexes (see
  // computeThreatMap) instead of only distance-to-objective/attack-opportunity.
  useThreatMap: boolean;
  // Pick one strategic plan tag per turn (DEFEND/EXPAND/SIEGE/RAID_ECONOMY/
  // TECH_UP) that biases objective selection (see chooseStrategicPlan).
  useStrategicPlanning: boolean;
  // How many top-scored move candidates get a cloned-state lookahead
  // evaluation instead of just taking the single top heuristic score.
  candidateLimit: number;
  // 0 = greedy (heuristic score only). >=1 = also weigh the resulting
  // position's evaluateState() score plus post-move threat exposure — a
  // cheap "what can the opponent then do to me" estimate, not a recursive
  // search (see chooseBestCandidate).
  searchDepth: number;
}

export const AI_DIFFICULTY: Record<AiDifficulty, AiDifficultyConfig> = {
  easy:   { randomness: 0.35, useResourceReservation: false, useThreatMap: false, useStrategicPlanning: false, candidateLimit: 1, searchDepth: 0 },
  normal: { randomness: 0.15, useResourceReservation: true,  useThreatMap: true,  useStrategicPlanning: false, candidateLimit: 1, searchDepth: 0 },
  hard:   { randomness: 0.04, useResourceReservation: true,  useThreatMap: true,  useStrategicPlanning: true,  candidateLimit: 3, searchDepth: 1 },
  expert: { randomness: 0,    useResourceReservation: true,  useThreatMap: true,  useStrategicPlanning: true,  candidateLimit: 6, searchDepth: 2 },
};

export function difficultyLabel(d: AiDifficulty): string {
  return d === 'easy' ? 'Easy AI' : d === 'normal' ? 'Normal AI' : d === 'hard' ? 'Hard AI' : 'Expert AI';
}

// ─────────────────────────────────────────────────────────────────────────────
// Best-Strategy AI
//
// Four difficulties (see AiDifficulty/AI_DIFFICULTY) share one engine-routed
// core via runAiTurn(state, difficulty, aiPlayerId?):
//   • easy   — no reservation/threat-map/planning, high randomness.
//   • normal — resource reservation + threat-aware movement, low randomness.
//   • hard   — + a per-turn strategic plan bias, minimal randomness.
//   • expert — + a shallow cloned-state lookahead on its top move candidates.
// All four ALWAYS spend equal Energy/Command/production/movement/costs and
// see only what's actually visible to that AI player — every difference is
// decision quality, never a hidden advantage.
//
// CONSISTENCY: every move/attack/spawn/capture/upgrade/research/teleport goes
// through the SAME src/game.ts mutators the human UI and the headless action
// dispatcher use (selectUnit → moveUnit/attackUnit, spawnUnit, captureTemple,
// upgradeTemple, researchTech, buildTeleportPair). The AI does NOT re-implement
// combat, so teleport-on-step, fog reveal, revenge, splash, melee-step and
// win-detection all behave identically to real play. (The old `doAIAttack` fork
// has been removed.)
//
// MULTI-AI: everything is parameterised by `aiPlayerId` — the AI reasons purely
// from its own id (its temples, its units, "enemies" = every other player), so
// several AI seats in one N-player game each play from their own start.
//
// The turn is NOT ended here — the caller (main.ts runAI / a headless runner)
// owns endTurn, exactly like the human flow.
// ─────────────────────────────────────────────────────────────────────────────

const SUPPORT_TYPES = new Set<UnitType>(['healer', 'damageBooster', 'rangeBooster']);
const isSupport = (t: UnitType): boolean => SUPPORT_TYPES.has(t);
// §16 — line-fighting/melee-adjacent classes that should screen the backline.
const FRONTLINE_TYPES = new Set<UnitType>(['warrior', 'spearsman', 'horserider', 'heavyknight']);

// ── AI observer hook (additive; ZERO behavior when unset) ────────────────────
// Used ONLY by the ML behavioural-cloning recorder (ml/bcRecord.ts). When an
// observer is installed, `observe` is fired with the state *before* each game
// mutation the AI performs and the dispatcher-equivalent micro ({action, params}
// exactly as ml/gameEnv.legalMicros / actionDispatcher.executeAction accept), so
// replaying the emitted micro through executeAction reproduces the AI's move.
// With no observer set (the default, and always in the game/verify paths), these
// calls are a single null check — the engine + verify scripts are untouched.
export interface AIMicro { action: string; params: Record<string, unknown>; }
let aiObserver: ((state: GameState, micro: AIMicro) => void) | null = null;
export function setAIObserver(fn: ((state: GameState, micro: AIMicro) => void) | null): void { aiObserver = fn; }
function observe(state: GameState, action: string, params: Record<string, unknown>): void {
  if (aiObserver) aiObserver(state, { action, params });
}

// Rough "kill value" of a target — prioritise removing expensive / support units.
function unitValue(type: UnitType): number {
  switch (type) {
    case 'heavyknight': return 9;
    case 'catapult': return 8;
    case 'healer': return 7;
    case 'damageBooster': return 7;
    case 'rangeBooster': return 7;
    case 'horserider': return 5;
    case 'spearsman': return 4;
    case 'archer': return 4;
    default: return 2; // warrior
  }
}

// A player is "alive" as long as their Capital stands — it's permanent and
// indestructible except by combat, and its destruction already ends the
// game (checkWinCondition), so in practice this is always true until then.
function isPlayerAlive(state: GameState, playerId: number): boolean {
  const capital = getPlayerCapital(state, playerId);
  return !!capital && capital.hp > 0;
}

export function revealedEnemies(state: GameState, aiPlayerId: number): Unit[] {
  return state.units.filter(u =>
    u.hp > 0 && u.playerId !== aiPlayerId && isForestUnitRevealed(state, u.pos, aiPlayerId));
}

// Deterministic damage estimate for target ranking. Mirrors the engine's own
// calculateDamage (combat.ts) exactly, via the shared getUnitTypeMultiplier
// helper, so the AI never drifts from the real combat math.
export function estimateDamage(state: GameState, attacker: Unit, target: Unit): number {
  const enc = calculateEncirclement(state, target);
  const typeBonus = getUnitTypeMultiplier(attacker.type, target.type);
  const atk = getEffectiveAttack(state, attacker);
  const def = getEffectiveDefense(state, target);
  const hpFraction = attacker.hp / attacker.stats.maxHp;
  return Math.max(1, calculateDamage(atk, def, enc.attackMultiplier, typeBonus, hpFraction));
}

export function scoreTarget(state: GameState, attacker: Unit, target: Unit): number {
  const dmg = estimateDamage(state, attacker, target);
  const kill = dmg >= target.hp;
  let score = kill ? 1000 + unitValue(target.type) * 10 : dmg * 3 + unitValue(target.type) * 5 - target.hp;
  // Discount for expected fight-back if this won't be a kill (avoid feeding
  // trades). Fight-back is now purely range-gated — a surviving defender counters
  // only if the attacker is within its range.
  if (!kill) {
    const dist = hexDistance(attacker.pos, target.pos);
    if (dist <= getEffectiveRange(state, target)) {
      score -= estimateDamage(state, target, attacker);
    }
  }
  return score;
}

// Where a unit actually ends up if it moves onto `hex` — accounts for stepping
// on an owned/any teleport portal (mirrors moveUnit's auto-teleport: land on the
// first free neighbour of the partner portal).
export function effectiveDest(state: GameState, hex: HexCoord): HexCoord {
  const portal = getTeleportAt(state, hex);
  if (portal?.pairedId) {
    const exit = state.teleportBuildings.find(t => t.id === portal.pairedId);
    if (exit) {
      const nb = hexNeighbors(exit.pos).find(h =>
        hexDistance({ q: 0, r: 0 }, h) <= state.mapRadius &&
        !state.walls.has(hexKey(h)) && !getUnitAt(state, h));
      if (nb) return nb;
    }
  }
  return hex;
}

// The heuristic value of moving to `hex` given a target `objective` — how
// much closer it gets, plus tactical adjustments (attack-from-there bonus,
// defensible terrain, formation/screening, threat-map exposure). Shared by
// actCombatUnit's own move ranking and scoreObjectiveCandidate below (which
// uses it to estimate how good pursuing a given objective actually is,
// before committing to it) — one formula, not two copies that could drift.
export function scoreMoveHex(
  state: GameState, unit: Unit, aiPlayerId: number, hex: HexCoord, objective: HexCoord | null,
  enemies: Unit[], threatMap: Map<string, number> | null,
): number {
  const dest = effectiveDest(state, hex);
  // Weighted well above the tactical/threat terms below (which can easily
  // total 5-15+ points from a single nearby enemy) — a plain 1-point-per-hex
  // signal was so weak that ANY threat-map presence near a committed
  // objective completely swamped "make progress toward it", causing units
  // to advance a hex, feel a threat gradient, retreat, then repeat forever
  // without ever closing the distance (observed directly: a unit stuck
  // oscillating between the same 3-4 hexes for 300+ rounds while its
  // objective sat fixed and reachable the entire time). Genuinely reckless
  // moves are already vetoed hard elsewhere (chooseBestCandidateByLookahead's
  // explicit lethal-exposure penalty), so this only needs to be a real
  // driver of progress, not a suicidal one.
  let s = objective ? -hexDistance(dest, objective) * 4 : 0;
  const rng = unit.stats.range + (state.hills.has(hexKey(dest)) && unit.stats.range > 1 ? 1 : 0);
  for (const e of enemies) {
    const d = hexDistance(dest, e.pos);
    if (d >= 1 && d <= rng) {
      const kill = estimateDamage(state, unit, e) >= e.hp;
      s += (kill ? 60 : 12) + unitValue(e.type);
    }
  }
  if (state.hills.has(hexKey(dest))) s += 1.5; // prefer defensible terrain
  // §16-17 — formation as a scoring PREFERENCE, never a hard constraint
  // (a better kill/objective always wins if one exists): a squishy
  // backline unit (archer/siege) scores a hex worse the closer it lands
  // to a visible enemy, unless that closeness is already accounted for
  // by a kill/attack-opportunity bonus above; a frontline unit
  // (warrior/pike/cavalry/heavy) gets a small bonus for standing closer
  // to the nearest enemy than its own backline currently sits — i.e.
  // actually screening them, not leaving them exposed out front.
  if ((unit.type === 'archer' || unit.type === 'catapult') && enemies.length > 0) {
    const nearestEnemyDist = Math.min(...enemies.map(e => hexDistance(dest, e.pos)));
    if (nearestEnemyDist < rng) s -= (rng - nearestEnemyDist) * 2;
  }
  if (FRONTLINE_TYPES.has(unit.type) && enemies.length > 0) {
    const nearestEnemyDist = Math.min(...enemies.map(e => hexDistance(dest, e.pos)));
    const backline = state.units.filter(u =>
      u.hp > 0 && u.playerId === aiPlayerId && u.id !== unit.id
      && (u.type === 'archer' || u.type === 'catapult' || isSupport(u.type)));
    if (backline.length > 0) {
      const avgBacklineDist = backline.reduce((sum, b) =>
        sum + Math.min(...enemies.map(e => hexDistance(b.pos, e.pos))), 0) / backline.length;
      if (nearestEnemyDist < avgBacklineDist) s += 2;
    }
  }
  if (threatMap) s -= (threatMap.get(hexKey(dest)) ?? 0) * 1.5;
  return s;
}

// Select a unit and expose the engine-computed highlight sets (moveHexes /
// attackHexes). Returns false if it can't be selected.
export function select(state: GameState, unit: Unit): boolean {
  selectUnit(state, unit.id);
  return state.selectedUnitId === unit.id;
}

// Enemy units currently in the selected unit's attack set.
export function currentAttackTargets(state: GameState): Unit[] {
  return state.attackHexes
    .map(h => getUnitAt(state, h))
    .filter((u): u is Unit => !!u && u.hp > 0);
}

// Enemy structures (Capital/City/Temple) currently in range — a hard-AI-only
// concern (finishing the enemy Capital is the whole point of the redesign),
// so keep it a separate query from unit targets rather than merging shapes.
export function currentStructureAttackHexes(state: GameState): HexCoord[] {
  return state.structureAttackHexes;
}

function bestBy<T>(items: T[], score: (t: T) => number): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const it of items) {
    const s = score(it);
    if (s > bestScore) { bestScore = s; best = it; }
  }
  return best;
}

// Pick from a list already sorted best-first. With probability `randomness`
// take the 2nd/3rd-best instead of the best — always still a REASONABLE
// legal option (never a uniformly random one, which could be actively
// self-destructive) — see §7's "fail to optimize, don't act absurd".
function pickWithRandomness<T>(ranked: T[], randomness: number): T | null {
  if (ranked.length === 0) return null;
  if (randomness > 0 && Math.random() < randomness) {
    const idx = Math.min(ranked.length - 1, 1 + Math.floor(Math.random() * 2));
    return ranked[idx]!;
  }
  return ranked[0]!;
}

// ── Objective selection: defend threatened structures → besiege → hunt weakest enemy ──

// A stable identity for whatever pickObjective committed a unit to — lets
// objectiveMemory re-resolve the CURRENT position of the same target next
// turn (it may have moved) while still recognizing "this is the same thing
// I was already going for", instead of only comparing raw coordinates.
type TargetRef = { kind: 'unit'; id: string } | { kind: 'structure'; id: string };

function weakestEnemyTarget(state: GameState, unit: Unit, aiPlayerId: number): { pos: HexCoord; ref: TargetRef } | null {
  const enemyPlayers = state.players.filter(p => p.id !== aiPlayerId && isPlayerAlive(state, p.id));
  if (enemyPlayers.length === 0) return null;
  // Strength = total unit HP + a premium per owned structure + remaining Capital
  // HP (the actual win condition now). Focus the weakest.
  const target = bestBy(enemyPlayers, p => {
    const hp = state.units.filter(u => u.hp > 0 && u.playerId === p.id).reduce((s, u) => s + u.hp, 0);
    const structures = getOwnedStructures(state, p.id).length;
    const capitalHp = getPlayerCapital(state, p.id)?.hp ?? 0;
    return -(hp + structures * 20 + capitalHp);
  });
  if (!target) return null;
  const revealed = state.units.filter(u =>
    u.hp > 0 && u.playerId === target.id && isForestUnitRevealed(state, u.pos, aiPlayerId));
  const nearestUnit = bestBy(revealed, u => -hexDistance(unit.pos, u.pos));
  if (nearestUnit) return { pos: nearestUnit.pos, ref: { kind: 'unit', id: nearestUnit.id } };
  const structures = getOwnedStructures(state, target.id);
  const nearestStructure = bestBy(structures, s => -hexDistance(unit.pos, s.pos));
  return nearestStructure ? { pos: nearestStructure.pos, ref: { kind: 'structure', id: nearestStructure.id } } : null;
}

// ── Objective persistence ───────────────────────────────────────────────────
// Simulation exposed a real problem this fixes: a slow (Agrar-speed) unit
// takes several turns to reach any objective, but the besiege-vs-hunt pick
// below is sensitive to enemy movement — as visible units reshuffle, "the
// nearest enemy structure" or "the weakest enemy's nearest unit" can flip to
// a DIFFERENT target every single turn. A fast unit still reaches its target
// before that matters; a slow one never arrives anywhere, visibly oscillating
// between a handful of hexes turn after turn instead of committing. Keyed by
// the exact GameState object (a WeakMap, so different game instances/AI-vs-AI
// simulations never share or leak memory into each other, and it's dropped
// automatically once a finished game's state is no longer referenced).
const objectiveMemory = new WeakMap<GameState, Map<string, TargetRef>>();

function getObjectiveMemory(state: GameState): Map<string, TargetRef> {
  let m = objectiveMemory.get(state);
  if (!m) { m = new Map(); objectiveMemory.set(state, m); }
  return m;
}

// Re-resolve a remembered target's CURRENT position — null if it's dead/gone,
// which is exactly the signal to drop the commitment and pick a fresh one.
function resolveTargetRef(state: GameState, ref: TargetRef): HexCoord | null {
  if (ref.kind === 'unit') {
    const u = state.units.find(x => x.id === ref.id && x.hp > 0);
    return u ? u.pos : null;
  }
  for (const p of state.players) {
    const s = getOwnedStructures(state, p.id).find(s => s.id === ref.id);
    if (s) return s.pos;
  }
  return null;
}

// `plan` (Hard+ only, see chooseStrategicPlan) gives one objective type
// first refusal ahead of the others below — it never REMOVES an option, it
// just changes the priority order, so a plan whose preferred target doesn't
// exist this turn just falls through to the normal chain.
// A completely unguarded Capital (no owned combat unit anywhere near it) has
// no vision of its own approach and so no warning before an enemy is already
// close enough to hit it — simulation showed this let the whole army commit
// to offense while the Capital slowly bled to death unseen and undefended
// until it was too late to recall anyone. GARRISON_RADIUS is deliberately
// wider than the structure's own vision (2) so "someone's on the way home"
// still counts as garrisoned, not just "already standing on the doorstep".
const GARRISON_RADIUS = 3;
// Below this many combat units, don't trickle a lone (or nearly-lone) unit
// deep into enemy territory to be picked off piecemeal — rally near home
// until there's enough mass to actually threaten something. Simulation
// showed a single early unit routinely being sent clear across a 14-hex-
// apart map alone; a real player masses up first. Generic (applies to any
// faction/matchup) — this is decision-quality, not a per-faction special case.
const MIN_ARMY_TO_ATTACK = 4;
const RALLY_SLACK = 2; // how much further than GARRISON_RADIUS still counts as "near home"

// A garrison assignment that only lasted for the ONE turn it was picked
// turned out not to be enough — the "closest unit right now" can be a
// different unit each turn as the army maneuvers, and whichever one wasn't
// picked THIS turn just resumed its own (offense) objective memory and
// drifted off again, so nothing ever actually settled into home defense.
// Persisted the same way as objectiveMemory: once a unit is assigned
// garrison duty it KEEPS that job (checked every turn, re-picked only if it
// dies) instead of being re-evaluated from scratch each time.
// Keyed by (state, aiPlayerId) — a 2-player game shares ONE GameState object
// between both AI seats' turns, so a map keyed only by state would let
// Temple's own guard assignment silently "fill" Agrar's slot too (and vice
// versa): Agrar's AI would see garrison.size > 0, assume it already had a
// defender posted, and never assign one of its OWN units — leaving its
// Capital genuinely empty the entire game while it looked, from the log,
// like garrison duty was already handled.
const garrisonMemory = new WeakMap<GameState, Map<number, Set<string>>>();
function getGarrisonMemory(state: GameState, aiPlayerId: number): Set<string> {
  let byPlayer = garrisonMemory.get(state);
  if (!byPlayer) { byPlayer = new Map(); garrisonMemory.set(state, byPlayer); }
  let s = byPlayer.get(aiPlayerId);
  if (!s) { s = new Set(); byPlayer.set(aiPlayerId, s); }
  return s;
}

// ── Mobile defensive reserve ─────────────────────────────────────────────────
// The garrison above only ever guarantees "the Capital itself isn't
// literally empty" — it says nothing about whether that's actually enough
// against a FAST enemy. The reserve is a second, proactive layer: instead of
// waiting for a structure to already be in imminent reach (the reactive
// "defend a threatened structure" step below), compare how many turns a
// visible enemy needs to threaten the Capital against how many turns the
// AI's currently-uncommitted forces (excluding whoever's already on
// garrison/reserve duty) would need to get back — and if that gap is too
// tight, hold one or two suitable units at a central, road-connected
// position (see chooseReservePosition) instead of letting them roam. Sized
// dynamically and released the instant the threat no longer justifies it —
// recomputed fresh every call, nothing here is a permanent tag.
const RESERVE_SAFETY_MARGIN = 1; // extra turns of buffer beyond a dead-even race
const MAX_RESERVE_UNITS = 2;

const reserveMemory = new WeakMap<GameState, Map<number, Set<string>>>();
function getReserveMemory(state: GameState, aiPlayerId: number): Set<string> {
  let byPlayer = reserveMemory.get(state);
  if (!byPlayer) { byPlayer = new Map(); reserveMemory.set(state, byPlayer); }
  let s = byPlayer.get(aiPlayerId);
  if (!s) { s = new Set(); byPlayer.set(aiPlayerId, s); }
  return s;
}

// Which of this player's units has "called dibs" on which claimable site
// (a neutral/ruined strategic site, or a Fertile Site) — without this,
// every unit picking its own individually-nearest open site converges on
// the SAME one whenever they start out clustered together (e.g. fresh off
// the Capital), leaving any OTHER open site completely unclaimed for many
// extra turns until some later unit happens to end up closer to it instead
// of the first. Keyed by (state, aiPlayerId) same as garrison/reserve.
const siteClaimMemory = new WeakMap<GameState, Map<number, Map<string, string>>>();
function getSiteClaimMemory(state: GameState, aiPlayerId: number): Map<string, string> {
  let byPlayer = siteClaimMemory.get(state);
  if (!byPlayer) { byPlayer = new Map(); siteClaimMemory.set(state, byPlayer); }
  let m = byPlayer.get(aiPlayerId);
  if (!m) { m = new Map(); byPlayer.set(aiPlayerId, m); }
  return m;
}

// Sticks a unit with whichever claimable site (by id) it already committed
// to, prunes stale claims (the site got claimed/founded elsewhere, or the
// claimant died), and otherwise assigns the unit to the nearest still-
// UNCLAIMED site — spreading multiple available units across multiple open
// sites instead of everyone racing for the same one.
function claimNearestOpenSite<T extends { id: string; pos: HexCoord }>(
  state: GameState, unit: Unit, aiPlayerId: number, openSites: T[],
): T | null {
  if (openSites.length === 0) return null;
  const claims = getSiteClaimMemory(state, aiPlayerId);
  for (const [siteId, unitId] of [...claims]) {
    const stillOpen = openSites.some(s => s.id === siteId);
    const claimantAlive = state.units.some(u => u.id === unitId && u.hp > 0);
    if (!stillOpen || !claimantAlive) claims.delete(siteId);
  }
  const myClaimId = [...claims].find(([, uid]) => uid === unit.id)?.[0];
  if (myClaimId) {
    const mine = openSites.find(s => s.id === myClaimId);
    if (mine) return mine;
  }
  const unclaimed = openSites.filter(s => !claims.has(s.id));
  const target = bestBy(unclaimed.length > 0 ? unclaimed : openSites, s => -hexDistance(unit.pos, s.pos));
  if (target) claims.set(target.id, unit.id);
  return target;
}

// Rough (not exact — §18 "does not need to be perfect") turns for an enemy
// to reach a threatening position on `target`: distance divided by its own
// move-then-hit reach (speed + effective range), same reach definition
// enemyCanReachNextTurn already uses for the 1-turn case.
function turnsToThreatenCapital(state: GameState, enemy: Unit, target: HexCoord): number {
  const reach = Math.max(1, enemy.stats.speed + getEffectiveRange(state, enemy));
  return Math.max(1, Math.ceil(hexDistance(enemy.pos, target) / reach));
}

// Same idea for one of our own units heading home — effective speed already
// accounts for Roads (Agrar's actual lever here), so a good Road network
// directly shortens this number.
function turnsToIntercept(state: GameState, defender: Unit, target: HexCoord): number {
  const speed = Math.max(1, getEffectiveSpeed(state, defender));
  return Math.max(1, Math.ceil(hexDistance(defender.pos, target) / speed));
}

// Within how many of ITS OWN turns does an enemy count as a near-term
// threat worth reserving against at all? An early attempt compared each
// enemy's turnsToThreatenCapital against our OWN slowest available
// responder's turnsToIntercept — but Agrar's units are frequently slow
// (speed 1) by faction design, so that comparison made nearly ANY enemy
// anywhere on the map "credible" (our worst-case responder is always slow
// too), overreacting exactly the way §41 says not to. An absolute, fixed
// horizon avoids that: only an enemy that could plausibly be threatening
// SOON (not hypothetically, eventually) counts at all.
const CREDIBLE_THREAT_TURNS = 2;

// Which visible enemies are a near-term threat to the Capital, beyond how
// many the standing garrison alone can already be expected to cover (one
// threat per garrison member — that's its whole job)? Only the EXCESS over
// garrison size justifies pulling extra, currently-uncommitted units into
// reserve — this is deliberately about "several fast attackers at once"
// (§24), not "does a single garrison member get outrun", which the
// garrison step above already handles on its own. §34 — only ever looks at
// revealedEnemies, the same fog-respecting filter used everywhere else.
function findCredibleMobilityThreats(state: GameState, aiPlayerId: number, capitalPos: HexCoord): Unit[] {
  return revealedEnemies(state, aiPlayerId)
    .filter(e => !isSupport(e.type))
    .filter(e => turnsToThreatenCapital(state, e, capitalPos) <= CREDIBLE_THREAT_TURNS);
}

// §23-24, §44 — reward a candidate that specifically counters the credible
// threats, via the EXISTING type-matchup table (getUnitTypeMultiplier),
// never a hardcoded "prefer Pikeman" rule — a Pikeman just naturally scores
// higher here against a Raider/Champion-type threat because the counter
// matrix already gives Pike a multiplier against Cavalry/Heavy.
function reserveSuitability(state: GameState, candidate: Unit, aiPlayerId: number, threats: Unit[]): number {
  const faction = state.players[aiPlayerId]?.faction;
  let score = getUnitCost(candidate.type, faction);
  for (const t of threats) score += (getUnitTypeMultiplier(candidate.type, t.type) - 1) * 10;
  return score;
}

// §22, §26, §29 — a reserve unit should sit somewhere USEFUL, not simply
// camp on the Capital: a central, Road-connected position it can reach
// several threatened approaches from. Reuses the exact same destination
// concept the Road-artery planner already computes (chooseRoadArteryDestination)
// so the two systems inform each other, as intended — if that destination
// is already close to home, or there's no Road network to use yet, just
// fall back to the Capital itself.
function chooseReservePosition(state: GameState, aiPlayerId: number, capitalPos: HexCoord): HexCoord {
  const destination = chooseRoadArteryDestination(state, aiPlayerId, capitalPos);
  if (hexDistance(destination, capitalPos) <= GARRISON_RADIUS) return capitalPos;
  const myRoads = state.roads.filter(r => r.ownerId === aiPlayerId);
  if (myRoads.length === 0) return capitalPos;
  const junction = bestBy(myRoads, r => -(hexDistance(r.pos, capitalPos) + hexDistance(r.pos, destination)));
  return junction ? junction.pos : capitalPos;
}

// How good is actually pursuing this objective, right now? Finds the
// unit's best move toward it (the exact same scoreMoveHex ranking
// actCombatUnit itself uses for the real move) and — for Hard/Expert —
// the resulting whole-state evaluateState() score from actually
// simulating that move, via the same chooseBestCandidateByLookahead
// machinery already used to pick between move candidates. Used below to
// let besiege-the-enemy-structure and hunt-the-weakest-enemy settle by
// comparing actual simulated outcomes instead of a fixed priority order
// with a hand-tuned distance margin — the fixed order still exists as the
// fallback for Normal/Easy (cfg.searchDepth === 0), which don't get this
// heavier evaluation.
// Reward an objective the army is ALREADY converging on. Found by tracing a
// genuine stalemate directly: a lone attacker kept probing a heavily
// defended Capital approach, getting parried by a single defender forever,
// while its allies were off independently pursuing whatever THEIR OWN
// per-unit evaluation happened to prefer — the army never once converged
// on the same target long enough to actually break through. A 1-2 ply
// evaluateState() score can't see this (it has no notion of "reinforcements
// are 3 turns away"), so it's added on top as an explicit signal instead.
function massBonus(state: GameState, unit: Unit, aiPlayerId: number, objective: HexCoord): number {
  const alliesNear = state.units.filter(u =>
    u.hp > 0 && u.playerId === aiPlayerId && u.id !== unit.id && !isSupport(u.type) && u.type !== 'founder'
    && hexDistance(u.pos, objective) <= 6).length;
  return alliesNear * 4;
}

function scoreObjectiveCandidate(
  state: GameState, unit: Unit, aiPlayerId: number, objective: HexCoord, cfg: AiDifficultyConfig,
): number {
  if (!select(state, unit)) return -Infinity;
  const enemies = revealedEnemies(state, aiPlayerId);
  const moveHexes = [...state.moveHexes];
  if (moveHexes.length === 0) return evaluateState(state, aiPlayerId) + massBonus(state, unit, aiPlayerId, objective);
  const ranked = moveHexes
    .sort((a, b) => scoreMoveHex(state, unit, aiPlayerId, b, objective, enemies, null)
      - scoreMoveHex(state, unit, aiPlayerId, a, objective, enemies, null));
  const best = chooseBestCandidateByLookahead(state, unit, aiPlayerId, ranked.slice(0, cfg.candidateLimit), cfg.searchDepth);
  return (best?.score ?? evaluateState(state, aiPlayerId)) + massBonus(state, unit, aiPlayerId, objective);
}

export function pickObjective(state: GameState, unit: Unit, aiPlayerId: number, plan: AiPlan | null = null, cfg: AiDifficultyConfig = AI_DIFFICULTY.easy): HexCoord | null {
  // getOwnedStructures only ever returns the Capital + owned Temple sites —
  // it never includes Farms. For Agrar that meant its ENTIRE economy was
  // structurally invisible to the "defend a threatened structure" check
  // below: a Temple Raider could walk up to and destroy an Agrar Farm
  // completely unopposed, no matter how good the rest of the AI's defense
  // logic was, simply because Farms were never in the list being checked.
  const myStructures = [...getOwnedStructures(state, aiPlayerId), ...state.farms.filter(f => f.ownerId === aiPlayerId && f.state === 'farm')];
  const enemies = revealedEnemies(state, aiPlayerId);

  // 0. Never leave the Capital completely empty — a genuinely competent
  // player never does, and reactive "defend once threatened" (below) can't
  // help if the threat was never seen coming in the first place (fog of
  // war). The ONLY exception is being 100% certain nothing could take it:
  // zero enemy units revealed ANYWHERE yet. The instant even one enemy has
  // been spotted, garrisoning becomes mandatory — this is deliberately NOT
  // gated behind having "enough" army first, per explicit instruction: an
  // empty Capital is an instant loss waiting to happen no matter how small
  // the army is. The Builder/founder is never assigned this job — it has
  // its own critical economic role and building Farms/Roads doesn't need
  // it to ever leave home anyway (see the founder block below). Exactly
  // one unit is ever assigned (see garrisonMemory above) — a standing
  // preference for the REST of the army, not a lockdown on everyone.
  const capital = getPlayerCapital(state, aiPlayerId);
  const combatUnitsAll = state.units.filter(u => u.hp > 0 && u.playerId === aiPlayerId && !isSupport(u.type) && u.type !== 'founder');
  // A fast raider or a long-range siege unit can hit the Capital and then
  // retreat (or simply stand) out of every ally's vision before the AI's
  // next turn, making revealedEnemies() see nothing at all — "no enemy
  // spotted" is NOT the same as "no enemy present". The Capital's own HP is
  // always visible to its owner regardless of fog (it's your own
  // structure), so any damage on it — even with zero currently-revealed
  // enemies — is proof something is still out there and it is NOT safe to
  // release the guard.
  const provablySafe = enemies.length === 0 && (!capital || capital.hp >= capital.maxHp);
  if (capital && combatUnitsAll.length > 0 && !provablySafe) {
    const garrison = getGarrisonMemory(state, aiPlayerId);
    for (const id of [...garrison]) if (!state.units.some(u => u.id === id && u.hp > 0)) garrison.delete(id); // prune dead guards
    if (garrison.has(unit.id)) return capital.pos;
    // A single guard is a fine deterrent while the Capital is untouched, but
    // once it's actually taking damage a lone defender has provably already
    // failed to stop whatever's hitting it — escalate to two. Beyond that,
    // the mobile reserve (step 0.5, Hard+) is the better-informed tool for
    // "how many more do we actually need" — it counts real credible threats
    // instead of blanket-escalating the garrison further, which would just
    // lock down units the reserve system might not find necessary at all.
    const desiredGuards = capital.hp < capital.maxHp ? 2 : 1;
    if (garrison.size < desiredGuards) {
      const closest = bestBy(combatUnitsAll.filter(u => !garrison.has(u.id)), u => -hexDistance(u.pos, capital.pos));
      if (closest) {
        garrison.add(closest.id);
        if (closest.id === unit.id) return capital.pos;
      }
    }
  }

  // 0.6. Free, unclaimed economic value takes priority over merely
  // ANTICIPATING a threat (the mobile reserve below) — a neutral site or
  // Fertile Site sitting there uncontested is real, current income being
  // left on the table, whereas the reserve is speculative insurance against
  // something that hasn't happened yet. The one always-on garrison guard
  // above still stands regardless, so the Capital is never truly
  // undefended even while the rest of the army rushes economic targets.
  //
  // v14 — a not-already-mine Fertile Site (Agrar mirror only;
  // state.fertileSites is empty in every other matchup, so this is a no-op
  // there). Contested map control, not free — walking a unit toward it is
  // how the AI ever bothers claiming one at all.
  const player = state.players.find(p => p.id === aiPlayerId);
  if (player?.faction === 'agrar') {
    const openFertile = claimNearestOpenSite(state, unit, aiPlayerId,
      state.fertileSites.filter(f => f.ownerId !== aiPlayerId));
    if (openFertile) return openFertile.pos;
  }

  // An unclaimed (neutral or ruined, not already being founded/reconstructed
  // by someone else) strategic site is a real objective for Temple — any
  // Temple unit can found one (v15, no dedicated founder type), and there
  // was previously NO explicit priority sending anyone toward one at all:
  // besiege/hunt only ever considers structures the ENEMY already owns, so
  // a neutral site just sat there uncontested for the entire game unless a
  // unit happened to wander onto it by coincidence. Each site gives real
  // income the moment it's founded, so speed matters — this used to sit
  // BELOW the mobile reserve check, which meant a merely-anticipated
  // (not yet real) threat could tie up 1-2 more units in reserve duty
  // before anyone was free to go grab free money. claimNearestOpenSite also
  // spreads multiple units across multiple open sites at once instead of
  // everyone converging on whichever is nearest overall.
  if (player?.faction === 'temple') {
    const openSite = claimNearestOpenSite(state, unit, aiPlayerId,
      state.strategicSites.filter(s => (s.state === 'neutral' || s.state === 'ruins') && !s.founding));
    if (openSite) return openSite.pos;
  }

  // 0.5. Mobile defensive reserve — proactive, not reactive (§21, §28): does
  // the REST of the army (everyone not already on garrison duty) still have
  // enough response time against a visible fast threat? If not, hold one or
  // two suitable units at a central, Road-connected position instead of
  // reacting only once a structure is already in imminent reach (step 1
  // below still exists as a fallback). Dynamically sized and released the
  // moment it's no longer justified — see findCredibleMobilityThreats.
  // Hard/Expert only (`plan` is null below that tier, see
  // chooseStrategicPlan/AI_DIFFICULTY.useStrategicPlanning) — Normal keeps
  // its existing simpler "one guard, once threatened" behavior from the
  // garrison step above; this is the more expensive, anticipatory layer.
  if (plan !== null && capital && combatUnitsAll.length > 0) {
    const garrison = getGarrisonMemory(state, aiPlayerId);
    const reserve = getReserveMemory(state, aiPlayerId);
    for (const id of [...reserve]) if (!state.units.some(u => u.id === id && u.hp > 0)) reserve.delete(id); // prune dead
    const credibleThreats = findCredibleMobilityThreats(state, aiPlayerId, capital.pos);
    // §24's own examples are explicit: even ONE credible raider warrants
    // ONE reserve unit — the reserve isn't "redundant" with the garrison
    // even then, since it typically holds a DIFFERENT position (a Road
    // junction covering farms/approaches, see chooseReservePosition) rather
    // than literally standing next to the same guard.
    const desiredReserve = Math.min(credibleThreats.length, MAX_RESERVE_UNITS);
    if (reserve.size > desiredReserve) {
      // The threat receded — release the excess back to normal duty rather
      // than leaving units permanently tagged for a reason that's gone.
      for (const id of [...reserve].slice(desiredReserve)) reserve.delete(id);
    }
    if (reserve.has(unit.id)) return chooseReservePosition(state, aiPlayerId, capital.pos);
    if (reserve.size < desiredReserve) {
      const pool = combatUnitsAll.filter(u => !garrison.has(u.id) && !reserve.has(u.id));
      const best = bestBy(pool, u => reserveSuitability(state, u, aiPlayerId, credibleThreats) - turnsToIntercept(state, u, capital.pos) * 2);
      if (best) {
        reserve.add(best.id);
        if (best.id === unit.id) return chooseReservePosition(state, aiPlayerId, capital.pos);
      }
    }
  }

  // 1. Defend an owned structure under imminent threat — "imminent" scaled
  // to each enemy's actual mobility (enemyCanReachNextTurn) rather than a
  // flat radius, so a fast unit gets flagged from farther out than a slow
  // one. "Defended" is now a rough STRENGTH comparison (cost-weighted HP of
  // nearby defenders vs the threatening enemies), not just "at least one
  // defender exists" — a lone unit posted next to 3 attackers used to count
  // as "handled" and stop pulling in any help, which was never actually
  // enough to hold. Keeps calling in reinforcements until roughly matched.
  const faction = state.players[aiPlayerId]?.faction;
  for (const s of myStructures) {
    const threats = enemies.filter(e => enemyCanReachNextTurn(state, e, s.pos));
    if (threats.length === 0) continue;
    const threatValue = threats.reduce((sum, e) => sum + getUnitCost(e.type, state.players[e.playerId]?.faction) * (e.hp / e.stats.maxHp), 0);
    const defenderValue = state.units
      .filter(u => u.hp > 0 && u.playerId === aiPlayerId && u.id !== unit.id && hexDistance(u.pos, s.pos) <= 1)
      .reduce((sum, u) => sum + getUnitCost(u.type, faction) * (u.hp / u.stats.maxHp), 0);
    if (defenderValue < threatValue) return s.pos;
  }

  // RAID_ECONOMY plan — a Raider heading for an exposed enemy Farm takes
  // priority over the general besiege/hunt chain below.
  if (plan === 'RAID_ECONOMY' && unit.type === 'horserider') {
    const farm = bestBy(state.farms.filter(f => f.ownerId !== aiPlayerId && f.state === 'farm'),
      f => -hexDistance(unit.pos, f.pos));
    if (farm) return farm.pos;
  }

  // Mass before attacking: below MIN_ARMY_TO_ATTACK combat units, don't
  // trickle this one deep into enemy territory alone — rally back toward
  // home instead, overriding even an already-remembered offensive target
  // (an army that just took losses should regroup, not keep splintering).
  // Already-close units are left alone (nothing to rally back FROM). A hard
  // gate for EVERY difficulty, including the Hard/Expert evaluation branch
  // below — an early attempt let "rally home" compete freely against
  // besiege/hunt via scoreObjectiveCandidate, but a 1-2 ply evaluation has
  // no way to see the multi-turn value of massing up first, and a lone
  // unit heading home always LOOKS safer in the moment (less immediate
  // threat exposure) regardless of whether there's an actual reason to
  // retreat — it ended up recalling units with no real threat around at
  // all, undoing real, tested "don't overreact" behavior.
  if (capital && combatUnitsAll.length < MIN_ARMY_TO_ATTACK && hexDistance(unit.pos, capital.pos) > GARRISON_RADIUS + RALLY_SLACK) {
    return capital.pos;
  }

  // 2-3. Besiege the nearest enemy structure (destroying the Capital wins
  // the game, §11) vs hunt the weakest enemy's units — but first, stick with
  // whatever this unit already committed to last turn if it's still valid
  // (see "Objective persistence" above). Only pick a FRESH target below if
  // there's no memory yet, or the remembered one is dead/gone.
  const memory = getObjectiveMemory(state);
  const remembered = memory.get(unit.id);
  if (remembered) {
    const pos = resolveTargetRef(state, remembered);
    if (pos) return pos;
    memory.delete(unit.id); // target destroyed/vanished — fall through to pick a new one
  }

  const enemyStructures = state.players
    .filter(p => p.id !== aiPlayerId)
    .flatMap(p => getOwnedStructures(state, p.id));
  // SIEGE plan — a siege unit heads straight for the enemy Capital instead of
  // whichever enemy structure merely happens to be nearest.
  const siegeCapital = plan === 'SIEGE' && unit.type === 'catapult'
    ? bestBy(
      state.players.filter(p => p.id !== aiPlayerId).map(p => getPlayerCapital(state, p.id)).filter((c): c is NonNullable<typeof c> => !!c),
      c => -hexDistance(unit.pos, c.pos))
    : null;
  const nearestStructure = siegeCapital ?? bestBy(enemyStructures, s => -hexDistance(unit.pos, s.pos));
  const enemyTarget = weakestEnemyTarget(state, unit, aiPlayerId);

  // Hard/Expert: rather than settle "besiege vs hunt" with a fixed priority
  // order and a hand-tuned distance margin, gather both genuine candidates
  // and let simulated outcomes (scoreObjectiveCandidate) decide which is
  // actually better right now — this is the one part of pickObjective that
  // was pure "which of these looks closest-ish", where an actual evaluation
  // of the resulting position is worth the extra compute. Deliberately
  // does NOT include "rally home" as a THIRD competing option here — that
  // decision is already made above (a hard gate, not a comparison): a 1-2
  // ply evaluation has no way to see the multi-turn value of massing up
  // first, and a lone unit heading home always looks safer in the moment
  // regardless of whether there's an actual reason to retreat. Normal/Easy
  // keep the original fixed-margin logic below unchanged (cfg.searchDepth
  // === 0 for both).
  if (cfg.searchDepth > 0 && (nearestStructure || enemyTarget)) {
    const candidates: { pos: HexCoord; ref: TargetRef | null }[] = [];
    if (nearestStructure) candidates.push({ pos: nearestStructure.pos, ref: { kind: 'structure', id: nearestStructure.id } });
    if (enemyTarget) candidates.push({ pos: enemyTarget.pos, ref: enemyTarget.ref });
    const best = bestBy(candidates, c => scoreObjectiveCandidate(state, unit, aiPlayerId, c.pos, cfg));
    if (best) {
      if (best.ref) memory.set(unit.id, best.ref);
      return best.pos;
    }
  }

  const structureDist = nearestStructure ? hexDistance(unit.pos, nearestStructure.pos) : Infinity;
  const enemyDist = enemyTarget ? hexDistance(unit.pos, enemyTarget.pos) : Infinity;

  // Destroying a Capital is the ONLY win condition (§11) — a scattered
  // individual enemy unit merely being slightly closer than the enemy
  // Capital isn't a good enough reason to give up on the actual objective.
  // Simulation showed the army never committing to a real assault, instead
  // splitting attention across whichever nearby enemy unit looked
  // marginally closer turn to turn, while the faster opposing side had no
  // such hesitation converging on OUR Capital. Require the individual
  // target to be MEANINGFULLY closer, not just closer-or-equal, before
  // preferring it over the structure.
  const STRUCTURE_COMMIT_MARGIN = 3;
  if (nearestStructure && structureDist <= enemyDist + STRUCTURE_COMMIT_MARGIN) {
    memory.set(unit.id, { kind: 'structure', id: nearestStructure.id });
    return nearestStructure.pos;
  }
  if (enemyTarget) {
    memory.set(unit.id, enemyTarget.ref);
    return enemyTarget.pos;
  }
  return nearestStructure ? nearestStructure.pos : null;
}

// ── Per-unit action (engine-routed) ──

// If the unit can attack an enemy structure right now, do it — prioritising
// the enemy Capital (that's the actual win condition, §11) over a City/Temple.
function tryAttackStructure(state: GameState, unit: Unit, difficulty: AiDifficulty, actions: AIAction[]): boolean {
  const hexes = currentStructureAttackHexes(state);
  if (hexes.length === 0) return false;
  const scored = bestBy(hexes, h => {
    const ref = getStructureAt(state, h);
    if (!ref) return -Infinity;
    if (ref.kind === 'capital') return 1000 - ref.capital.hp;
    if (ref.kind === 'farm') return 200 - ref.farm.hp;
    return 500 - ref.site.hp;
  });
  if (!scored) return false;
  observe(state, 'attack-structure', { unitId: unit.id, targetPos: scored });
  const result = attackStructure(state, scored);
  if (!result) return false;
  actions.push({ type: 'attack', pos: { ...scored }, description: `${difficultyLabel(difficulty)} ${unit.type} strikes a structure at (${scored.q},${scored.r})${result.gameOver ? ' — Capital destroyed!' : ''}` });
  return true;
}

// Expert's shallow lookahead: simulate each candidate move on a CLONED state
// (the live state is never touched here) and re-rank by the resulting
// evaluateState() score, penalized by how exposed the landing hex is to
// enemy threat right after the move — a cheap stand-in for "the opponent's
// best reply" rather than a real recursive search. Falls back to the
// heuristic's own top pick if simulation ever fails for every candidate
// (never throws — a failed clone/move just drops that candidate).
// Does any enemy unit in `sim`, from ITS current position and stats, have a
// GUARANTEED kill on `target` right now? The single most concrete, cheapest
// form of "the opponent's best reply" — directly targets §49's "don't take a
// trade that hands the opponent a guaranteed kill on something valuable".
// §34 — fog of war: both reply-simulation helpers below only ever look at
// revealedEnemies (the SAME visibility filter every other targeting/threat
// function in this file already uses), never the clone's full unit list —
// the AI's search must never "know" about a unit it couldn't actually see.
export function anyEnemyHasLethalShot(sim: GameState, target: Unit, aiPlayerId: number): boolean {
  for (const e of revealedEnemies(sim, aiPlayerId)) {
    const rng = getEffectiveRange(sim, e);
    if (hexDistance(e.pos, target.pos) > rng) continue;
    if (estimateDamage(sim, e, target) >= target.hp) return true;
  }
  return false;
}

// One cheap, single "opponent reply" step for depth>=2: the (visible) enemy
// unit that can deal the most damage to ANY of the AI's units this instant
// takes that shot (on the clone). Not a recursive AI turn (too expensive,
// and risks runaway recursion) — just the single most obviously-threatening
// reply, good enough to catch "this walks me into their whole army's focus fire".
function applyBestEnemyReply(sim: GameState, aiPlayerId: number): void {
  let bestDmg = 0, bestAttacker: Unit | null = null, bestTarget: Unit | null = null;
  for (const e of revealedEnemies(sim, aiPlayerId)) {
    const rng = getEffectiveRange(sim, e);
    for (const u of sim.units) {
      if (u.hp <= 0 || u.playerId !== aiPlayerId) continue;
      if (hexDistance(e.pos, u.pos) > rng) continue;
      const dmg = estimateDamage(sim, e, u);
      if (dmg > bestDmg) { bestDmg = dmg; bestAttacker = e; bestTarget = u; }
    }
  }
  if (bestAttacker && bestTarget) {
    bestTarget.hp = Math.max(0, bestTarget.hp - bestDmg);
  }
}

function chooseBestCandidateByLookahead(
  state: GameState, unit: Unit, aiPlayerId: number, candidates: HexCoord[], depth: number,
): { hex: HexCoord; score: number } | null {
  if (candidates.length === 0) return null;
  let best: HexCoord | null = null;
  let bestScore = -Infinity;
  for (const hex of candidates) {
    try {
      const sim = cloneStateForSim(state);
      const simUnit = sim.units.find(u => u.id === unit.id);
      if (!simUnit) continue;
      selectUnit(sim, simUnit.id);
      if (!moveUnit(sim, hex).moved) continue;
      // depth >= 2 (Expert): actually simulate the single most threatening
      // enemy reply before scoring, not just a static post-move threat read.
      if (depth >= 2) applyBestEnemyReply(sim, aiPlayerId);
      const postThreat = computeThreatMap(sim, aiPlayerId).get(hexKey(simUnit.pos)) ?? 0;
      const lethalExposure = simUnit.hp > 0 && anyEnemyHasLethalShot(sim, simUnit, aiPlayerId);
      let score = evaluateState(sim, aiPlayerId) - postThreat * 2;
      if (lethalExposure) score -= getUnitCost(simUnit.type, sim.players[aiPlayerId]?.faction) * 4;
      if (score > bestScore) { bestScore = score; best = hex; }
    } catch { /* a failed simulation just drops this one candidate */ }
  }
  return { hex: best ?? candidates[0]!, score: bestScore };
}

// Shared with the Phase 8 activation-order pre-pass below — whether THIS
// unit specifically has real tactical content to weigh right now: an
// immediate attack available, an enemy actually reachable this turn via
// move+attack, or a credible lethal threat against it (a real defensive
// emergency, not just proximity). See actCombatUnit's own call site for
// why this gate is narrow rather than "an enemy exists somewhere nearby".
function hasTacticalContent(state: GameState, unit: Unit, aiPlayerId: number): boolean {
  if (!select(state, unit)) return false;
  const hasImmediateCombat = currentAttackTargets(state).length > 0 || currentStructureAttackHexes(state).length > 0;
  const reachableEnemy = revealedEnemies(state, aiPlayerId).some(e =>
    hexDistance(e.pos, unit.pos) <= getEffectiveSpeed(state, unit) + getEffectiveRange(state, unit));
  const underLethalThreat = anyEnemyHasLethalShot(state, unit, aiPlayerId);
  return hasImmediateCombat || reachableEnemy || underLethalThreat;
}

// Eligible for the multi-unit activation-order pass: has real tactical
// content (see above) AND doesn't have one of actCombatUnit's own
// higher-priority special actions available (founding/claiming/pillaging,
// or being an Agrar Builder) — those must never be preempted by a generic
// move/attack candidate, since generateCandidateActions doesn't know about
// any of them.
function isEligibleForActivationSearch(state: GameState, unit: Unit, aiPlayerId: number, difficulty: AiDifficulty): boolean {
  const cfg = AI_DIFFICULTY[difficulty];
  const player = state.players.find(p => p.id === aiPlayerId);
  if (unit.type === 'founder' && player?.faction === 'agrar') return false;
  if (canStartFounding(state, unit)) return false;
  if (canClaimFertileSite(state, unit)) return false;
  if (cfg.useResourceReservation && canPillageRoad(state, unit)) return false;
  return hasTacticalContent(state, unit, aiPlayerId);
}

// Applies the winning AiAction from searchBestAction to the LIVE state via
// the same canonical applyAiAction the search itself used on its clones —
// then translates it into the existing AIAction combat-log shape and fires
// the same `observe` micro convention every other AI mutation already does
// (see `observe`'s own comment — this is what feeds any future ML replay
// pipeline, so a search-chosen move needs to look identical to a
// heuristic-chosen one there). Returns whether it actually applied; a
// false here means the caller falls back to the heuristic path untouched.
function applySearchAction(
  state: GameState, unit: Unit, aiPlayerId: number, difficulty: AiDifficulty, action: AiAction, actions: AIAction[],
): boolean {
  const before = { ...unit.pos };
  switch (action.kind) {
    case 'endActivation':
      // A deliberate "nothing worthwhile right now" — no log line, exactly
      // like the heuristic path's own silent no-op when it reaches the same
      // conclusion.
      return applyAiAction(state, action);
    case 'attack': {
      const targetId = getUnitAt(state, action.targetPos)?.id;
      observe(state, 'attack', { unitId: unit.id, targetId });
      if (!applyAiAction(state, action)) return false;
      actions.push({ type: 'attack', pos: { ...action.targetPos }, description: `${difficultyLabel(difficulty)} ${unit.type} attacks at (${action.targetPos.q},${action.targetPos.r})` });
      return true;
    }
    case 'attackStructure': {
      observe(state, 'attack-structure', { unitId: unit.id, targetPos: action.targetPos });
      if (!applyAiAction(state, action)) return false;
      actions.push({ type: 'attack', pos: { ...action.targetPos }, description: `${difficultyLabel(difficulty)} ${unit.type} strikes a structure at (${action.targetPos.q},${action.targetPos.r})` });
      return true;
    }
    case 'move': {
      observe(state, 'move', { unitId: unit.id, to: action.to });
      if (!applyAiAction(state, action)) return false;
      actions.push({ type: 'move', pos: { ...unit.pos }, description: `${difficultyLabel(difficulty)} ${unit.type} advances (${before.q},${before.r})→(${unit.pos.q},${unit.pos.r})` });
      return true;
    }
    case 'moveAttack': {
      const targetId = getUnitAt(state, action.targetPos)?.id;
      observe(state, 'move', { unitId: unit.id, to: action.to });
      observe(state, 'attack', { unitId: unit.id, targetId });
      if (!applyAiAction(state, action)) return false;
      actions.push({ type: 'move+attack', pos: { ...unit.pos }, description: `${difficultyLabel(difficulty)} ${unit.type} advances (${before.q},${before.r})→(${unit.pos.q},${unit.pos.r}) and strikes` });
      return true;
    }
    default:
      // Search's combat-unit candidate generation never produces any other
      // kind — a defensive default only, never actually reached.
      return false;
  }
}

function actCombatUnit(
  state: GameState, unit: Unit, aiPlayerId: number, difficulty: AiDifficulty,
  actions: AIAction[], plan: AiPlan | null, threatMap: Map<string, number> | null,
  turnSearchDeadline: number = Infinity,
): void {
  if (state.phase !== 'playing' || unit.hp <= 0) return;
  const cfg = AI_DIFFICULTY[difficulty];
  const advanced = cfg.useResourceReservation; // "normal and above" — matches the old hard-only gate for these

  // Founding/reconstructing a neutral/ruined site it's standing on (no-op —
  // canStartFounding returns null — for every other case, e.g. an active
  // enemy Temple, which must be destroyed first). Any Temple unit may do
  // this (v15 — no dedicated founder-type unit).
  const founding = canStartFounding(state, unit);
  if (founding) {
    observe(state, 'found', { unitId: unit.id });
    startFounding(state, unit.id);
    actions.push({ type: 'upgrade', pos: { ...unit.pos }, description: `${difficultyLabel(difficulty)} begins founding a ${founding.targetState} at (${unit.pos.q},${unit.pos.r})` });
    return; // founding spends the whole activation
  }

  // v14 — claim a Fertile Site the unit happens to be standing on (Agrar
  // mirror only; canClaimFertileSite is always null in every other matchup).
  if (canClaimFertileSite(state, unit)) {
    observe(state, 'claim-fertile-site', { unitId: unit.id });
    claimFertileSite(state, unit.id);
    actions.push({ type: 'upgrade', pos: { ...unit.pos }, description: `${difficultyLabel(difficulty)} claims a Fertile Site at (${unit.pos.q},${unit.pos.r})` });
    return; // claiming spends the whole activation
  }

  // v14 — pillage an enemy Road the unit happens to be standing on, rather
  // than leave it for a later, separate move (Normal+ — a simple
  // opportunistic check, not a dedicated demolition planner).
  if (advanced && canPillageRoad(state, unit)) {
    observe(state, 'pillage-road', { unitId: unit.id });
    pillageRoad(state, unit.id);
    actions.push({ type: 'upgrade', pos: { ...unit.pos }, description: `${difficultyLabel(difficulty)} pillages a Road at (${unit.pos.q},${unit.pos.r})` });
    return; // pillaging spends the whole activation
  }

  // Agrar's Builder grows its Farm network first — that's the faction's
  // whole economy now (§6-9) — and only pays a road forward if no valid
  // Farm hex is available this turn, UNLESS the strategic plan is already
  // DEFEND (a real threat, not just a hypothetical one): interior lines —
  // a road that lets defenders reach the front (or race home) faster — are
  // worth more than one more Farm once an actual raid is already brewing.
  // Either way getValidRoadHexes already only ever offers hexes adjacent to
  // the existing Capital/Farm/Road network, so every candidate is
  // inherently connected, never an isolated stray tile — and which of those
  // candidates gets picked is no longer arbitrary either, see
  // roadFrontierPoint below.
  if (advanced && unit.type === 'founder') {
    const player = state.players[aiPlayerId]!;
    if (player.faction === 'agrar') {
      // If this Builder is standing ON its own recruiting structure (the
      // Capital — Agrar's only production site) with a unit already queued
      // to deploy there, step off FIRST. Simulation uncovered a severe bug
      // here: building Farms/Roads never requires actually leaving the
      // tile, so the Builder had no other reason to ever move — it would
      // permanently occupy the Capital and block EVERY future recruit from
      // ever deploying (resolveTrainingForPlayer requires the spawn tile
      // free), leaving Agrar's army stuck at population 3 for the entire
      // game regardless of how much aura it had.
      const onOwnStructure = getOwnedStructures(state, aiPlayerId).some(s => hexEqual(s.pos, unit.pos));
      const blockingDeployment = onOwnStructure && state.trainingQueue.some(o => o.playerId === aiPlayerId);
      if (blockingDeployment && !unit.hasMoved && select(state, unit) && state.moveHexes.length > 0) {
        const dest = bestBy(state.moveHexes, h => -hexDistance(h, unit.pos));
        if (dest) {
          observe(state, 'move', { unitId: unit.id, to: dest });
          if (moveUnit(state, dest).moved) {
            actions.push({ type: 'move', pos: { ...unit.pos }, description: `${difficultyLabel(difficulty)} Builder steps aside to let a recruit deploy` });
            return;
          }
        }
      }

      // A whole path is picked toward an actual strategic destination (see
      // chooseRoadArteryDestination/planRoadArteryPath) and laid in one
      // activation via buildRoadPath, instead of one arbitrary adjacent hex
      // at a time. Farm always comes first — it's the faction's core
      // economy (§6-9) — Road is only the fallback when no valid Farm hex
      // exists this turn. An earlier version swapped this priority under
      // DEFEND, but DEFEND (hasEmergency) fires easily against a naturally
      // fast opponent — practically any Temple unit within striking range
      // counts as a "credible" threat — and swapping the priority meant the
      // Farm network could stop growing for most of a real game the moment
      // any Temple unit came within a few hexes, not just during a genuine
      // emergency.
      const capitalPos = getPlayerCapital(state, aiPlayerId)?.pos;
      const buildRoadNow = (): boolean => {
        if (getValidRoadHexes(state, unit).filter(h => canBuildRoad(state, unit, h)).length === 0) return false;
        const destination = capitalPos ? chooseRoadArteryDestination(state, aiPlayerId, capitalPos) : unit.pos;
        const path = planRoadArteryPath(state, unit, destination);
        const built = buildRoadPath(state, unit.id, path);
        if (built.length === 0) return false;
        observe(state, 'build-road', { unitId: unit.id, pos: built[built.length - 1]! });
        actions.push({
          type: 'upgrade', pos: { ...built[0]! },
          description: `${difficultyLabel(difficulty)} lays ${built.length} Road segment${built.length > 1 ? 's' : ''} toward (${destination.q},${destination.r})`,
        });
        return true;
      };
      const buildFarmNow = (): boolean => {
        const validFarms = getValidFarmHexes(state, unit).filter(h => canStartFarm(state, unit, h));
        if (validFarms.length === 0) return false;
        // An active Farm now grants Road-equivalent movement (see
        // getEffectiveSpeed), so WHERE it lands matters the same way Road
        // placement does — prefer whichever legal candidate sits closer to
        // the Capital (shorter response distance for the garrison/reserve —
        // pure defense value) and closer to the same strategic direction
        // the Road artery is already extending toward (so the Farm doubles
        // as useful fast-travel infrastructure on the way there, not just
        // isolated economy sitting wherever happened to be first).
        let farmHex = validFarms[0]!;
        if (capitalPos) {
          const cap = capitalPos;
          const destination = chooseRoadArteryDestination(state, aiPlayerId, cap);
          const best = bestBy(validFarms, h => -hexDistance(h, cap) - hexDistance(h, destination) * 0.5);
          if (best) farmHex = best;
        }
        observe(state, 'build-farm', { unitId: unit.id, pos: farmHex });
        startFarm(state, unit.id, farmHex);
        actions.push({ type: 'upgrade', pos: { ...farmHex }, description: `${difficultyLabel(difficulty)} begins building a Farm at (${farmHex.q},${farmHex.r})` });
        return true;
      };
      if (buildFarmNow() || buildRoadNow()) return;
      // Nothing legal to build from HERE (getValidFarmHexes/getValidRoadHexes
      // only ever offer hexes adjacent to the Builder's CURRENT position) —
      // head back toward the Capital/Farm network instead of falling
      // through to the generic combat pickObjective logic below, which
      // isn't founder-aware and would otherwise send the Builder wandering
      // off to besiege/hunt/garrison duty. This was the actual cause of
      // Farm-building grinding to a halt after the very first Farm: once
      // the Builder drifted away (there's no other reason it would ever
      // move once a Farm/Road is placed), it simply never came back, so
      // no LATER Farm from a different position was ever attempted again
      // even with aura piling up unspent for dozens of rounds.
      if (capitalPos && !unit.hasMoved && select(state, unit) && state.moveHexes.length > 0) {
        // Head toward the nearest hex ANYWHERE in current territory that
        // could actually hold a Farm (not just neighbours of the Builder's
        // current position, which is all getValidFarmHexes ever checks) —
        // the network can grow lopsided in one direction early on (nothing
        // revealed yet to point chooseRoadArteryDestination anywhere else)
        // until it runs into the map edge or FARM_MIN_SPACING packs the
        // immediate area solid, and "just return to the nearest anchor"
        // used to endlessly loop the Builder right back into that same
        // dead end instead of ever reaching a still-open spot elsewhere.
        // Only once there's truly nowhere left for a Farm does this fall
        // back to whichever anchor still has open Road room.
        const openFarmSpots = getAllValidFarmSpots(state, aiPlayerId);
        let target: HexCoord | null = bestBy(openFarmSpots, h => -hexDistance(unit.pos, h));
        if (!target) {
          const anchors = [capitalPos, ...state.farms.filter(f => f.ownerId === aiPlayerId).map(f => f.pos)];
          const openRoom = (p: HexCoord) => hexNeighbors(p).filter(h => isLegalRoadTile(state, h)).length;
          target = bestBy(anchors, p => openRoom(p) * 10 - hexDistance(unit.pos, p));
        }
        const dest = target ? bestBy(state.moveHexes, h => -hexDistance(h, target!)) : null;
        if (dest) {
          observe(state, 'move', { unitId: unit.id, to: dest });
          if (moveUnit(state, dest).moved) {
            actions.push({ type: 'move', pos: { ...unit.pos }, description: `${difficultyLabel(difficulty)} Builder heads toward open Farm territory` });
            return;
          }
        }
      }
    }
  }
  if (unit.hasAttacked) return;
  if (!select(state, unit)) return;

  // Hard/Expert — let real search choose this unit's whole activation
  // (attack-now / move / move+attack / retreat / hold) whenever THIS unit
  // specifically has real tactical content to weigh, rather than the fixed
  // heuristic priority order below. evaluateState has no notion of "closer
  // to my objective" the way pickObjective/scoreMoveHex does, so handing a
  // unit's every activation to search regressed multi-turn marches badly
  // (racing to a neutral site, falling back to defend the Capital) — a
  // shallow tactical evaluator has no reason to keep walking toward a goal
  // several turns away with nothing to fight yet. So the gate is narrow and
  // per-unit, not "an enemy exists somewhere nearby": an immediate
  // attack available right now, an enemy actually reachable this turn via
  // move+attack, or a credible lethal threat against THIS unit specifically
  // (a real defensive emergency, not just proximity). Anything broader kept
  // hijacking the site-capture/mobile-reserve heuristics the same tests
  // below already cover. Falls straight through to the unchanged heuristic
  // path whenever none of that applies, search is disabled for this
  // difficulty, finds nothing, or (defensively) throws — never a stall or
  // a skipped activation.
  const remainingTurnBudget = turnSearchDeadline - Date.now();
  if (SEARCH_CONFIG[difficulty].enabled && remainingTurnBudget > 0 && hasTacticalContent(state, unit, aiPlayerId)) {
    try {
      const outcome = searchBestAction(state, unit, aiPlayerId, difficulty, [], remainingTurnBudget);
      if (outcome && applySearchAction(state, unit, aiPlayerId, difficulty, outcome.action, actions)) return;
    } catch { /* fall through to the heuristic path below */ }
  }

  // Kill from current position if possible (esp. valuable for ranged units).
  const here = currentAttackTargets(state);
  const bestHere = bestBy(here, t => scoreTarget(state, unit, t));
  if (bestHere && estimateDamage(state, unit, bestHere) >= bestHere.hp) {
    observe(state, 'attack', { unitId: unit.id, targetId: bestHere.id });
    attackUnit(state, bestHere.pos);
    actions.push({ type: 'attack', pos: { ...bestHere.pos }, description: `${difficultyLabel(difficulty)} ${unit.type} kills at (${bestHere.pos.q},${bestHere.pos.r})` });
    return;
  }

  // No unit kill available — take a shot at an enemy structure if one is in range.
  if (!bestHere && tryAttackStructure(state, unit, difficulty, actions)) return;

  // Otherwise consider repositioning toward the best objective / a kill.
  if (!unit.hasMoved) {
    const objective = pickObjective(state, unit, aiPlayerId, plan, cfg);
    const enemies = revealedEnemies(state, aiPlayerId);
    const moveHexes = [...state.moveHexes];
    const scoreHex = (hex: HexCoord): number =>
      scoreMoveHex(state, unit, aiPlayerId, hex, objective, enemies, threatMap);

    const rankedHexes = [...moveHexes].sort((a, b) => scoreHex(b) - scoreHex(a));
    // Hard/Expert — shallow lookahead: rather than trust the heuristic's top
    // pick outright, actually simulate the top `candidateLimit` candidates on
    // a CLONED state (never the live one) and re-rank by the resulting
    // evaluateState() score, an explicit "would this hand the opponent a
    // guaranteed kill" check, and (Expert, searchDepth>=2 only) the single
    // most threatening enemy reply actually simulated — not a full
    // recursive search.
    const scored = cfg.searchDepth > 0
      ? chooseBestCandidateByLookahead(state, unit, aiPlayerId, rankedHexes.slice(0, cfg.candidateLimit), cfg.searchDepth)?.hex ?? null
      : pickWithRandomness(rankedHexes, cfg.randomness);

    if (scored && !hexEqual(effectiveDest(state, scored), unit.pos)) {
      const before = { ...unit.pos };
      observe(state, 'move', { unitId: unit.id, to: scored });
      const moved = moveUnit(state, scored).moved;
      if (moved) {
        // Attack from the new position if worthwhile (moveUnit refreshed attackHexes).
        const after = currentAttackTargets(state);
        const bestAfter = bestBy(after, t => scoreTarget(state, unit, t));
        if (bestAfter && scoreTarget(state, unit, bestAfter) > 0) {
          observe(state, 'attack', { unitId: unit.id, targetId: bestAfter.id });
          attackUnit(state, bestAfter.pos);
          actions.push({ type: 'move+attack', pos: { ...unit.pos }, description: `${difficultyLabel(difficulty)} ${unit.type} advances (${before.q},${before.r})→(${unit.pos.q},${unit.pos.r}) and strikes` });
        } else if (tryAttackStructure(state, unit, difficulty, actions)) {
          // handled — moved and struck a structure
        } else {
          actions.push({ type: 'move', pos: { ...unit.pos }, description: `${difficultyLabel(difficulty)} ${unit.type} advances to (${unit.pos.q},${unit.pos.r})` });
        }
        return;
      }
    }
  }

  // Couldn't (or chose not to) move — take the best available shot.
  if (bestHere && scoreTarget(state, unit, bestHere) > 0) {
    observe(state, 'attack', { unitId: unit.id, targetId: bestHere.id });
    attackUnit(state, bestHere.pos);
    actions.push({ type: 'attack', pos: { ...bestHere.pos }, description: `${difficultyLabel(difficulty)} ${unit.type} attacks at (${bestHere.pos.q},${bestHere.pos.r})` });
    return;
  }
  tryAttackStructure(state, unit, difficulty, actions);
}

// Support units (healer / boosters) never charge — they trail the combat cluster
// where their aura reaches the most allies, staying clear of enemy range.
function actSupportUnit(state: GameState, unit: Unit, aiPlayerId: number, actions: AIAction[]): void {
  if (state.phase !== 'playing' || unit.hp <= 0 || unit.hasMoved || unit.hasAttacked) return;
  if (!select(state, unit)) return;
  if (state.moveHexes.length === 0) return;

  const combat = state.units.filter(u =>
    u.hp > 0 && u.playerId === aiPlayerId && u.id !== unit.id && !isSupport(u.type));
  const enemies = revealedEnemies(state, aiPlayerId);
  const faction = state.players[aiPlayerId]?.faction;
  // §17 — weigh actual expected VALUE delivered, not just a raw ally count:
  // a Healer favors hexes near INJURED, valuable allies (missing HP it could
  // actually restore); a damage/range booster favors hexes near many
  // valuable allies that benefit from the buff (range booster specifically
  // only helps already-ranged units — buffing a warrior's range does nothing).
  const allyValue = (ally: Unit): number => {
    const cost = getUnitCost(ally.type, faction);
    if (unit.type === 'healer') return cost * (1 - ally.hp / ally.stats.maxHp);
    if (unit.type === 'rangeBooster') return ally.stats.range > 1 ? cost : 0;
    return cost; // damageBooster — any combat ally benefits
  };
  const scoreHex = (pos: HexCoord): number => {
    const radius = unit.type === 'rangeBooster' ? RANGE_BOOST_RADIUS : SUPPORT_RANGE;
    let value = 0;
    for (const c of combat) if (hexDistance(pos, c.pos) <= radius) value += allyValue(c);
    let danger = 0;
    for (const e of enemies) {
      const d = hexDistance(pos, e.pos);
      if (d <= 1) danger += 3; else if (d <= 2) danger += 1;
    }
    return value * 2 - danger * 3;
  };

  let bestHex: HexCoord | null = null;
  let best = scoreHex(unit.pos); // staying put is an option
  for (const hex of state.moveHexes) {
    const s = scoreHex(effectiveDest(state, hex));
    if (s > best) { best = s; bestHex = hex; }
  }
  if (bestHex) {
    const before = { ...unit.pos };
    observe(state, 'move', { unitId: unit.id, to: bestHex });
    if (moveUnit(state, bestHex).moved) {
      actions.push({ type: 'move', pos: { ...unit.pos }, description: `AI ${unit.type} repositions (${before.q},${before.r})→(${unit.pos.q},${unit.pos.r})` });
    }
  }
}

// ── Economy (hard AI) ──

// Coherent tech build: siege core, a force-multiplier support unit, then
// splash and the elite/anti-cavalry line (which now needs its prerequisite
// first — see TECH_NODES). Siege/elite lines are faction-specific (phase 11
// §33-34); canResearch also enforces branch exclusivity and faction gating,
// so unreachable picks are skipped automatically.
// command_1 is deliberately FIRST, ahead of the siege/support techs it used
// to follow: the starting population cap (6 command points) saturates with
// cheap 1-cost Warriors/Spearsmen within the first ~20 rounds, well before
// any of the pricier unlocks (Catapult/Heavy Knight/support) finish
// researching — so those units had no population room left to ever actually
// get recruited, freezing the whole army composition at "all cheap melee"
// for the rest of the game regardless of tech or aura. Command I is also the
// cheapest, fastest item on either plan (12 aura, 1 round), so front-loading
// it costs very little.
const HARD_RESEARCH_PLAN: Record<'agrar' | 'temple', TechId[]> = {
  agrar: [
    'command_1',
    'agrar_siegecraft',
    'longrange_hp',
    'unlock_damagebooster',
    'agrar_siegecraft_splash',
    'agrar_heavy_armor',
    'agrar_heavy_knight_tech',
  ],
  temple: [
    'command_1',
    'temple_mobile_siege_tech',
    'longrange_hp',
    'unlock_damagebooster',
    'temple_mobile_siege_splash',
    'temple_warrior_rite',
    'temple_champion_rite',
  ],
};

// The AI's actual next savings/research goal: the first item on its
// faction's priority-ordered plan whose PREREQS are already met (regardless
// of whether it's currently affordable) — shared by doResearch (don't skip
// ahead to a cheaper later item just because the priority one isn't
// affordable yet) and computeReservation (save toward that same item).
function nextPlannedTech(state: GameState, aiPlayerId: number): typeof TECH_NODES[number] | null {
  const player = state.players[aiPlayerId];
  const tech = state.playerTech[aiPlayerId];
  if (!player?.faction || !tech) return null;
  for (const techId of HARD_RESEARCH_PLAN[player.faction]) {
    if (tech.researched.has(techId)) continue;
    const node = TECH_NODES.find(n => n.id === techId);
    if (!node) continue;
    const prereqsMet = node.prereqs.every(p => tech.researched.has(p as TechId))
      && (!node.faction || node.faction === player.faction);
    if (!prereqsMet) continue;
    return node;
  }
  return null;
}

function doResearch(state: GameState, aiPlayerId: number, actions: AIAction[]): void {
  const home = getPlayerCapital(state, aiPlayerId);
  const tech = state.playerTech[aiPlayerId];
  if (tech?.researching) return;
  const node = nextPlannedTech(state, aiPlayerId);
  if (!node || !canResearch(state, node.id)) return; // not reachable, or not affordable yet — save, don't skip ahead
  observe(state, 'research', { techId: node.id });
  if (researchTech(state, node.id)) {
    actions.push({ type: 'upgrade', pos: home ? { ...home.pos } : { q: 0, r: 0 }, description: `Hard AI researches ${node.id}` });
  }
}

// Temple upgrade (v11) — phase 4/10 economy. Greedy: start the Temple
// I->II upgrade on every owned Temple site that can afford it, one start
// per site per turn. Agrar's Farm-building is handled per-unit in
// actCombatUnit instead (it's Builder-driven, not site-driven — see §6-9).
function doEconomy(state: GameState, aiPlayerId: number, actions: AIAction[]): void {
  for (const site of getOwnedSites(state, aiPlayerId)) {
    if (site.state === 'temple' && canStartTempleUpgrade(state, site.id)) {
      observe(state, 'upgrade-temple', { templeId: site.id });
      if (startTempleUpgrade(state, site.id)) {
        actions.push({ type: 'upgrade', pos: { ...site.pos }, description: `Hard AI starts Temple upgrade at (${site.pos.q},${site.pos.r})` });
      }
    }
  }
}

function getOwnedSites(state: GameState, aiPlayerId: number) {
  return state.strategicSites.filter(s => s.ownerId === aiPlayerId && s.state === 'temple');
}

// Teleports removed (phase 11 §32) — the 'teleports' tech no longer exists,
// so canBuildTeleportPair always returns false. Kept as a no-op rather than
// deleted so callers/imports don't need to change.
function doTeleport(_state: GameState, _aiPlayerId: number, _actions: AIAction[]): void {}

// ── Resource reservation (Normal+) ──────────────────────────────────────────
// The old "spend everything the instant it's affordable" behavior is
// strategically wrong once research/Temple-upgrades exist: recruiting one
// more cheap unit instead of saving 2 more rounds toward Command I (or
// Temple II) is usually the worse trade. Returns the aura amount the AI
// wants to keep on hand for its next reachable economy/tech goal (0 if
// nothing is worth saving for) — computeReservation only ever looks at the
// SINGLE next item on the plan, not the whole remaining tree, so it doesn't
// lock the AI out of recruiting for the rest of the game.
function computeReservation(state: GameState, aiPlayerId: number): number {
  const tech = state.playerTech[aiPlayerId];
  let target = Infinity;
  if (tech && !tech.researching) {
    const node = nextPlannedTech(state, aiPlayerId);
    if (node) target = Math.min(target, node.cost);
  }
  for (const site of getOwnedSites(state, aiPlayerId)) {
    if (site.state === 'temple' && site.templeLevel === 1 && !site.upgrade) {
      target = Math.min(target, TEMPLE_UPGRADE_COST);
    }
  }
  return Number.isFinite(target) ? target : 0;
}

// Agrar — as many Farms as possible (up to MAX_ACTIVE_FARMS) is the
// faction's whole point. Unlike computeReservation above, this is NOT
// gated behind "within reach next round": AGRAR_FARM_COST is cheap (6) —
// nothing like the "zero units for 10+ rounds" disaster a distant, 16-cost
// tech goal caused — but with only a low income cycle, the "within reach"
// gate for a cheap goal like this almost never actually engages: as long
// as even the cheapest recruit (1⚡) is affordable, spawnPass keeps
// recruiting it every single turn, resetting aura back near 0 before it
// can ever climb close enough to the Farm cost to trip the gate at all.
// The Farm reservation is therefore always active while below the cap —
// see spawnPass, which enforces it unconditionally rather than folding it
// into the same reach-gated pool as computeReservation.
function computeFarmReservation(state: GameState, aiPlayerId: number): number {
  const player = state.players[aiPlayerId];
  if (player?.faction !== 'agrar') return 0;
  const farmCount = state.farms.filter(f => f.ownerId === aiPlayerId).length;
  return farmCount < MAX_ACTIVE_FARMS ? AGRAR_FARM_COST : 0;
}

// Emergencies override saving/planning — a Capital in real danger, or an
// owned structure under imminent threat with nothing nearby to defend it,
// always gets first claim on the Energy the AI has right now.
// Could `e` reach and hit `target` on ITS OWN next activation (move + attack,
// same-turn)? Simulation showed the flat "within 2 hexes" radius the defend
// checks used to use was far too tight against Temple's faster (speed 2-3)
// roster — by the time a fast Raider/Champion was actually within 2 hexes it
// could already reach and hit next turn regardless, giving the (slower,
// speed 1-2) Agrar side's AI no real warning. Using each enemy's actual
// speed+range gives proportionate warning to however mobile the threat is.
function enemyCanReachNextTurn(state: GameState, e: Unit, target: HexCoord): boolean {
  return hexDistance(e.pos, target) <= e.stats.speed + getEffectiveRange(state, e);
}

function hasEmergency(state: GameState, aiPlayerId: number): boolean {
  const capital = getPlayerCapital(state, aiPlayerId);
  // Substantial damage, OR a currently-active fast threat — NOT "ever took
  // a single hit". The Capital never regenerates HP, so an "any damage"
  // reading here was permanently stuck true for the rest of the game after
  // one graze, since this feeds the DEFEND strategic plan — whose
  // consequences are much heavier than the (separately, correctly, always-
  // sensitive) garrison check in pickObjective: DEFEND makes the Builder
  // stop building Farms in favour of Roads, and recalls ANY unit more than
  // a few hexes from home regardless of what it's doing. That combination
  // meant one early graze quietly froze the entire economy AND stopped
  // Temple from ever advancing on a neutral site again for the rest of the
  // match. Both conditions below are naturally transient — they stop being
  // true again once the HP threshold is no longer crossed or the fast
  // threat is gone/out of range, unlike "hp < maxHp" which never resets.
  if (capital && capital.hp / capital.maxHp < 0.5) return true;
  const enemies = revealedEnemies(state, aiPlayerId);
  if (capital && enemies.some(e => turnsToThreatenCapital(state, e, capital.pos) <= CREDIBLE_THREAT_TURNS)) return true;
  // See pickObjective's myStructures comment — Farms must be included here
  // too, or an Agrar economy under active raid would never count as an
  // emergency worth breaking resource reservation for.
  const structures = [...getOwnedStructures(state, aiPlayerId), ...state.farms.filter(f => f.ownerId === aiPlayerId && f.state === 'farm')];
  for (const s of structures) {
    if (!enemies.some(e => enemyCanReachNextTurn(state, e, s.pos))) continue;
    const defended = state.units.some(u => u.hp > 0 && u.playerId === aiPlayerId && hexDistance(u.pos, s.pos) <= 1);
    if (!defended) return true;
  }
  return false;
}

// ── Threat map (Normal+) ─────────────────────────────────────────────────────
// A coarse spatial "how much could a visible enemy hurt me here" model, used
// to weigh movement destinations (see actCombatUnit) instead of only scoring
// distance-to-objective/attack-opportunity. Deliberately approximate — it's a
// bounded flat-radius spread per enemy unit, not a real reachability BFS —
// and NEVER looks at anything not currently visible/revealed to aiPlayerId,
// so it can't cheat through fog of war.
export function computeThreatMap(state: GameState, aiPlayerId: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of revealedEnemies(state, aiPlayerId)) {
    const rng = getEffectiveRange(state, e);
    const reach = e.stats.speed + rng; // rough "move then hit" radius
    const power = getEffectiveAttack(state, e) * (e.hp / e.stats.maxHp);
    for (let dq = -reach; dq <= reach; dq++) {
      for (let dr = Math.max(-reach, -dq - reach); dr <= Math.min(reach, -dq + reach); dr++) {
        const hex = { q: e.pos.q + dq, r: e.pos.r + dr };
        const d = hexDistance(e.pos, hex);
        if (d > reach) continue;
        const key = hexKey(hex);
        // Falls off with distance so "just barely in reach" reads as less
        // dangerous than "already adjacent".
        const falloff = 1 - (d / (reach + 1)) * 0.6;
        map.set(key, (map.get(key) ?? 0) + power * falloff);
      }
    }
  }
  return map;
}

// Where should the Road network actually grow TOWARD? A Road only earns its
// keep as part of a connected route somewhere useful — a Builder picking
// "whichever adjacent hex happens to be legal" wastes that on a network
// that never reaches anywhere it matters. Priority order, most concrete
// signal first: a Farm already under imminent threat (defend it directly);
// the nearest revealed enemy (anticipate — that's exactly where a raid
// would come from); a Farm the network hasn't reached yet (grow the
// economy's connectivity); a contested Fertile Site (Agrar mirror only);
// and only with no signal at all, wherever the army is currently operating.
function chooseRoadArteryDestination(state: GameState, aiPlayerId: number, capitalPos: HexCoord): HexCoord {
  const myFarms = state.farms.filter(f => f.ownerId === aiPlayerId && f.state === 'farm');
  const enemies = revealedEnemies(state, aiPlayerId);

  const threatenedFarm = bestBy(
    myFarms.filter(f => enemies.some(e => enemyCanReachNextTurn(state, e, f.pos))),
    f => -hexDistance(f.pos, capitalPos));
  if (threatenedFarm) return threatenedFarm.pos;

  // As many Farms as possible, as fast as possible, is the whole point of
  // the faction — if the immediate area is boxed in by hills (Farms can't
  // be built on them, but Roads CAN), aim the Road straight at the nearest
  // hex anywhere in territory that's actually farmable, rather than a
  // generic "chase the nearest enemy" direction that might not even be
  // pointed toward open land at all.
  if (myFarms.length < MAX_ACTIVE_FARMS) {
    const openFarmSpot = bestBy(getAllValidFarmSpots(state, aiPlayerId), h => -hexDistance(h, capitalPos));
    if (openFarmSpot) return openFarmSpot;
  }

  if (enemies.length > 0) {
    const nearest = bestBy(enemies, e => -hexDistance(e.pos, capitalPos));
    if (nearest) return nearest.pos;
  }

  const myRoads = state.roads.filter(r => r.ownerId === aiPlayerId);
  const disconnectedFarm = bestBy(
    myFarms.filter(f => !hexEqual(f.pos, capitalPos) && !myRoads.some(r => hexDistance(r.pos, f.pos) <= 1)),
    f => hexDistance(f.pos, capitalPos));
  if (disconnectedFarm) return disconnectedFarm.pos;

  const openFertile = state.fertileSites.find(f => f.ownerId !== aiPlayerId);
  if (openFertile) return openFertile.pos;

  const mine = state.units.filter(u =>
    u.hp > 0 && u.playerId === aiPlayerId && !isSupport(u.type) && u.type !== 'founder');
  if (mine.length > 0) {
    const farthest = bestBy(mine, u => hexDistance(u.pos, capitalPos));
    if (farthest) return farthest.pos;
  }
  return capitalPos;
}

// Greedy hill-climb toward `destination`, up to ROAD_SEGMENTS_PER_ACTIVATION
// hexes: not a real pathfinder (§13 — "does not need to be a permanent
// complex object"), just a per-turn plan good enough to make the Builder's
// multi-segment action actually point somewhere. The first hex must be a
// legal Road location for the Builder right now (getValidRoadHexes already
// enforces "connects to existing infrastructure"); each hex after that only
// needs to chain off the previous one and pass the same terrain/occupancy
// rule (isLegalRoadTile) — exactly what buildRoadPath itself will re-verify.
function planRoadArteryPath(state: GameState, unit: Unit, destination: HexCoord): HexCoord[] {
  const first = bestBy(getValidRoadHexes(state, unit), h => -hexDistance(h, destination));
  if (!first) return [];
  const path = [first];
  let current = first;
  while (path.length < ROAD_SEGMENTS_PER_ACTIVATION && !hexEqual(current, destination)) {
    const candidates = hexNeighbors(current).filter(h =>
      isLegalRoadTile(state, h) && !path.some(p => hexEqual(p, h)));
    const next = bestBy(candidates, h => -hexDistance(h, destination));
    if (!next || hexDistance(next, destination) >= hexDistance(current, destination)) break; // no longer closing the gap
    path.push(next);
    current = next;
  }
  return path;
}

// ── Strategic plan (Hard+) ───────────────────────────────────────────────────
// One plan tag per AI turn (computed once in runTurn, not per unit), biasing
// pickObjective instead of replacing it — the underlying tactical logic
// (kill-first, defend-threatened, besiege, hunt-weakest) still runs
// regardless of plan, this just changes which objective gets first refusal.
export type AiPlan = 'DEFEND' | 'RAID_ECONOMY' | 'SIEGE' | 'TECH_UP' | 'EXPAND';

export function chooseStrategicPlan(state: GameState, aiPlayerId: number): AiPlan {
  if (hasEmergency(state, aiPlayerId)) return 'DEFEND';
  const player = state.players[aiPlayerId];
  const mine = state.units.filter(u => u.hp > 0 && u.playerId === aiPlayerId);
  if (player?.faction === 'temple') {
    const hasRaider = mine.some(u => u.type === 'horserider');
    const exposedFarm = state.farms.some(f => f.ownerId !== aiPlayerId && f.state === 'farm');
    if (hasRaider && exposedFarm) return 'RAID_ECONOMY';
  }
  if (mine.some(u => u.type === 'catapult')) return 'SIEGE';
  if (computeReservation(state, aiPlayerId) > 0 && !hasEmergency(state, aiPlayerId)) return 'TECH_UP';
  return 'EXPAND';
}

// ── Whole-state evaluator ────────────────────────────────────────────────────
// AI 2.0 — moved to aiEval.ts (a single number, positive = good for
// forPlayerId, negative for the opponent(s); see that file's own header for
// why it's a separate, ai.ts-independent module). Imported (not just
// re-exported) so every existing LOCAL caller in this file keeps working
// unchanged, and re-exported so every test importing `evaluateState`/
// `evaluateStateDetailed` from '../src/ai' also keeps working unchanged.

// Deep-clones a GameState for simulation — a plain object-spread (as
// serializer.ts's own serialize/deserialize do for the live save/load path)
// is NOT enough here, since nested arrays (units, farms, ...) would still
// share references with the live state; mutating a "clone" through the real
// engine mutators would then corrupt the actual game. A full JSON round-trip
// guarantees independence (GameState is plain, JSON-safe data).
export function cloneStateForSim(state: GameState): GameState {
  return deserialize(JSON.parse(JSON.stringify(serialize(state))));
}

// ── Recruiting ──

function chooseSpawnType(state: GameState, aiPlayerId: number, unlocked: Set<UnitType>, aura: number, advanced: boolean): UnitType | null {
  const mine = state.units.filter(u => u.hp > 0 && u.playerId === aiPlayerId);
  const queued = state.trainingQueue.filter(o => o.playerId === aiPlayerId);
  const count = (t: UnitType) => mine.filter(u => u.type === t).length + queued.filter(o => o.unitType === t).length;
  const army = mine.length;
  const combat = mine.filter(u => !isSupport(u.type)).length;
  const faction = state.players[aiPlayerId]?.faction;
  const cost = (t: UnitType) => getUnitCost(t, faction);

  // §5, §39 (phase 11 correction) — there are zero starting units now, so
  // the Builder is recruited like anything else (Temple has no equivalent,
  // v15). Get exactly one out first — without it Agrar can never build a
  // Farm/Road — so this takes priority over any combat unit. count() already
  // includes a still-queued (not yet deployed) one, so a busy turn with
  // multiple recruit passes never queues a redundant extra Builder.
  //
  // A single Builder serializes the whole Farm economy — it must physically
  // stand next to a spot AND stay adjacent through the 1-round founding
  // delay before it's free to start the next one, so a 2nd Builder roughly
  // doubles Farm-building throughput while there's still Farm capacity left
  // to fill. Cheap (2⚡, 1 Command point) relative to the payoff; stops
  // being worth recruiting more of once Farms are maxed (a 3rd+ Builder
  // would just be idle Road/pillage-repair labor, not double economy).
  const farmCount = state.farms.filter(f => f.ownerId === aiPlayerId).length;
  const desiredFounders = faction === 'agrar' && farmCount < MAX_ACTIVE_FARMS ? 2 : 1;
  if (unlocked.has('founder') && count('founder') < desiredFounders && aura >= cost('founder')) {
    return 'founder';
  }

  if (advanced) {
    // Keep exactly one damage booster as a force multiplier once a core exists.
    if (unlocked.has('damageBooster') && count('damageBooster') === 0 && combat >= 3 && aura >= cost('damageBooster')) {
      return 'damageBooster';
    }
    // Buy the best affordable unit, but cap the priciest types so the army stays
    // mixed (share = max fraction of the army that type may occupy).
    const prefs: [UnitType, number][] = [
      ['heavyknight', 0.35], ['catapult', 0.35], ['horserider', 0.5],
      ['spearsman', 0.6], ['archer', 1], ['warrior', 1],
    ];
    for (const [t, maxShare] of prefs) {
      if (!unlocked.has(t) || aura < cost(t)) continue;
      if (count(t) > Math.ceil(army * maxShare)) continue;
      return t;
    }
    if (unlocked.has('warrior') && aura >= cost('warrior')) return 'warrior';
    return null;
  }

  // Easy AI: cheap, simple mix.
  if (unlocked.has('horserider') && aura >= cost('horserider') && Math.random() < 0.3) return 'horserider';
  if (unlocked.has('archer') && aura >= cost('archer') && Math.random() < 0.5) return 'archer';
  if (unlocked.has('warrior') && aura >= cost('warrior')) return 'warrior';
  if (unlocked.has('archer') && aura >= cost('archer')) return 'archer';
  return null;
}

function spawnPass(state: GameState, aiPlayerId: number, difficulty: AiDifficulty, actions: AIAction[]): void {
  const cfg = AI_DIFFICULTY[difficulty];
  const player = state.players[aiPlayerId]!;
  // §9-10 — resource reservation: don't recruit past the point of dropping
  // below the aura reserved for the AI's next research/Temple-upgrade goal
  // — but ONLY once that goal is actually within reach next income cycle
  // (current aura + one round's income already covers it). Reserving from
  // the moment a distant, expensive goal enters the plan (regardless of how
  // far off it is) was tried first and was a disaster in practice — it left
  // the AI with a ZERO-unit army for 10+ rounds while it slow-saved toward a
  // single 16-cost tech, losing to an opponent that just built an army. The
  // aura-within-reach gate below keeps saving to its intended narrow case —
  // "I'm 1 recruit away from also affording my tech goal next round" — never
  // "stockpile from turn one no matter how far away the goal is".
  const reservation = cfg.useResourceReservation ? computeReservation(state, aiPlayerId) : 0;
  const withinReachNextRound = reservation > 0 && player.aura + getPlayerIncome(state, aiPlayerId) >= reservation;
  // The Farm reservation (see computeFarmReservation) is NOT gated behind
  // "within reach" the same way — it's cheap enough that saving from turn
  // one never risks the "zero units for 10+ rounds" scenario the gate above
  // exists to prevent, and the gate would almost never engage for it anyway
  // (see computeFarmReservation's own comment).
  const farmReservation = cfg.useResourceReservation ? computeFarmReservation(state, aiPlayerId) : 0;
  const effectiveFloor = Math.max(withinReachNextRound ? reservation : 0, farmReservation);
  const emergency = effectiveFloor > 0 ? hasEmergency(state, aiPlayerId) : false;
  for (const structure of getOwnedStructures(state, aiPlayerId)) {
    if (getUnitAt(state, structure.pos)) continue; // occupied — can't spawn (throttles multi-spawn)
    if (getPopulationCount(state, aiPlayerId) >= getPopulationCap(state, aiPlayerId)) break;
    const unlocked = getUnlockedUnits(state.playerTech[aiPlayerId]!, state.players[aiPlayerId]?.faction);
    // chooseSpawnType only ever returns 'founder' while there's still a
    // genuine Builder need (the very first one, or a 2nd while Farms aren't
    // maxed yet, to parallelize Farm-building — see its own comment), so
    // `type !== 'founder'` alone identifies "this recruit is discretionary".
    // A Builder recruit is exempt from reservation even then: it's part of
    // the Farm economy the reservation exists to protect in the first
    // place, not competing against it — blocking it on "not enough spare
    // aura beyond the Farm reservation" would be self-defeating (a 2nd
    // Builder recruit needing 2⚡ PLUS the already-reserved 6⚡ on top is a
    // much higher bar than the 2nd Builder actually needs to clear).
    const type = chooseSpawnType(state, aiPlayerId, unlocked, player.aura, cfg.useResourceReservation);
    if (!type) continue;
    if (effectiveFloor > 0 && !emergency && type !== 'founder') {
      const cost = getUnitCost(type, player.faction);
      if (player.aura - cost < effectiveFloor) continue; // saving — skip this discretionary recruit
    }
    observe(state, 'recruit', { unitType: type, templeId: structure.id });
    if (spawnUnit(state, structure.id, type)) {
      actions.push({ type: 'spawn', pos: { ...structure.pos }, description: `${difficultyLabel(difficulty)} recruits ${type} at (${structure.pos.q},${structure.pos.r})` });
    }
  }
}

// ── Turn driver ──

function runTurn(state: GameState, aiPlayerId: number, difficulty: AiDifficulty): AIAction[] {
  const actions: AIAction[] = [];
  const player = state.players.find(p => p.id === aiPlayerId);
  if (!player || state.phase !== 'playing' || getCurrentPlayer(state).id !== aiPlayerId) return actions;
  const cfg = AI_DIFFICULTY[difficulty];

  // 1. Economy (Normal+ — Easy keeps things simple and skips Farms/Temple-
  // upgrades/research/teleport; its surplus aura goes straight to recruiting
  // below). Resource reservation (spawnPass) means Normal+ won't necessarily
  // spend everything down to 0 either — see computeReservation.
  if (cfg.useResourceReservation) {
    doEconomy(state, aiPlayerId, actions);
    doResearch(state, aiPlayerId, actions);
    doTeleport(state, aiPlayerId, actions);
  }

  // Hard+ picks one strategic plan for the whole turn (see chooseStrategicPlan)
  // — it biases pickObjective's priority order, it doesn't replace the
  // underlying tactics (kill-first/defend/besiege/hunt still all run).
  const plan = cfg.useStrategicPlanning ? chooseStrategicPlan(state, aiPlayerId) : null;
  const threatMap = cfg.useThreatMap ? computeThreatMap(state, aiPlayerId) : null;

  // 2. Recruit (pass 1).
  spawnPass(state, aiPlayerId, difficulty, actions);

  // 3. Manoeuvre — combat units first (so support can then tuck in behind them).
  //
  // Hard/Expert — before falling into the fixed per-unit order below,
  // let search itself pick WHICH eligible unit acts next, not just what it
  // does (§ "who acts next", deliberately deferred until the single-unit
  // search — Phase 4-7 — was already measured working). Only kicks in when
  // there are genuinely 2+ units search would even consider (see
  // isEligibleForActivationSearch — founders and anything with no real
  // tactical content nearby are excluded, same gate as the per-unit path
  // below), and capped to a handful of resolutions per turn: this is for
  // untangling a live skirmish's turn order, not replacing the whole army's
  // manoeuvring with one giant joint search. Whatever's left afterward
  // (everything not eligible, or left over once the cap/budget/a null
  // result is hit) goes through the exact same per-unit loop as before,
  // completely unchanged — so the worst case is identical to not having
  // this pass at all.
  // A single call's own timeBudgetMs only bounds THAT call — a turn can
  // make several (this pre-pass, plus one per eligible unit below), which
  // could otherwise stack up to multiples of it on a busy board. This is a
  // hard ceiling on ALL search time for the WHOLE turn combined, checked
  // before every call (both here and inside actCombatUnit) — never a
  // stall, worst case just falls back to the heuristic path early.
  const turnSearchDeadline = Date.now() + SEARCH_CONFIG[difficulty].perTurnBudgetMs;
  const MAX_ACTIVATION_SEARCHES_PER_TURN = 3;
  if (SEARCH_CONFIG[difficulty].enabled) {
    for (let i = 0; i < MAX_ACTIVATION_SEARCHES_PER_TURN && state.phase === 'playing'; i++) {
      const remainingTurnBudget = turnSearchDeadline - Date.now();
      if (remainingTurnBudget <= 0) break;
      const pending = state.units.filter(u =>
        u.hp > 0 && u.playerId === aiPlayerId && !isSupport(u.type)
        && isEligibleForActivationSearch(state, u, aiPlayerId, difficulty));
      if (pending.length < 2) break; // no real "who goes first" ambiguity to resolve
      try {
        const outcome = searchBestActivation(state, pending, aiPlayerId, difficulty, remainingTurnBudget);
        if (!outcome) break;
        const unit = state.units.find(u => u.id === outcome.unitId);
        if (!unit || !applySearchAction(state, unit, aiPlayerId, difficulty, outcome.action, actions)) break;
      } catch { break; }
    }
  }

  const combatUnits = state.units.filter(u => u.hp > 0 && u.playerId === aiPlayerId && !isSupport(u.type));
  for (const unit of combatUnits) {
    if (state.phase !== 'playing') break;
    actCombatUnit(state, unit, aiPlayerId, difficulty, actions, plan, threatMap, turnSearchDeadline);
  }
  const supportUnits = state.units.filter(u => u.hp > 0 && u.playerId === aiPlayerId && isSupport(u.type));
  for (const unit of supportUnits) {
    if (state.phase !== 'playing') break;
    actSupportUnit(state, unit, aiPlayerId, actions);
  }

  // 4. Recruit again (pass 2) — units have vacated their structures, so this is
  //    the multi-spawn-per-structure pass that spends leftover aura (Normal+).
  if (cfg.useResourceReservation && state.phase === 'playing') spawnPass(state, aiPlayerId, difficulty, actions);

  deselectAll(state);
  return actions;
}

// §45 (phase 11) — "Hard AI" was the trained RL bot (policy-g2 policy net +
// turn-level search, ~92% vs the hand-crafted hard AI — see ml/botClient.ts
// / docs M4-RL-REBUILD-REPORT), but those nets were trained under the
// PRE-phase-11 rules (Founding Round, starting units, instant recruiting).
// Under the new zero-start/training-queue opening the trained policy
// essentially never chooses to recruit, so it builds no army at all. Left
// disconnected deliberately (per the current task's scope) — do not wire it
// back in until a checkpoint is retrained against the current rules AND the
// current 4-tier difficulty split below: `import { runRLHardTurn } from
// '../ml/botClient';` and call `runRLHardTurn(state, s =>
// { runTurn(s, getCurrentPlayer(s).id, 'expert'); if (s.phase === 'playing') endTurn(s); })`.
//
// Contract: mutate `state` with the AI's completed turn, return AIAction[]
// for the combat log, and do NOT end the turn — the caller does that.
export function runAiTurn(state: GameState, difficulty: AiDifficulty, aiPlayerId: number = getCurrentPlayer(state).id): AIAction[] {
  return runTurn(state, aiPlayerId, difficulty);
}
