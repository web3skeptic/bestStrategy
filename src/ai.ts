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
import { TEMPLE_UPGRADE_COST } from './factions';
import {
  getCurrentPlayer, getUnitAt,
  spawnUnit, selectUnit, moveUnit, attackUnit, deselectAll,
  canStartFounding, startFounding,
  attackStructure, getStructureAt,
  getOwnedStructures, getPlayerCapital,
  researchTech, canResearch,
  getTeleportAt,
  canStartFarm, startFarm, getValidFarmHexes, canStartTempleUpgrade, startTempleUpgrade,
  canBuildRoad, buildRoad, getValidRoadHexes, canPillageRoad, pillageRoad,
  canClaimFertileSite, claimFertileSite,
  getUnlockedUnits, getPopulationCap, getPopulationCount,
  getEffectiveRange, getEffectiveAttack, getEffectiveDefense,
  calculateEncirclement, isForestUnitRevealed, endTurn,
  getUnitTypeMultiplier,
  getUnitCost,
  getPlayerIncome,
} from './game';

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

function revealedEnemies(state: GameState, aiPlayerId: number): Unit[] {
  return state.units.filter(u =>
    u.hp > 0 && u.playerId !== aiPlayerId && isForestUnitRevealed(state, u.pos, aiPlayerId));
}

// Deterministic damage estimate for target ranking. Mirrors the engine's own
// calculateDamage (combat.ts) exactly, via the shared getUnitTypeMultiplier
// helper, so the AI never drifts from the real combat math.
function estimateDamage(state: GameState, attacker: Unit, target: Unit): number {
  const enc = calculateEncirclement(state, target);
  const typeBonus = getUnitTypeMultiplier(attacker.type, target.type);
  const atk = getEffectiveAttack(state, attacker);
  const def = getEffectiveDefense(state, target);
  const hpFraction = attacker.hp / attacker.stats.maxHp;
  return Math.max(1, calculateDamage(atk, def, enc.attackMultiplier, typeBonus, hpFraction));
}

function scoreTarget(state: GameState, attacker: Unit, target: Unit): number {
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
function effectiveDest(state: GameState, hex: HexCoord): HexCoord {
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

// Select a unit and expose the engine-computed highlight sets (moveHexes /
// attackHexes). Returns false if it can't be selected.
function select(state: GameState, unit: Unit): boolean {
  selectUnit(state, unit.id);
  return state.selectedUnitId === unit.id;
}

// Enemy units currently in the selected unit's attack set.
function currentAttackTargets(state: GameState): Unit[] {
  return state.attackHexes
    .map(h => getUnitAt(state, h))
    .filter((u): u is Unit => !!u && u.hp > 0);
}

// Enemy structures (Capital/City/Temple) currently in range — a hard-AI-only
// concern (finishing the enemy Capital is the whole point of the redesign),
// so keep it a separate query from unit targets rather than merging shapes.
function currentStructureAttackHexes(state: GameState): HexCoord[] {
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
const MIN_ARMY_TO_GARRISON = 2; // don't strand a brand-new 1-unit army on turtle duty
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
const garrisonMemory = new WeakMap<GameState, Set<string>>();
function getGarrisonMemory(state: GameState): Set<string> {
  let s = garrisonMemory.get(state);
  if (!s) { s = new Set(); garrisonMemory.set(state, s); }
  return s;
}

function pickObjective(state: GameState, unit: Unit, aiPlayerId: number, plan: AiPlan | null = null): HexCoord | null {
  // getOwnedStructures only ever returns the Capital + owned Temple sites —
  // it never includes Farms. For Agrar that meant its ENTIRE economy was
  // structurally invisible to the "defend a threatened structure" check
  // below: a Temple Raider could walk up to and destroy an Agrar Farm
  // completely unopposed, no matter how good the rest of the AI's defense
  // logic was, simply because Farms were never in the list being checked.
  const myStructures = [...getOwnedStructures(state, aiPlayerId), ...state.farms.filter(f => f.ownerId === aiPlayerId && f.state === 'farm')];
  const enemies = revealedEnemies(state, aiPlayerId);

  // 0. Keep a standing home guard — a genuinely competent player never
  // leaves the Capital with zero eyes/defenders on it, and reactive
  // "defend once threatened" (below) can't help if the threat was never
  // seen coming in the first place (fog of war). Exactly one unit is ever
  // assigned (see garrisonMemory above) — this is a standing-garrison
  // preference the rest of the army is entirely free of, not a lockdown.
  const capital = getPlayerCapital(state, aiPlayerId);
  const myArmySize = state.units.filter(u => u.hp > 0 && u.playerId === aiPlayerId && !isSupport(u.type)).length;
  if (capital && myArmySize >= MIN_ARMY_TO_GARRISON) {
    const garrison = getGarrisonMemory(state);
    const currentGuard = [...garrison].map(id => state.units.find(u => u.id === id && u.hp > 0)).find(u => !!u);
    if (currentGuard) {
      if (currentGuard.id === unit.id) return capital.pos;
    } else {
      garrison.clear(); // previous guard died — hand the job to a new unit
      const combatUnits = state.units.filter(u => u.hp > 0 && u.playerId === aiPlayerId && !isSupport(u.type));
      const closest = bestBy(combatUnits, u => -hexDistance(u.pos, capital.pos));
      if (closest) {
        garrison.add(closest.id);
        if (closest.id === unit.id) return capital.pos;
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

  // v14 — a not-already-mine Fertile Site is a real objective (Agrar
  // mirror only; state.fertileSites is empty in every other matchup, so
  // this is a no-op there). Contested map control, not free — walking a
  // unit toward it is how the AI ever bothers claiming one at all.
  const player = state.players.find(p => p.id === aiPlayerId);
  if (player?.faction === 'agrar') {
    const openFertile = state.fertileSites.find(f => f.ownerId !== aiPlayerId);
    if (openFertile) return openFertile.pos;
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
  // Already-close units are left alone (nothing to rally back FROM).
  if (capital && myArmySize < MIN_ARMY_TO_ATTACK && hexDistance(unit.pos, capital.pos) > GARRISON_RADIUS + RALLY_SLACK) {
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

  // SIEGE plan — a siege unit heads straight for the enemy Capital instead of
  // whichever enemy structure merely happens to be nearest.
  const enemyStructures = state.players
    .filter(p => p.id !== aiPlayerId)
    .flatMap(p => getOwnedStructures(state, p.id));
  if (plan === 'SIEGE' && unit.type === 'catapult') {
    const enemyCapitals = state.players
      .filter(p => p.id !== aiPlayerId)
      .map(p => getPlayerCapital(state, p.id))
      .filter((c): c is NonNullable<typeof c> => !!c);
    const enemyCapital = bestBy(enemyCapitals, c => -hexDistance(unit.pos, c.pos));
    if (enemyCapital) { memory.set(unit.id, { kind: 'structure', id: enemyCapital.id }); return enemyCapital.pos; }
  }
  const nearestStructure = bestBy(enemyStructures, s => -hexDistance(unit.pos, s.pos));
  const structureDist = nearestStructure ? hexDistance(unit.pos, nearestStructure.pos) : Infinity;

  const enemyTarget = weakestEnemyTarget(state, unit, aiPlayerId);
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
): HexCoord | null {
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
  return best ?? candidates[0]!;
}

function actCombatUnit(
  state: GameState, unit: Unit, aiPlayerId: number, difficulty: AiDifficulty,
  actions: AIAction[], plan: AiPlan | null, threatMap: Map<string, number> | null,
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
  // Farm hex is available this turn (Normal+; a simple baseline, not a
  // network planner — though getValidRoadHexes already only ever offers
  // hexes adjacent to the existing Capital/Farm/Road network, so every
  // candidate is inherently "connected", never an isolated stray tile).
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

      const farmHex = getValidFarmHexes(state, unit).find(h => canStartFarm(state, unit, h));
      if (farmHex) {
        observe(state, 'build-farm', { unitId: unit.id, pos: farmHex });
        startFarm(state, unit.id, farmHex);
        actions.push({ type: 'upgrade', pos: { ...farmHex }, description: `${difficultyLabel(difficulty)} begins building a Farm at (${farmHex.q},${farmHex.r})` });
        return; // building spends the whole activation
      }
      const roadHex = getValidRoadHexes(state, unit).find(h => canBuildRoad(state, unit, h));
      if (roadHex) {
        observe(state, 'build-road', { unitId: unit.id, pos: roadHex });
        buildRoad(state, unit.id, roadHex);
        actions.push({ type: 'upgrade', pos: { ...roadHex }, description: `${difficultyLabel(difficulty)} builds a road at (${roadHex.q},${roadHex.r})` });
        return; // building spends the whole activation
      }
    }
  }
  if (unit.hasAttacked) return;
  if (!select(state, unit)) return;

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
    const objective = pickObjective(state, unit, aiPlayerId, plan);
    const enemies = revealedEnemies(state, aiPlayerId);
    const moveHexes = [...state.moveHexes];
    const scoreHex = (hex: HexCoord): number => {
      const dest = effectiveDest(state, hex);
      let s = objective ? -hexDistance(dest, objective) : 0;
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
    };

    const rankedHexes = [...moveHexes].sort((a, b) => scoreHex(b) - scoreHex(a));
    // Hard/Expert — shallow lookahead: rather than trust the heuristic's top
    // pick outright, actually simulate the top `candidateLimit` candidates on
    // a CLONED state (never the live one) and re-rank by the resulting
    // evaluateState() score, an explicit "would this hand the opponent a
    // guaranteed kill" check, and (Expert, searchDepth>=2 only) the single
    // most threatening enemy reply actually simulated — not a full
    // recursive search.
    const scored = cfg.searchDepth > 0
      ? chooseBestCandidateByLookahead(state, unit, aiPlayerId, rankedHexes.slice(0, cfg.candidateLimit), cfg.searchDepth)
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
const HARD_RESEARCH_PLAN: Record<'agrar' | 'temple', TechId[]> = {
  agrar: [
    'agrar_siegecraft',
    'longrange_hp',
    'unlock_damagebooster',
    'agrar_siegecraft_splash',
    'agrar_heavy_armor',
    'command_1',
    'agrar_heavy_knight_tech',
  ],
  temple: [
    'temple_mobile_siege_tech',
    'longrange_hp',
    'unlock_damagebooster',
    'temple_mobile_siege_splash',
    'temple_warrior_rite',
    'command_1',
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
  if (capital && capital.hp / capital.maxHp < 0.5) return true;
  const enemies = revealedEnemies(state, aiPlayerId);
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
function computeThreatMap(state: GameState, aiPlayerId: number): Map<string, number> {
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

// ── Strategic plan (Hard+) ───────────────────────────────────────────────────
// One plan tag per AI turn (computed once in runTurn, not per unit), biasing
// pickObjective instead of replacing it — the underlying tactical logic
// (kill-first, defend-threatened, besiege, hunt-weakest) still runs
// regardless of plan, this just changes which objective gets first refusal.
export type AiPlan = 'DEFEND' | 'RAID_ECONOMY' | 'SIEGE' | 'TECH_UP' | 'EXPAND';

function chooseStrategicPlan(state: GameState, aiPlayerId: number): AiPlan {
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
// A single number, positive = good for `forPlayerId`. Used by Expert's
// shallow lookahead (chooseBestCandidate) to compare candidate resulting
// positions. Deliberately NOT the full §23 spec (no tech-progress/road-
// connectivity/formation terms yet) — material, income, Capital safety
// (nonlinear — see §25) and structure count cover the load-bearing cases.
export function evaluateState(state: GameState, forPlayerId: number): number {
  let score = 0;
  for (const player of state.players) {
    const sign = player.id === forPlayerId ? 1 : -1;
    for (const u of state.units) {
      if (u.hp <= 0 || u.playerId !== player.id) continue;
      score += sign * getUnitCost(u.type, player.faction) * (u.hp / u.stats.maxHp) * 3;
    }
    score += sign * player.aura * 0.5;
    const capital = getPlayerCapital(state, player.id);
    if (capital) {
      const frac = capital.hp / capital.maxHp;
      let capScore = frac * 100;
      if (frac < 0.25) capScore -= 150;
      else if (frac < 0.5) capScore -= 60;
      score += sign * capScore;
    }
    score += sign * getOwnedStructures(state, player.id).length * 15;
  }
  return score;
}

// Deep-clones a GameState for simulation — a plain object-spread (as
// serializer.ts's own serialize/deserialize do for the live save/load path)
// is NOT enough here, since nested arrays (units, farms, ...) would still
// share references with the live state; mutating a "clone" through the real
// engine mutators would then corrupt the actual game. A full JSON round-trip
// guarantees independence (GameState is plain, JSON-safe data).
function cloneStateForSim(state: GameState): GameState {
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
  // multiple recruit passes never queues a second redundant Builder.
  if (unlocked.has('founder') && count('founder') === 0 && aura >= cost('founder')) {
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
  const emergency = withinReachNextRound ? hasEmergency(state, aiPlayerId) : false;
  for (const structure of getOwnedStructures(state, aiPlayerId)) {
    if (getUnitAt(state, structure.pos)) continue; // occupied — can't spawn (throttles multi-spawn)
    if (getPopulationCount(state, aiPlayerId) >= getPopulationCap(state, aiPlayerId)) break;
    const unlocked = getUnlockedUnits(state.playerTech[aiPlayerId]!, state.players[aiPlayerId]?.faction);
    // chooseSpawnType only ever returns 'founder' while none exists yet
    // (alive OR still queued — see its own count()), so `type !== 'founder'`
    // alone is enough to identify "this recruit is discretionary".
    const type = chooseSpawnType(state, aiPlayerId, unlocked, player.aura, cfg.useResourceReservation);
    if (!type) continue;
    if (withinReachNextRound && !emergency && type !== 'founder') {
      const cost = getUnitCost(type, player.faction);
      if (player.aura - cost < reservation) continue; // saving — skip this discretionary recruit
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
  const combatUnits = state.units.filter(u => u.hp > 0 && u.playerId === aiPlayerId && !isSupport(u.type));
  for (const unit of combatUnits) {
    if (state.phase !== 'playing') break;
    actCombatUnit(state, unit, aiPlayerId, difficulty, actions, plan, threatMap);
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
