import {
  GameState, HexCoord, Unit, UnitType, TechId,
  UNIT_COSTS, templeUpgradeCost, TECH_COST,
  TEMPLE_ECONOMY_CAP_LEVEL, TELEPORT_BUILD_COST, SUPPORT_RANGE,
} from './types';
import { hexDistance, hexKey, hexEqual, hexNeighbors } from './hex';
import {
  getCurrentPlayer, getUnitAt,
  spawnUnit, selectUnit, moveUnit, attackUnit, deselectAll,
  captureTemple, canCaptureTemple,
  upgradeTemple, researchTech, canResearch,
  buildTeleportPair, canBuildTeleportPair, getValidTeleportHexes,
  getValidTeleportHexesForOtherTemples, getTeleportAt,
  getUnlockedUnits, getPopulationCap, getPopulationCount,
  getEffectiveRange, getEffectiveAttack, getEffectiveDefense,
  calculateEncirclement, isForestUnitRevealed,
} from './game';

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

function isPlayerAlive(state: GameState, playerId: number): boolean {
  return state.units.some(u => u.hp > 0 && u.playerId === playerId)
    || state.temples.some(t => t.ownerId === playerId);
}

function revealedEnemies(state: GameState, aiPlayerId: number): Unit[] {
  return state.units.filter(u =>
    u.hp > 0 && u.playerId !== aiPlayerId && isForestUnitRevealed(state, u.pos, aiPlayerId));
}

// Deterministic mean-case damage estimate (multiplier fixed at 1.0). Mirrors the
// engine's calculateDamage: round(mult * enc * typeBonus * (atk - def)). Used only
// for target ranking, so no RNG is wanted here.
function estimateDamage(state: GameState, attacker: Unit, target: Unit): number {
  const enc = calculateEncirclement(state, target);
  const typeBonus =
    (attacker.stats.attackBonusAgainst?.[target.type] ?? 1) /
    (target.stats.defenseBonusAgainst?.[attacker.type] ?? 1);
  const atk = getEffectiveAttack(state, attacker);
  const def = getEffectiveDefense(state, target);
  return Math.max(0, Math.round(enc.attackMultiplier * typeBonus * (atk - def)));
}

function scoreTarget(state: GameState, attacker: Unit, target: Unit): number {
  const dmg = estimateDamage(state, attacker, target);
  const kill = dmg >= target.hp;
  let score = kill ? 1000 + unitValue(target.type) * 10 : dmg * 3 + unitValue(target.type) * 5 - target.hp;
  // Discount for expected revenge if this won't be a kill (avoid feeding trades).
  if (!kill && attacker.stats.canBeRevenged) {
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

function bestBy<T>(items: T[], score: (t: T) => number): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const it of items) {
    const s = score(it);
    if (s > bestScore) { bestScore = s; best = it; }
  }
  return best;
}

// ── Objective selection: defend threatened temples → expand → hunt weakest enemy ──

function weakestEnemyTarget(state: GameState, unit: Unit, aiPlayerId: number): HexCoord | null {
  const enemyPlayers = state.players.filter(p => p.id !== aiPlayerId && isPlayerAlive(state, p.id));
  if (enemyPlayers.length === 0) return null;
  // Strength = total unit HP + a premium per owned temple. Focus the weakest.
  const target = bestBy(enemyPlayers, p => {
    const hp = state.units.filter(u => u.hp > 0 && u.playerId === p.id).reduce((s, u) => s + u.hp, 0);
    const temples = state.temples.filter(t => t.ownerId === p.id).length;
    return -(hp + temples * 20);
  });
  if (!target) return null;
  const revealed = state.units.filter(u =>
    u.hp > 0 && u.playerId === target.id && isForestUnitRevealed(state, u.pos, aiPlayerId));
  const nearestUnit = bestBy(revealed, u => -hexDistance(unit.pos, u.pos));
  if (nearestUnit) return nearestUnit.pos;
  const temples = state.temples.filter(t => t.ownerId === target.id);
  const nearestTemple = bestBy(temples, t => -hexDistance(unit.pos, t.pos));
  return nearestTemple ? nearestTemple.pos : null;
}

function pickObjective(state: GameState, unit: Unit, aiPlayerId: number): HexCoord | null {
  const myTemples = state.temples.filter(t => t.ownerId === aiPlayerId);
  const enemies = revealedEnemies(state, aiPlayerId);

  // 1. Defend an owned temple under imminent threat with no adjacent defender.
  for (const t of myTemples) {
    const threatened = enemies.some(e => hexDistance(e.pos, t.pos) <= 2);
    if (!threatened) continue;
    const defended = state.units.some(u =>
      u.hp > 0 && u.playerId === aiPlayerId && u.id !== unit.id && hexDistance(u.pos, t.pos) <= 1);
    if (!defended) return t.pos;
  }

  // 2. Expand: nearest temple we don't own (neutral or enemy).
  const capturable = state.temples.filter(t => t.ownerId !== aiPlayerId);
  const nearestTemple = bestBy(capturable, t => -hexDistance(unit.pos, t.pos));
  const templeDist = nearestTemple ? hexDistance(unit.pos, nearestTemple.pos) : Infinity;

  // 3. Hunt the weakest enemy.
  const enemyTarget = weakestEnemyTarget(state, unit, aiPlayerId);
  const enemyDist = enemyTarget ? hexDistance(unit.pos, enemyTarget) : Infinity;

  if (nearestTemple && templeDist <= enemyDist) return nearestTemple.pos;
  if (enemyTarget) return enemyTarget;
  return nearestTemple ? nearestTemple.pos : null;
}

// ── Per-unit action (engine-routed) ──

function actCombatUnit(state: GameState, unit: Unit, aiPlayerId: number, hard: boolean, actions: AIAction[]): void {
  if (state.phase !== 'playing' || unit.hp <= 0) return;

  // Free capture of the temple we stand on (does not consume move/attack).
  const cap = canCaptureTemple(state, unit);
  if (cap) {
    captureTemple(state, unit, cap);
    actions.push({ type: 'upgrade', pos: { ...unit.pos }, description: `${hard ? 'Hard ' : ''}AI captures temple at (${unit.pos.q},${unit.pos.r})` });
  }
  if (unit.hasAttacked) return;
  if (!select(state, unit)) return;

  // Kill from current position if possible (esp. valuable for ranged units).
  const here = currentAttackTargets(state);
  const bestHere = bestBy(here, t => scoreTarget(state, unit, t));
  if (bestHere && estimateDamage(state, unit, bestHere) >= bestHere.hp) {
    attackUnit(state, bestHere.pos);
    actions.push({ type: 'attack', pos: { ...bestHere.pos }, description: `${hard ? 'Hard ' : ''}AI ${unit.type} kills at (${bestHere.pos.q},${bestHere.pos.r})` });
    return;
  }

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
      const moved = moveUnit(state, scored).moved;
      if (moved) {
        // Attack from the new position if worthwhile (moveUnit refreshed attackHexes).
        const after = currentAttackTargets(state);
        const bestAfter = bestBy(after, t => scoreTarget(state, unit, t));
        if (bestAfter && scoreTarget(state, unit, bestAfter) > 0) {
          attackUnit(state, bestAfter.pos);
          actions.push({ type: 'move+attack', pos: { ...unit.pos }, description: `${hard ? 'Hard ' : ''}AI ${unit.type} advances (${before.q},${before.r})→(${unit.pos.q},${unit.pos.r}) and strikes` });
        } else {
          actions.push({ type: 'move', pos: { ...unit.pos }, description: `${hard ? 'Hard ' : ''}AI ${unit.type} advances to (${unit.pos.q},${unit.pos.r})` });
        }
        return;
      }
    }
  }

  // Couldn't (or chose not to) move — take the best available shot.
  if (bestHere && scoreTarget(state, unit, bestHere) > 0) {
    attackUnit(state, bestHere.pos);
    actions.push({ type: 'attack', pos: { ...bestHere.pos }, description: `${hard ? 'Hard ' : ''}AI ${unit.type} attacks at (${bestHere.pos.q},${bestHere.pos.r})` });
  }
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
  const home = state.temples.find(t => t.ownerId === aiPlayerId);
  for (const tech of HARD_RESEARCH_PLAN) {
    if (!canResearch(state, tech)) continue;
    if (researchTech(state, tech)) {
      actions.push({ type: 'upgrade', pos: home ? { ...home.pos } : { q: 0, r: 0 }, description: `Hard AI researches ${tech}` });
      return; // one tech per turn
    }
  }
}

function doUpgrades(state: GameState, aiPlayerId: number, homeTempleId: string | undefined, actions: AIAction[]): void {
  const player = state.players[aiPlayerId]!;
  const RESERVE = 6; // keep some aura for recruiting
  const temples = state.temples
    .filter(t => t.ownerId === aiPlayerId && t.level < TEMPLE_ECONOMY_CAP_LEVEL)
    .sort((a, b) => {
      const ah = a.id === homeTempleId ? 0 : 1;
      const bh = b.id === homeTempleId ? 0 : 1;
      return ah - bh || a.level - b.level;
    });
  for (const t of temples) {
    const cost = templeUpgradeCost(t.level);
    if (cost === null || player.aura < cost) continue;
    const priority = t.id === homeTempleId && t.level < 3; // rush home to L3 first
    if (!priority && player.aura < cost + RESERVE) continue;
    if (upgradeTemple(state, t.id)) {
      actions.push({ type: 'upgrade', pos: { ...t.pos }, description: `Hard AI upgrades temple to L${t.level} at (${t.pos.q},${t.pos.r})` });
    }
  }
}

function doTeleport(state: GameState, aiPlayerId: number, actions: AIAction[]): void {
  if (!state.playerTech[aiPlayerId]?.researched.has('teleports')) return;
  const player = state.players[aiPlayerId]!;
  if (player.aura < TELEPORT_BUILD_COST) return;
  for (const temple of state.temples.filter(t => t.ownerId === aiPlayerId)) {
    if (!canBuildTeleportPair(state, temple.id)) continue;
    const hexesA = getValidTeleportHexes(state, temple.id);
    const hexesB = getValidTeleportHexesForOtherTemples(state, temple.id);
    if (hexesA.length === 0 || hexesB.length === 0) continue;
    // Connect the two most-distant temples for maximum redeploy value.
    const posB = bestBy(hexesB, h => hexDistance(temple.pos, h))!;
    if (buildTeleportPair(state, temple.id, hexesA[0]!, posB)) {
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

  if (hard) {
    // Keep exactly one damage booster as a force multiplier once a core exists.
    if (unlocked.has('damageBooster') && count('damageBooster') === 0 && combat >= 3 && aura >= UNIT_COSTS.damageBooster) {
      return 'damageBooster';
    }
    // Buy the best affordable unit, but cap the priciest types so the army stays
    // mixed (share = max fraction of the army that type may occupy).
    const prefs: [UnitType, number][] = [
      ['heavyknight', 0.35], ['catapult', 0.35], ['horserider', 0.5],
      ['spearsman', 0.6], ['archer', 1], ['warrior', 1],
    ];
    for (const [t, maxShare] of prefs) {
      if (!unlocked.has(t) || aura < UNIT_COSTS[t]) continue;
      if (count(t) > Math.ceil(army * maxShare)) continue;
      return t;
    }
    if (unlocked.has('warrior') && aura >= UNIT_COSTS.warrior) return 'warrior';
    return null;
  }

  // Normal AI: cheap, simple mix.
  if (unlocked.has('horserider') && aura >= UNIT_COSTS.horserider && Math.random() < 0.3) return 'horserider';
  if (unlocked.has('archer') && aura >= UNIT_COSTS.archer && Math.random() < 0.5) return 'archer';
  if (unlocked.has('warrior') && aura >= UNIT_COSTS.warrior) return 'warrior';
  if (unlocked.has('archer') && aura >= UNIT_COSTS.archer) return 'archer';
  return null;
}

function spawnPass(state: GameState, aiPlayerId: number, hard: boolean, actions: AIAction[]): void {
  const player = state.players[aiPlayerId]!;
  for (const temple of state.temples.filter(t => t.ownerId === aiPlayerId)) {
    if (getUnitAt(state, temple.pos)) continue; // occupied — can't spawn (throttles multi-spawn)
    if (getPopulationCount(state, aiPlayerId) >= getPopulationCap(state, aiPlayerId)) break;
    const unlocked = getUnlockedUnits(state.playerTech[aiPlayerId]!);
    const type = chooseSpawnType(state, aiPlayerId, unlocked, player.aura, hard);
    if (!type) continue;
    if (spawnUnit(state, temple.id, type)) {
      actions.push({ type: 'spawn', pos: { ...temple.pos }, description: `${hard ? 'Hard ' : ''}AI recruits ${type} at (${temple.pos.q},${temple.pos.r})` });
    }
  }
}

// ── Turn driver ──

function runTurn(state: GameState, aiPlayerId: number, hard: boolean): AIAction[] {
  const actions: AIAction[] = [];
  const player = state.players.find(p => p.id === aiPlayerId);
  if (!player || state.phase !== 'playing' || getCurrentPlayer(state).id !== aiPlayerId) return actions;

  const aiTemples = state.temples.filter(t => t.ownerId === aiPlayerId);
  const homeTemple =
    (player.startTempleId ? aiTemples.find(t => t.id === player.startTempleId) : undefined) ?? aiTemples[0];

  // 1. Economy (spend aura — never float it).
  if (hard) {
    doResearch(state, aiPlayerId, actions);
    doUpgrades(state, aiPlayerId, homeTemple?.id, actions);
    doTeleport(state, aiPlayerId, actions);
  } else if (homeTemple && homeTemple.level < 3) {
    // Normal AI: only nudges its home temple up when it has clear surplus.
    const cost = templeUpgradeCost(homeTemple.level);
    if (cost !== null && player.aura >= cost + 3 && Math.random() < 0.5) {
      if (upgradeTemple(state, homeTemple.id)) {
        actions.push({ type: 'upgrade', pos: { ...homeTemple.pos }, description: `AI upgrades home temple to L${homeTemple.level}` });
      }
    }
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

export function runHardAITurn(state: GameState, aiPlayerId: number = getCurrentPlayer(state).id): AIAction[] {
  return runTurn(state, aiPlayerId, true);
}
