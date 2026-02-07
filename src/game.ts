import { GameState, Unit, UnitStats, UnitType, Player, HexCoord, Temple, UNIT_COSTS } from './types';
import { hexDistance, hexEqual, hexNeighbors, getReachableHexes, hexKey, DIRECTIONS, OPPOSING_PAIRS } from './hex';

// ── Unit stats ──

const WARRIOR_STATS: UnitStats = {
  maxHp: 100, attack: 40, defense: 5, speed: 1,
  range: 1, splash: 0, splashFactor: 0, canBeRevenged: true,
};

const ARCHER_STATS: UnitStats = {
  maxHp: 100, attack: 40, defense: 5, speed: 1,
  range: 3, splash: 0, splashFactor: 0, canBeRevenged: true,
};

const BOMBER_STATS: UnitStats = {
  maxHp: 100, attack: 40, defense: 5, speed: 1,
  range: 3, splash: 1, splashFactor: 0.5, canBeRevenged: false,
};

const UNIT_STATS: Record<UnitType, UnitStats> = {
  warrior: WARRIOR_STATS,
  archer: ARCHER_STATS,
  bomber: BOMBER_STATS,
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
  { name: 'Player 2', color: '#4488ff' },
];

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

  const units: Unit[] = [
    createUnit('warrior', 0, { q: -3, r: 1 }),
    createUnit('warrior', 0, { q: -3, r: 2 }),
    createUnit('warrior', 1, { q: 3, r: -1 }),
    createUnit('warrior', 1, { q: 3, r: -2 }),
  ];

  return {
    players, units, temples,
    currentPlayerIndex: 0, phase: 'playing', mapRadius,
    winner: null,
    selectedUnitId: null, selectedTempleId: null, selectionMode: null,
    moveHexes: [], attackHexes: [],
  };
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
// To capture: move a unit onto the temple tile. The unit stands on it.
// Next turn (if still alive on the tile), the unit can "capture" the temple.
// We track this by checking: unit is on temple tile, unit belongs to current player,
// unit did NOT just move there this turn (hasMoved=false at start of turn means it was there).

export function canCaptureTemple(state: GameState, unit: Unit): Temple | null {
  // Unit must not have moved this turn (was already standing on it)
  if (unit.hasMoved || unit.hasAttacked) return null;
  const temple = getTempleAt(state, unit.pos);
  if (!temple) return null;
  if (temple.ownerId === unit.playerId) return null; // already owned
  return temple;
}

export function captureTemple(state: GameState, unit: Unit, temple: Temple): void {
  temple.ownerId = unit.playerId;
  unit.hasAttacked = true; // uses the action
  unit.hasMoved = true;
}

// ── Spawning ──
// Spawned units appear on the temple tile itself and CAN act immediately.

export function canAfford(state: GameState, unitType: UnitType): boolean {
  return getCurrentPlayer(state).aura >= UNIT_COSTS[unitType];
}

export function spawnUnit(state: GameState, templeId: string, unitType: UnitType): boolean {
  const temple = state.temples.find(t => t.id === templeId);
  if (!temple || temple.ownerId !== getCurrentPlayer(state).id) return false;

  const player = getCurrentPlayer(state);
  const cost = UNIT_COSTS[unitType];
  if (player.aura < cost) return false;

  // Check no unit already on the temple
  if (getUnitAt(state, temple.pos)) return false;

  player.aura -= cost;
  const unit = createUnit(unitType, player.id, temple.pos);
  // Can act immediately!
  unit.hasMoved = false;
  unit.hasAttacked = false;
  state.units.push(unit);

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
    // No move/attack hexes for temple — spawning is done directly on temple tile
    return;
  }

  const unit = state.units.find(u => u.id === state.selectedUnitId);
  if (!unit) return;

  // Check if unit can capture a temple it's standing on
  const capturable = canCaptureTemple(state, unit);
  // (capture is shown as a special action button, not a hex highlight)

  if (!unit.hasMoved && !unit.hasAttacked) {
    const occupied = state.units.filter(u => u.hp > 0 && u.id !== unit.id).map(u => u.pos);
    // Also block temple tiles (can't move onto temples unless to capture — we allow stepping on non-owned temples)
    const templePositions = state.temples
      .filter(t => getUnitAt(state, t.pos) !== undefined) // only block if occupied
      .map(t => t.pos);
    state.moveHexes = getReachableHexes(unit.pos, unit.stats.speed, state.mapRadius, [...occupied]);
  }

  if (!unit.hasAttacked) {
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
  // Only select if no unit on it (otherwise select the unit)
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

  const isValid = state.attackHexes.some(h => hexEqual(h, targetPos));
  if (!isValid) return null;

  const target = getUnitAt(state, targetPos);
  if (!target) return null;

  const targetEncirclement = calculateEncirclement(state, target);
  const attackerEncirclement = calculateEncirclement(state, attacker);

  const damageDealt = calculateDamage(attacker.stats.attack, target.stats.defense, targetEncirclement.attackMultiplier);
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
      const splashDmg = Math.round(
        calculateDamage(attacker.stats.attack, splashUnit.stats.defense, splashEnc.attackMultiplier) * attacker.stats.splashFactor
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
      damageReceived = calculateDamage(target.stats.attack, attacker.stats.defense, attackerEncirclement.attackMultiplier);
      attacker.hp -= damageReceived;
      attackerKilled = attacker.hp <= 0;
      if (attackerKilled) attacker.hp = 0;
    }
  }

  attacker.hasAttacked = true;
  attacker.hasMoved = true;
  updateHighlights(state);
  checkWinCondition(state);

  return { damageDealt, damageReceived, targetKilled, attackerKilled, targetEncirclement, attackerEncirclement, splashHits };
}

// ── Win condition ──

function checkWinCondition(state: GameState): void {
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

  // Reset units for current player
  state.units.forEach(u => {
    if (u.playerId === getCurrentPlayer(state).id) {
      u.hasMoved = false;
      u.hasAttacked = false;
    }
  });

  // Advance to next living player
  let next = (state.currentPlayerIndex + 1) % state.players.length;
  while (next !== state.currentPlayerIndex) {
    const hasUnits = state.units.some(u => u.playerId === state.players[next]!.id && u.hp > 0);
    const hasTemples = state.temples.some(t => t.ownerId === state.players[next]!.id);
    if (hasUnits || hasTemples) break;
    next = (next + 1) % state.players.length;
  }
  state.currentPlayerIndex = next;

  // Grant aura income: 1 per owned temple
  const newPlayer = getCurrentPlayer(state);
  const templeCount = state.temples.filter(t => t.ownerId === newPlayer.id).length;
  newPlayer.aura += templeCount;
}
