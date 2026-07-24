import {
  GameState, Unit, UnitStats, UnitType, Player, HexCoord, Temple,
  UNIT_COSTS, HILL_DEFENSE_BONUS, HILL_VISION_BONUS, HILL_RANGE_BONUS,
  TEMPLE_AURA_PER_LEVEL, TEMPLE_MAX_LEVEL, TEMPLE_POP_CAP_PER_LEVEL, templeUpgradeCost,
  templeEconomyLevel,
  SUPPORT_RANGE, RANGE_BOOST_RADIUS,
  TechId, TechNode, TECH_NODES, PlayerTech,
  TeleportBuilding, TELEPORT_BUILD_COST, TELEPORT_RADIUS, TELEPORT_MAX_PER_TEMPLE,
  PLAYER_COLORS, mapRadiusForPlayers, templeCountForPlayers,
} from './types';
import {
  hexDistance, hexEqual, hexNeighbors, getReachableHexes,
  hexKey, generateHexMap, DIRECTIONS, OPPOSING_PAIRS, hexLineDraw,
} from './hex';

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
  maxHp: 15, attack: 10, defense: 5, speed: 2,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 2, cantShootAfterMove: false,
  attackBonusAgainst: { horserider: 3.0, heavyknight: 4.0 },
  // Balance v2 (2026-05-17): defense bonus capped from 3×→2× (vs horse) and
  // 6×→2.5× (vs HK). Previous values made a 2⚡ spearsman hard-counter a 7⚡
  // heavy knight (1v1 win with full HP). counter_v1 swept the v2 tournament at
  // 88.9% because the cavalry-heavy field couldn't trade into spearsmen. Keeps
  // the spearsman as the cavalry counter, but a soft counter, not a hard one.
  defenseBonusAgainst: { horserider: 2.0, heavyknight: 2.5 },
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

export const HEALER_HEAL_AMOUNT = 5;
export const DAMAGE_BOOST_AMOUNT = 5;
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
};

// ── Tech helpers ──

export const DEFAULT_UNLOCKED_UNITS: UnitType[] = ['warrior', 'archer', 'horserider'];

export function getUnlockedUnits(tech: PlayerTech): Set<UnitType> {
  const unlocked = new Set<UnitType>(DEFAULT_UNLOCKED_UNITS);
  for (const node of TECH_NODES) {
    if (node.unitUnlock && tech.researched.has(node.id)) {
      unlocked.add(node.unitUnlock);
    }
  }
  return unlocked;
}

/**
 * Deep-copy a base UnitStats, cloning the nested bonus dicts so the copy never
 * shares the `attackBonusAgainst`/`defenseBonusAgainst` objects with the shared
 * UNIT_STATS singletons. Used by both `createUnit` and `rebuildUnitStats` so the
 * two paths produce identical, fully-independent stat objects.
 */
function cloneStats(base: UnitStats): UnitStats {
  return {
    ...base,
    attackBonusAgainst: { ...(base.attackBonusAgainst ?? {}) },
    defenseBonusAgainst: { ...(base.defenseBonusAgainst ?? {}) },
  };
}

function applyTechToStats(stats: UnitStats, type: UnitType, tech: PlayerTech): UnitStats {
  const r = tech.researched;
  if (r.has('roads')) stats.speed += 1;
  if (r.has('infantry_move') && (type === 'warrior' || type === 'spearsman')) stats.speed += 1;
  if (r.has('longrange_hp') && (type === 'archer' || type === 'catapult')) stats.maxHp += 5;
  if (r.has('catapult_splash') && type === 'catapult') { stats.splash = 1; stats.splashFactor = 0.5; }
  if (r.has('horse_sight') && (type === 'horserider' || type === 'heavyknight')) stats.vision += 1;
  return stats;
}

/**
 * Rebuild a living unit's stats from base + currently-researched tech. Used
 * by `researchTech()` to retroactively apply tech effects to units that were
 * spawned before the tech was researched.
 *
 * Idempotent — always starts from `UNIT_STATS[unit.type]`, so calling multiple
 * times never double-applies. Preserves current HP (and clamps it to the new
 * maxHp if max ever shrinks — currently nothing shrinks, but the guard makes
 * future tech changes safe).
 */
function rebuildUnitStats(unit: Unit, tech: PlayerTech): void {
  const fresh = cloneStats(UNIT_STATS[unit.type]);
  applyTechToStats(fresh, unit.type, tech);
  unit.stats = fresh;
  if (unit.hp > fresh.maxHp) unit.hp = fresh.maxHp;
}

// ── Factories ──

let unitIdCounter = 0;
let templeIdCounter = 0;

// Called by server after deserializing saved state to prevent ID collisions
export function resetCounters(unitMax: number, templeMax: number, tpMax: number): void {
  unitIdCounter = unitMax;
  templeIdCounter = templeMax;
  teleportIdCounter = tpMax;
}

// Additive: snapshot the global ID counters. Used only by the ML fidelity test
// (ml/bcRecord.ts) to replay a turn producing the SAME unit/temple/teleport ids
// as the original. No behavior change; nothing in the game paths reads this.
export function getCounters(): [number, number, number] {
  return [unitIdCounter, templeIdCounter, teleportIdCounter];
}

function createUnit(type: UnitType, playerId: number, pos: HexCoord, tech?: PlayerTech): Unit {
  const stats = cloneStats(UNIT_STATS[type]);
  if (tech) applyTechToStats(stats, type, tech);
  return {
    id: `unit_${unitIdCounter++}`,
    type, playerId,
    stats,
    hp: stats.maxHp,
    pos: { ...pos },
    hasMoved: false,
    hasAttacked: false,
    hasCaptured: false,
  };
}

function createTemple(pos: HexCoord, ownerId: number | null): Temple {
  return {
    id: `temple_${templeIdCounter++}`,
    pos: { ...pos },
    ownerId,
    level: 1,
  };
}

// ── Player config ──

export interface PlayerConfig {
  name: string;
  color: string;
}

const DEFAULT_PLAYERS: PlayerConfig[] = [
  { name: 'Player 1', color: '#ff4444' },
  { name: 'AI', color: '#4488ff' },
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

export function updateVisibility(state: GameState, playerId: number): void {
  const units = state.units.filter(u => u.hp > 0 && u.playerId === playerId);
  for (const unit of units) {
    revealForPlayer(state, playerId, unit.pos, unit.stats.vision);
  }
  const temples = state.temples.filter(t => t.ownerId === playerId);
  for (const temple of temples) {
    revealForPlayer(state, playerId, temple.pos, 2);
  }
}

export function isForestUnitRevealed(state: GameState, unitPos: HexCoord, observerPlayerId: number): boolean {
  if (!state.forests.has(hexKey(unitPos))) return true;

  const friendlies = state.units.filter(u => u.hp > 0 && u.playerId === observerPlayerId);
  for (const f of friendlies) {
    if (hexDistance(f.pos, unitPos) <= 1) return true;
  }
  const ownedTemples = state.temples.filter(t => t.ownerId === observerPlayerId);
  for (const t of ownedTemples) {
    if (hexDistance(t.pos, unitPos) <= 1) return true;
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
  const temples = state.temples.filter(t => t.ownerId === playerId);
  for (const temple of temples) {
    for (const hex of getVisibleHexes(temple.pos, 2, state.mapRadius, state.forests, state.hills)) {
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

export function getSupportBoostsForUnit(state: GameState, unit: Unit): { damageBonus: number; rangeBonus: number } {
  let damageBonus = 0;
  let rangeBonus = 0;
  for (const ally of state.units) {
    if (ally.hp <= 0 || ally.playerId !== unit.playerId || ally.id === unit.id) continue;
    const dist = hexDistance(ally.pos, unit.pos);
    if (ally.type === 'damageBooster') {
      damageBonus += supportFalloffAmount(DAMAGE_BOOST_AMOUNT, dist);
    } else if (ally.type === 'rangeBooster') {
      // Range boost is binary within a tight radius — a fractional range bonus
      // makes no sense, so no falloff: full +RANGE within RANGE_BOOST_RADIUS.
      if (dist <= RANGE_BOOST_RADIUS) rangeBonus += RANGE_BOOST_AMOUNT;
    }
  }
  return { damageBonus, rangeBonus };
}

// ── Effective stats (with hill + support bonuses) ──

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

// ── Population cap ──

export function getPopulationCap(state: GameState, playerId: number): number {
  return state.temples
    .filter(t => t.ownerId === playerId)
    .reduce((sum, t) => sum + templeEconomyLevel(t.level) * TEMPLE_POP_CAP_PER_LEVEL, 0);
}

export function getPopulationCount(state: GameState, playerId: number): number {
  return state.units.filter(u => u.hp > 0 && u.playerId === playerId).length;
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

const STARTING_UNITS_PER_PLAYER = 2;

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!; arr[i] = arr[j]!; arr[j] = tmp;
  }
  return arr;
}

interface TempleLayout {
  starts: HexCoord[];            // one start temple per player (index === player id)
  neutrals: HexCoord[];          // shared neutral temples
  unitPositions: HexCoord[][];   // per-player starting-unit positions
}

// Randomly place N start temples + M neutral temples so that:
//  • no two temples are closer than MIN_TEMPLE_SEPARATION (hex distance),
//  • player starts are spread out (prefer a larger separation, backing off until
//    a layout is found) and never adjacent to each other,
//  • each start temple has room for its starting units on free neighbour tiles,
//  • temples MAY sit on the map border (edge hexes are eligible).
// Never hangs / crashes: the separation is relaxed down to MIN_TEMPLE_SEPARATION,
// and a guaranteed best-effort fallback runs if the constraints can't be met.
function placeTemples(mapRadius: number, numPlayers: number, numNeutral: number): TempleLayout {
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

  // Build several complete layouts and keep the most spread-out one (largest
  // minimum pairwise temple distance).
  let bestLayout: TempleLayout | null = null;
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
  console.warn(`[placeTemples] spread placement failed (radius=${mapRadius} players=${numPlayers} neutral=${numNeutral}); using relaxed greedy fallback`);
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
  const numNeutral = templeCountForPlayers(numPlayers) - numPlayers;

  // Balance v2.2 (2026-05-17): Symmetric starting aura. The proper fix for the
  // first-mover gap is randomizing who acts first (see `firstPlayer` below) so
  // no slot is "fixed P0"; with that, asymmetric aura would itself be unfair.
  const players: Player[] = configs.map((cfg, i) => ({
    id: i,
    name: cfg.name,
    color: cfg.color || PLAYER_COLORS[i % PLAYER_COLORS.length]!,
    aura: 2,
  }));

  const playerTech: PlayerTech[] = players.map(() => ({ researched: new Set<TechId>() }));

  // Change #5: randomized temple placement each game (starts + neutrals), with a
  // minimum separation. Temples may sit on the border.
  const layout = placeTemples(mapRadius, numPlayers, numNeutral);

  const temples: Temple[] = [];
  layout.starts.forEach((pos, i) => {
    const t = createTemple(pos, i);
    temples.push(t);
    players[i]!.startTempleId = t.id; // durable "home temple" signal for the AI
  });
  for (const pos of layout.neutrals) temples.push(createTemple(pos, null));

  const allUnitPositions = layout.unitPositions.flat();
  const { hills, walls, forests } = generateTerrain(mapRadius, temples.map(t => t.pos), allUnitPositions);

  const units: Unit[] = [];
  layout.unitPositions.forEach((positions, playerId) => {
    for (const pos of positions) units.push(createUnit('warrior', playerId, pos));
  });

  const explored: Set<string>[] = players.map(() => new Set<string>());

  // Balance v2.2 (2026-05-17): Random first-mover, generalized to N players.
  const firstPlayer = Math.floor(Math.random() * numPlayers);

  const state: GameState = {
    players, units, temples, hills, walls, forests, explored,
    currentPlayerIndex: firstPlayer, firstPlayerIndex: firstPlayer,
    phase: 'playing', mapRadius,
    winner: null,
    turnNumber: 1,
    selectedUnitId: null, selectedTempleId: null, selectionMode: null,
    moveHexes: [], attackHexes: [], supportHexes: [],
    spawnedTempleIds: new Set(),
    playerTech,
    teleportBuildings: [],
    buildHexes: [],
  };

  for (const player of players) {
    updateVisibility(state, player.id);
  }

  return state;
}

// ── Getters ──

export function getCurrentPlayer(state: GameState): Player {
  return state.players[state.currentPlayerIndex]!;
}

export function getUnitAt(state: GameState, pos: HexCoord): Unit | undefined {
  return state.units.find(u => hexEqual(u.pos, pos) && u.hp > 0);
}

export function getTempleAt(state: GameState, pos: HexCoord): Temple | undefined {
  return state.temples.find(t => hexEqual(t.pos, pos));
}

// ── Temple capture ──

export function canCaptureTemple(state: GameState, unit: Unit): Temple | null {
  // Capture is a separate action from move/attack: it does NOT consume
  // hasMoved/hasAttacked. A unit that already moved this turn (or is standing
  // on a temple from a previous turn without having acted yet) can still
  // capture — but only once per turn.
  if (unit.hasCaptured) return null;
  const temple = getTempleAt(state, unit.pos);
  if (!temple) return null;
  if (temple.ownerId === unit.playerId) return null;
  return temple;
}

export function captureTemple(state: GameState, unit: Unit, temple: Temple): void {
  temple.ownerId = unit.playerId;
  unit.hasCaptured = true;
  updateVisibility(state, unit.playerId);
  checkWinCondition(state);
}

// Auto-capture a temple the unit is now standing on (once per turn via the
// hasCaptured guard inside canCaptureTemple/captureTemple). Called from every
// path that changes a unit's position so capture is deterministic across local
// play, AI, multiplayer, and replays.
function autoCapture(state: GameState, unit: Unit): void {
  const t = canCaptureTemple(state, unit);
  if (t) captureTemple(state, unit, t);
}

// ── Temple upgrade ──

export function canUpgradeTemple(state: GameState, templeId: string): number | null {
  const temple = state.temples.find(t => t.id === templeId);
  if (!temple || temple.ownerId !== getCurrentPlayer(state).id) return null;
  const cost = templeUpgradeCost(temple.level);
  if (cost === null) return null;
  if (getCurrentPlayer(state).aura < cost) return null;
  return cost;
}

export function upgradeTemple(state: GameState, templeId: string): boolean {
  const cost = canUpgradeTemple(state, templeId);
  if (cost === null) return false;
  const temple = state.temples.find(t => t.id === templeId)!;
  getCurrentPlayer(state).aura -= cost;
  temple.level++;
  return true;
}

// ── Tech research ──

export function canResearch(state: GameState, techId: TechId): boolean {
  const player = getCurrentPlayer(state);
  const tech = state.playerTech[player.id]!;
  if (tech.researched.has(techId)) return false;

  const node = TECH_NODES.find(n => n.id === techId);
  if (!node) return false;

  for (const prereq of node.prereqs) {
    if (!tech.researched.has(prereq)) return false;
  }

  if (node.branch) {
    const branchNodes = TECH_NODES.filter(n => n.branch === node.branch);
    for (const bn of branchNodes) {
      if (bn.id !== techId && tech.researched.has(bn.id)) return false;
    }
  }

  return player.aura >= node.cost;
}

export function researchTech(state: GameState, techId: TechId): boolean {
  if (!canResearch(state, techId)) return false;
  const player = getCurrentPlayer(state);
  const node = TECH_NODES.find(n => n.id === techId)!;
  player.aura -= node.cost;
  state.playerTech[player.id]!.researched.add(techId);

  // Retroactively apply this tech (and any previously-researched tech that
  // happened to be missing from a unit's stats) to every living unit owned
  // by the researcher. Without this, `applyTechToStats` only fires at
  // `createUnit` time, so existing units never benefit from techs like
  // `roads`, `infantry_move`, `longrange_hp`, or `horse_sight` — bug
  // discovered in REPORT.md §6.
  const tech = state.playerTech[player.id]!;
  for (const unit of state.units) {
    if (unit.playerId !== player.id || unit.hp <= 0) continue;
    rebuildUnitStats(unit, tech);
  }

  return true;
}

// ── Spawning ──

export function canAfford(state: GameState, unitType: UnitType): boolean {
  const player = getCurrentPlayer(state);
  if (player.aura < UNIT_COSTS[unitType]) return false;
  // Check population cap
  const cap = getPopulationCap(state, player.id);
  const count = getPopulationCount(state, player.id);
  if (count >= cap) return false;
  // Check unit is unlocked via tech
  const unlocked = getUnlockedUnits(state.playerTech[player.id]!);
  return unlocked.has(unitType);
}

export function spawnUnit(state: GameState, templeId: string, unitType: UnitType): boolean {
  const temple = state.temples.find(t => t.id === templeId);
  if (!temple || temple.ownerId !== getCurrentPlayer(state).id) return false;

  // A temple may spawn MORE THAN ONE unit per turn — there is no per-turn spawn
  // gate. Successive spawns are naturally throttled by the tile-occupancy check
  // below: the freshly spawned unit stands on the temple, so the player must
  // move it off before the temple can spawn the next unit.

  const player = getCurrentPlayer(state);
  const cost = UNIT_COSTS[unitType];
  if (player.aura < cost) return false;

  // Population cap check
  const cap = getPopulationCap(state, player.id);
  const count = getPopulationCount(state, player.id);
  if (count >= cap) return false;

  // Tech unlock check
  const unlocked = getUnlockedUnits(state.playerTech[player.id]!);
  if (!unlocked.has(unitType)) return false;

  if (getUnitAt(state, temple.pos)) return false;

  player.aura -= cost;
  const unit = createUnit(unitType, player.id, temple.pos, state.playerTech[player.id]);
  // Unit may move and attack on the turn it is spawned
  unit.hasMoved = false;
  unit.hasAttacked = false;
  state.units.push(unit);

  state.spawnedTempleIds.add(templeId);

  revealForPlayer(state, player.id, unit.pos, unit.stats.vision);

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

function isBlockedHex(hex: HexCoord, targetPlayerId: number, aliveUnits: Unit[], mapRadius: number, group: Set<string>): boolean {
  if (group.has(hexKey(hex))) return false;
  if (hexDistance({ q: 0, r: 0 }, hex) > mapRadius) return true;
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
    if (isBlockedHex(hex, targetUnit.playerId, aliveUnits, state.mapRadius, group)) {
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
      if (isBlockedHex(hexA, targetUnit.playerId, aliveUnits, state.mapRadius, group) &&
          isBlockedHex(hexB, targetUnit.playerId, aliveUnits, state.mapRadius, group)) {
        pinchCount++;
      }
    }
  }

  const opposingRatio = pinchMax > 0 ? pinchCount / pinchMax : 0;

  let encirclementBonus = 0;
  if (ratio > 0.5) {
    encirclementBonus = ((ratio - 0.5) / 0.5) * 0.5;
  }
  const opposingBonus = opposingRatio * 0.5;
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
  state.supportHexes = [];

  if (state.selectionMode === 'temple') return;

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
    state.moveHexes = getReachableHexes(unit.pos, unit.stats.speed, state.mapRadius, [...occupied, ...wallPositions], state.hills);
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
  }
}

export function selectUnit(state: GameState, unitId: string): void {
  const unit = state.units.find(u => u.id === unitId);
  if (!unit || unit.playerId !== getCurrentPlayer(state).id) return;
  state.selectedUnitId = unitId;
  state.selectedTempleId = null;
  state.selectionMode = 'unit';
  updateHighlights(state);
}

export function selectTemple(state: GameState, templeId: string): void {
  const temple = state.temples.find(t => t.id === templeId);
  if (!temple || temple.ownerId !== getCurrentPlayer(state).id) return;
  state.selectedTempleId = templeId;
  state.selectedUnitId = null;
  state.selectionMode = 'temple';
  updateHighlights(state);
}

export function deselectAll(state: GameState): void {
  state.selectedUnitId = null;
  state.selectedTempleId = null;
  state.selectionMode = null;
  state.moveHexes = [];
  state.attackHexes = [];
  state.supportHexes = [];
}

export interface MoveResult {
  moved: boolean;
}

export function moveUnit(state: GameState, dest: HexCoord): MoveResult {
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

  revealForPlayer(state, unit.playerId, unit.pos, unit.stats.vision);
  autoCapture(state, unit);
  updateHighlights(state);

  return { moved: true };
}

// ── Combat ──

function randomMultiplier(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const value = 1.0 + z * 0.2;
  return Math.max(0.5, Math.min(1.5, value));
}

function getAttackTypeBonus(attacker: Unit, target: Unit): number {
  return attacker.stats.attackBonusAgainst?.[target.type] ?? 1;
}

function getDefenseTypeBonus(defender: Unit, attacker: Unit): number {
  return defender.stats.defenseBonusAgainst?.[attacker.type] ?? 1;
}

// hpFraction scales the damage by the attacker's CURRENT health (hp / maxHp), so
// a wounded unit hits softer. This is what gives attacking first a real edge: the
// attacker strikes at full strength, and the defender fights back (if it can) from
// its reduced post-hit health.
function calculateDamage(attackerAtk: number, defenderDef: number, encirclementMultiplier: number, typeBonus = 1, hpFraction = 1): number {
  const multiplier = randomMultiplier();
  const raw = multiplier * encirclementMultiplier * typeBonus * (attackerAtk - defenderDef) * hpFraction;
  return Math.max(0, Math.round(raw));
}

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
  const typeBonus = getAttackTypeBonus(attacker, target) / getDefenseTypeBonus(target, attacker);
  let damageDealt = calculateDamage(getEffectiveAttack(state, attacker), targetDef, targetEncirclement.attackMultiplier, typeBonus, attackerHpFrac);
  if (damageDealt < 1) damageDealt = 1;
  target.hp -= damageDealt;

  const targetKilled = target.hp <= 0;
  if (targetKilled) target.hp = 0;

  // Splash
  const splashHits: SplashHit[] = [];
  if (attacker.stats.splash > 0) {
    const splashTargets = state.units.filter(u =>
      u.hp > 0 && u.id !== target.id && u.playerId !== attacker.playerId &&
      hexDistance(targetPos, u.pos) <= attacker.stats.splash
    );
    for (const splashUnit of splashTargets) {
      const splashEnc = calculateEncirclement(state, splashUnit);
      const splashDef = getEffectiveDefense(state, splashUnit);
      const splashDmg = Math.round(
        calculateDamage(getEffectiveAttack(state, attacker), splashDef, splashEnc.attackMultiplier, 1, attackerHpFrac) * attacker.stats.splashFactor
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
      const revengeTypeBonus = getAttackTypeBonus(target, attacker) / getDefenseTypeBonus(attacker, target);
      damageReceived = calculateDamage(getEffectiveAttack(state, target), attackerDef, attackerEncirclement.attackMultiplier, revengeTypeBonus, defenderHpFrac);
      if (damageReceived < 1) damageReceived = 1;
      attacker.hp -= damageReceived;
      attackerKilled = attacker.hp <= 0;
      if (attackerKilled) attacker.hp = 0;
    }
  }

  // Melee unit steps onto killed unit's tile
  if (targetKilled && !attackerKilled && attacker.stats.range === 1) {
    attacker.pos = { ...targetPos };
    revealForPlayer(state, attacker.playerId, attacker.pos, attacker.stats.vision);
    autoCapture(state, attacker);
  }

  attacker.hasAttacked = true;
  attacker.hasMoved = true;
  updateHighlights(state);
  checkWinCondition(state);

  return { damageDealt, damageReceived, targetKilled, attackerKilled, targetEncirclement, attackerEncirclement, splashHits, typeBonus };
}

// ── Win condition ──

function checkWinCondition(state: GameState): void {
  if (state.temples.length > 0) {
    for (const player of state.players) {
      if (state.temples.every(t => t.ownerId === player.id)) {
        state.phase = 'gameOver';
        state.winner = player;
        return;
      }
    }
  }

  const alivePlayers = state.players.filter(p =>
    state.units.some(u => u.playerId === p.id && u.hp > 0) ||
    state.temples.some(t => t.ownerId === p.id)
  );
  if (alivePlayers.length === 1) {
    state.phase = 'gameOver';
    state.winner = alivePlayers[0]!;
  } else if (alivePlayers.length === 0) {
    state.phase = 'gameOver';
    state.winner = null;
  }
}

// ── Resign ──

/**
 * Resigns the game on behalf of the given player. Sets phase = 'gameOver' and
 * declares the opposing player the winner. Idempotent / no-op if the game has
 * already ended.
 *
 * Returns true if the resignation took effect.
 */
export function resignGame(state: GameState, playerId: number): boolean {
  if (state.phase === 'gameOver') return false;
  if (!state.players.some(p => p.id === playerId)) return false;
  // Eliminate the resigner: their units die and their temples go neutral. With
  // 2 players this immediately leaves one player standing (win). With N players
  // the game continues until only one remains — checkWinCondition handles both.
  for (const u of state.units) {
    if (u.playerId === playerId) u.hp = 0;
  }
  for (const t of state.temples) {
    if (t.ownerId === playerId) t.ownerId = null;
  }
  checkWinCondition(state);
  // If the resigner was the active player and the game isn't over, advance past
  // them to the next surviving player. (Cast avoids a literal-type narrowing
  // false-positive: checkWinCondition may have set phase to 'gameOver'.)
  if ((state.phase as string) !== 'gameOver' && state.currentPlayerIndex === playerId) {
    endTurn(state);
  }
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
  deselectAll(state);

  state.units.forEach(u => {
    if (u.playerId === getCurrentPlayer(state).id) {
      u.hasMoved = false;
      u.hasAttacked = false;
      u.hasCaptured = false;
    }
  });
  state.spawnedTempleIds.clear();

  const prevIndex = state.currentPlayerIndex;
  let next = (state.currentPlayerIndex + 1) % state.players.length;
  while (next !== state.currentPlayerIndex) {
    const hasUnits = state.units.some(u => u.playerId === state.players[next]!.id && u.hp > 0);
    const hasTemples = state.temples.some(t => t.ownerId === state.players[next]!.id);
    if (hasUnits || hasTemples) break;
    next = (next + 1) % state.players.length;
  }
  state.currentPlayerIndex = next;
  // Bump turn counter when active player wraps back to the player who started
  // the game (full round complete). Pre-v2.2 this was hard-coded to slot 0;
  // with random first-mover we read it from state instead.
  if (prevIndex !== state.firstPlayerIndex && next === state.firstPlayerIndex) {
    state.turnNumber++;
  }

  // Grant aura income: effective-level × TEMPLE_AURA_PER_LEVEL per owned temple
  // (plateaus at TEMPLE_ECONOMY_CAP_LEVEL, no depletion)
  const newPlayer = getCurrentPlayer(state);
  const ownedTemples = state.temples.filter(t => t.ownerId === newPlayer.id);
  for (const temple of ownedTemples) {
    newPlayer.aura += templeEconomyLevel(temple.level) * TEMPLE_AURA_PER_LEVEL;
  }

  // Healer: restore HP to allies at start of their turn, with distance falloff —
  // full heal within radius 1, half at radius 2, nothing beyond (SUPPORT_RANGE).
  const healers = state.units.filter(u => u.hp > 0 && u.playerId === newPlayer.id && u.type === 'healer');
  for (const healer of healers) {
    for (const ally of state.units) {
      if (ally.hp <= 0 || ally.playerId !== newPlayer.id || ally.id === healer.id) continue;
      const dist = hexDistance(healer.pos, ally.pos);
      const heal = supportFalloffAmount(HEALER_HEAL_AMOUNT, dist);
      if (heal > 0) ally.hp = Math.min(ally.stats.maxHp, ally.hp + heal);
    }
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
// owning temple, but NOT on:
//   • walls (the impassable rock mountains — a unit could never step on the portal)
//   • the temple tile itself
//   • a tile that already holds a portal
//   • a tile occupied by a unit
//   • off-map tiles
// The placement highlight (main.ts buildHexes) and the actual placement rule
// (buildTeleportPair) BOTH go through this predicate so the highlighted set is
// exactly the placeable set.
export function isValidTeleportHex(state: GameState, temple: Temple, hex: HexCoord): boolean {
  if (hexDistance(temple.pos, hex) > TELEPORT_RADIUS) return false;
  if (hexDistance({ q: 0, r: 0 }, hex) > state.mapRadius) return false;
  const key = hexKey(hex);
  if (state.walls.has(key)) return false;      // mountains — impassable
  if (hexEqual(hex, temple.pos)) return false; // not on the temple itself
  if (getTeleportAt(state, hex)) return false; // already has a portal
  if (getUnitAt(state, hex)) return false;     // occupied by a unit
  return true;
}

export function getValidTeleportHexes(state: GameState, templeId: string): HexCoord[] {
  const temple = state.temples.find(t => t.id === templeId);
  if (!temple) return [];
  const result: HexCoord[] = [];
  for (let dq = -TELEPORT_RADIUS; dq <= TELEPORT_RADIUS; dq++) {
    for (let dr = Math.max(-TELEPORT_RADIUS, -dq - TELEPORT_RADIUS); dr <= Math.min(TELEPORT_RADIUS, -dq + TELEPORT_RADIUS); dr++) {
      const hex: HexCoord = { q: temple.pos.q + dq, r: temple.pos.r + dr };
      if (isValidTeleportHex(state, temple, hex)) result.push(hex);
    }
  }
  return result;
}

// Valid hexes for the second portal: near any other owned temple that doesn't yet have a portal.
export function getValidTeleportHexesForOtherTemples(state: GameState, excludeTempleId: string): HexCoord[] {
  const player = getCurrentPlayer(state);
  const result: HexCoord[] = [];
  for (const temple of state.temples) {
    if (temple.ownerId !== player.id) continue;
    if (temple.id === excludeTempleId) continue;
    const existing = state.teleportBuildings.filter(b => b.templeId === temple.id);
    if (existing.length >= TELEPORT_MAX_PER_TEMPLE) continue;
    result.push(...getValidTeleportHexes(state, temple.id));
  }
  return result;
}

export function canBuildTeleportPair(state: GameState, templeId: string): boolean {
  const player = getCurrentPlayer(state);
  const temple = state.temples.find(t => t.id === templeId);
  if (!temple || temple.ownerId !== player.id) return false;
  if (!state.playerTech[player.id]?.researched.has('teleports')) return false;
  const existing = state.teleportBuildings.filter(t => t.templeId === templeId);
  if (existing.length >= TELEPORT_MAX_PER_TEMPLE) return false;
  if (player.aura < TELEPORT_BUILD_COST) return false;
  if (getValidTeleportHexes(state, templeId).length < 1) return false;
  return getValidTeleportHexesForOtherTemples(state, templeId).length >= 1;
}

export function buildTeleportPair(
  state: GameState,
  templeIdA: string,
  posA: HexCoord,
  posB: HexCoord,
): boolean {
  if (!canBuildTeleportPair(state, templeIdA)) return false;
  const validHexesA = getValidTeleportHexes(state, templeIdA);
  if (!validHexesA.some(h => hexEqual(h, posA))) return false;
  const validHexesB = getValidTeleportHexesForOtherTemples(state, templeIdA);
  if (!validHexesB.some(h => hexEqual(h, posB))) return false;
  if (hexEqual(posA, posB)) return false;
  // Determine which temple posB belongs to
  const player = getCurrentPlayer(state);
  const templeB = state.temples.find(t =>
    t.ownerId === player.id &&
    t.id !== templeIdA &&
    state.teleportBuildings.filter(b => b.templeId === t.id).length < TELEPORT_MAX_PER_TEMPLE &&
    isValidTeleportHex(state, t, posB),
  );
  if (!templeB) return false;
  player.aura -= TELEPORT_BUILD_COST;
  const idA = `tp_${teleportIdCounter++}`;
  const idB = `tp_${teleportIdCounter++}`;
  state.teleportBuildings.push({ id: idA, pos: { ...posA }, builtByPlayerId: player.id, templeId: templeIdA, pairedId: idB });
  state.teleportBuildings.push({ id: idB, pos: { ...posB }, builtByPlayerId: player.id, templeId: templeB.id, pairedId: idA });
  return true;
}
