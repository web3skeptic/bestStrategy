import { GameState, Unit, UnitStats, UnitType, Player, HexCoord, Temple, UNIT_COSTS, HILL_DEFENSE_BONUS } from './types';
import { hexDistance, hexEqual, hexNeighbors, getReachableHexes, hexKey, generateHexMap, DIRECTIONS, OPPOSING_PAIRS } from './hex';

// ── Unit stats ──

const WARRIOR_STATS: UnitStats = {
  maxHp: 15, attack: 10, defense: 5, speed: 2,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 3, cantShootAfterMove: false,
};

const ARCHER_STATS: UnitStats = {
  maxHp: 15, attack: 10, defense: 1, speed: 2,
  range: 3, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 4, cantShootAfterMove: false,
};

const BOMBER_STATS: UnitStats = {
  maxHp: 10, attack: 20, defense: 1, speed: 1,
  range: 3, splash: 1, splashFactor: 0.5, canBeRevenged: false, vision: 4, cantShootAfterMove: false,
};

const SNIPER_STATS: UnitStats = {
  maxHp: 10, attack: 30, defense: 1, speed: 1,
  range: 6, splash: 0, splashFactor: 0, canBeRevenged: false, vision: 8, cantShootAfterMove: true,
};

const UNIT_STATS: Record<UnitType, UnitStats> = {
  warrior: WARRIOR_STATS,
  archer: ARCHER_STATS,
  bomber: BOMBER_STATS,
  sniper: SNIPER_STATS,
};

// ── Factories ──

let unitIdCounter = 0;
let templeIdCounter = 0;

function createUnit(type: UnitType, playerId: number, pos: HexCoord): Unit {
  const stats = UNIT_STATS[type];
  return {
    id: `unit_${unitIdCounter++}`,
    type, playerId,
    stats: { ...stats },
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

export function getVisibleHexes(pos: HexCoord, visionRange: number, mapRadius: number): HexCoord[] {
  const result: HexCoord[] = [];
  for (let dq = -visionRange; dq <= visionRange; dq++) {
    for (let dr = Math.max(-visionRange, -dq - visionRange); dr <= Math.min(visionRange, -dq + visionRange); dr++) {
      const hex: HexCoord = { q: pos.q + dq, r: pos.r + dr };
      if (hexDistance({ q: 0, r: 0 }, hex) <= mapRadius) {
        result.push(hex);
      }
    }
  }
  return result;
}

function revealForPlayer(state: GameState, playerId: number, pos: HexCoord, visionRange: number): void {
  const visible = getVisibleHexes(pos, visionRange, state.mapRadius);
  for (const hex of visible) {
    state.explored[playerId]!.add(hexKey(hex));
  }
}

export function updateVisibility(state: GameState, playerId: number): void {
  const units = state.units.filter(u => u.hp > 0 && u.playerId === playerId);
  for (const unit of units) {
    revealForPlayer(state, playerId, unit.pos, unit.stats.vision);
  }
  // Temples also give vision (radius 2)
  const temples = state.temples.filter(t => t.ownerId === playerId);
  for (const temple of temples) {
    revealForPlayer(state, playerId, temple.pos, 2);
  }
}

export function getCurrentPlayerVisible(state: GameState): Set<string> {
  // Currently visible hexes (not just explored — for fog of war)
  const visible = new Set<string>();
  const playerId = getCurrentPlayer(state).id;
  const units = state.units.filter(u => u.hp > 0 && u.playerId === playerId);
  for (const unit of units) {
    for (const hex of getVisibleHexes(unit.pos, unit.stats.vision, state.mapRadius)) {
      visible.add(hexKey(hex));
    }
  }
  const temples = state.temples.filter(t => t.ownerId === playerId);
  for (const temple of temples) {
    for (const hex of getVisibleHexes(temple.pos, 2, state.mapRadius)) {
      visible.add(hexKey(hex));
    }
  }
  return visible;
}

// ── Terrain generation ──

function generateTerrain(mapRadius: number, templePositions: HexCoord[], unitPositions: HexCoord[]): { hills: Set<string>; walls: Set<string> } {
  const hills = new Set<string>();
  const walls = new Set<string>();
  const allHexes = generateHexMap(mapRadius);
  const allKeys = new Set(allHexes.map(h => hexKey(h)));
  const reserved = new Set([
    ...templePositions.map(p => hexKey(p)),
    ...unitPositions.map(p => hexKey(p)),
  ]);
  // Also reserve neighbors of temples/units so clusters don't block them
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

  // Pick random seed points for wall clusters (mountain ranges)
  const wallSeeds = 3 + Math.floor(Math.random() * 3); // 3-5 clusters
  for (let i = 0; i < wallSeeds; i++) {
    const seed = allHexes[Math.floor(Math.random() * allHexes.length)]!;
    if (reservedBuffer.has(hexKey(seed))) continue;
    growCluster(seed, walls, 3 + Math.floor(Math.random() * 4), 0.55);
  }

  // Pick random seed points for hill clusters
  const hillSeeds = 4 + Math.floor(Math.random() * 4); // 4-7 clusters
  for (let i = 0; i < hillSeeds; i++) {
    const seed = allHexes[Math.floor(Math.random() * allHexes.length)]!;
    if (reservedBuffer.has(hexKey(seed)) || used.has(hexKey(seed))) continue;
    growCluster(seed, hills, 3 + Math.floor(Math.random() * 5), 0.6);
  }

  // Add scattered hills around wall edges (foothills effect)
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

  return { hills, walls };
}

// ── Effective defense (with hill bonus) ──

export function getEffectiveDefense(state: GameState, unit: Unit): number {
  const onHill = state.hills.has(hexKey(unit.pos));
  return unit.stats.defense + (onHill ? HILL_DEFENSE_BONUS : 0);
}

// ── Game creation ──

export function createGameState(playerConfigs?: PlayerConfig[]): GameState {
  const mapRadius = 6;
  const configs = playerConfigs || DEFAULT_PLAYERS;

  const players: Player[] = configs.map((cfg, i) => ({
    id: i, name: cfg.name, color: cfg.color, aura: 2,
  }));

  const temples: Temple[] = [
    createTemple({ q: -4, r: 2 }, 0),   // Red home
    createTemple({ q: 4, r: -2 }, 1),   // Blue home
    createTemple({ q: 0, r: 0 }, null),  // Neutral
    createTemple({ q: -2, r: -2 }, null),
    createTemple({ q: 2, r: 2 }, null),
  ];

  const unitPositions: HexCoord[] = [
    { q: -3, r: 1 }, { q: -3, r: 2 },
    { q: 3, r: -1 }, { q: 3, r: -2 },
  ];

  const { hills, walls } = generateTerrain(mapRadius, temples.map(t => t.pos), unitPositions);

  const units: Unit[] = [
    createUnit('warrior', 0, unitPositions[0]!),
    createUnit('warrior', 0, unitPositions[1]!),
    createUnit('warrior', 1, unitPositions[2]!),
    createUnit('warrior', 1, unitPositions[3]!),
  ];

  // Per-player explored sets
  const explored: Set<string>[] = players.map(() => new Set<string>());

  const state: GameState = {
    players, units, temples, hills, walls, explored,
    currentPlayerIndex: 0, phase: 'playing', mapRadius,
    winner: null,
    selectedUnitId: null, selectedTempleId: null, selectionMode: null,
    moveHexes: [], attackHexes: [],
  };

  // Reveal initial vision for all players
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

// ── Spawning ──

export function canAfford(state: GameState, unitType: UnitType): boolean {
  return getCurrentPlayer(state).aura >= UNIT_COSTS[unitType];
}

export function spawnUnit(state: GameState, templeId: string, unitType: UnitType): boolean {
  const temple = state.temples.find(t => t.id === templeId);
  if (!temple || temple.ownerId !== getCurrentPlayer(state).id) return false;

  const player = getCurrentPlayer(state);
  const cost = UNIT_COSTS[unitType];
  if (player.aura < cost) return false;

  if (getUnitAt(state, temple.pos)) return false;

  player.aura -= cost;
  const unit = createUnit(unitType, player.id, temple.pos);
  unit.hasMoved = true;      // just spawned — can't move this turn
  unit.hasAttacked = false;  // can still attack this turn
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

function updateHighlights(state: GameState): void {
  state.moveHexes = [];
  state.attackHexes = [];

  if (state.selectionMode === 'temple') {
    return;
  }

  const unit = state.units.find(u => u.id === state.selectedUnitId);
  if (!unit) return;

  if (!unit.hasMoved && !unit.hasAttacked) {
    const occupied = state.units.filter(u => u.hp > 0 && u.id !== unit.id).map(u => u.pos);
    const wallPositions = [...state.walls].map(k => { const [q, r] = k.split(',').map(Number); return { q: q!, r: r! }; });
    state.moveHexes = getReachableHexes(unit.pos, unit.stats.speed, state.mapRadius, [...occupied, ...wallPositions], state.hills);
  }

  // cantShootAfterMove: if unit moved this turn, no attack highlights
  const canAttack = !unit.hasAttacked && !(unit.stats.cantShootAfterMove && unit.hasMoved);
  if (canAttack) {
    const enemies = state.units.filter(u => u.hp > 0 && u.playerId !== unit.playerId);
    state.attackHexes = enemies
      .filter(e => hexDistance(unit.pos, e.pos) <= unit.stats.range)
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
}

export function moveUnit(state: GameState, dest: HexCoord): boolean {
  const unit = state.units.find(u => u.id === state.selectedUnitId);
  if (!unit || unit.hasMoved || unit.hasAttacked) return false;

  const isValid = state.moveHexes.some(h => hexEqual(h, dest));
  if (!isValid) return false;

  unit.pos = { ...dest };
  unit.hasMoved = true;

  // Reveal vision
  revealForPlayer(state, unit.playerId, unit.pos, unit.stats.vision);

  updateHighlights(state);
  return true;
}

// ── Combat ──

function randomMultiplier(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const value = 1.0 + z * 0.2;
  return Math.max(0.5, Math.min(1.5, value));
}

function calculateDamage(attackerAtk: number, defenderDef: number, encirclementMultiplier: number): number {
  const multiplier = randomMultiplier();
  const raw = multiplier * encirclementMultiplier * (attackerAtk - defenderDef);
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
}

export function attackUnit(state: GameState, targetPos: HexCoord): CombatResult | null {
  const attacker = state.units.find(u => u.id === state.selectedUnitId);
  if (!attacker || attacker.hasAttacked) return null;
  // cantShootAfterMove: block attack if unit already moved this turn
  if (attacker.stats.cantShootAfterMove && attacker.hasMoved) return null;

  const isValid = state.attackHexes.some(h => hexEqual(h, targetPos));
  if (!isValid) return null;

  const target = getUnitAt(state, targetPos);
  if (!target) return null;

  const targetEncirclement = calculateEncirclement(state, target);
  const attackerEncirclement = calculateEncirclement(state, attacker);

  // Use effective defense (hill bonus)
  const targetDef = getEffectiveDefense(state, target);
  const attackerDef = getEffectiveDefense(state, attacker);

  const damageDealt = calculateDamage(attacker.stats.attack, targetDef, targetEncirclement.attackMultiplier);
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
    if (dist <= target.stats.range) {
      damageReceived = calculateDamage(target.stats.attack, attackerDef, attackerEncirclement.attackMultiplier);
      attacker.hp -= damageReceived;
      attackerKilled = attacker.hp <= 0;
      if (attackerKilled) attacker.hp = 0;
    }
  }

  // Warrior steps onto killed unit's tile (melee only)
  if (targetKilled && !attackerKilled && attacker.stats.range === 1) {
    attacker.pos = { ...targetPos };
    revealForPlayer(state, attacker.playerId, attacker.pos, attacker.stats.vision);
  }

  attacker.hasAttacked = true;
  attacker.hasMoved = true;
  updateHighlights(state);
  checkWinCondition(state);

  return { damageDealt, damageReceived, targetKilled, attackerKilled, targetEncirclement, attackerEncirclement, splashHits };
}

// ── Win condition ──

function checkWinCondition(state: GameState): void {
  for (const player of state.players) {
    if (state.temples.every(t => t.ownerId === player.id)) {
      state.phase = 'gameOver';
      state.winner = player;
      return;
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

  let next = (state.currentPlayerIndex + 1) % state.players.length;
  while (next !== state.currentPlayerIndex) {
    const hasUnits = state.units.some(u => u.playerId === state.players[next]!.id && u.hp > 0);
    const hasTemples = state.temples.some(t => t.ownerId === state.players[next]!.id);
    if (hasUnits || hasTemples) break;
    next = (next + 1) % state.players.length;
  }
  state.currentPlayerIndex = next;

  // Grant aura income: 2 per owned temple
  const newPlayer = getCurrentPlayer(state);
  const templeCount = state.temples.filter(t => t.ownerId === newPlayer.id).length;
  newPlayer.aura += templeCount * 2;

  // Update visibility for new player
  updateVisibility(state, newPlayer.id);
}
