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
  attackBonusAgainst?: Partial<Record<UnitType, number>>;  // outgoing damage multiplier vs specific unit types
  defenseBonusAgainst?: Partial<Record<UnitType, number>>; // incoming damage divisor vs specific unit types (higher = harder to damage)
}

export const UNIT_COSTS: Record<UnitType, number> = {
  warrior:      1,
  archer:       2,
  catapult:     4,
  horserider:   3,
  heavyknight:  7,
  spearsman:    2,
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
  /**
   * True if this unit has already captured a temple this turn. Capture is a
   * separate action from move/attack — a unit can capture even after moving,
   * but only once per turn. Reset to false on the owner's `endTurn`.
   */
  hasCaptured: boolean;
}

// ── Temple level system ──
export const TEMPLE_AURA_PER_LEVEL = 2;    // aura income = effective-level × this, per turn
export const TEMPLE_MAX_LEVEL = 10;
export const TEMPLE_POP_CAP_PER_LEVEL = 2; // population cap += effective-level × this per owned temple

// Economy (aura income + pop cap) plateaus at this level: levels 6-10 are
// purely visual/prestige upgrades and grant no further income or pop cap.
export const TEMPLE_ECONOMY_CAP_LEVEL = 5;

// The level used for economy calcs — clamped to the plateau so a level-10 temple
// yields the same aura/pop as a level-5 one (10 aura/turn, +10 pop).
export function templeEconomyLevel(level: number): number {
  return Math.min(level, TEMPLE_ECONOMY_CAP_LEVEL);
}

// Aura cost to upgrade FROM currentLevel to currentLevel+1 (index = currentLevel;
// index 0 unused since temples start at level 1). Gentle ~quadratic curve so the
// top levels are expensive but reachable (old curve was 2^level → 512 at 9→10).
const TEMPLE_UPGRADE_COSTS: readonly number[] = [
  0, 2, 3, 5, 7, 10, 14, 19, 25, 32, // 1→2, 2→3, … 9→10
];

export function templeUpgradeCost(currentLevel: number): number | null {
  if (currentLevel >= TEMPLE_MAX_LEVEL) return null;
  return TEMPLE_UPGRADE_COSTS[currentLevel] ?? null;
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

// ── Tech tree ──

export type TechId =
  | 'unlock_catapult'
  | 'unlock_heavyknight'
  | 'unlock_spearsman'
  | 'catapult_splash'
  | 'roads'
  | 'teleports'
  | 'infantry_move'
  | 'longrange_hp'
  | 'horse_sight'
  | 'unlock_healer'
  | 'unlock_damagebooster'
  | 'unlock_rangebooster'
  ;

export const TECH_COST = 5;

export interface TechNode {
  id: TechId;
  name: string;
  description: string;
  cost: number;
  prereqs: TechId[];
  branch?: string;       // branch id — only one per branch can be researched
  unitUnlock?: UnitType; // if set, this tech unlocks a unit type
}

export const TECH_NODES: TechNode[] = [
  // Unit unlocks
  { id: 'unlock_spearsman',    name: 'Spearsman',         description: 'Unlock Spearsman — counter-cavalry infantry with bonus damage vs horseriders and knights.', cost: TECH_COST, prereqs: [], unitUnlock: 'spearsman' },
  { id: 'unlock_heavyknight',  name: 'Heavy Knight',      description: 'Unlock Heavy Knight — heavily armoured mounted unit with high HP and attack.',              cost: TECH_COST, prereqs: [], unitUnlock: 'heavyknight' },
  { id: 'unlock_catapult',     name: 'Catapult',          description: 'Unlock Catapult — long-range siege weapon with area splash damage.',                        cost: TECH_COST, prereqs: [], unitUnlock: 'catapult' },
  // Catapult sub-upgrade
  { id: 'catapult_splash',     name: 'Splash Range +1',   description: 'Catapults gain splash radius 1.',                                                           cost: TECH_COST, prereqs: ['unlock_catapult'] },
  // Branch: Movement (pick ONE)
  { id: 'roads',               name: 'Roads',             description: 'All your units gain +1 movement speed.',                                                    cost: TECH_COST, prereqs: [], branch: 'movement' },
  { id: 'teleports',           name: 'Teleports',         description: 'Unlock teleport portals. Build a portal pair (5⚡) — one near each of two different temples. Any unit stepping on a portal is instantly transported to its partner.',               cost: TECH_COST, prereqs: [], branch: 'movement' },
  // Branch: Stat Bonus (pick ONE)
  { id: 'infantry_move',       name: 'Infantry March',    description: 'Warriors and Spearsmen gain +1 movement speed.',                                            cost: TECH_COST, prereqs: [], branch: 'stat_bonus' },
  { id: 'longrange_hp',        name: 'Fortified Ranged',  description: 'Archers and Catapults gain +5 max HP.',                                                    cost: TECH_COST, prereqs: [], branch: 'stat_bonus' },
  { id: 'horse_sight',         name: 'Scout Cavalry',     description: 'Horseriders and Heavy Knights gain +1 vision range.',                                       cost: TECH_COST, prereqs: [], branch: 'stat_bonus' },
  // Branch: Support Unit (pick ONE)
  { id: 'unlock_healer',       name: 'Healer',            description: 'Unlock Healer — support unit that restores HP to nearby allies each turn.',                 cost: TECH_COST, prereqs: [], branch: 'support', unitUnlock: 'healer' },
  { id: 'unlock_damagebooster',name: 'Damage Booster',    description: 'Unlock Damage Booster — support unit that increases attack of nearby allies.',             cost: TECH_COST, prereqs: [], branch: 'support', unitUnlock: 'damageBooster' },
  { id: 'unlock_rangebooster', name: 'Range Booster',     description: 'Unlock Range Booster — support unit that increases attack range of nearby allies.',        cost: TECH_COST, prereqs: [], branch: 'support', unitUnlock: 'rangeBooster' },
];

export interface PlayerTech {
  researched: Set<TechId>;
}

// ── Teleport buildings ──

export const TELEPORT_BUILD_COST = 5;
export const TELEPORT_RADIUS = 2;      // max dist from owning temple
export const TELEPORT_MAX_PER_TEMPLE = 1; // one portal per temple (pairs connect two different temples)

export interface TeleportBuilding {
  id: string;
  pos: HexCoord;
  builtByPlayerId: number;
  templeId: string;        // which temple this was built under (for quota)
  pairedId: string | null; // id of the partner portal (null until pair is complete)
}

export interface GameState {
  players: Player[];
  units: Unit[];
  temples: Temple[];
  hills: Set<string>;       // hex keys of hill tiles
  walls: Set<string>;       // hex keys of impassable tiles
  forests: Set<string>;     // hex keys of forest tiles
  explored: Set<string>[];  // per-player set of explored hex keys
  currentPlayerIndex: number;
  /**
   * Which player acted first in the very first turn. Used by `endTurn()` to
   * correctly increment `turnNumber` regardless of whether P0 or P1 went
   * first (balance v2.2: first-mover is randomized).
   */
  firstPlayerIndex: number;
  phase: GamePhase;
  mapRadius: number;
  winner: Player | null;
  /**
   * Full-round turn counter. Starts at 1. Incremented by `endTurn()` each time
   * the active player wraps back to player index 0 (i.e. after the last player ends
   * their turn). Persisted and serialised over both transports.
   */
  turnNumber: number;
  // ── UI-only state — see JSDoc below ──────────────────────────────────────
  /**
   * @uiOnly Client-only selection / highlight state. Not part of the persisted
   * game contract: populated by `selectUnit` / `selectTemple` and cleared by
   * `deselectAll`. Stripped from server-side broadcasts via
   * `stripSelectionState()` (gameManager.ts) and never emitted by the headless
   * REST API (`serializeStateForApi()` in headlessApi.ts builds a fresh shape
   * without these fields). They live on `GameState` for ergonomic reasons —
   * `moveUnit`/`attackUnit` consume `moveHexes`/`attackHexes` as the validated
   * move set — but they should NOT be treated as authoritative state by API
   * clients.
   */
  selectedUnitId: string | null;
  /** @uiOnly see above */
  selectedTempleId: string | null;
  /** @uiOnly see above */
  selectionMode: SelectionMode;
  /** @uiOnly see above */
  moveHexes: HexCoord[];
  /** @uiOnly see above */
  attackHexes: HexCoord[];
  /** @uiOnly see above */
  supportHexes: HexCoord[];
  // ── End UI-only fields ────────────────────────────────────────────────────
  spawnedTempleIds: Set<string>;   // temples that have already spawned a unit this turn
  playerTech: PlayerTech[];        // per-player tech research state
  teleportBuildings: TeleportBuilding[];
  /** @uiOnly hexes highlighted during build-placement mode */
  buildHexes: HexCoord[];
}
