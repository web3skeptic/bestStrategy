// Axial hex coordinates (q, r)
export interface HexCoord {
  q: number;
  r: number;
}

export type UnitType = 'warrior' | 'archer' | 'bomber' | 'sniper';

export interface UnitStats {
  maxHp: number;
  attack: number;
  defense: number;
  speed: number;    // tiles per move
  range: number;    // attack range in hex tiles
  splash: number;   // splash radius (0 = no splash)
  splashFactor: number; // splash damage multiplier (e.g. 0.5 = 50%)
  canBeRevenged: boolean; // whether the target can hit back after being hit
  vision: number;   // exploration/visibility radius
  cantShootAfterMove: boolean; // whether the unit cannot attack on a turn it moved
}

export const UNIT_COSTS: Record<UnitType, number> = {
  warrior: 1,
  archer: 2,
  bomber: 4,
  sniper: 8,
};

export const HILL_DEFENSE_BONUS = 2;

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

export interface Temple {
  id: string;
  pos: HexCoord;
  ownerId: number | null;  // null = neutral
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
}
