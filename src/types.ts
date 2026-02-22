// Axial hex coordinates (q, r)
export interface HexCoord {
  q: number;
  r: number;
}

export type UnitType = 'warrior' | 'archer' | 'catapult' | 'horserider' | 'heavyknight' | 'spearsman' | 'healer' | 'damageBooster' | 'rangeBooster';

export const SUPPORT_RANGE = 2;

export interface UnitStats {
  maxHp: number;
  attack: number;
  defense: number;
  speed: number;        // tiles per move
  range: number;        // attack range in hex tiles
  splash: number;       // splash radius (0 = no splash)
  splashFactor: number; // splash damage multiplier (e.g. 0.5 = 50%)
  canBeRevenged: boolean;      // whether the target can hit back after being hit
  vision: number;              // exploration/visibility radius
  cantShootAfterMove: boolean; // whether the unit cannot attack on a turn it moved
  bonusAgainst?: Partial<Record<UnitType, number>>; // bonus damage multiplier vs specific unit types
}

export const UNIT_COSTS: Record<UnitType, number> = {
  warrior:      1,
  archer:       2,
  catapult:     4,
  horserider:   3,
  heavyknight:  7,
  spearsman:    3,
  healer:       3,
  damageBooster: 3,
  rangeBooster:  3,
};

export const HILL_DEFENSE_BONUS = 2;
export const HILL_VISION_BONUS = 1;
export const HILL_RANGE_BONUS = 1;

export interface Unit {
  id: string;
  type: UnitType;
  playerId: number;
  stats: UnitStats;
  hp: number;
  pos: HexCoord;
  hasMoved: boolean;
  hasAttacked: boolean;
}

// ── Temple level system ──
export const TEMPLE_AURA_PER_LEVEL = 2;    // aura income = level × this, per turn (linear)
export const TEMPLE_MAX_LEVEL = 5;
export const TEMPLE_POP_CAP_PER_LEVEL = 2; // population cap += level × this per owned temple

export function templeUpgradeCost(currentLevel: number): number | null {
  if (currentLevel >= TEMPLE_MAX_LEVEL) return null;
  return Math.pow(2, currentLevel); // 1→2: 2, 2→3: 4, 3→4: 8, 4→5: 16
}

export interface Temple {
  id: string;
  pos: HexCoord;
  ownerId: number | null; // null = neutral
  level: number;          // 1..TEMPLE_MAX_LEVEL
}

export interface Player {
  id: number;
  name: string;
  color: string;
  aura: number;
}

export type GamePhase = 'playing' | 'gameOver';

export type SelectionMode = 'unit' | 'temple' | null;

export interface GameState {
  players: Player[];
  units: Unit[];
  temples: Temple[];
  hills: Set<string>;       // hex keys of hill tiles
  walls: Set<string>;       // hex keys of impassable tiles
  forests: Set<string>;     // hex keys of forest tiles
  explored: Set<string>[];  // per-player set of explored hex keys
  currentPlayerIndex: number;
  phase: GamePhase;
  mapRadius: number;
  winner: Player | null;
  selectedUnitId: string | null;
  selectedTempleId: string | null;
  selectionMode: SelectionMode;
  moveHexes: HexCoord[];
  attackHexes: HexCoord[];
  supportHexes: HexCoord[];
  spawnedTempleIds: Set<string>; // temples that have already spawned a unit this turn
}
