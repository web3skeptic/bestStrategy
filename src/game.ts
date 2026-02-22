import {
  GameState, Unit, UnitStats, UnitType, Player, HexCoord, Temple,
  UNIT_COSTS, HILL_DEFENSE_BONUS, HILL_VISION_BONUS, HILL_RANGE_BONUS,
  TEMPLE_AURA_PER_LEVEL, TEMPLE_MAX_LEVEL, TEMPLE_POP_CAP_PER_LEVEL, templeUpgradeCost,
  SUPPORT_RANGE,
  TechId, TechNode, TECH_NODES, PlayerTech,
  TeleportBuilding, TELEPORT_BUILD_COST, TELEPORT_RADIUS, TELEPORT_MAX_PER_TEMPLE,
} from './types';
import {
  hexDistance, hexEqual, hexNeighbors, getReachableHexes,
  hexKey, generateHexMap, DIRECTIONS, OPPOSING_PAIRS, hexLineDraw,
} from './hex';

// ── Unit stats ──

const WARRIOR_STATS: UnitStats = {
  maxHp: 15, attack: 10, defense: 5, speed: 2,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 3, cantShootAfterMove: false,
};

const ARCHER_STATS: UnitStats = {
  maxHp: 10, attack: 10, defense: 1, speed: 2,
  range: 2, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 4, cantShootAfterMove: false,
};

const CATAPULT_STATS: UnitStats = {
  maxHp: 10, attack: 20, defense: 1, speed: 1,
  range: 3, splash: 1, splashFactor: 0.5, canBeRevenged: false, vision: 4, cantShootAfterMove: false,
};

const HORSERIDER_STATS: UnitStats = {
  maxHp: 10, attack: 8, defense: 2, speed: 4,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 3, cantShootAfterMove: false,
};

const HEAVYKNIGHT_STATS: UnitStats = {
  maxHp: 30, attack: 20, defense: 8, speed: 3,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 2, cantShootAfterMove: false,
};

const SPEARSMAN_STATS: UnitStats = {
  maxHp: 20, attack: 15, defense: 5, speed: 2,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 2, cantShootAfterMove: false,
  bonusAgainst: { horserider: 2.5, heavyknight: 1.5 },
};

const HEALER_STATS: UnitStats = {
  maxHp: 12, attack: 4, defense: 2, speed: 2,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 3, cantShootAfterMove: false,
};

const DAMAGE_BOOSTER_STATS: UnitStats = {
  maxHp: 12, attack: 4, defense: 2, speed: 2,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 3, cantShootAfterMove: false,
};

const RANGE_BOOSTER_STATS: UnitStats = {
  maxHp: 12, attack: 4, defense: 2, speed: 2,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 3, cantShootAfterMove: false,
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

function applyTechToStats(stats: UnitStats, type: UnitType, tech: PlayerTech): UnitStats {
  const r = tech.researched;
  if (r.has('roads')) stats.speed += 1;
  if (r.has('infantry_move') && (type === 'warrior' || type === 'spearsman')) stats.speed += 1;
  if (r.has('longrange_hp') && (type === 'archer' || type === 'catapult')) stats.maxHp += 5;
  if (r.has('catapult_splash') && type === 'catapult') stats.splash += 1;
  if (r.has('horse_sight') && (type === 'horserider' || type === 'heavyknight')) stats.vision += 1;
  return stats;
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

function createUnit(type: UnitType, playerId: number, pos: HexCoord, tech?: PlayerTech): Unit {
  const baseStats = UNIT_STATS[type];
  const stats = tech ? applyTechToStats({ ...baseStats }, type, tech) : { ...baseStats };
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

export function getCurrentPlayerVisible(state: GameState): Set<string> {
  const visible = new Set<string>();
  const playerId = getCurrentPlayer(state).id;
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

export function getSupportBoostsForUnit(state: GameState, unit: Unit): { damageBonus: number; rangeBonus: number } {
  let damageBonus = 0;
  let rangeBonus = 0;
  for (const ally of state.units) {
    if (ally.hp <= 0 || ally.playerId !== unit.playerId || ally.id === unit.id) continue;
    const dist = hexDistance(ally.pos, unit.pos);
    if (dist > SUPPORT_RANGE) continue;
    if (ally.type === 'damageBooster') damageBonus += DAMAGE_BOOST_AMOUNT;
    if (ally.type === 'rangeBooster') rangeBonus += RANGE_BOOST_AMOUNT;
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
  const onHill = state.hills.has(hexKey(unit.pos));
  const hillBonus = (onHill && unit.stats.range > 1) ? HILL_RANGE_BONUS : 0;
  const { rangeBonus } = getSupportBoostsForUnit(state, unit);
  return unit.stats.range + hillBonus + rangeBonus;
}

// ── Population cap ──

export function getPopulationCap(state: GameState, playerId: number): number {
  return state.temples
    .filter(t => t.ownerId === playerId)
    .reduce((sum, t) => sum + t.level * TEMPLE_POP_CAP_PER_LEVEL, 0);
}

export function getPopulationCount(state: GameState, playerId: number): number {
  return state.units.filter(u => u.hp > 0 && u.playerId === playerId).length;
}

// ── Game creation ──

export function createGameState(playerConfigs?: PlayerConfig[]): GameState {
  const mapRadius = 6;
  const configs = playerConfigs || DEFAULT_PLAYERS;

  const players: Player[] = configs.map((cfg, i) => ({
    id: i, name: cfg.name, color: cfg.color, aura: 2,
  }));

  const playerTech: PlayerTech[] = players.map(() => ({ researched: new Set<TechId>() }));

  const temples: Temple[] = [
    createTemple({ q: -4, r: 2 }, 0),
    createTemple({ q: 4, r: -2 }, 1),
    createTemple({ q: -2, r: -2 }, null),
    createTemple({ q: 2, r: 2 }, null),
  ];

  const unitPositions: HexCoord[] = [
    { q: -3, r: 1 }, { q: -3, r: 2 },
    { q: 3, r: -1 }, { q: 3, r: -2 },
  ];

  const { hills, walls, forests } = generateTerrain(mapRadius, temples.map(t => t.pos), unitPositions);

  const units: Unit[] = [
    createUnit('warrior', 0, unitPositions[0]!),
    createUnit('warrior', 0, unitPositions[1]!),
    createUnit('warrior', 1, unitPositions[2]!),
    createUnit('warrior', 1, unitPositions[3]!),
  ];

  const explored: Set<string>[] = players.map(() => new Set<string>());

  const state: GameState = {
    players, units, temples, hills, walls, forests, explored,
    currentPlayerIndex: 0, phase: 'playing', mapRadius,
    winner: null,
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
  if (unit.hasMoved || unit.hasAttacked) return null;
  const temple = getTempleAt(state, unit.pos);
  if (!temple) return null;
  if (temple.ownerId === unit.playerId) return null;
  return temple;
}

export function captureTemple(state: GameState, unit: Unit, temple: Temple): void {
  temple.ownerId = unit.playerId;
  unit.hasAttacked = true;
  unit.hasMoved = true;
  updateVisibility(state, unit.playerId);
  checkWinCondition(state);
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

  // Each temple may only spawn once per turn
  if (state.spawnedTempleIds.has(templeId)) return false;

  const player = getCurrentPlayer(state);
  const cost = UNIT_COSTS[unitType];
  if (player.aura < cost) return false;

  // Population cap check
  const cap = getPopulationCap(state, player.id);
  const count = getPopulationCount(state, player.id);
  if (count >= cap) return false;

  if (getUnitAt(state, temple.pos)) return false;

  player.aura -= cost;
  const unit = createUnit(unitType, player.id, temple.pos, state.playerTech[player.id]);
  // Unit may move and attack on the turn it is spawned
  unit.hasMoved = false;
  unit.hasAttacked = false;
  state.spawnedTempleIds.add(templeId);
  state.units.push(unit);

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

  // Support area: always show for support units when selected
  if (SUPPORT_UNIT_TYPES.has(unit.type)) {
    for (let dq = -SUPPORT_RANGE; dq <= SUPPORT_RANGE; dq++) {
      for (let dr = Math.max(-SUPPORT_RANGE, -dq - SUPPORT_RANGE); dr <= Math.min(SUPPORT_RANGE, -dq + SUPPORT_RANGE); dr++) {
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
    const enemies = state.units.filter(u => u.hp > 0 && u.playerId !== unit.playerId);
    state.attackHexes = enemies
      .filter(e => hexDistance(unit.pos, e.pos) <= effectiveRange)
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

function getTypeBonusMultiplier(attacker: Unit, target: Unit): number {
  if (attacker.stats.bonusAgainst) {
    return attacker.stats.bonusAgainst[target.type] ?? 1;
  }
  return 1;
}

function calculateDamage(attackerAtk: number, defenderDef: number, encirclementMultiplier: number, typeBonus = 1): number {
  const multiplier = randomMultiplier();
  const raw = multiplier * encirclementMultiplier * typeBonus * (attackerAtk - defenderDef);
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

  const typeBonus = getTypeBonusMultiplier(attacker, target);
  const damageDealt = calculateDamage(getEffectiveAttack(state, attacker), targetDef, targetEncirclement.attackMultiplier, typeBonus);
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
        calculateDamage(attacker.stats.attack, splashDef, splashEnc.attackMultiplier) * attacker.stats.splashFactor
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

  if (!targetKilled && attacker.stats.canBeRevenged) {
    const dist = hexDistance(attacker.pos, target.pos);
    const targetEffRange = getEffectiveRange(state, target);
    if (dist <= targetEffRange) {
      damageReceived = calculateDamage(getEffectiveAttack(state, target), attackerDef, attackerEncirclement.attackMultiplier);
      attacker.hp -= damageReceived;
      attackerKilled = attacker.hp <= 0;
      if (attackerKilled) attacker.hp = 0;
    }
  }

  // Melee unit steps onto killed unit's tile
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

// ── End turn ──

export function endTurn(state: GameState): void {
  if (state.phase === 'gameOver') return;
  deselectAll(state);

  state.units.forEach(u => {
    if (u.playerId === getCurrentPlayer(state).id) {
      u.hasMoved = false;
      u.hasAttacked = false;
    }
  });
  state.spawnedTempleIds.clear();

  let next = (state.currentPlayerIndex + 1) % state.players.length;
  while (next !== state.currentPlayerIndex) {
    const hasUnits = state.units.some(u => u.playerId === state.players[next]!.id && u.hp > 0);
    const hasTemples = state.temples.some(t => t.ownerId === state.players[next]!.id);
    if (hasUnits || hasTemples) break;
    next = (next + 1) % state.players.length;
  }
  state.currentPlayerIndex = next;

  // Grant aura income: level × TEMPLE_AURA_PER_LEVEL per owned temple (linear, no depletion)
  const newPlayer = getCurrentPlayer(state);
  const ownedTemples = state.temples.filter(t => t.ownerId === newPlayer.id);
  for (const temple of ownedTemples) {
    newPlayer.aura += temple.level * TEMPLE_AURA_PER_LEVEL;
  }

  // Healer: restore HP to allies within SUPPORT_RANGE at start of their turn
  const healers = state.units.filter(u => u.hp > 0 && u.playerId === newPlayer.id && u.type === 'healer');
  for (const healer of healers) {
    const nearby = state.units.filter(u =>
      u.hp > 0 && u.playerId === newPlayer.id && u.id !== healer.id &&
      hexDistance(healer.pos, u.pos) <= SUPPORT_RANGE
    );
    for (const ally of nearby) {
      ally.hp = Math.min(ally.stats.maxHp, ally.hp + HEALER_HEAL_AMOUNT);
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

export function getValidTeleportHexes(state: GameState, templeId: string): HexCoord[] {
  const temple = state.temples.find(t => t.id === templeId);
  if (!temple) return [];
  const result: HexCoord[] = [];
  for (let dq = -TELEPORT_RADIUS; dq <= TELEPORT_RADIUS; dq++) {
    for (let dr = Math.max(-TELEPORT_RADIUS, -dq - TELEPORT_RADIUS); dr <= Math.min(TELEPORT_RADIUS, -dq + TELEPORT_RADIUS); dr++) {
      const hex: HexCoord = { q: temple.pos.q + dq, r: temple.pos.r + dr };
      if (hexDistance({ q: 0, r: 0 }, hex) > state.mapRadius) continue;
      const key = hexKey(hex);
      if (state.hills.has(key)) continue;
      if (state.forests.has(key)) continue;
      if (state.walls.has(key)) continue;
      if (hexEqual(hex, temple.pos)) continue;  // don't place on the temple itself
      if (getTeleportAt(state, hex)) continue;   // already has a portal
      result.push(hex);
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
    hexDistance(t.pos, posB) <= TELEPORT_RADIUS &&
    !state.hills.has(hexKey(posB)) &&
    !state.forests.has(hexKey(posB)) &&
    !state.walls.has(hexKey(posB)) &&
    !hexEqual(posB, t.pos),
  );
  if (!templeB) return false;
  player.aura -= TELEPORT_BUILD_COST;
  const idA = `tp_${teleportIdCounter++}`;
  const idB = `tp_${teleportIdCounter++}`;
  state.teleportBuildings.push({ id: idA, pos: { ...posA }, builtByPlayerId: player.id, templeId: templeIdA, pairedId: idB });
  state.teleportBuildings.push({ id: idB, pos: { ...posB }, builtByPlayerId: player.id, templeId: templeB.id, pairedId: idA });
  return true;
}
