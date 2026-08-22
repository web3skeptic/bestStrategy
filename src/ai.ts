import {
  GameState, HexCoord, Unit, UnitType, TechId,
  UNIT_COSTS, TECH_COST,
  TELEPORT_BUILD_COST, SUPPORT_RANGE,
} from './types';
import { hexDistance, hexKey, hexEqual, hexNeighbors } from './hex';
import { calculateDamage } from './combat';
import {
  getCurrentPlayer, getUnitAt,
  spawnUnit, selectUnit, moveUnit, attackUnit, deselectAll,
  canStartFounding, startFounding,
  attackStructure, getStructureAt,
  getOwnedStructures, getPlayerCapital,
  researchTech, canResearch,
  buildTeleportPair, canBuildTeleportPair, getValidTeleportHexes,
  getValidTeleportHexesForOtherTemples, getTeleportAt,
  canStartFarm, startFarm, getValidFarmHexes, canBuyDevotion, buyDevotion,
  canBuildRoad, buildRoad,
  getUnlockedUnits, getPopulationCap, getPopulationCount,
  getEffectiveRange, getEffectiveAttack, getEffectiveDefense,
  calculateEncirclement, isForestUnitRevealed, endTurn,
  getUnitTypeMultiplier,
  getUnitCost,
} from './game';
import { runRLHardTurn } from '../ml/botClient';

export interface AIAction {
  type: 'spawn' | 'move' | 'attack' | 'move+attack' | 'upgrade';
  pos: HexCoord;
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Best-Strategy AI
//
// Two difficulties share one engine-routed core:
//   • runAITurn      — "normal": light economy, simple targeting (beatable).
//   • runHardAITurn  — "hard":  uses (nearly) everything the game offers.
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

// ── Objective selection: defend threatened structures → besiege → hunt weakest enemy ──

function weakestEnemyTarget(state: GameState, unit: Unit, aiPlayerId: number): HexCoord | null {
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
  if (nearestUnit) return nearestUnit.pos;
  const structures = getOwnedStructures(state, target.id);
  const nearestStructure = bestBy(structures, s => -hexDistance(unit.pos, s.pos));
  return nearestStructure ? nearestStructure.pos : null;
}

function pickObjective(state: GameState, unit: Unit, aiPlayerId: number): HexCoord | null {
  const myStructures = getOwnedStructures(state, aiPlayerId);
  const enemies = revealedEnemies(state, aiPlayerId);

  // 1. Defend an owned structure under imminent threat with no adjacent defender.
  for (const s of myStructures) {
    const threatened = enemies.some(e => hexDistance(e.pos, s.pos) <= 2);
    if (!threatened) continue;
    const defended = state.units.some(u =>
      u.hp > 0 && u.playerId === aiPlayerId && u.id !== unit.id && hexDistance(u.pos, s.pos) <= 1);
    if (!defended) return s.pos;
  }

  // 2. Besiege: nearest enemy structure — destroying the Capital wins the game
  // (§11), and any City/Temple along the way is a legitimate combat target too.
  const enemyStructures = state.players
    .filter(p => p.id !== aiPlayerId)
    .flatMap(p => getOwnedStructures(state, p.id));
  const nearestStructure = bestBy(enemyStructures, s => -hexDistance(unit.pos, s.pos));
  const structureDist = nearestStructure ? hexDistance(unit.pos, nearestStructure.pos) : Infinity;

  // 3. Hunt the weakest enemy's units.
  const enemyTarget = weakestEnemyTarget(state, unit, aiPlayerId);
  const enemyDist = enemyTarget ? hexDistance(unit.pos, enemyTarget) : Infinity;

  if (nearestStructure && structureDist <= enemyDist) return nearestStructure.pos;
  if (enemyTarget) return enemyTarget;
  return nearestStructure ? nearestStructure.pos : null;
}

// ── Per-unit action (engine-routed) ──

// If the unit can attack an enemy structure right now, do it — prioritising
// the enemy Capital (that's the actual win condition, §11) over a City/Temple.
function tryAttackStructure(state: GameState, unit: Unit, hard: boolean, actions: AIAction[]): boolean {
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
  actions.push({ type: 'attack', pos: { ...scored }, description: `${hard ? 'Hard ' : ''}AI ${unit.type} strikes a structure at (${scored.q},${scored.r})${result.gameOver ? ' — Capital destroyed!' : ''}` });
  return true;
}

function actCombatUnit(state: GameState, unit: Unit, aiPlayerId: number, hard: boolean, actions: AIAction[]): void {
  if (state.phase !== 'playing' || unit.hp <= 0) return;

  // Founder units try to found on the neutral/ruined site they're standing on
  // (no-op — canStartFounding returns null — for every other unit type).
  const founding = canStartFounding(state, unit);
  if (founding) {
    observe(state, 'found', { unitId: unit.id });
    startFounding(state, unit.id);
    actions.push({ type: 'upgrade', pos: { ...unit.pos }, description: `${hard ? 'Hard ' : ''}AI begins founding a ${founding.targetState} at (${unit.pos.q},${unit.pos.r})` });
    return; // founding spends the whole activation
  }

  // Agrar's Builder grows its Farm network first — that's the faction's
  // whole economy now (§6-9) — and only pays a road forward if no valid
  // Farm hex is available this turn (hard AI only; a simple baseline, not a
  // network planner).
  if (hard && unit.type === 'founder') {
    const player = state.players[aiPlayerId]!;
    if (player.faction === 'agrar') {
      const farmHex = getValidFarmHexes(state, aiPlayerId).find(h => canStartFarm(state, unit, h));
      if (farmHex) {
        observe(state, 'build-farm', { unitId: unit.id, pos: farmHex });
        startFarm(state, unit.id, farmHex);
        actions.push({ type: 'upgrade', pos: { ...farmHex }, description: `Hard AI begins building a Farm at (${farmHex.q},${farmHex.r})` });
        return; // building spends the whole activation
      }
      if (canBuildRoad(state, unit)) {
        observe(state, 'build-road', { unitId: unit.id });
        buildRoad(state, unit.id);
        actions.push({ type: 'upgrade', pos: { ...unit.pos }, description: `Hard AI builds a road at (${unit.pos.q},${unit.pos.r})` });
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
    actions.push({ type: 'attack', pos: { ...bestHere.pos }, description: `${hard ? 'Hard ' : ''}AI ${unit.type} kills at (${bestHere.pos.q},${bestHere.pos.r})` });
    return;
  }

  // No unit kill available — take a shot at an enemy structure if one is in range.
  if (!bestHere && tryAttackStructure(state, unit, hard, actions)) return;

  // Otherwise consider repositioning toward the best objective / a kill.
  if (!unit.hasMoved) {
    const objective = pickObjective(state, unit, aiPlayerId);
    const enemies = revealedEnemies(state, aiPlayerId);
    const moveHexes = [...state.moveHexes];
    const scored = bestBy(moveHexes, hex => {
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
      return s;
    });

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
          actions.push({ type: 'move+attack', pos: { ...unit.pos }, description: `${hard ? 'Hard ' : ''}AI ${unit.type} advances (${before.q},${before.r})→(${unit.pos.q},${unit.pos.r}) and strikes` });
        } else if (tryAttackStructure(state, unit, hard, actions)) {
          // handled — moved and struck a structure
        } else {
          actions.push({ type: 'move', pos: { ...unit.pos }, description: `${hard ? 'Hard ' : ''}AI ${unit.type} advances to (${unit.pos.q},${unit.pos.r})` });
        }
        return;
      }
    }
  }

  // Couldn't (or chose not to) move — take the best available shot.
  if (bestHere && scoreTarget(state, unit, bestHere) > 0) {
    observe(state, 'attack', { unitId: unit.id, targetId: bestHere.id });
    attackUnit(state, bestHere.pos);
    actions.push({ type: 'attack', pos: { ...bestHere.pos }, description: `${hard ? 'Hard ' : ''}AI ${unit.type} attacks at (${bestHere.pos.q},${bestHere.pos.r})` });
    return;
  }
  tryAttackStructure(state, unit, hard, actions);
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
  const scoreHex = (pos: HexCoord): number => {
    let allies = 0;
    for (const c of combat) if (hexDistance(pos, c.pos) <= SUPPORT_RANGE) allies++;
    let danger = 0;
    for (const e of enemies) {
      const d = hexDistance(pos, e.pos);
      if (d <= 1) danger += 3; else if (d <= 2) danger += 1;
    }
    return allies * 4 - danger * 3;
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

// Coherent tech build: siege core (catapult + fortified ranged), a force-
// multiplier support unit, cross-map teleports (great now that temples are far
// apart), then splash and elite/anti-cavalry unlocks. canResearch enforces
// branch exclusivity, so unreachable picks are skipped automatically.
const HARD_RESEARCH_PLAN: TechId[] = [
  'unlock_catapult',
  'longrange_hp',
  'unlock_damagebooster',
  'teleports',
  'catapult_splash',
  'unlock_heavyknight',
  'unlock_spearsman',
];

function doResearch(state: GameState, aiPlayerId: number, actions: AIAction[]): void {
  const player = state.players[aiPlayerId]!;
  if (player.aura < TECH_COST) return;
  const home = getPlayerCapital(state, aiPlayerId);
  for (const tech of HARD_RESEARCH_PLAN) {
    if (!canResearch(state, tech)) continue;
    observe(state, 'research', { techId: tech });
    if (researchTech(state, tech)) {
      actions.push({ type: 'upgrade', pos: home ? { ...home.pos } : { q: 0, r: 0 }, description: `Hard AI researches ${tech}` });
      return; // one tech per turn
    }
  }
}

// Temple Devotion — phase 4/10 economy. Greedy: buy the next level on every
// owned Temple site that can afford it, one purchase per site per turn.
// Agrar's Farm-building is handled per-unit in actCombatUnit instead (it's
// Builder-driven, not site-driven — see §6-9).
function doEconomy(state: GameState, aiPlayerId: number, actions: AIAction[]): void {
  for (const site of getOwnedSites(state, aiPlayerId)) {
    if (site.state === 'temple' && canBuyDevotion(state, site.id)) {
      observe(state, 'buy-devotion', { templeId: site.id });
      if (buyDevotion(state, site.id)) {
        actions.push({ type: 'upgrade', pos: { ...site.pos }, description: `Hard AI purchases Devotion at (${site.pos.q},${site.pos.r})` });
      }
    }
  }
}

function getOwnedSites(state: GameState, aiPlayerId: number) {
  return state.strategicSites.filter(s => s.ownerId === aiPlayerId && s.state === 'temple');
}

function doTeleport(state: GameState, aiPlayerId: number, actions: AIAction[]): void {
  if (!state.playerTech[aiPlayerId]?.researched.has('teleports')) return;
  const player = state.players[aiPlayerId]!;
  if (player.aura < TELEPORT_BUILD_COST) return;
  for (const anchor of getOwnedStructures(state, aiPlayerId)) {
    if (!canBuildTeleportPair(state, anchor.id)) continue;
    const hexesA = getValidTeleportHexes(state, anchor.id);
    const hexesB = getValidTeleportHexesForOtherTemples(state, anchor.id);
    if (hexesA.length === 0 || hexesB.length === 0) continue;
    // Connect the two most-distant structures for maximum redeploy value.
    const posB = bestBy(hexesB, h => hexDistance(anchor.pos, h))!;
    observe(state, 'build-teleport', { templeId: anchor.id, pos: hexesA[0]!, targetPos: posB });
    if (buildTeleportPair(state, anchor.id, hexesA[0]!, posB)) {
      actions.push({ type: 'upgrade', pos: { ...hexesA[0]! }, description: `Hard AI builds teleport at (${hexesA[0]!.q},${hexesA[0]!.r})` });
      return; // one pair per turn
    }
  }
}

// ── Recruiting ──

function chooseSpawnType(state: GameState, aiPlayerId: number, unlocked: Set<UnitType>, aura: number, hard: boolean): UnitType | null {
  const mine = state.units.filter(u => u.hp > 0 && u.playerId === aiPlayerId);
  const count = (t: UnitType) => mine.filter(u => u.type === t).length;
  const army = mine.length;
  const combat = mine.filter(u => !isSupport(u.type)).length;
  const faction = state.players[aiPlayerId]?.faction;
  const cost = (t: UnitType) => getUnitCost(t, faction);

  if (hard) {
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

  // Normal AI: cheap, simple mix.
  if (unlocked.has('horserider') && aura >= cost('horserider') && Math.random() < 0.3) return 'horserider';
  if (unlocked.has('archer') && aura >= cost('archer') && Math.random() < 0.5) return 'archer';
  if (unlocked.has('warrior') && aura >= cost('warrior')) return 'warrior';
  if (unlocked.has('archer') && aura >= cost('archer')) return 'archer';
  return null;
}

function spawnPass(state: GameState, aiPlayerId: number, hard: boolean, actions: AIAction[]): void {
  const player = state.players[aiPlayerId]!;
  for (const structure of getOwnedStructures(state, aiPlayerId)) {
    if (getUnitAt(state, structure.pos)) continue; // occupied — can't spawn (throttles multi-spawn)
    if (getPopulationCount(state, aiPlayerId) >= getPopulationCap(state, aiPlayerId)) break;
    const unlocked = getUnlockedUnits(state.playerTech[aiPlayerId]!, state.players[aiPlayerId]?.faction);
    const type = chooseSpawnType(state, aiPlayerId, unlocked, player.aura, hard);
    if (!type) continue;
    observe(state, 'recruit', { unitType: type, templeId: structure.id });
    if (spawnUnit(state, structure.id, type)) {
      actions.push({ type: 'spawn', pos: { ...structure.pos }, description: `${hard ? 'Hard ' : ''}AI recruits ${type} at (${structure.pos.q},${structure.pos.r})` });
    }
  }
}

// ── Turn driver ──

function runTurn(state: GameState, aiPlayerId: number, hard: boolean): AIAction[] {
  const actions: AIAction[] = [];
  const player = state.players.find(p => p.id === aiPlayerId);
  if (!player || state.phase !== 'playing' || getCurrentPlayer(state).id !== aiPlayerId) return actions;

  // 1. Economy (spend aura — never float it). The normal AI keeps things
  // simple and skips Farms/Devotion/research/teleport; its surplus aura goes
  // straight to recruiting below.
  if (hard) {
    doEconomy(state, aiPlayerId, actions);
    doResearch(state, aiPlayerId, actions);
    doTeleport(state, aiPlayerId, actions);
  }

  // 2. Recruit (pass 1).
  spawnPass(state, aiPlayerId, hard, actions);

  // 3. Manoeuvre — combat units first (so support can then tuck in behind them).
  const combatUnits = state.units.filter(u => u.hp > 0 && u.playerId === aiPlayerId && !isSupport(u.type));
  for (const unit of combatUnits) {
    if (state.phase !== 'playing') break;
    actCombatUnit(state, unit, aiPlayerId, hard, actions);
  }
  const supportUnits = state.units.filter(u => u.hp > 0 && u.playerId === aiPlayerId && isSupport(u.type));
  for (const unit of supportUnits) {
    if (state.phase !== 'playing') break;
    actSupportUnit(state, unit, aiPlayerId, actions);
  }

  // 4. Recruit again (pass 2) — units have vacated their temples, so this is the
  //    multi-spawn-per-temple pass that spends leftover aura up to the pop cap.
  if (hard && state.phase === 'playing') spawnPass(state, aiPlayerId, hard, actions);

  deselectAll(state);
  return actions;
}

// Run one full AI turn for `aiPlayerId` (defaults to the current player). Does
// NOT end the turn — the caller does that.
export function runAITurn(state: GameState, aiPlayerId: number = getCurrentPlayer(state).id): AIAction[] {
  return runTurn(state, aiPlayerId, false);
}

// The "Hard AI" is now the trained RL bot: policy-g2 policy net + turn-level
// search (K=12, temp=1.0, depth=1, blend leaf; value-net-v2mc-best) — ~92% vs the
// hand-crafted hard AI (see ml/botClient.ts / docs M4-RL-REBUILD-REPORT). The
// original hand-crafted hard-AI turn is preserved as `hardAILogicTurn` and used as
// the search's opponent model (the legitimate, plan-blessed opponent model).
//
// Contract is unchanged from the old runHardAITurn: mutate `state` with the AI's
// completed turn, return AIAction[] for the combat log, and do NOT end the turn.
const hardAILogicTurn = (s: GameState): void => {
  runTurn(s, getCurrentPlayer(s).id, true);
  if (s.phase === 'playing') endTurn(s);
};

export function runHardAITurn(state: GameState, aiPlayerId: number = getCurrentPlayer(state).id): AIAction[] {
  // The RL bot reasons from the current player's seat. Guard the (not used in
  // practice) off-turn case by falling back to the hand-crafted hard AI.
  if (state.phase !== 'playing' || getCurrentPlayer(state).id !== aiPlayerId) {
    return runTurn(state, aiPlayerId, true);
  }
  return runRLHardTurn(state, hardAILogicTurn);
}
