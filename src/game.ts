import {
  GameState, Unit, UnitStats, UnitType, Player, HexCoord,
  StrategicSite, StrategicSiteState, FoundingProgress, Capital, Farm, Road, TrainingOrder,
  UNIT_COSTS, HILL_DEFENSE_BONUS, HILL_VISION_BONUS, HILL_RANGE_BONUS,
  SUPPORT_RANGE, RANGE_BOOST_RADIUS,
  TechId, TechNode, TECH_NODES, PlayerTech,
  TeleportBuilding, TELEPORT_BUILD_COST, TELEPORT_RADIUS, TELEPORT_MAX_PER_TEMPLE,
  PLAYER_COLORS, mapRadiusForPlayers, neutralSiteCountForPlayers,
  FactionId,
} from './types';
import {
  hexDistance, hexEqual, hexNeighbors, getReachableHexes,
  hexKey, generateHexMap, DIRECTIONS, OPPOSING_PAIRS, hexLineDraw,
} from './hex';
import { calculateDamage, getTypeMultiplier, UnitClass } from './combat';
import {
  FACTION_UNITS, FactionUnitDef, EARLY_UNLOCKED_SLOTS, STRUCTURES, SITE_ESTABLISH_COST,
  BASE_INCOME_PER_ROUND, STARTING_ENERGY,
  AGRAR_FARM_COST, AGRAR_FARM_INCOME, MAX_ACTIVE_FARMS, AGRAR_TERRITORY_RADIUS, CULTIVATION_RADIUS, FARM_MIN_SPACING,
  TEMPLE_UPGRADE_COST, TEMPLE_LEVEL_INCOME, TEMPLE_II_PRODUCTION_BONUS,
  COMMAND_TIERS, PRODUCTION_BASE_SLOTS, PRODUCTION_MAX_SLOTS, UNIT_TRAINING_ROUNDS,
  ROAD_COST_PER_HEX, ROAD_MOVEMENT_BONUS, ROAD_PILLAGE_REBUILD_COST,
} from './factions';

// Maps the current universal unit roster onto the shared soft-counter classes
// (see ./combat.ts). The faction-specific v0.2 roster will assign its own
// classes directly; this table exists so the single legacy roster keeps
// working under the same rules engine in the meantime.
export const UNIT_CLASS: Record<UnitType, UnitClass> = {
  warrior:       'warrior',
  archer:        'archer',
  catapult:      'siege',
  horserider:    'cavalry',
  heavyknight:   'heavy',
  spearsman:     'pike',
  healer:        'support',
  damageBooster: 'support',
  rangeBooster:  'support',
  founder:       'support',
};

export function getUnitTypeMultiplier(attackerType: UnitType, defenderType: UnitType): number {
  return getTypeMultiplier(UNIT_CLASS[attackerType], UNIT_CLASS[defenderType]);
}

// ── Unit stats ──

const WARRIOR_STATS: UnitStats = {
  maxHp: 15, attack: 10, defense: 5, speed: 1,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 2, cantShootAfterMove: false,
};

const ARCHER_STATS: UnitStats = {
  maxHp: 15, attack: 10, defense: 3, speed: 2,
  range: 2, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 2, cantShootAfterMove: false,
};

const CATAPULT_STATS: UnitStats = {
  // Balance v2 (2026-05-17): maxHp 10→16 — catapults died before firing under
  // pressure; the entire `unlock_catapult` tech branch had a 0% win share in
  // tournament v2. Restoring viability for splash strategies.
  maxHp: 16, attack: 14, defense: 1, speed: 1,
  range: 3, splash: 0, splashFactor: 0, canBeRevenged: false, vision: 4, cantShootAfterMove: false,
};

const HORSERIDER_STATS: UnitStats = {
  maxHp: 15, attack: 16, defense: 2, speed: 2,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 3, cantShootAfterMove: false,
};

const HEAVYKNIGHT_STATS: UnitStats = {
  maxHp: 22, attack: 20, defense: 8, speed: 3,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 2, cantShootAfterMove: false,
};

const SPEARSMAN_STATS: UnitStats = {
  // Balance v3 (2026-08-21): the old per-unit 3x/4x attack + 2x/2.5x defense
  // bonuses made the spearsman a near hard-counter. Replaced by the shared
  // soft-counter matrix in combat.ts (pike class gets a flat 1.35x attacking
  // cavalry/heavy, no defense-side multiplier at all) — a strong answer at
  // equal cost, not an auto-win.
  maxHp: 15, attack: 10, defense: 5, speed: 2,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 2, cantShootAfterMove: false,
};

const HEALER_STATS: UnitStats = {
  // Balance v2 (2026-05-17): maxHp 12→18. The 5HP/turn aura needs the healer to
  // survive past one focus-fire round to pay back; 12HP died in 1-2 hits.
  maxHp: 18, attack: 4, defense: 2, speed: 2,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 3, cantShootAfterMove: false,
};

const DAMAGE_BOOSTER_STATS: UnitStats = {
  maxHp: 12, attack: 4, defense: 2, speed: 2,
  range: 0, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 3, cantShootAfterMove: false,
};

const RANGE_BOOSTER_STATS: UnitStats = {
  maxHp: 12, attack: 4, defense: 2, speed: 2,
  range: 0, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 3, cantShootAfterMove: false,
};

// The Builder/Acolyte base stats — generic pre-reveal fallback only. Once a
// faction is known, applyFactionToStats overrides these from AGRAR_UNITS/
// TEMPLE_UNITS like any other slot (Agrar's Builder is deliberately slower —
// see the "way less movement, bunker down" correction). An ordinary
// recruitable unit like any other, not a special starting-only one.
const FOUNDER_STATS: UnitStats = {
  maxHp: 12, attack: 5, defense: 3, speed: 2,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 3, cantShootAfterMove: false,
};

// §27 (phase 11 correction): +2 at distance 1, +1 at distance 2 (via
// supportFalloffAmount's built-in half-at-range-2 falloff) — the old flat +5
// was far too strong. Same-type support effects never STACK (two Healers
// near the same ally don't add up) — see getSupportBoostsForUnit and the
// healer heal-application loop in endTurn, both of which take the max
// contribution across allies of the same support type, not a sum.
export const HEALER_HEAL_AMOUNT = 2;
export const DAMAGE_BOOST_AMOUNT = 2;
export const RANGE_BOOST_AMOUNT = 1;

export const UNIT_STATS: Record<UnitType, UnitStats> = {
  warrior:      WARRIOR_STATS,
  archer:       ARCHER_STATS,
  catapult:     CATAPULT_STATS,
  horserider:   HORSERIDER_STATS,
  heavyknight:  HEAVYKNIGHT_STATS,
  spearsman:    SPEARSMAN_STATS,
  healer:       HEALER_STATS,
  damageBooster: DAMAGE_BOOSTER_STATS,
  rangeBooster:  RANGE_BOOSTER_STATS,
  founder:       FOUNDER_STATS,
};

// ── Tech helpers ──

// Fallback set for when no faction is known yet (phase 11: before both
// players reveal, right at the start of the match — recruiting itself is
// blocked then by isMatchSetupRestricted, so this only matters for tooling
// that calls getUnlockedUnits pre-reveal).
export const DEFAULT_UNLOCKED_UNITS: UnitType[] = ['warrior', 'archer', 'horserider'];

// §39 — once a player's faction is known, their early-unlock set (see
// EARLY_UNLOCKED_SLOTS) replaces the generic default; tech then adds more.
export function getUnlockedUnits(tech: PlayerTech, faction?: FactionId | null): Set<UnitType> {
  const base = faction ? EARLY_UNLOCKED_SLOTS[faction] : DEFAULT_UNLOCKED_UNITS;
  const unlocked = new Set<UnitType>(base);
  for (const node of TECH_NODES) {
    if (node.unitUnlock && tech.researched.has(node.id)) {
      unlocked.add(node.unitUnlock);
    }
  }
  return unlocked;
}

/**
 * Shallow-copy a base UnitStats so the copy never shares object identity with
 * the shared UNIT_STATS singletons. Used by both `createUnit` and
 * `rebuildUnitStats` so the two paths produce identical, independent stat
 * objects.
 */
function cloneStats(base: UnitStats): UnitStats {
  return { ...base };
}

function applyTechToStats(stats: UnitStats, type: UnitType, tech: PlayerTech): UnitStats {
  const r = tech.researched;
  // §17 (balance pass) — Infantry March removed: it undermined the Roads/
  // native-speed faction identity too directly. Fortified Ranged reduced
  // from +5 to +3 max HP — +5 was too large relative to 12-16 base HP values.
  if (r.has('longrange_hp') && (type === 'archer' || type === 'catapult')) stats.maxHp += 3;
  if ((r.has('agrar_siegecraft_splash') || r.has('temple_mobile_siege_splash')) && type === 'catapult') { stats.splash = 1; stats.splashFactor = 0.4; }
  if (r.has('horse_sight') && (type === 'horserider' || type === 'heavyknight')) stats.vision += 1;
  return stats;
}

// Look up a faction's flavor of a given universal-roster "slot" (§37/§38 —
// e.g. slot 'spearsman' -> Agrar's Pikeman or Temple's Spearsman).
function factionUnitDef(faction: FactionId, type: UnitType): FactionUnitDef | undefined {
  return FACTION_UNITS[faction].find(u => u.slot === type);
}

// Overwrite a unit's combat stats with its faction's flavor of the same base
// slot (§37/§38). Founder deliberately excluded — Builder/Acolyte are
// mechanically identical between factions, display-name-only (§4-6, see
// unitDisplayName) even though phase 11 makes both ordinarily recruitable.
// No-op for any other type without a faction-specific entry.
function applyFactionToStats(stats: UnitStats, type: UnitType, faction: FactionId | null | undefined): UnitStats {
  if (!faction) return stats;
  const def = factionUnitDef(faction, type);
  if (!def) return stats;
  stats.maxHp = def.hp;
  stats.attack = def.attack;
  stats.defense = def.defense;
  stats.speed = def.speed;
  stats.range = def.range;
  stats.vision = def.vision;
  return stats;
}

// Faction-flavored recruit cost (§37/§38 — e.g. Agrar's Knight costs more
// than Temple's Raider). Falls back to the universal UNIT_COSTS baseline for
// founder (identical cost either faction anyway) or when no faction is known yet.
export function getUnitCost(type: UnitType, faction: FactionId | null | undefined): number {
  if (faction && type !== 'founder') {
    const def = factionUnitDef(faction, type);
    if (def) return def.cost;
  }
  return UNIT_COSTS[type];
}

// Faction-flavored display name for a recruitable unit slot (e.g. 'spearsman'
// -> "Pikeman" for Agrar, "Spearsman" for Temple). Falls back to the generic
// engine name pre-reveal. Founder has its own dedicated helper (see
// founderDisplayName) purely for the name lookup — used throughout the UI.
export function unitDisplayName(type: UnitType, faction: FactionId | null | undefined): string {
  if (faction) {
    const def = factionUnitDef(faction, type);
    if (def) return def.displayName;
  }
  return GENERIC_UNIT_NAMES[type];
}

const GENERIC_UNIT_NAMES: Record<UnitType, string> = {
  warrior: 'Warrior', archer: 'Archer', catapult: 'Catapult', horserider: 'Horserider',
  heavyknight: 'Heavy Knight', spearsman: 'Spearsman', healer: 'Healer',
  damageBooster: 'Damage Booster', rangeBooster: 'Range Booster', founder: 'Founder',
};

/**
 * Rebuild a living unit's stats from base + currently-researched tech +
 * (if revealed) its owner's faction flavor. Used by `researchTech()` to
 * retroactively apply tech effects to units that were spawned before the
 * tech was researched.
 *
 * Idempotent — always starts from `UNIT_STATS[unit.type]`, so calling multiple
 * times never double-applies. Preserves current HP (and clamps it to the new
 * maxHp if max ever shrinks — currently nothing shrinks, but the guard makes
 * future tech changes safe).
 */
function rebuildUnitStats(unit: Unit, tech: PlayerTech, faction?: FactionId | null): void {
  const fresh = cloneStats(UNIT_STATS[unit.type]);
  applyTechToStats(fresh, unit.type, tech);
  applyFactionToStats(fresh, unit.type, faction);
  unit.stats = fresh;
  if (unit.hp > fresh.maxHp) unit.hp = fresh.maxHp;
}

// ── Factories ──

let unitIdCounter = 0;
let siteIdCounter = 0;
let farmIdCounter = 0;

// Called by server after deserializing saved state to prevent ID collisions
export function resetCounters(unitMax: number, siteMax: number, tpMax: number, farmMax = 0): void {
  unitIdCounter = unitMax;
  siteIdCounter = siteMax;
  teleportIdCounter = tpMax;
  farmIdCounter = farmMax;
}

// Additive: snapshot the global ID counters. Used only by the ML fidelity test
// (ml/bcRecord.ts) to replay a turn producing the SAME unit/site/teleport/farm
// ids as the original. No behavior change; nothing in the game paths reads this.
export function getCounters(): [number, number, number, number] {
  return [unitIdCounter, siteIdCounter, teleportIdCounter, farmIdCounter];
}

// Exported for test scripts (scripts/verify-*.ts) that need to place a unit
// directly for setup convenience, bypassing the real recruit-then-wait
// training-queue flow (spawnUnit/resolveTrainingForPlayer) that live play
// always goes through.
export function createUnit(type: UnitType, playerId: number, pos: HexCoord, tech?: PlayerTech, faction?: FactionId | null): Unit {
  const stats = cloneStats(UNIT_STATS[type]);
  if (tech) applyTechToStats(stats, type, tech);
  applyFactionToStats(stats, type, faction);
  return {
    id: `unit_${unitIdCounter++}`,
    type, playerId,
    stats,
    hp: stats.maxHp,
    pos: { ...pos },
    hasMoved: false,
    hasAttacked: false,
  };
}

// A freshly-placed strategic site is always neutral — nobody owns it and no
// founding is in progress (§7-9). Combat stats are 0 until it's actually
// founded into a City/Temple (see completeFounding / isAttackableStructure).
function createStrategicSite(pos: HexCoord): StrategicSite {
  return {
    id: `site_${siteIdCounter++}`,
    pos: { ...pos },
    state: 'neutral',
    ownerId: null,
    founding: null,
    upgrade: null,
    hp: 0, maxHp: 0, defense: 0,
    templeLevel: null,
  };
}

// One Capital per player, permanent ownership, deterministic id (never
// recreated/rebuilt, so no shared counter needed — see §11).
function createCapital(playerId: number, pos: HexCoord): Capital {
  return {
    id: `capital_${playerId}`,
    playerId,
    pos: { ...pos },
    hp: STRUCTURES.capital.hp,
    maxHp: STRUCTURES.capital.hp,
    defense: STRUCTURES.capital.defense,
  };
}

// ── Player config ──

export interface PlayerConfig {
  name: string;
  color: string;
}

const DEFAULT_PLAYERS: PlayerConfig[] = [
  { name: 'Player 1', color: '#ff4444' },
  { name: 'AI', color: '#44cc55' },
];

// ── Visibility ──

function hasLineOfSight(from: HexCoord, to: HexCoord, forests: Set<string>, hills: Set<string>): boolean {
  const dist = hexDistance(from, to);
  if (dist <= 1) return true;

  if (forests.has(hexKey(from))) return false;

  const observerOnHill = hills.has(hexKey(from));

  const line = hexLineDraw(from, to);
  for (let i = 1; i < line.length - 1; i++) {
    const key = hexKey(line[i]!);
    if (forests.has(key)) return false;
    if (hills.has(key) && !observerOnHill) return false;
  }
  return true;
}

export function getVisibleHexes(pos: HexCoord, visionRange: number, mapRadius: number, forests?: Set<string>, hills?: Set<string>): HexCoord[] {
  const result: HexCoord[] = [];
  let effectiveRange = visionRange;
  if (forests && forests.has(hexKey(pos))) {
    effectiveRange = 1;
  } else if (hills && hills.has(hexKey(pos))) {
    effectiveRange = visionRange + HILL_VISION_BONUS;
  }
  for (let dq = -effectiveRange; dq <= effectiveRange; dq++) {
    for (let dr = Math.max(-effectiveRange, -dq - effectiveRange); dr <= Math.min(effectiveRange, -dq + effectiveRange); dr++) {
      const hex: HexCoord = { q: pos.q + dq, r: pos.r + dr };
      if (hexDistance({ q: 0, r: 0 }, hex) <= mapRadius) {
        if (!forests || hasLineOfSight(pos, hex, forests, hills || new Set())) {
          result.push(hex);
        }
      }
    }
  }
  return result;
}

function revealForPlayer(state: GameState, playerId: number, pos: HexCoord, visionRange: number): void {
  const visible = getVisibleHexes(pos, visionRange, state.mapRadius, state.forests, state.hills);
  for (const hex of visible) {
    state.explored[playerId]!.add(hexKey(hex));
  }
}

// Capital + owned active (Temple I or II, including mid-upgrade) strategic
// sites — the "owned structures" a player gets vision/recruiting/income
// from. Neutral, ruined or still-founding sites are NOT included (§10 — a
// founding site provides nothing until it completes). An upgrading Temple
// stays a valid recruiting location — v11 §10, it's physically present and
// operating at its Temple I level throughout the upgrade.
export function getOwnedStructures(state: GameState, playerId: number): { id: string; pos: HexCoord }[] {
  const out: { id: string; pos: HexCoord }[] = [];
  const capital = state.capitals.find(c => c.playerId === playerId);
  if (capital) out.push(capital);
  for (const site of state.strategicSites) {
    if ((site.state === 'temple' || site.state === 'upgradingTemple') && site.ownerId === playerId) out.push(site);
  }
  return out;
}

export function getPlayerCapital(state: GameState, playerId: number): Capital | undefined {
  return state.capitals.find(c => c.playerId === playerId);
}

export function updateVisibility(state: GameState, playerId: number): void {
  const units = state.units.filter(u => u.hp > 0 && u.playerId === playerId);
  for (const unit of units) {
    revealForPlayer(state, playerId, unit.pos, unit.stats.vision);
  }
  for (const structure of getOwnedStructures(state, playerId)) {
    revealForPlayer(state, playerId, structure.pos, 2);
  }
}

export function isForestUnitRevealed(state: GameState, unitPos: HexCoord, observerPlayerId: number): boolean {
  if (!state.forests.has(hexKey(unitPos))) return true;

  const friendlies = state.units.filter(u => u.hp > 0 && u.playerId === observerPlayerId);
  for (const f of friendlies) {
    if (hexDistance(f.pos, unitPos) <= 1) return true;
  }
  for (const structure of getOwnedStructures(state, observerPlayerId)) {
    if (hexDistance(structure.pos, unitPos) <= 1) return true;
  }
  return false;
}

export function getPlayerVisible(state: GameState, playerId: number): Set<string> {
  const visible = new Set<string>();
  const units = state.units.filter(u => u.hp > 0 && u.playerId === playerId);
  for (const unit of units) {
    for (const hex of getVisibleHexes(unit.pos, unit.stats.vision, state.mapRadius, state.forests, state.hills)) {
      visible.add(hexKey(hex));
    }
  }
  for (const structure of getOwnedStructures(state, playerId)) {
    for (const hex of getVisibleHexes(structure.pos, 2, state.mapRadius, state.forests, state.hills)) {
      visible.add(hexKey(hex));
    }
  }
  return visible;
}

export function getCurrentPlayerVisible(state: GameState): Set<string> {
  return getPlayerVisible(state, getCurrentPlayer(state).id);
}

// ── Terrain generation ──

function generateTerrain(mapRadius: number, templePositions: HexCoord[], unitPositions: HexCoord[]): { hills: Set<string>; walls: Set<string>; forests: Set<string> } {
  const hills = new Set<string>();
  const walls = new Set<string>();
  const forests = new Set<string>();
  const allHexes = generateHexMap(mapRadius);
  const allKeys = new Set(allHexes.map(h => hexKey(h)));
  const reserved = new Set([
    ...templePositions.map(p => hexKey(p)),
    ...unitPositions.map(p => hexKey(p)),
  ]);
  const reservedBuffer = new Set(reserved);
  for (const pos of [...templePositions, ...unitPositions]) {
    for (const n of hexNeighbors(pos)) {
      reservedBuffer.add(hexKey(n));
    }
  }

  const used = new Set<string>();

  function growCluster(seed: HexCoord, target: Set<string>, maxSize: number, growProb: number): void {
    const queue: HexCoord[] = [seed];
    let placed = 0;
    while (queue.length > 0 && placed < maxSize) {
      const idx = Math.floor(Math.random() * queue.length);
      const hex = queue.splice(idx, 1)[0]!;
      const key = hexKey(hex);
      if (used.has(key) || reserved.has(key) || !allKeys.has(key)) continue;
      target.add(key);
      used.add(key);
      placed++;
      for (const n of hexNeighbors(hex)) {
        const nk = hexKey(n);
        if (!used.has(nk) && !reserved.has(nk) && allKeys.has(nk) && Math.random() < growProb) {
          queue.push(n);
        }
      }
    }
  }

  const wallSeeds = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < wallSeeds; i++) {
    const seed = allHexes[Math.floor(Math.random() * allHexes.length)]!;
    if (reservedBuffer.has(hexKey(seed))) continue;
    growCluster(seed, walls, 3 + Math.floor(Math.random() * 4), 0.55);
  }

  const hillSeeds = 4 + Math.floor(Math.random() * 4);
  for (let i = 0; i < hillSeeds; i++) {
    const seed = allHexes[Math.floor(Math.random() * allHexes.length)]!;
    if (reservedBuffer.has(hexKey(seed)) || used.has(hexKey(seed))) continue;
    growCluster(seed, hills, 3 + Math.floor(Math.random() * 5), 0.6);
  }

  for (const wk of walls) {
    const [q, r] = wk.split(',').map(Number);
    for (const n of hexNeighbors({ q: q!, r: r! })) {
      const nk = hexKey(n);
      if (!used.has(nk) && !reserved.has(nk) && allKeys.has(nk) && Math.random() < 0.35) {
        hills.add(nk);
        used.add(nk);
      }
    }
  }

  const forestSeeds = 5 + Math.floor(Math.random() * 4);
  for (let i = 0; i < forestSeeds; i++) {
    const seed = allHexes[Math.floor(Math.random() * allHexes.length)]!;
    const sk = hexKey(seed);
    if (reserved.has(sk) || walls.has(sk) || hills.has(sk) || forests.has(sk)) continue;
    const queue: HexCoord[] = [seed];
    const maxSize = 3 + Math.floor(Math.random() * 5);
    let placed = 0;
    while (queue.length > 0 && placed < maxSize) {
      const idx = Math.floor(Math.random() * queue.length);
      const hex = queue.splice(idx, 1)[0]!;
      const key = hexKey(hex);
      if (reserved.has(key) || walls.has(key) || hills.has(key) || forests.has(key) || !allKeys.has(key)) continue;
      forests.add(key);
      placed++;
      for (const n of hexNeighbors(hex)) {
        const nk = hexKey(n);
        if (!reserved.has(nk) && !walls.has(nk) && !hills.has(nk) && !forests.has(nk) && allKeys.has(nk) && Math.random() < 0.6) {
          queue.push(n);
        }
      }
    }
  }

  return { hills, walls, forests };
}

// ── Support boosts ──

// Support falloff for the damage booster and healer: full strength within
// radius 1 (dist ≤ 1), half strength at radius 2 (dist === 2), nothing beyond.
// The half value is rounded to the nearest integer (Math.round), so a base of 5
// yields 3 at radius 2.
export function supportFalloffAmount(base: number, dist: number): number {
  if (dist <= 1) return base;
  if (dist === 2) return Math.round(base / 2);
  return 0;
}

// §27 — same-type support effects never stack: two Drummers/Chanters near
// the same unit don't add up to +4, they just extend coverage. Each support
// type's contribution is the BEST single nearby booster, not a sum.
export function getSupportBoostsForUnit(state: GameState, unit: Unit): { damageBonus: number; rangeBonus: number } {
  let damageBonus = 0;
  let rangeBonus = 0;
  for (const ally of state.units) {
    if (ally.hp <= 0 || ally.playerId !== unit.playerId || ally.id === unit.id) continue;
    const dist = hexDistance(ally.pos, unit.pos);
    if (ally.type === 'damageBooster') {
      damageBonus = Math.max(damageBonus, supportFalloffAmount(DAMAGE_BOOST_AMOUNT, dist));
    } else if (ally.type === 'rangeBooster') {
      // Range boost is binary within a tight radius — a fractional range bonus
      // makes no sense, so no falloff: full +RANGE within RANGE_BOOST_RADIUS.
      if (dist <= RANGE_BOOST_RADIUS) rangeBonus = Math.max(rangeBonus, RANGE_BOOST_AMOUNT);
    }
  }
  return { damageBonus, rangeBonus };
}

// ── Effective stats (with hill + support bonuses) ──

// §9 (balance pass) — Agrar Territory is deliberately NOT a combat bonus.
// Agrar's edge is structural (higher HP/DEF baselines, Roads, ZOC formations,
// Farms, area denial) — a flat +DEF aura on top of that would be a huge,
// invisible swing (DEF is subtractive: ATK10 vs DEF5 = 5 dmg, vs DEF7 = 3 dmg,
// a ~40% cut) stacked on units that are already tankier by design.
export function getEffectiveDefense(state: GameState, unit: Unit): number {
  const onHill = state.hills.has(hexKey(unit.pos));
  return unit.stats.defense + (onHill ? HILL_DEFENSE_BONUS : 0);
}

export function getEffectiveAttack(state: GameState, unit: Unit): number {
  const { damageBonus } = getSupportBoostsForUnit(state, unit);
  return unit.stats.attack + damageBonus;
}

export function getEffectiveRange(state: GameState, unit: Unit): number {
  // Booster units can only move/support — never attack. Range is always zero,
  // ignoring hill/range boosts.
  if (unit.type === 'damageBooster' || unit.type === 'rangeBooster') return 0;
  const onHill = state.hills.has(hexKey(unit.pos));
  const hillBonus = (onHill && unit.stats.range > 1) ? HILL_RANGE_BONUS : 0;
  const { rangeBonus } = getSupportBoostsForUnit(state, unit);
  return unit.stats.range + hillBonus + rangeBonus;
}

// §25 (phase 11 correction) — a road grants its movement bonus to Agrar
// units ONLY. Temple units treat an Agrar road as normal terrain — Agrar's
// physical infrastructure is a faction-locked mechanic, not a map-wide buff.
export function getEffectiveSpeed(state: GameState, unit: Unit): number {
  const player = state.players.find(p => p.id === unit.playerId);
  if (player?.faction !== 'agrar') return unit.stats.speed;
  const onRoad = state.roads.some(r => hexEqual(r.pos, unit.pos));
  return unit.stats.speed + (onRoad ? ROAD_MOVEMENT_BONUS : 0);
}

// ── Zone of Control (§26) ──
//
// Line-fighting unit classes project a ZOC onto their 6 adjacent hexes;
// archers/siege/support/Builder-Acolyte don't (they're not a physical
// blocking presence). Shared across both factions — it's keyed purely by
// combat class (UNIT_CLASS), not faction, since every faction's flavor of a
// given slot has the identical projectsZOC flag (verified in factions.ts).
const ZOC_CLASSES: ReadonlySet<UnitClass> = new Set(['warrior', 'pike', 'cavalry', 'heavy']);

export function unitProjectsZoc(unit: Unit): boolean {
  return ZOC_CLASSES.has(UNIT_CLASS[unit.type]);
}

// The set of hexes (from forPlayerId's perspective) currently under enemy
// ZOC — adjacent to a VISIBLE enemy ZOC-projecting unit (fogged/hidden-in-
// forest enemies don't project a ZOC the opponent can react to). Entering
// one of these hexes ends a unit's movement for the turn — see
// getReachableHexes in hex.ts.
export function getZocHexes(state: GameState, forPlayerId: number): Set<string> {
  const zoc = new Set<string>();
  const visible = getPlayerVisible(state, forPlayerId);
  for (const enemy of state.units) {
    if (enemy.hp <= 0 || enemy.playerId === forPlayerId) continue;
    if (!unitProjectsZoc(enemy)) continue;
    if (!visible.has(hexKey(enemy.pos))) continue;
    if (!isForestUnitRevealed(state, enemy.pos, forPlayerId)) continue;
    for (const n of hexNeighbors(enemy.pos)) {
      if (hexDistance({ q: 0, r: 0 }, n) > state.mapRadius) continue;
      zoc.add(hexKey(n));
    }
  }
  return zoc;
}

// ── Command system (§19-22) ──
//
// The population cap is raised ONLY by Command I/II tech, never by
// territory (§21) — 8/10/12, linear, Command II requires Command I.
export function getPopulationCap(state: GameState, playerId: number): number {
  const tech = state.playerTech[playerId];
  if (!tech) return COMMAND_TIERS.start;
  if (tech.researched.has('command_2')) return COMMAND_TIERS.commandII;
  if (tech.researched.has('command_1')) return COMMAND_TIERS.commandI;
  return COMMAND_TIERS.start;
}

// Population is spent by COMMAND COST, not a flat 1-per-unit — heavier units
// (cavalry/heavy) cost more of the cap than light ones (§19). Founder/
// pre-reveal units (no faction-specific def yet) fall back to 1.
function getUnitCommandCost(type: UnitType, faction: FactionId | null | undefined): number {
  if (faction && type !== 'founder') {
    const def = FACTION_UNITS[faction].find(u => u.slot === type);
    if (def) return def.commandCost;
  }
  return 1;
}

// Counts both deployed units AND units still in the training queue (§5) —
// otherwise a player could queue arbitrarily many recruits past their pop
// cap in one turn and have them all land over-cap once deployed.
export function getPopulationCount(state: GameState, playerId: number): number {
  const faction = state.players.find(p => p.id === playerId)?.faction;
  let count = 0;
  for (const u of state.units) {
    if (u.hp <= 0 || u.playerId !== playerId) continue;
    count += getUnitCommandCost(u.type, faction);
  }
  for (const order of state.trainingQueue) {
    if (order.playerId !== playerId) continue;
    count += getUnitCommandCost(order.unitType, faction);
  }
  return count;
}

// §16-20 (phase 10 correction; v11 Temple conquest/upgrade system) —
// production is centralized for Agrar (scales with active Farm count, all
// training still happens at the Capital — Roads move the result) and
// distributed for Temple (scales with FULLY-developed — i.e. Temple II —
// owned-Temple count; a merely founded Temple I grants no extra slot,
// matching the macro-investment-equality invariant with Agrar's
// 2-Farms-for-+1 curve). Both start at PRODUCTION_BASE_SLOTS and cap at
// PRODUCTION_MAX_SLOTS — the two curves reach the same ceiling by different
// map structures, matching the area-vs-points asymmetry. A recruit occupies
// one of the recruiting player's slots for the full training duration (§5)
// — the unit itself does NOT exist on the battlefield until it deploys at
// the start of the player's next round.
export function getProductionSlots(state: GameState, playerId: number): number {
  const player = state.players.find(p => p.id === playerId);
  if (player?.faction === 'agrar') {
    const farms = activeFarmsOf(state, playerId).length;
    let slots = PRODUCTION_BASE_SLOTS;
    if (farms >= 2) slots++;
    if (farms >= 4) slots++;
    return Math.min(slots, PRODUCTION_MAX_SLOTS);
  }
  if (player?.faction === 'temple') {
    const developedTemples = state.strategicSites.filter(s =>
      s.ownerId === playerId && s.state === 'temple' && s.templeLevel === 2).length;
    return Math.min(PRODUCTION_BASE_SLOTS + developedTemples * TEMPLE_II_PRODUCTION_BONUS, PRODUCTION_MAX_SLOTS);
  }
  return PRODUCTION_BASE_SLOTS;
}

// A slot is busy for exactly as long as its TrainingOrder is still queued —
// from the instant it's queued until the unit actually deploys (§5). See
// resolveTrainingForPlayer for deployment.
export function getBusyProductionSlotCount(state: GameState, playerId: number): number {
  return state.trainingQueue.filter(o => o.playerId === playerId).length;
}

// §5 — called once per player, right when it becomes their turn (mirrors
// resolveFoundingForPlayer). Every due TrainingOrder (readyAtRound reached)
// attempts to deploy: if the target structure's tile is free, the real Unit
// is created there and the order clears (freeing its slot); if the tile is
// still occupied, the order just keeps waiting — NOTHING is destroyed or
// refunded, deployment is simply deterministic and patient (§5, §14).
function resolveTrainingForPlayer(state: GameState, playerId: number): void {
  const tech = state.playerTech[playerId]!;
  const player = state.players.find(p => p.id === playerId)!;
  const stillWaiting: TrainingOrder[] = [];
  for (const order of state.trainingQueue) {
    if (order.playerId !== playerId) continue;
    if (state.turnNumber < order.readyAtRound) { stillWaiting.push(order); continue; }

    const structure = getOwnedStructures(state, playerId).find(s => s.id === order.structureId);
    if (!structure || getUnitAt(state, structure.pos)) { stillWaiting.push(order); continue; }

    const unit = createUnit(order.unitType, playerId, structure.pos, tech, player.faction);
    unit.hasMoved = false;
    unit.hasAttacked = false;
    state.units.push(unit);
  }
  state.trainingQueue = [
    ...state.trainingQueue.filter(o => o.playerId !== playerId),
    ...stillWaiting,
  ];
}

// ── Economy (§4-19, phase 10 correction; v11 Temple conquest/upgrade) ──
//
// Base income is flat and unconditional (always BASE_INCOME_PER_ROUND per
// player, regardless of structures owned). On top of that: Agrar's active
// Farms each contribute AGRAR_FARM_INCOME (§6-9); Temple's owned sites
// contribute TEMPLE_LEVEL_INCOME[templeLevel] — +1 for Temple I, +2 TOTAL
// (not +1 on top) for Temple II. A site mid-upgrade ('upgradingTemple')
// still counts at its current templeLevel (1) — the Temple II bonus only
// applies once the upgrade actually resolves. A founding/neutral/ruined
// site or a still-founding Farm contributes nothing.
export function getPlayerIncome(state: GameState, playerId: number): number {
  let income = BASE_INCOME_PER_ROUND;
  income += activeFarmsOf(state, playerId).length * AGRAR_FARM_INCOME;
  for (const site of state.strategicSites) {
    if (site.ownerId !== playerId) continue;
    if (site.state !== 'temple' && site.state !== 'upgradingTemple') continue;
    if (site.templeLevel) income += TEMPLE_LEVEL_INCOME[site.templeLevel];
  }
  return income;
}

// ── Temple placement (change #5 + spread hardening) ──

// Minimum hex distance allowed between ANY two temples. hexDistance 3 means at
// least TWO empty tiles separate any two temples (dist 1 = adjacent, dist 2 =
// exactly one empty tile between). This is the single tunable knob for temple
// spacing — Max asked for "at least 2 tiles between temples", read as two empty
// tiles = hexDistance 3. Beyond this hard floor the placer actively MAXIMIZES
// spread (Mitchell's best-candidate per temple + keep the most spread-out of
// several full layouts), so temples fan out across the map instead of hugging
// the floor. Placement always backs off / falls back gracefully — it never hangs
// or crashes, even if the map is too small to honour the floor.
export const MIN_TEMPLE_SEPARATION = 3;

// Mitchell's best-candidate: how many random eligible tiles to sample when
// placing each temple. The candidate that maximizes the minimum distance to the
// already-placed temples wins, so temples push apart. Higher = tighter/more even
// spread; lower = more layout variety between games.
const TEMPLE_SPREAD_CANDIDATES = 18;

// Build this many complete layouts and keep the one with the largest minimum
// pairwise temple distance — a second maximize-min-distance pass on top of the
// per-temple best-candidate sampling.
const TEMPLE_LAYOUT_ATTEMPTS = 16;

// §3 — map generation still reserves this many free tiles near each Capital
// (kept clear of terrain/sites) even though no units are actually placed on
// them at game start any more — early recruits need somewhere to deploy.
const STARTING_UNITS_PER_PLAYER = 3;

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!; arr[i] = arr[j]!; arr[j] = tmp;
  }
  return arr;
}

interface SiteLayout {
  starts: HexCoord[];            // one Capital position per player (index === player id)
  neutrals: HexCoord[];          // neutral strategic site positions
  unitPositions: HexCoord[][];   // per-player starting-unit positions
}

// Randomly place N Capitals + M neutral strategic sites so that:
//  • 1v1 specifically: the two Capitals are ALWAYS placed at the map's true
//    maximum possible distance apart (antipodal boundary hexes — see the
//    numPlayers===2 branch below) so the two tribes can never start close
//    together — this is deterministic every game, only which side of the
//    map each player lands on is randomized;
//  • 3+ players: no two sites are closer than MIN_TEMPLE_SEPARATION (hex
//    distance), Capitals are spread out as widely as the map allows
//    (backing off until a layout is found) and never adjacent to each other,
//  • each Capital has room for its starting units on free neighbour tiles,
//  • sites MAY sit on the map border (edge hexes are eligible).
// Never hangs / crashes: the separation is relaxed down to MIN_TEMPLE_SEPARATION,
// and a guaranteed best-effort fallback runs if the constraints can't be met.
function placeSites(mapRadius: number, numPlayers: number, numNeutral: number): SiteLayout {
  const all = generateHexMap(mapRadius);
  // Prefer starts spread even wider than the global floor, backing off toward it
  // if the map is too tight to honour the wider gap.
  const idealStartSep = Math.max(MIN_TEMPLE_SEPARATION + 1, Math.floor(mapRadius * 1.15));

  const freeNeighbors = (pos: HexCoord, taken: HexCoord[]): HexCoord[] =>
    hexNeighbors(pos).filter(n =>
      hexDistance({ q: 0, r: 0 }, n) <= mapRadius && !taken.some(t => hexEqual(t, n)));

  const minDistTo = (hex: HexCoord, refs: HexCoord[]): number =>
    refs.length ? Math.min(...refs.map(t => hexDistance(t, hex))) : Infinity;

  // Place `count` temples one at a time with Mitchell's best-candidate sampling:
  // for each new temple sample up to TEMPLE_SPREAD_CANDIDATES random ELIGIBLE
  // tiles (on-map, unoccupied, honouring `minSep`, and — for starts — keeping
  // enough free neighbour tiles for the opening units) and keep the one sitting
  // FARTHEST from every already-placed temple. Returns null if it can't place all
  // `count` while honouring the floor, so the caller can back off / fall back.
  const spread = (
    count: number, existing: HexCoord[], minSep: number, requireUnitRoom: boolean,
  ): HexCoord[] | null => {
    const placed: HexCoord[] = [];
    for (let i = 0; i < count; i++) {
      const refs = [...existing, ...placed];
      const eligible = all.filter(hex => {
        if (refs.some(t => hexEqual(t, hex))) return false;
        if (minDistTo(hex, refs) < minSep) return false;
        if (requireUnitRoom && freeNeighbors(hex, refs).length < STARTING_UNITS_PER_PLAYER) return false;
        return true;
      });
      if (eligible.length === 0) return null;
      const pool = shuffle([...eligible]);
      const sampleN = Math.min(TEMPLE_SPREAD_CANDIDATES, pool.length);
      let best = pool[0]!;
      let bestScore = minDistTo(best, refs);
      for (let k = 1; k < sampleN; k++) {
        const cand = pool[k]!;
        const score = minDistTo(cand, refs);
        if (score > bestScore) { bestScore = score; best = cand; }
      }
      placed.push(best);
    }
    return placed;
  };

  // Give each start temple STARTING_UNITS_PER_PLAYER free neighbour tiles for its
  // opening units; null if any start can't fit its units.
  const assignUnits = (starts: HexCoord[], neutrals: HexCoord[]): HexCoord[][] | null => {
    const allTemples = [...starts, ...neutrals];
    const used: HexCoord[] = [];
    const out: HexCoord[][] = [];
    for (const s of starts) {
      const free = freeNeighbors(s, [...allTemples, ...used]);
      if (free.length < STARTING_UNITS_PER_PLAYER) return null;
      const chosen = free.slice(0, STARTING_UNITS_PER_PLAYER);
      out.push(chosen);
      used.push(...chosen);
    }
    return out;
  };

  const pairwiseMin = (pts: HexCoord[]): number => {
    let m = Infinity;
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++)
        m = Math.min(m, hexDistance(pts[i]!, pts[j]!));
    return m;
  };

  // 1v1: Capitals always sit at TRUE maximum distance apart — antipodal
  // points on the map's outer ring (hexDistance = 2*mapRadius, the largest
  // distance any two hexes on a radius-`mapRadius` disk can ever be, since
  // hexDistance(hex, -hex) = 2*hexDistance(origin, hex) — see the game
  // design note "so the tribes don't meet too early, and it's predictable").
  // A random boundary hex is still chosen each game (so the two starting
  // corners of the map vary), but the SEPARATION itself is never anything
  // less than the map's full diameter, unlike the general N-player spread
  // below (which only maximizes, it doesn't guarantee the true max).
  if (numPlayers === 2) {
    const ring = all.filter(hex => hexDistance({ q: 0, r: 0 }, hex) === mapRadius);
    const withRoom = shuffle(ring.filter(hex => freeNeighbors(hex, []).length >= STARTING_UNITS_PER_PLAYER));
    const pool = withRoom.length > 0 ? withRoom : shuffle([...ring]);
    for (const a of pool) {
      const b: HexCoord = { q: -a.q, r: -a.r }; // antipodal — always on-map, always 2*mapRadius away
      const starts = [a, b];
      const neutrals = spread(numNeutral, starts, MIN_TEMPLE_SEPARATION, false);
      if (!neutrals) continue;
      const unitPositions = assignUnits(starts, neutrals);
      if (!unitPositions) continue;
      return { starts, neutrals, unitPositions };
    }
    // Falls through to the general spread/greedy logic below only if no
    // boundary hex could also fit the neutral sites + starting-unit room
    // (astronomically unlikely at the game's actual map sizes) — still
    // guaranteed to never hang or crash.
  }

  // Build several complete layouts and keep the most spread-out one (largest
  // minimum pairwise temple distance).
  let bestLayout: SiteLayout | null = null;
  let bestSpread = -Infinity;
  for (let attempt = 0; attempt < TEMPLE_LAYOUT_ATTEMPTS; attempt++) {
    // Starts first, as wide as the map allows (back off toward the floor).
    let starts: HexCoord[] | null = null;
    for (let sep = idealStartSep; sep >= MIN_TEMPLE_SEPARATION; sep--) {
      starts = spread(numPlayers, [], sep, true);
      if (starts) break;
    }
    if (!starts) continue;
    const neutrals = spread(numNeutral, starts, MIN_TEMPLE_SEPARATION, false);
    if (!neutrals) continue;
    const unitPositions = assignUnits(starts, neutrals);
    if (!unitPositions) continue;
    const s = pairwiseMin([...starts, ...neutrals]);
    if (s > bestSpread) {
      bestSpread = s;
      bestLayout = { starts, neutrals, unitPositions };
    }
  }
  if (bestLayout) return bestLayout;

  // Guaranteed fallback: place greedily with the loosest separation we can,
  // returning fewer neutral temples / units rather than ever failing or hanging.
  console.warn(`[placeSites] spread placement failed (radius=${mapRadius} players=${numPlayers} neutral=${numNeutral}); using relaxed greedy fallback`);
  const greedy = (count: number, minSep: number, existing: HexCoord[]): HexCoord[] => {
    const out: HexCoord[] = [];
    for (let sep = minSep; sep >= 0 && out.length < count; sep--) {
      for (const hex of shuffle([...all])) {
        if (out.length >= count) break;
        const conflicts = [...existing, ...out];
        if (conflicts.some(t => hexEqual(t, hex))) continue;
        if (conflicts.some(t => hexDistance(t, hex) < sep)) continue;
        out.push(hex);
      }
    }
    return out;
  };
  const starts = greedy(numPlayers, MIN_TEMPLE_SEPARATION, []);
  const neutrals = greedy(numNeutral, MIN_TEMPLE_SEPARATION, starts);
  const allTemples = [...starts, ...neutrals];
  const usedUnitTiles: HexCoord[] = [];
  const unitPositions = starts.map(s => {
    const free = freeNeighbors(s, [...allTemples, ...usedUnitTiles]).slice(0, STARTING_UNITS_PER_PLAYER);
    usedUnitTiles.push(...free);
    return free;
  });
  return { starts, neutrals, unitPositions };
}

// ── Game creation ──

export function createGameState(playerConfigs?: PlayerConfig[]): GameState {
  const configs = playerConfigs || DEFAULT_PLAYERS;
  const numPlayers = configs.length;
  const mapRadius = mapRadiusForPlayers(numPlayers);
  const numNeutral = neutralSiteCountForPlayers(numPlayers);

  // Balance v2.2 (2026-05-17): Symmetric starting aura. The proper fix for the
  // first-mover gap is randomizing who acts first (see `firstPlayer` below) so
  // no slot is "fixed P0"; with that, asymmetric aura would itself be unfair.
  // §4: starting energy is 6⚡ (phase 4 — matches the real economy now wired up).
  const players: Player[] = configs.map((cfg, i) => ({
    id: i,
    name: cfg.name,
    color: cfg.color || PLAYER_COLORS[i % PLAYER_COLORS.length]!,
    aura: STARTING_ENERGY,
    faction: null, // chosen right at the start of the match — see chooseFaction()
  }));

  const playerTech: PlayerTech[] = players.map(() => ({ researched: new Set<TechId>(), researching: null }));

  // Randomized site placement each game (Capitals + neutrals), with a minimum
  // separation. Sites may sit on the border.
  const layout = placeSites(mapRadius, numPlayers, numNeutral);

  // §7, §11 — one permanent Capital per player, plus shared neutral strategic
  // sites (foundable into a City or a Temple — see chooseFaction/§7-10).
  const capitals: Capital[] = layout.starts.map((pos, i) => createCapital(i, pos));
  const strategicSites: StrategicSite[] = layout.neutrals.map(pos => createStrategicSite(pos));

  // layout.unitPositions is no longer used to seed starting units (phase 11
  // — a match starts with zero units, see §3), but the reserved-tile
  // computation is still passed into generateTerrain so those tiles around
  // each Capital stay clear/passable for the player's first recruits.
  const allSitePositions = [...layout.starts, ...layout.neutrals];
  const allUnitPositions = layout.unitPositions.flat();
  const { hills, walls, forests } = generateTerrain(mapRadius, allSitePositions, allUnitPositions);

  // §3 — a match starts with the Capital only: no neutral Warrior/Archer/
  // Founder, no Founding Round. Faction choice happens immediately (see
  // chooseFaction) and the player's first units come from recruiting.
  const units: Unit[] = [];

  const explored: Set<string>[] = players.map(() => new Set<string>());

  // Balance v2.2 (2026-05-17): Random first-mover, generalized to N players.
  const firstPlayer = Math.floor(Math.random() * numPlayers);

  const state: GameState = {
    players, units, strategicSites, capitals, farms: [], hills, walls, forests, explored,
    currentPlayerIndex: firstPlayer, firstPlayerIndex: firstPlayer,
    phase: 'playing', mapRadius,
    winner: null,
    turnNumber: 1,
    selectedUnitId: null, selectedSiteId: null, selectionMode: null,
    moveHexes: [], attackHexes: [], structureAttackHexes: [], supportHexes: [],
    spawnedSiteIds: new Set(),
    playerTech,
    teleportBuildings: [],
    buildHexes: [],
    trainingQueue: [],
    roads: [],
    pillagedRoadHexes: new Set(),
  };

  for (const player of players) {
    updateVisibility(state, player.id);
  }

  return state;
}

// ── Faction reveal (§2, phase 11 — no more Founding Round) ──
//
// A match starts with zero units and an empty board (§3) — there's nothing
// to scout, so faction choice happens immediately, before any other action.
// Every action except choosing a faction (or resigning) is rejected until
// EACH player has independently and secretly locked Agrar or Temple. The
// instant the second player locks, both reveal simultaneously and real
// turn 1 play (recruiting, etc.) becomes available right away.
//
// Secrecy is NOT enforced here — chooseFaction always writes the true value
// into the authoritative Player.faction. Hiding an unrevealed pick from the
// opponent is the transport layer's job (see stripHiddenFaction in
// server/gameManager.ts) — this file only ever deals in ground truth.

export function isAwaitingFactionReveal(state: GameState): boolean {
  return state.players.some(p => p.faction === null);
}

// True while combat/recruit/research/construction actions are rejected —
// only during the pre-reveal window now (no more Founding Round on top).
export function isMatchSetupRestricted(state: GameState): boolean {
  return isAwaitingFactionReveal(state);
}

/**
 * Secretly lock in a player's faction choice. Idempotent for a repeated
 * identical choice (a duplicate submit — e.g. a retried request — succeeds
 * as a no-op); rejected if the player already chose a DIFFERENT faction, since
 * the choice is permanent once made (§5). The instant both players have
 * chosen, reveal happens atomically for both and normal play begins — there
 * are no Round-1 units left to convert (§3), so nothing else to do here.
 */
export function chooseFaction(state: GameState, playerId: number, faction: FactionId): boolean {
  if (!isAwaitingFactionReveal(state)) return false;
  const player = state.players.find(p => p.id === playerId);
  if (!player) return false;
  if (player.faction !== null) return player.faction === faction;

  player.faction = faction;
  return true;
}

// Display-only label for a Founder-type unit, reflecting its owner's
// revealed faction (Agrar's Builder and Temple's Acolyte otherwise get their
// stats independently from AGRAR_UNITS/TEMPLE_UNITS like any other slot —
// see applyFactionToStats — this is purely the name lookup).
export function founderDisplayName(faction: FactionId | null | undefined): string {
  if (faction === 'agrar') return 'Builder';
  if (faction === 'temple') return 'Acolyte';
  return 'Founder';
}

// ── Getters ──

export function getCurrentPlayer(state: GameState): Player {
  return state.players[state.currentPlayerIndex]!;
}

export function getUnitAt(state: GameState, pos: HexCoord): Unit | undefined {
  return state.units.find(u => hexEqual(u.pos, pos) && u.hp > 0);
}

export function getStrategicSiteAt(state: GameState, pos: HexCoord): StrategicSite | undefined {
  return state.strategicSites.find(s => hexEqual(s.pos, pos));
}

// ── Strategic site founding (§7-10, phase 10: Temple-only) ──
//
// Replaces the old instant-capture-by-presence system entirely. There is no
// "capture" any more — a neutral or ruined site becomes an actual Temple
// only through a multi-turn founding process the opponent has a real window
// to interrupt. Phase 10 correction: Agrar NEVER founds a site — "Agrar
// controls area (Farms), Temple controls points (Temples)" — see §28 and
// the STATUS comment in factions.ts.

function isFounderUnit(unit: Unit): boolean {
  return unit.type === 'founder';
}

export interface FoundingCheck {
  site: StrategicSite;
  targetState: 'temple';
}

// §7 — everything that must hold true to START founding.
export function canStartFounding(state: GameState, unit: Unit): FoundingCheck | null {
  if (isMatchSetupRestricted(state)) return null;
  if (unit.playerId !== getCurrentPlayer(state).id) return null;
  if (unit.hasMoved || unit.hasAttacked) return null; // needs an unused activation
  if (!isFounderUnit(unit)) return null; // only the Acolyte
  const player = state.players.find(p => p.id === unit.playerId);
  if (!player || !player.faction) return null;
  if (player.faction !== 'temple') return null; // §28 — Agrar never founds a site
  const site = getStrategicSiteAt(state, unit.pos);
  if (!site) return null;
  if (site.state !== 'neutral' && site.state !== 'ruins') return null;
  if (site.founding) return null;
  const enemyOnSite = state.units.some(u => u.hp > 0 && u.id !== unit.id && u.playerId !== unit.playerId && hexEqual(u.pos, site.pos));
  if (enemyOnSite) return null;
  if (player.aura < SITE_ESTABLISH_COST) return null;
  // §10-11 — a site inside enemy Agrar cultivated territory cannot be founded.
  if (isSiteCultivationBlocked(state, site.pos, player.id)) return null;
  return { site, targetState: 'temple' };
}

// Begin founding: charges 4⚡ immediately (§7 — "do not wait until completion
// to charge it, otherwise the player can start construction without actually
// committing resources") and consumes the Acolyte's whole activation.
// Resolves automatically at the start of the founder's next round — see
// resolveFoundingForPlayer, called from endTurn().
export function startFounding(state: GameState, unitId: string): boolean {
  const unit = state.units.find(u => u.id === unitId && u.hp > 0);
  if (!unit) return false;
  const check = canStartFounding(state, unit);
  if (!check) return false;

  const player = state.players.find(p => p.id === unit.playerId)!;
  player.aura -= SITE_ESTABLISH_COST;

  const fromState = check.site.state as 'neutral' | 'ruins'; // canStartFounding already restricted this to neutral|ruins
  check.site.state = 'foundingTemple';
  check.site.founding = {
    playerId: unit.playerId,
    unitId: unit.id,
    targetState: 'temple',
    fromState,
    startedRound: state.turnNumber,
    completesRound: state.turnNumber + 1,
  };
  unit.hasMoved = true;
  unit.hasAttacked = true;
  updateHighlights(state);
  return true;
}

// v11 — conquest NEVER transfers or restores economic investment, even for
// the site's original owner recapturing their own former Ruins: every
// completed founding produces a fresh Temple I, full stop. "Destroying
// economic infrastructure destroys its accumulated investment instead of
// transferring that investment to the attacker" (RULES_VERSION v11 note).
function completeFounding(state: GameState, site: StrategicSite): void {
  const founding = site.founding!;
  site.ownerId = founding.playerId;
  site.state = 'temple';
  site.templeLevel = 1;
  site.hp = STRUCTURES.temple.hp;
  site.maxHp = STRUCTURES.temple.hp;
  site.defense = STRUCTURES.temple.defense;
  site.founding = null;
}

// §9 — failure returns the site to whatever it was before, cleanly, with NO
// refund of the 4⚡ already spent. No permanent "half-built" state.
function failFounding(site: StrategicSite): void {
  site.state = site.founding!.fromState;
  site.ownerId = null;
  site.founding = null;
}

// §8 — called once per player, right when it becomes their turn (see
// endTurn()), for every site they have founding in progress that is now due.
// A founding resolves successfully only if, at this exact moment: the
// founder is alive AND still standing on the site AND no enemy unit occupies
// the site AND no enemy unit is adjacent to it. Any one of those failing
// (founder killed, founder moved off — structurally the founder can never
// move before this check since starting founding spends its whole
// activation and this resolves before the founder's next one — enemy moved
// onto or next to the site) fails the founding. This gives the opponent a
// real interrupt window without needing a ZOC system.
function resolveFoundingForPlayer(state: GameState, playerId: number): void {
  for (const site of state.strategicSites) {
    if (site.state !== 'foundingTemple') continue;
    const founding = site.founding;
    if (!founding || founding.playerId !== playerId) continue;
    if (state.turnNumber < founding.completesRound) continue;

    const founder = state.units.find(u => u.id === founding.unitId && u.hp > 0);
    const founderStillHere = !!founder && hexEqual(founder.pos, site.pos);
    const enemyOnSite = state.units.some(u => u.hp > 0 && u.playerId !== playerId && hexEqual(u.pos, site.pos));
    const enemyAdjacent = state.units.some(u => u.hp > 0 && u.playerId !== playerId && hexDistance(u.pos, site.pos) === 1);

    if (founderStillHere && !enemyOnSite && !enemyAdjacent) {
      completeFounding(state, site);
    } else {
      failFounding(site);
    }
  }
  for (const p of state.players) if (p.id === playerId) updateVisibility(state, playerId);
}

// ── Agrar Farms (§6-11, phase 10 correction) ──
//
// Agrar's ONLY economic expansion, built directly by the Builder on open
// land — never tied to a captured site (Agrar never founds one, §28). A
// Farm founds over a round like a strategic site (not instantly): the
// Builder spends its whole activation + AGRAR_FARM_COST to start one, it
// completes at the start of Agrar's next round if uncontested (see
// resolveFarmFoundingForPlayer), and only then becomes a real attackable
// structure that expands Agrar Territory (§10-11, getAgrarTerritory).

function activeFarmsOf(state: GameState, playerId: number): Farm[] {
  return state.farms.filter(f => f.ownerId === playerId && f.state === 'farm');
}

// Founding + active — the global cap (§6, MAX_ACTIVE_FARMS) counts a Farm
// the instant its aura is committed, not just once it's complete.
function allFarmsOf(state: GameState, playerId: number): Farm[] {
  return state.farms.filter(f => f.ownerId === playerId);
}

// §10-14 (phase 11; unified into Agrar Territory afterward) — a new Farm
// must be a direct NEIGHBOR of the Builder's own position (the Builder's
// physical movement still matters) AND land INSIDE existing Agrar Territory
// (see getAgrarTerritory — within AGRAR_TERRITORY_RADIUS of the Capital or
// of an existing active Farm) — the network only grows as a connected
// bunker, it can never leapfrog to some far corner of the map, and building
// a new Farm immediately expands the territory for the next one. It must
// also be: on the map, empty/passable terrain, not a sacred site/Capital/
// structure, not occupied by a unit, and never directly adjacent to another
// existing Farm (founding or active — `distance >= FARM_MIN_SPACING`).
// Adjacent to the Capital itself is fine (encourages tight bunkering).
export function getValidFarmHexes(state: GameState, unit: Unit): HexCoord[] {
  const player = state.players.find(p => p.id === unit.playerId);
  if (!player) return [];
  const capital = state.capitals.find(c => c.playerId === player.id);
  if (!capital) return [];
  const allOwn = allFarmsOf(state, player.id);
  const territory = getAgrarTerritory(state, player.id);
  const result: HexCoord[] = [];
  for (const hex of hexNeighbors(unit.pos)) {
    if (hexDistance({ q: 0, r: 0 }, hex) > state.mapRadius) continue; // off-map
    const key = hexKey(hex);
    if (state.hills.has(key) || state.walls.has(key)) continue;
    if (getStrategicSiteAt(state, hex)) continue;
    if (state.capitals.some(c => hexEqual(c.pos, hex))) continue;
    if (state.farms.some(f => hexEqual(f.pos, hex))) continue;
    if (getUnitAt(state, hex)) continue;
    if (!territory.has(key)) continue; // must land inside existing Agrar Territory
    if (!allOwn.every(f => hexDistance(f.pos, hex) >= FARM_MIN_SPACING)) continue; // not adjacent to another Farm
    result.push(hex);
  }
  return result;
}

export function canStartFarm(state: GameState, unit: Unit, pos: HexCoord): boolean {
  if (isMatchSetupRestricted(state)) return false;
  if (unit.playerId !== getCurrentPlayer(state).id) return false;
  if (unit.hasMoved || unit.hasAttacked) return false; // needs an unused activation
  if (unit.type !== 'founder') return false; // only the Builder
  const player = state.players.find(p => p.id === unit.playerId);
  if (!player || player.faction !== 'agrar') return false; // §28 — Temple has no equivalent
  if (allFarmsOf(state, player.id).length >= MAX_ACTIVE_FARMS) return false;
  if (player.aura < AGRAR_FARM_COST) return false;
  return getValidFarmHexes(state, unit).some(h => hexEqual(h, pos));
}

// Begin building: charges AGRAR_FARM_COST immediately (same "commit the
// resource up front" rule as site founding, §7/§9) and consumes the
// Builder's whole activation. Resolves at the start of Agrar's next round —
// see resolveFarmFoundingForPlayer, called from endTurn().
export function startFarm(state: GameState, unitId: string, pos: HexCoord): boolean {
  const unit = state.units.find(u => u.id === unitId && u.hp > 0);
  if (!unit || !canStartFarm(state, unit, pos)) return false;
  const player = state.players.find(p => p.id === unit.playerId)!;
  player.aura -= AGRAR_FARM_COST;
  state.farms.push({
    id: `farm_${farmIdCounter++}`,
    pos: { ...pos },
    ownerId: player.id,
    state: 'foundingFarm',
    founding: { playerId: player.id, unitId: unit.id, startedRound: state.turnNumber, completesRound: state.turnNumber + 1 },
    hp: 0, maxHp: 0, defense: 0,
  });
  unit.hasMoved = true;
  unit.hasAttacked = true;
  return true;
}

// §14 interruption: construction fails outright (removed, no refund, no
// "Ruins" — Farms don't have one, §15) if by the time it's due the Builder
// has been killed, or is no longer adjacent to (or standing on) the
// construction hex, or an enemy now occupies the hex. Otherwise it completes
// and becomes a real structure.
function resolveFarmFoundingForPlayer(state: GameState, playerId: number): void {
  const stillFounding: Farm[] = [];
  for (const farm of state.farms) {
    if (farm.state !== 'foundingFarm' || !farm.founding || farm.founding.playerId !== playerId) continue;
    if (state.turnNumber < farm.founding.completesRound) continue;
    const builder = state.units.find(u => u.id === farm.founding!.unitId && u.hp > 0);
    const builderNear = !!builder && hexDistance(builder.pos, farm.pos) <= 1;
    const enemyOnHex = state.units.some(u => u.hp > 0 && u.playerId !== playerId && hexEqual(u.pos, farm.pos));
    if (!builderNear || enemyOnHex) { stillFounding.push(farm); continue; }
    farm.state = 'farm';
    farm.founding = null;
    farm.hp = STRUCTURES.farm.hp;
    farm.maxHp = STRUCTURES.farm.hp;
    farm.defense = STRUCTURES.farm.defense;
  }
  if (stillFounding.length) state.farms = state.farms.filter(f => !stillFounding.includes(f));
}

// Every hex within `radius` of `center`, bounded to the actual map — a
// generic "disk around an arbitrary hex" helper (generateHexMap only does
// disks around the origin).
function hexesWithinRadius(center: HexCoord, radius: number, mapRadius: number): HexCoord[] {
  const result: HexCoord[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      const hex = { q: center.q + dq, r: center.r + dr };
      if (hexDistance({ q: 0, r: 0 }, hex) > mapRadius) continue; // off-map
      result.push(hex);
    }
  }
  return result;
}

// §10-11 (economy/pacing balance pass — split back into two distinct radii,
// each with exactly one job) — "Agrar Territory" is INFRASTRUCTURE reach
// only: the union of every hex within AGRAR_TERRITORY_RADIUS of the
// Capital, PLUS every hex within AGRAR_TERRITORY_RADIUS of each ACTIVE
// Farm. Used ONLY to gate where a new Farm/Road may be built (getValidFarm
// Hexes / getValidRoadHexes — a new one must land inside existing
// territory, so completing one immediately expands where the next can go).
// It grants NO combat bonus (see getEffectiveDefense) and does NOT drive
// area denial — that's the separate, tighter getAgrarCultivation below.
// Deliberately NOT stored on GameState; always derived fresh from live
// Capital/Farm positions (§45 — avoid duplicated, driftable state).
export function getAgrarTerritory(state: GameState, agrarPlayerId: number): Set<string> {
  const hexes = new Set<string>();
  const capital = state.capitals.find(c => c.playerId === agrarPlayerId);
  if (capital) for (const h of hexesWithinRadius(capital.pos, AGRAR_TERRITORY_RADIUS, state.mapRadius)) hexes.add(hexKey(h));
  for (const farm of activeFarmsOf(state, agrarPlayerId)) {
    for (const h of hexesWithinRadius(farm.pos, AGRAR_TERRITORY_RADIUS, state.mapRadius)) hexes.add(hexKey(h));
  }
  return hexes;
}

// "Cultivated Influence" — a TIGHTER, farm-only radius (CULTIVATION_RADIUS,
// deliberately smaller than AGRAR_TERRITORY_RADIUS): every ACTIVE Farm's own
// hex + its 6 neighbours. The CAPITAL projects none of this — only Farms do.
// Its only job is area denial: a neutral/ruined site inside it cannot be
// founded/rebuilt by Temple (see isSiteCultivationBlocked/canStartFounding).
// An already-ACTIVE Temple is never affected — only new founding/rebuilding.
export function getAgrarCultivation(state: GameState, agrarPlayerId: number): Set<string> {
  const hexes = new Set<string>();
  for (const farm of activeFarmsOf(state, agrarPlayerId)) {
    for (const h of hexesWithinRadius(farm.pos, CULTIVATION_RADIUS, state.mapRadius)) hexes.add(hexKey(h));
  }
  return hexes;
}

function isSiteCultivationBlocked(state: GameState, pos: HexCoord, templePlayerId: number): boolean {
  const key = hexKey(pos);
  for (const p of state.players) {
    if (p.id === templePlayerId || p.faction !== 'agrar') continue;
    if (getAgrarCultivation(state, p.id).has(key)) return true;
  }
  return false;
}

// ── Temple upgrade (v11 Temple conquest + upgrade system) ──
//
// Temple I -> Temple II, a single timed step mirroring founding itself: pay
// TEMPLE_UPGRADE_COST up front, occupy the site for one full round, and only
// then does the Temple II bonus (+2 income total, +1 production) apply —
// see resolveTempleUpgradeForPlayer below and TEMPLE_LEVEL_INCOME in
// getPlayerIncome. Unlike founding there's no board presence to contest (no
// unit needs to stay nearby) — the only way to stop an upgrade is to
// destroy the Temple outright before it completes (see attackStructure).

export function canStartTempleUpgrade(state: GameState, templeSiteId: string): boolean {
  if (isMatchSetupRestricted(state)) return false;
  const player = getCurrentPlayer(state);
  const site = state.strategicSites.find(s => s.id === templeSiteId);
  if (!site || site.state !== 'temple' || site.ownerId !== player.id) return false;
  if (site.templeLevel !== 1) return false; // already Temple II, or not founded
  if (site.upgrade) return false; // already upgrading
  return player.aura >= TEMPLE_UPGRADE_COST;
}

// Begin upgrade: charges TEMPLE_UPGRADE_COST immediately (same "commit up
// front" rule as founding/research) and moves the site into
// 'upgradingTemple' — it keeps its Temple I economic effect throughout (see
// getPlayerIncome/getProductionSlots) until resolveTempleUpgradeForPlayer
// applies the Temple II bonus at the start of the owning player's next round.
export function startTempleUpgrade(state: GameState, templeSiteId: string): boolean {
  if (!canStartTempleUpgrade(state, templeSiteId)) return false;
  const player = getCurrentPlayer(state);
  player.aura -= TEMPLE_UPGRADE_COST;
  const site = state.strategicSites.find(s => s.id === templeSiteId)!;
  site.state = 'upgradingTemple';
  site.upgrade = { playerId: player.id, startedRound: state.turnNumber, completesRound: state.turnNumber + 1 };
  return true;
}

// §9 — called once per player, right when it becomes their turn (mirrors
// resolveFoundingForPlayer/resolveFarmFoundingForPlayer). An upgrade never
// fails once started (no board presence to contest, same as research) —
// it either completes on schedule, still owned by that player, or it was
// already destroyed into Ruins by attackStructure (which also clears
// `upgrade`, so there's nothing left here to resolve).
function resolveTempleUpgradeForPlayer(state: GameState, playerId: number): void {
  for (const site of state.strategicSites) {
    if (site.state !== 'upgradingTemple') continue;
    const upgrade = site.upgrade;
    if (!upgrade || upgrade.playerId !== playerId) continue;
    if (state.turnNumber < upgrade.completesRound) continue;
    if (site.ownerId !== playerId) { site.upgrade = null; continue; } // shouldn't happen, but stay safe
    site.state = 'temple';
    site.templeLevel = 2;
    site.upgrade = null;
  }
}

// ── Agrar Roads (§23-25; adjacency + network-connectivity correction) ──
//
// Agrar-only physical road tiles, built by the Builder ('founder'-type unit,
// mechanically identical either faction but only Agrar's flavor may build
// roads — Temple's Acolyte has no equivalent, §25). A new Road hex must be a
// direct NEIGHBOUR of the Builder (same as Farm placement — the Builder
// picks an adjacent tile, not just its own) AND itself be directly adjacent
// to the Capital, an active Farm, or another existing Road of that same
// player — the network only extends link by link out from something real,
// it can never appear disconnected in the middle of nowhere. Building
// consumes the Builder's whole activation, same as founding, and resolves
// immediately (no multi-round construction, unlike Farms).

export function getRoadAt(state: GameState, pos: HexCoord): Road | undefined {
  return state.roads.find(r => hexEqual(r.pos, pos));
}

// Mirrors getValidFarmHexes: every hex a Builder could legally lay a Road on
// right now — a direct neighbour of the Builder, empty/on-map/unoccupied,
// not under a site/Capital/Farm, and itself adjacent to the Capital, an
// active Farm, or an existing Road (all belonging to the Builder's own
// player — the network only ever grows from its own infrastructure).
export function getValidRoadHexes(state: GameState, unit: Unit): HexCoord[] {
  const player = state.players.find(p => p.id === unit.playerId);
  if (!player) return [];
  const capital = state.capitals.find(c => c.playerId === player.id);
  const anchors: HexCoord[] = [
    ...(capital ? [capital.pos] : []),
    ...activeFarmsOf(state, player.id).map(f => f.pos),
    ...state.roads.filter(r => r.ownerId === player.id).map(r => r.pos),
  ];
  const result: HexCoord[] = [];
  for (const hex of hexNeighbors(unit.pos)) {
    if (hexDistance({ q: 0, r: 0 }, hex) > state.mapRadius) continue; // off-map
    const key = hexKey(hex);
    if (state.walls.has(key)) continue; // no roads over impassable mountains
    if (getRoadAt(state, hex)) continue; // already a road here
    if (getStrategicSiteAt(state, hex)) continue; // no roads under a site
    if (state.capitals.some(c => hexEqual(c.pos, hex))) continue; // no roads under a Capital
    if (state.farms.some(f => hexEqual(f.pos, hex))) continue; // no roads under a Farm (founding or active)
    if (getUnitAt(state, hex)) continue;
    if (!anchors.some(a => hexDistance(a, hex) === 1)) continue; // must be adjacent to the Capital, a Farm, or an existing Road
    result.push(hex);
  }
  return result;
}

export function canBuildRoad(state: GameState, unit: Unit, pos: HexCoord): boolean {
  if (isMatchSetupRestricted(state)) return false;
  if (unit.type !== 'founder' || unit.hasMoved || unit.hasAttacked) return false;
  const player = state.players.find(p => p.id === unit.playerId);
  if (!player || player.faction !== 'agrar') return false;
  const cost = state.pillagedRoadHexes.has(hexKey(pos)) ? ROAD_PILLAGE_REBUILD_COST : ROAD_COST_PER_HEX;
  if (player.aura < cost) return false;
  return getValidRoadHexes(state, unit).some(h => hexEqual(h, pos));
}

export function buildRoad(state: GameState, unitId: string, pos: HexCoord): boolean {
  const unit = state.units.find(u => u.id === unitId && u.hp > 0);
  if (!unit || !canBuildRoad(state, unit, pos)) return false;
  const player = state.players.find(p => p.id === unit.playerId)!;
  const key = hexKey(pos);
  const cost = state.pillagedRoadHexes.has(key) ? ROAD_PILLAGE_REBUILD_COST : ROAD_COST_PER_HEX;
  player.aura -= cost;
  state.pillagedRoadHexes.delete(key);
  state.roads.push({ pos: { ...pos }, ownerId: player.id });
  unit.hasMoved = true;
  unit.hasAttacked = true;
  return true;
}

// A unit that ends its move on a road it does NOT own tramples it — the
// road is destroyed (moved to pillagedRoadHexes, cheaper to rebuild than a
// fresh one). Called from moveUnit right after the position is finalized
// (including any auto-teleport landing).
function pillageRoadIfEnemy(state: GameState, unit: Unit): void {
  const road = getRoadAt(state, unit.pos);
  if (!road || road.ownerId === unit.playerId) return;
  state.roads = state.roads.filter(r => r !== road);
  state.pillagedRoadHexes.add(hexKey(road.pos));
}

// ── Tech research (single-slot, multi-round — tech-tree pacing pass) ──
//
// Research is a real civilization investment now, not an instant menu
// purchase: each player has exactly ONE active research slot (see
// PlayerTech.researching). Starting a tech commits its Energy cost
// immediately, same as Farm/Temple founding, but the effect (researched
// set membership, and therefore every stat/unlock it drives) only applies
// once `researchTime` rounds have elapsed — see resolveResearchForPlayer,
// called from endTurn() exactly like the other founding/training resolvers.

// Command II additionally requires at least this many OTHER completed
// technologies (not expressible via `prereqs`, which means "all of these")
// — stops a player rushing straight from Command I into Command II with no
// other development.
const COMMAND_2_MIN_OTHER_TECHS = 2;

export function canResearch(state: GameState, techId: TechId): boolean {
  if (isMatchSetupRestricted(state)) return false;
  const player = getCurrentPlayer(state);
  const tech = state.playerTech[player.id]!;
  if (tech.researched.has(techId)) return false;
  if (tech.researching) return false; // §2 — exactly one active research slot

  const node = TECH_NODES.find(n => n.id === techId);
  if (!node) return false;
  if (node.faction && node.faction !== player.faction) return false;

  for (const prereq of node.prereqs) {
    if (!tech.researched.has(prereq)) return false;
  }

  if (techId === 'command_2') {
    const otherCompleted = [...tech.researched].filter(id => id !== 'command_1' && id !== 'command_2').length;
    if (otherCompleted < COMMAND_2_MIN_OTHER_TECHS) return false;
  }

  if (node.branch) {
    const branchNodes = TECH_NODES.filter(n => n.branch === node.branch);
    for (const bn of branchNodes) {
      if (bn.id !== techId && tech.researched.has(bn.id)) return false;
    }
  }

  return player.aura >= node.cost;
}

// Begin research: charges the full Energy cost immediately (same "commit up
// front" rule as Farm/Temple founding) and occupies the player's one
// research slot for `researchTime` rounds. Resolves automatically — see
// resolveResearchForPlayer, called from endTurn().
export function researchTech(state: GameState, techId: TechId): boolean {
  if (!canResearch(state, techId)) return false;
  const player = getCurrentPlayer(state);
  const node = TECH_NODES.find(n => n.id === techId)!;
  player.aura -= node.cost;
  state.playerTech[player.id]!.researching = {
    techId,
    startedRound: state.turnNumber,
    completesRound: state.turnNumber + node.researchTime,
  };
  return true;
}

// §11 — called once per player, right when it becomes their turn (mirrors
// resolveFoundingForPlayer/resolveFarmFoundingForPlayer/resolveTrainingFor
// Player). If that player's research is due, it completes: added to
// `researched` (freeing the slot) and retroactively applied to every living
// unit they own — `applyTechToStats` only fires at `createUnit` time, so
// existing units would otherwise never benefit from techs like
// `longrange_hp`/`horse_sight` (bug discovered in REPORT.md §6). Research
// never fails or gets interrupted once started — unlike founding/Farms
// there's no board presence to contest, it's a pure Energy/time commitment.
function resolveResearchForPlayer(state: GameState, playerId: number): void {
  const tech = state.playerTech[playerId]!;
  if (!tech.researching || state.turnNumber < tech.researching.completesRound) return;
  const player = state.players.find(p => p.id === playerId)!;
  tech.researched.add(tech.researching.techId);
  tech.researching = null;
  for (const unit of state.units) {
    if (unit.playerId !== playerId || unit.hp <= 0) continue;
    rebuildUnitStats(unit, tech, player.faction);
  }
}

// ── Spawning ──

export function canAfford(state: GameState, unitType: UnitType): boolean {
  const player = getCurrentPlayer(state);
  if (player.aura < getUnitCost(unitType, player.faction)) return false;
  // Population cap check — commandCost-weighted (§19), not flat 1-per-unit.
  const cap = getPopulationCap(state, player.id);
  const count = getPopulationCount(state, player.id);
  if (count + getUnitCommandCost(unitType, player.faction) > cap) return false;
  // §19-20 — production slots: a limited pool, not unlimited.
  if (getBusyProductionSlotCount(state, player.id) >= getProductionSlots(state, player.id)) return false;
  // Check unit is unlocked (faction early-unlock + tech)
  const unlocked = getUnlockedUnits(state.playerTech[player.id]!, player.faction);
  return unlocked.has(unitType);
}

// §5, §19-20 — recruiting queues a TrainingOrder, it does NOT create a Unit.
// The unit does not exist on the battlefield until it deploys at the start
// of the recruiting player's next round (resolveTrainingForPlayer). A
// structure may have MORE THAN ONE order queued against it over time — the
// player's overall production-slot pool is what actually caps how many can
// be in flight at once, not a per-structure gate.
export function spawnUnit(state: GameState, structureId: string, unitType: UnitType): boolean {
  if (isMatchSetupRestricted(state)) return false;
  const player = getCurrentPlayer(state);
  const structure = getOwnedStructures(state, player.id).find(s => s.id === structureId);
  if (!structure) return false;

  const cost = getUnitCost(unitType, player.faction);
  if (player.aura < cost) return false;

  // Population cap check — commandCost-weighted (§19), not flat 1-per-unit.
  // getPopulationCount already includes queued (not-yet-deployed) orders.
  const cap = getPopulationCap(state, player.id);
  const count = getPopulationCount(state, player.id);
  const commandCost = getUnitCommandCost(unitType, player.faction);
  if (count + commandCost > cap) return false;

  // §19-20 — production slots: a limited pool, not unlimited.
  if (getBusyProductionSlotCount(state, player.id) >= getProductionSlots(state, player.id)) return false;

  // Unlock check (faction early-unlock + tech)
  const unlocked = getUnlockedUnits(state.playerTech[player.id]!, player.faction);
  if (!unlocked.has(unitType)) return false;

  player.aura -= cost;
  state.trainingQueue.push({
    playerId: player.id,
    unitType,
    structureId,
    readyAtRound: state.turnNumber + UNIT_TRAINING_ROUNDS,
  });

  return true;
}

// ── Encirclement ──

export interface EncirclementInfo {
  ratio: number;
  opposingRatio: number;
  groupSize: number;
  perimeterTotal: number;
  perimeterBlocked: number;
  pinchCount: number;
  pinchMax: number;
  attackMultiplier: number;
}

// Balance v3 (2026-08-21): map edges no longer count as blocking. A group
// defending against empty space near its own Capital isn't "half surrounded"
// just because the map ends there — only actual enemy pressure should earn
// the encirclement bonus. Movement is still naturally bounded by mapRadius
// elsewhere (getReachableHexes); this function is only about damage pressure.
function isBlockedHex(hex: HexCoord, targetPlayerId: number, aliveUnits: Unit[], group: Set<string>): boolean {
  if (group.has(hexKey(hex))) return false;
  const unitThere = aliveUnits.find(u => hexEqual(u.pos, hex));
  if (unitThere && unitThere.playerId !== targetPlayerId) return true;
  return false;
}

export function calculateEncirclement(state: GameState, targetUnit: Unit): EncirclementInfo {
  const aliveUnits = state.units.filter(u => u.hp > 0);

  const group = new Set<string>();
  const groupCoords: HexCoord[] = [];
  const queue: HexCoord[] = [targetUnit.pos];
  group.add(hexKey(targetUnit.pos));
  groupCoords.push(targetUnit.pos);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of hexNeighbors(current)) {
      const key = hexKey(neighbor);
      if (group.has(key)) continue;
      const unitThere = aliveUnits.find(u => hexEqual(u.pos, neighbor));
      if (unitThere && unitThere.playerId === targetUnit.playerId) {
        group.add(key);
        groupCoords.push(neighbor);
        queue.push(neighbor);
      }
    }
  }

  const perimeterSet = new Set<string>();
  const perimeterHexes: HexCoord[] = [];

  for (const key of group) {
    const [q, r] = key.split(',').map(Number) as [number, number];
    for (const neighbor of hexNeighbors({ q, r })) {
      const nKey = hexKey(neighbor);
      if (group.has(nKey)) continue;
      if (perimeterSet.has(nKey)) continue;
      perimeterSet.add(nKey);
      perimeterHexes.push(neighbor);
    }
  }

  const perimeterTotal = perimeterHexes.length;
  let perimeterBlocked = 0;
  for (const hex of perimeterHexes) {
    if (isBlockedHex(hex, targetUnit.playerId, aliveUnits, group)) {
      perimeterBlocked++;
    }
  }

  const ratio = perimeterTotal > 0 ? perimeterBlocked / perimeterTotal : 0;

  let pinchCount = 0;
  const pinchMax = groupCoords.length * 3;

  for (const pos of groupCoords) {
    for (const [i, j] of OPPOSING_PAIRS) {
      const dirA = DIRECTIONS[i]!;
      const dirB = DIRECTIONS[j]!;
      const hexA: HexCoord = { q: pos.q + dirA.q, r: pos.r + dirA.r };
      const hexB: HexCoord = { q: pos.q + dirB.q, r: pos.r + dirB.r };
      if (isBlockedHex(hexA, targetUnit.playerId, aliveUnits, group) &&
          isBlockedHex(hexB, targetUnit.playerId, aliveUnits, group)) {
        pinchCount++;
      }
    }
  }

  const opposingRatio = pinchMax > 0 ? pinchCount / pinchMax : 0;

  // Balance v3 (2026-08-21): both bonuses capped at +0.25 (was +0.5), so full
  // encirclement + full pinch tops out at 1.5x (was 2.0x). Temple's mobility
  // already makes it better at creating encirclement — doubling that damage
  // on top would reward the same advantage twice.
  let encirclementBonus = 0;
  if (ratio > 0.5) {
    encirclementBonus = ((ratio - 0.5) / 0.5) * 0.25;
  }
  const opposingBonus = opposingRatio * 0.25;
  const attackMultiplier = 1.0 + encirclementBonus + opposingBonus;

  return {
    ratio, opposingRatio, groupSize: group.size,
    perimeterTotal, perimeterBlocked,
    pinchCount, pinchMax, attackMultiplier,
  };
}

// ── Highlights ──

const SUPPORT_UNIT_TYPES: Set<UnitType> = new Set(['healer', 'damageBooster', 'rangeBooster']);

function updateHighlights(state: GameState): void {
  state.moveHexes = [];
  state.attackHexes = [];
  state.structureAttackHexes = [];
  state.supportHexes = [];

  if (state.selectionMode === 'site') return;

  const unit = state.units.find(u => u.id === state.selectedUnitId);
  if (!unit) return;

  // Support area: always show for support units when selected. The range booster
  // only reaches RANGE_BOOST_RADIUS; the damage booster and healer reach SUPPORT_RANGE.
  if (SUPPORT_UNIT_TYPES.has(unit.type)) {
    const r = unit.type === 'rangeBooster' ? RANGE_BOOST_RADIUS : SUPPORT_RANGE;
    for (let dq = -r; dq <= r; dq++) {
      for (let dr = Math.max(-r, -dq - r); dr <= Math.min(r, -dq + r); dr++) {
        const hex: HexCoord = { q: unit.pos.q + dq, r: unit.pos.r + dr };
        if (hexDistance({ q: 0, r: 0 }, hex) <= state.mapRadius) {
          state.supportHexes.push(hex);
        }
      }
    }
  }

  if (!unit.hasMoved && !unit.hasAttacked) {
    const occupied = state.units.filter(u => u.hp > 0 && u.id !== unit.id).map(u => u.pos);
    const wallPositions = [...state.walls].map(k => { const [q, r] = k.split(',').map(Number); return { q: q!, r: r! }; });
    state.moveHexes = getReachableHexes(unit.pos, getEffectiveSpeed(state, unit), state.mapRadius, [...occupied, ...wallPositions], state.hills, getZocHexes(state, unit.playerId));
  }

  const canAttack = !unit.hasAttacked && !(unit.stats.cantShootAfterMove && unit.hasMoved);
  if (canAttack) {
    const effectiveRange = getEffectiveRange(state, unit);
    const visible = getPlayerVisible(state, unit.playerId);
    const enemies = state.units.filter(u => u.hp > 0 && u.playerId !== unit.playerId);
    state.attackHexes = enemies
      .filter(e => hexDistance(unit.pos, e.pos) <= effectiveRange)
      .filter(e => visible.has(hexKey(e.pos)))
      .filter(e => isForestUnitRevealed(state, e.pos, unit.playerId))
      .map(e => e.pos);

    const enemyStructures: HexCoord[] = [];
    for (const capital of state.capitals) {
      if (capital.playerId !== unit.playerId && hexDistance(unit.pos, capital.pos) <= effectiveRange) enemyStructures.push(capital.pos);
    }
    for (const site of state.strategicSites) {
      if ((site.state === 'temple' || site.state === 'upgradingTemple') && site.ownerId !== unit.playerId
        && hexDistance(unit.pos, site.pos) <= effectiveRange) enemyStructures.push(site.pos);
    }
    for (const farm of state.farms) {
      if (farm.state === 'farm' && farm.ownerId !== unit.playerId && hexDistance(unit.pos, farm.pos) <= effectiveRange) enemyStructures.push(farm.pos);
    }
    state.structureAttackHexes = enemyStructures;
  }
}

export function selectUnit(state: GameState, unitId: string): void {
  const unit = state.units.find(u => u.id === unitId);
  if (!unit || unit.playerId !== getCurrentPlayer(state).id) return;
  state.selectedUnitId = unitId;
  state.selectedSiteId = null;
  state.selectionMode = 'unit';
  updateHighlights(state);
}

// Select an owned structure (Capital or a completed City/Temple) — used for
// recruiting. Neutral/founding/ruined sites aren't selectable this way.
export function selectSite(state: GameState, siteId: string): void {
  const owned = getOwnedStructures(state, getCurrentPlayer(state).id);
  if (!owned.some(s => s.id === siteId)) return;
  state.selectedSiteId = siteId;
  state.selectedUnitId = null;
  state.selectionMode = 'site';
  updateHighlights(state);
}

export function deselectAll(state: GameState): void {
  state.selectedUnitId = null;
  state.selectedSiteId = null;
  state.selectionMode = null;
  state.moveHexes = [];
  state.attackHexes = [];
  state.structureAttackHexes = [];
  state.supportHexes = [];
}

export interface MoveResult {
  moved: boolean;
}

export function moveUnit(state: GameState, dest: HexCoord): MoveResult {
  // Blocked only during the pre-game faction-reveal pause (§3) — there's no
  // separate Founding Round to gate on top of that any more.
  if (isAwaitingFactionReveal(state)) return { moved: false };
  const unit = state.units.find(u => u.id === state.selectedUnitId);
  if (!unit || unit.hasMoved || unit.hasAttacked) return { moved: false };

  const isValid = state.moveHexes.some(h => hexEqual(h, dest));
  if (!isValid) return { moved: false };

  unit.pos = { ...dest };
  unit.hasMoved = true;

  // Auto-teleport: if unit stepped on a portal with a paired exit
  const portal = getTeleportAt(state, unit.pos);
  if (portal?.pairedId) {
    const exit = state.teleportBuildings.find(t => t.id === portal.pairedId);
    if (exit) {
      // Land on a free neighbour of the exit portal, not the portal tile itself
      const neighbours = hexNeighbors(exit.pos).filter(h => {
        if (hexDistance({ q: 0, r: 0 }, h) > state.mapRadius) return false;
        if (state.walls.has(hexKey(h))) return false;
        if (getUnitAt(state, h)) return false;
        return true;
      });
      if (neighbours.length > 0) {
        unit.pos = { ...neighbours[0]! };
      }
    }
  }

  // §23-25 — trampling an enemy-owned road pillages it.
  pillageRoadIfEnemy(state, unit);

  revealForPlayer(state, unit.playerId, unit.pos, unit.stats.vision);
  updateHighlights(state);

  return { moved: true };
}

// ── Combat ──
//
// Balance v3 (2026-08-21): competitive combat is now fully deterministic — no
// RNG multiplier. Uncertainty should come from the opponent's plan and
// positioning, not damage variance. Per-unit hard-counter multipliers
// (old spearsman 3x/4x) are gone too; type matchups now come from the shared
// soft-counter class matrix in ./combat.ts (max 1.35x, never a hard immunity).
// The damage formula itself (25% floor, health-scaled) also lives there —
// see calculateDamage in ./combat.ts for the actual math.
//
// hpFraction scales the damage by the attacker's CURRENT health (hp / maxHp), so
// a wounded unit hits softer, but never below half strength. This is what gives
// attacking first a real edge: the attacker strikes at full strength, and the
// defender fights back (if it can) from its reduced post-hit health.

export interface SplashHit {
  unitId: string;
  damage: number;
  killed: boolean;
}

export interface CombatResult {
  damageDealt: number;
  damageReceived: number;
  targetKilled: boolean;
  attackerKilled: boolean;
  targetEncirclement: EncirclementInfo;
  attackerEncirclement: EncirclementInfo;
  splashHits: SplashHit[];
  typeBonus: number;
}

export function attackUnit(state: GameState, targetPos: HexCoord): CombatResult | null {
  // No combat during the pre-game faction-reveal pause (§3).
  if (isMatchSetupRestricted(state)) return null;
  const attacker = state.units.find(u => u.id === state.selectedUnitId);
  if (!attacker || attacker.hasAttacked) return null;
  if (attacker.stats.cantShootAfterMove && attacker.hasMoved) return null;

  const isValid = state.attackHexes.some(h => hexEqual(h, targetPos));
  if (!isValid) return null;

  const target = getUnitAt(state, targetPos);
  if (!target) return null;

  const targetEncirclement = calculateEncirclement(state, target);
  const attackerEncirclement = calculateEncirclement(state, attacker);

  const targetDef = getEffectiveDefense(state, target);
  const attackerDef = getEffectiveDefense(state, attacker);

  // Sequential resolution: the attacker strikes first, scaled by its own current
  // health; a landed attack always deals at least 1.
  const attackerHpFrac = attacker.hp / attacker.stats.maxHp;
  const typeBonus = getUnitTypeMultiplier(attacker.type, target.type);
  let damageDealt = calculateDamage(getEffectiveAttack(state, attacker), targetDef, targetEncirclement.attackMultiplier, typeBonus, attackerHpFrac);
  if (damageDealt < 1) damageDealt = 1;
  target.hp -= damageDealt;

  const targetKilled = target.hp <= 0;
  if (targetKilled) target.hp = 0;

  // Splash. Computed from the *un-encircled* base hit (encirclementMultiplier
  // pinned to 1, neutral 1.0 type multiplier) so a heavily-encircled primary
  // target doesn't cause amplified splash damage across its whole formation.
  const splashHits: SplashHit[] = [];
  if (attacker.stats.splash > 0) {
    const splashTargets = state.units.filter(u =>
      u.hp > 0 && u.id !== target.id && u.playerId !== attacker.playerId &&
      hexDistance(targetPos, u.pos) <= attacker.stats.splash
    );
    for (const splashUnit of splashTargets) {
      const splashDef = getEffectiveDefense(state, splashUnit);
      const splashDmg = Math.round(
        calculateDamage(getEffectiveAttack(state, attacker), splashDef, 1, 1, attackerHpFrac) * attacker.stats.splashFactor
      );
      splashUnit.hp -= splashDmg;
      const killed = splashUnit.hp <= 0;
      if (killed) splashUnit.hp = 0;
      splashHits.push({ unitId: splashUnit.id, damage: splashDmg, killed });
    }
  }

  // Revenge
  let damageReceived = 0;
  let attackerKilled = false;

  // Fight-back happens only if the surviving defender can actually reach the
  // attacker — i.e. the attacker sits within the defender's effective attack
  // range (tech/terrain modifiers included). A melee unit cannot counter a
  // catapult shelling it from 3 tiles; a defender whose range covers the
  // attacker can. (Replaces the old per-unit `canBeRevenged` immunity.)
  if (!targetKilled) {
    const dist = hexDistance(attacker.pos, target.pos);
    const targetEffRange = getEffectiveRange(state, target);
    if (dist <= targetEffRange) {
      // Fight-back is scaled by the defender's REMAINING health (after the hit it
      // just took), so a badly-wounded survivor counters weakly. A dead defender
      // never reaches here (guarded by !targetKilled above).
      const defenderHpFrac = target.hp / target.stats.maxHp;
      const revengeTypeBonus = getUnitTypeMultiplier(target.type, attacker.type);
      damageReceived = calculateDamage(getEffectiveAttack(state, target), attackerDef, attackerEncirclement.attackMultiplier, revengeTypeBonus, defenderHpFrac);
      if (damageReceived < 1) damageReceived = 1;
      attacker.hp -= damageReceived;
      attackerKilled = attacker.hp <= 0;
      if (attackerKilled) attacker.hp = 0;
    }
  }

  // Melee unit steps onto killed unit's tile. Purely tactical positioning now
  // (§5 — no capture-by-presence any more, on a site or a Capital).
  if (targetKilled && !attackerKilled && attacker.stats.range === 1) {
    attacker.pos = { ...targetPos };
    revealForPlayer(state, attacker.playerId, attacker.pos, attacker.stats.vision);
  }

  attacker.hasAttacked = true;
  attacker.hasMoved = true;
  updateHighlights(state);
  checkWinCondition(state);

  return { damageDealt, damageReceived, targetKilled, attackerKilled, targetEncirclement, attackerEncirclement, splashHits, typeBonus };
}

// ── Structure combat (§11, §4 of the phase-3 spec) ──
//
// A shared path for attacking ANY structure (Capital, City or Temple) —
// there is no Capital-only special case. Structures never revenge
// (structureCanRevenge = false), never grant melee follow-through (the
// match is already over if a Capital falls, and a City/Temple isn't
// "captured" by stepping onto it), and use the 'siege beats structure' 1.30x
// entry from the shared soft-counter matrix (combat.ts) like any other
// matchup — no separate formula.

export type StructureRef =
  | { kind: 'capital'; capital: Capital }
  | { kind: 'site'; site: StrategicSite }
  | { kind: 'farm'; farm: Farm };

// Only a completed City/Temple, a Capital, or a Farm is a valid combat
// target — neutral, founding and ruined sites have no HP and can't be
// attacked (§13: Farms ARE independently attackable — "see, attack, protect,
// and route around them").
export function getStructureAt(state: GameState, pos: HexCoord): StructureRef | null {
  const capital = state.capitals.find(c => hexEqual(c.pos, pos));
  if (capital) return { kind: 'capital', capital };
  const site = state.strategicSites.find(s => hexEqual(s.pos, pos) && (s.state === 'temple' || s.state === 'upgradingTemple'));
  if (site) return { kind: 'site', site };
  const farm = state.farms.find(f => hexEqual(f.pos, pos) && f.state === 'farm');
  if (farm) return { kind: 'farm', farm };
  return null;
}

function structureOwnerId(ref: StructureRef): number {
  if (ref.kind === 'capital') return ref.capital.playerId;
  if (ref.kind === 'farm') return ref.farm.ownerId;
  return ref.site.ownerId!;
}

function structureDefense(ref: StructureRef): number {
  if (ref.kind === 'capital') return ref.capital.defense;
  if (ref.kind === 'farm') return ref.farm.defense;
  return ref.site.defense;
}

export interface StructureCombatResult {
  damageDealt: number;
  destroyed: boolean;
  gameOver: boolean;
}

export function attackStructure(state: GameState, targetPos: HexCoord): StructureCombatResult | null {
  if (isMatchSetupRestricted(state)) return null;
  const attacker = state.units.find(u => u.id === state.selectedUnitId);
  if (!attacker || attacker.hasAttacked) return null;
  if (attacker.stats.cantShootAfterMove && attacker.hasMoved) return null;

  const isValid = state.structureAttackHexes.some(h => hexEqual(h, targetPos));
  if (!isValid) return null;

  const ref = getStructureAt(state, targetPos);
  if (!ref) return null;
  if (structureOwnerId(ref) === attacker.playerId) return null;

  const typeMult = getTypeMultiplier(UNIT_CLASS[attacker.type], 'structure');
  const attackerHpFrac = attacker.hp / attacker.stats.maxHp;
  // Structures don't participate in encirclement (they don't move or form
  // groups) — no bonus multiplier either way, just the base 1.0x.
  let damageDealt = calculateDamage(getEffectiveAttack(state, attacker), structureDefense(ref), 1, typeMult, attackerHpFrac);
  if (damageDealt < 1) damageDealt = 1;

  let destroyed = false;
  let gameOver = false;
  if (ref.kind === 'capital') {
    ref.capital.hp -= damageDealt;
    destroyed = ref.capital.hp <= 0;
    if (destroyed) ref.capital.hp = 0;
  } else if (ref.kind === 'farm') {
    ref.farm.hp -= damageDealt;
    destroyed = ref.farm.hp <= 0;
    if (destroyed) state.farms = state.farms.filter(f => f.id !== ref.farm.id); // gone outright, no "ruins" for a field
  } else {
    ref.site.hp -= damageDealt;
    destroyed = ref.site.hp <= 0;
    if (destroyed) {
      ref.site.hp = 0;
      // v11 §11 — Temple destruction (whether Temple I, Temple II, or
      // mid-upgrade) goes to Ruins, not a game-over: clear ownership,
      // founding/upgrade progress AND templeLevel — nothing is preserved or
      // transferred to the attacker (see completeFounding/RULES_VERSION v11).
      ref.site.state = 'ruins';
      ref.site.ownerId = null;
      ref.site.founding = null;
      ref.site.upgrade = null;
      ref.site.templeLevel = null;
      ref.site.maxHp = 0;
      ref.site.defense = 0;
    }
  }
  // structureCanRevenge = false — no counter-damage, ever (§4).

  attacker.hasAttacked = true;
  attacker.hasMoved = true;
  updateHighlights(state);
  checkWinCondition(state);
  gameOver = state.phase === 'gameOver';

  return { damageDealt, destroyed, gameOver };
}

// ── Win condition ──

// §5, §11: the ONLY normal victory condition is a Capital reaching 0 HP.
// There is no more "own every site" check, no elimination-by-attrition
// fallback — a Capital is permanent and indestructible except by combat, so
// as long as it stands the game continues no matter what else happens on
// the board.
function checkWinCondition(state: GameState): void {
  const destroyedCapital = state.capitals.find(c => c.hp <= 0);
  if (!destroyedCapital) return;
  state.phase = 'gameOver';
  state.winner = state.players.find(p => p.id !== destroyedCapital.playerId) ?? null;
}

// ── Resign ──

/**
 * Resigns the game on behalf of the given player. Ends the match immediately
 * and declares the opposing player the winner. Idempotent / no-op if the
 * game has already ended.
 *
 * Returns true if the resignation took effect.
 */
export function resignGame(state: GameState, playerId: number): boolean {
  if (state.phase === 'gameOver') return false;
  if (!state.players.some(p => p.id === playerId)) return false;
  state.phase = 'gameOver';
  state.winner = state.players.find(p => p.id !== playerId) ?? null;
  return true;
}

// ── Destroy / disband ──

/**
 * Whether the current player may disband the given unit. Legal for any living
 * unit the current player owns, regardless of hasMoved/hasAttacked/hasCaptured
 * (disbanding is always available on your own turn).
 */
export function canDestroyUnit(state: GameState, unitId: string): boolean {
  const unit = state.units.find(u => u.id === unitId);
  if (!unit || unit.hp <= 0) return false;
  return unit.playerId === getCurrentPlayer(state).id;
}

/**
 * Disband one of your own units. The unit dies (hp = 0) and stays in
 * state.units like any combat casualty, so all existing death handling applies.
 * Grants NO aura or kill credit to anyone — combat kills award nothing either,
 * so simply zeroing hp keeps disbanding neutral. Deliberately excluded from the
 * AI / RL legal-action set (see computeUnitActions in actionDispatcher.ts).
 */
export function destroyUnit(state: GameState, unitId: string): boolean {
  if (!canDestroyUnit(state, unitId)) return false;
  const unit = state.units.find(u => u.id === unitId)!;
  unit.hp = 0;
  if (state.selectedUnitId === unitId) deselectAll(state);
  updateHighlights(state);
  checkWinCondition(state);
  return true;
}

// ── End turn ──

export function endTurn(state: GameState): void {
  if (state.phase === 'gameOver') return;
  // The pre-game faction-reveal pause blocks everything, including this,
  // until both players have locked in a faction (§3).
  if (isAwaitingFactionReveal(state)) return;
  deselectAll(state);

  state.units.forEach(u => {
    if (u.playerId === getCurrentPlayer(state).id) {
      u.hasMoved = false;
      u.hasAttacked = false;
    }
  });
  state.spawnedSiteIds.clear();

  const prevIndex = state.currentPlayerIndex;
  // No more skip-eliminated-player loop: a Capital is permanent and
  // indestructible except by combat (§11), and Capital destruction already
  // ends the game via checkWinCondition — so by the time we get here every
  // remaining player necessarily still has one. Plain rotation.
  const next = (state.currentPlayerIndex + 1) % state.players.length;
  state.currentPlayerIndex = next;
  // Bump turn counter when active player wraps back to the player who started
  // the game (full round complete). Pre-v2.2 this was hard-coded to slot 0;
  // with random first-mover we read it from state instead.
  if (prevIndex !== state.firstPlayerIndex && next === state.firstPlayerIndex) {
    state.turnNumber++;
  }

  const newPlayer = getCurrentPlayer(state);

  // §6, §8 — resolve any founding/Farm construction this player has due,
  // BEFORE granting income, so a structure that completes right now already
  // contributes this turn.
  resolveFoundingForPlayer(state, newPlayer.id);
  resolveFarmFoundingForPlayer(state, newPlayer.id);
  resolveTempleUpgradeForPlayer(state, newPlayer.id);

  // §5 — deploy any due TrainingOrders (units queued by recruiting), which
  // also frees their production slots on success.
  resolveTrainingForPlayer(state, newPlayer.id);

  // §11 (tech-tree pacing pass) — complete any due research, freeing the
  // player's single research slot and applying its effect.
  resolveResearchForPlayer(state, newPlayer.id);

  // §4-19 — real economy: flat base + Agrar's active Farms / Temple's
  // level (I/II). See getPlayerIncome.
  newPlayer.aura += getPlayerIncome(state, newPlayer.id);

  // Healer: restore HP to allies at start of their turn, with distance falloff —
  // full heal within radius 1, half at radius 2, nothing beyond (SUPPORT_RANGE).
  // §27 — multiple Healers near the same ally don't stack; take the best
  // single heal amount, same as the damage/range booster non-stacking rule.
  const healers = state.units.filter(u => u.hp > 0 && u.playerId === newPlayer.id && u.type === 'healer');
  for (const ally of state.units) {
    if (ally.hp <= 0 || ally.playerId !== newPlayer.id) continue;
    let heal = 0;
    for (const healer of healers) {
      if (healer.id === ally.id) continue;
      const dist = hexDistance(healer.pos, ally.pos);
      heal = Math.max(heal, supportFalloffAmount(HEALER_HEAL_AMOUNT, dist));
    }
    if (heal > 0) ally.hp = Math.min(ally.stats.maxHp, ally.hp + heal);
  }

  updateVisibility(state, newPlayer.id);
  checkWinCondition(state);
}

// ── Teleport buildings ──

let teleportIdCounter = 0;

export function getTeleportAt(state: GameState, pos: HexCoord): TeleportBuilding | undefined {
  return state.teleportBuildings.find(t => hexEqual(t.pos, pos));
}

// Single source of truth for teleport-portal placement validity. A portal may sit
// on any reachable terrain (plains, hills, forests) within TELEPORT_RADIUS of the
// owning structure (Capital or completed City/Temple), but NOT on:
//   • walls (the impassable rock mountains — a unit could never step on the portal)
//   • the structure's own tile
//   • a tile that already holds a portal
//   • a tile occupied by a unit
//   • off-map tiles
// The placement highlight (main.ts buildHexes) and the actual placement rule
// (buildTeleportPair) BOTH go through this predicate so the highlighted set is
// exactly the placeable set.
export function isValidTeleportHex(state: GameState, anchor: { pos: HexCoord }, hex: HexCoord): boolean {
  if (hexDistance(anchor.pos, hex) > TELEPORT_RADIUS) return false;
  if (hexDistance({ q: 0, r: 0 }, hex) > state.mapRadius) return false;
  const key = hexKey(hex);
  if (state.walls.has(key)) return false;       // mountains — impassable
  if (hexEqual(hex, anchor.pos)) return false;   // not on the structure's own tile
  if (getTeleportAt(state, hex)) return false;   // already has a portal
  if (getUnitAt(state, hex)) return false;       // occupied by a unit
  return true;
}

export function getValidTeleportHexes(state: GameState, anchorId: string): HexCoord[] {
  const anchor = getOwnedStructures(state, getCurrentPlayer(state).id).find(s => s.id === anchorId);
  if (!anchor) return [];
  const result: HexCoord[] = [];
  for (let dq = -TELEPORT_RADIUS; dq <= TELEPORT_RADIUS; dq++) {
    for (let dr = Math.max(-TELEPORT_RADIUS, -dq - TELEPORT_RADIUS); dr <= Math.min(TELEPORT_RADIUS, -dq + TELEPORT_RADIUS); dr++) {
      const hex: HexCoord = { q: anchor.pos.q + dq, r: anchor.pos.r + dr };
      if (isValidTeleportHex(state, anchor, hex)) result.push(hex);
    }
  }
  return result;
}

// Valid hexes for the second portal: near any other owned structure that doesn't yet have a portal.
export function getValidTeleportHexesForOtherTemples(state: GameState, excludeAnchorId: string): HexCoord[] {
  const player = getCurrentPlayer(state);
  const result: HexCoord[] = [];
  for (const anchor of getOwnedStructures(state, player.id)) {
    if (anchor.id === excludeAnchorId) continue;
    const existing = state.teleportBuildings.filter(b => b.templeId === anchor.id);
    if (existing.length >= TELEPORT_MAX_PER_TEMPLE) continue;
    result.push(...getValidTeleportHexes(state, anchor.id));
  }
  return result;
}

// §45 (phase 11 correction) — teleports are fully dormant: the 'teleports'
// tech no longer exists in TECH_NODES, so it can never be researched, and
// this always returns false. Not exposed in UI, not constructible.
export function canBuildTeleportPair(_state: GameState, _anchorId: string): boolean {
  return false;
}

export function buildTeleportPair(
  state: GameState,
  anchorIdA: string,
  posA: HexCoord,
  posB: HexCoord,
): boolean {
  if (!canBuildTeleportPair(state, anchorIdA)) return false;
  const validHexesA = getValidTeleportHexes(state, anchorIdA);
  if (!validHexesA.some(h => hexEqual(h, posA))) return false;
  const validHexesB = getValidTeleportHexesForOtherTemples(state, anchorIdA);
  if (!validHexesB.some(h => hexEqual(h, posB))) return false;
  if (hexEqual(posA, posB)) return false;
  // Determine which owned structure posB belongs to
  const player = getCurrentPlayer(state);
  const anchorB = getOwnedStructures(state, player.id).find(a =>
    a.id !== anchorIdA &&
    state.teleportBuildings.filter(b => b.templeId === a.id).length < TELEPORT_MAX_PER_TEMPLE &&
    isValidTeleportHex(state, a, posB),
  );
  if (!anchorB) return false;
  player.aura -= TELEPORT_BUILD_COST;
  const idA = `tp_${teleportIdCounter++}`;
  const idB = `tp_${teleportIdCounter++}`;
  state.teleportBuildings.push({ id: idA, pos: { ...posA }, builtByPlayerId: player.id, templeId: anchorIdA, pairedId: idB });
  state.teleportBuildings.push({ id: idB, pos: { ...posB }, builtByPlayerId: player.id, templeId: anchorB.id, pairedId: idA });
  return true;
}
