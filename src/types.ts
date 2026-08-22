// Axial hex coordinates (q, r)
export interface HexCoord {
  q: number;
  r: number;
}

export type UnitType = 'warrior' | 'archer' | 'catapult' | 'horserider' | 'heavyknight' | 'spearsman' | 'healer' | 'damageBooster' | 'rangeBooster' | 'founder';

// The two civilizations of the "Asymmetric Tribes v0.2" redesign. Chosen
// secretly at the end of the Founding Round (Round 1) — see chooseFaction in
// game.ts and the reveal-secrecy handling in server/gameManager.ts.
export type FactionId = 'agrar' | 'temple';

// Bumped whenever the match/save shape changes incompatibly. Saved games,
// replays and rooms are versioned against this — an old blob is rejected
// cleanly rather than silently misinterpreted (see assertCompatibleRulesVersion
// in serializer.ts). Bump this on any future breaking change to GameState.
// v3 (phase 3): temples -> strategicSites + capitals, selectedTempleId ->
// selectedSiteId, spawnedTempleIds -> spawnedSiteIds, hasCaptured removed,
// structureAttackHexes added.
// v5 (phase 6): productionOrders added (Command system's production-slot cooldowns).
// v6 (phase 7): roads + pillagedRoadHexes added (Agrar-only physical Roads).
// v7 (phase 10): macro-economy correction — "Agrar controls area, Temple
// controls points". StrategicSiteState drops 'foundingCity'/'city' (Agrar no
// longer founds sites at all); Farm drops citySiteId, gains state/founding
// (Farms are now Capital/Farm-network-placed, not City-owned, and found over
// a round like a site instead of instantly).
export const RULES_VERSION = 7;

// Maximum support reach. Damage-booster and healer effects reach this far, with
// distance falloff (full strength within radius 1, half at radius 2 — see
// supportFalloffAmount in game.ts). The range booster is tighter: it only
// affects allies within RANGE_BOOST_RADIUS.
export const SUPPORT_RANGE = 2;
export const RANGE_BOOST_RADIUS = 1;

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
}

export const UNIT_COSTS: Record<UnitType, number> = {
  warrior:      1,
  archer:       2,
  catapult:     4,
  horserider:   3,
  heavyknight:  6,
  spearsman:    2,
  healer:       3,
  damageBooster: 3,
  rangeBooster:  3,
  founder:       2,
};

// Balance v3 (asymmetric redesign, 2026-08-21): +2 disproportionately
// strengthened already-defensive units since defense is subtractive; +1 keeps
// hills a real edge without letting a single tile decide fights on its own.
export const HILL_DEFENSE_BONUS = 1;
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

// A unit "still needs to move" this turn while it has neither moved nor attacked.
// This mirrors the engine's own move gate (selectUnit computes move targets only
// when !hasMoved && !hasAttacked, and attack() spends both flags), so the to-move
// dot shows for fresh units and clears the instant the unit acts — moves OR
// attacks. Reset each turn by endTurn (hasMoved/hasAttacked → false).
export function unitYetToMove(unit: Unit): boolean {
  return unit.hp > 0 && !unit.hasMoved && !unit.hasAttacked;
}

// ── Strategic sites (phase 3 of the "Asymmetric Tribes v0.2" redesign) ──
//
// Replaces the old "Temple" domain type, which was overloaded to mean
// starting objective + neutral objective + capturable structure + the win
// condition all at once. That's gone: a StrategicSite is a neutral map
// objective that ONLY a Temple Acolyte can found into an actual Temple —
// Agrar never converts one into a City (phase 10 correction: "Agrar
// controls area, Temple controls points" — see factions.ts §STATUS). It is
// never instantly captured by standing on it. The player's permanent home
// base is a separate `Capital` entity (see below), not a StrategicSite state.
export type StrategicSiteState =
  | 'neutral'         // unclaimed — foundable only by Temple
  | 'foundingTemple'  // Temple Acolyte founding; 0 income/production until complete
  | 'temple'          // completed Temple-faction structure
  | 'ruins';          // a destroyed temple — refoundable (Temple only)

// In-progress founding, tracked with explicit round numbers rather than a
// loose "turn count" (§6 of the brief): founding completes at the START of
// the founding player's NEXT round, giving the opponent the rest of the
// current round to respond.
export interface FoundingProgress {
  playerId: number;
  unitId: string;               // the Acolyte performing the founding
  targetState: 'temple';
  fromState: 'neutral' | 'ruins'; // what to revert to if founding fails (§9 — no half-built garbage states)
  startedRound: number;
  completesRound: number;       // startedRound + 1 — see resolveFoundingForPlayer in game.ts
}

export interface StrategicSite {
  id: string;
  pos: HexCoord;
  state: StrategicSiteState;
  // Only meaningful (non-null) once state is 'temple'. A ruined or founding
  // site has no owner — do not read this as "who's founding it", use
  // `founding.playerId` for that.
  ownerId: number | null;
  founding: FoundingProgress | null;
  // Combat stats — 0 while neutral/founding/ruins (not a valid attack
  // target in those states; see getStructureAt/isAttackableStructure).
  hp: number;
  maxHp: number;
  defense: number;
  /**
   * §17-18 (phase 4): who the Devotion investment on this site belongs to.
   * Distinct from `ownerId` — it PERSISTS through Ruins (unlike ownerId,
   * which goes null), so a player who rebuilds their OWN former site gets
   * their Devotion back. It is only reset (to the new founder) when a
   * DIFFERENT player completes founding here — see completeFounding in
   * game.ts. Null only for a virgin site that has never been founded.
   */
  investmentOwnerId: number | null;
  /** §15 (phase 4): 0-2, Temple's economic investment on its own site. */
  devotionLevel: number;
}

// Phase 10 correction — a Farm is Agrar's economy engine, built directly by
// the Builder on open land (NOT tied to a City/StrategicSite — Agrar never
// owns one of those). Global cap MAX_ACTIVE_FARMS per player, placed within
// FARM_DISTANCE_FROM_CAPITAL of the Capital or an existing active Farm, but
// never closer than FARM_MIN_SPACING to another Farm — Agrar expands as a
// spreading network, not a tight cluster (§8). A real attackable structure
// (see getStructureAt). Founds over one round like a strategic site, not
// instantly — see startFarm/resolveFarmFoundingForPlayer in game.ts.
export interface Farm {
  id: string;
  pos: HexCoord;
  ownerId: number;
  state: 'foundingFarm' | 'farm';
  founding: FarmFoundingProgress | null;
  hp: number;
  maxHp: number;
  defense: number;
}

export interface FarmFoundingProgress {
  playerId: number;
  unitId: string; // the Builder performing the construction
  startedRound: number;
  completesRound: number;
}

// The player's permanent home base. Cannot be captured, cannot become
// Ruins, cannot change owner — destroyed only by reducing HP to 0, which
// ends the match immediately (§11).
export interface Capital {
  id: string;
  playerId: number;
  pos: HexCoord;
  hp: number;
  maxHp: number;
  defense: number;
}

export interface Player {
  id: number;
  name: string;
  color: string;
  aura: number;
  /**
   * Civilization chosen at the end of the Founding Round — null during Round 1
   * and while awaiting the opponent's pick. Set once by chooseFaction() and
   * never changed after (§6). The server never broadcasts this to the
   * opponent's client until BOTH players have chosen — see
   * stripHiddenFaction in server/gameManager.ts. This field is the sole
   * source of truth for "which faction"; there is no separate reveal flag.
   */
  faction: FactionId | null;
}

// ── Multiplayer / N-player support ──

// Maximum number of players a single game supports. The colour palette below
// must have at least this many visually-distinct entries.
export const MAX_PLAYERS = 6;

// Per-player colour palette. Index === player slot. Slots 0 and 1 are red /
// green so 1-player and 2-player games show that pairing.
export const PLAYER_COLORS: readonly string[] = [
  '#ff4444', // 0 red
  '#44cc55', // 1 green
  '#4488ff', // 2 blue
  '#ffcc33', // 3 gold
  '#cc55dd', // 4 purple
  '#ff8833', // 5 orange
];

// Map radius as a function of player count: 2-player games (incl. vs-AI) use a
// tighter radius-5 board for faster, more contested matches; 3+ players keep the
// classic radius 6 at 2p baseline, growing by 1 per extra player so every player
// still gets a fair start.
export function mapRadiusForPlayers(numPlayers: number): number {
  return numPlayers <= 2 ? 5 : 6 + Math.max(0, numPlayers - 2);
}

// One neutral strategic site per player (2p → 1 Capital each + 2 neutral
// sites, matching §7 of the redesign brief: "2 Capitals, 2 neutral
// strategic sites"). Capitals themselves are just `players.length`, one each
// — this function is only about the neutral sites.
export function neutralSiteCountForPlayers(numPlayers: number): number {
  return numPlayers;
}

export type GamePhase = 'playing' | 'gameOver';

export type SelectionMode = 'unit' | 'site' | null;

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
  | 'command_1'
  | 'command_2'
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
  // §21 — Command tiers, linear (not a branch): only Command I/II raise the
  // population cap — territory never does (see COMMAND_TIERS in factions.ts).
  { id: 'command_1',           name: 'Command I',         description: 'Raise your population cap.',                                                               cost: TECH_COST, prereqs: [] },
  { id: 'command_2',           name: 'Command II',        description: 'Raise your population cap further.',                                                       cost: TECH_COST, prereqs: ['command_1'] },
];

export interface PlayerTech {
  researched: Set<TechId>;
}

// ── Teleport buildings ──
//
// Dormant in the v0.2 ruleset (kept — not deleted — per the redesign brief's
// asset/code-reuse policy; the 'teleports' tech is still live for now since
// phase 3 doesn't touch the tech tree, but Agrar Roads/Phase 6 movement work
// will likely replace or remove this). `templeId` is a legacy field name —
// it anchors to any OWNED structure id now (Capital or a completed
// city/temple StrategicSite), not the old Temple type.
export const TELEPORT_BUILD_COST = 5;
export const TELEPORT_RADIUS = 2;      // max dist from owning structure
export const TELEPORT_MAX_PER_TEMPLE = 1; // one portal per structure (pairs connect two different structures)

export interface TeleportBuilding {
  id: string;
  pos: HexCoord;
  builtByPlayerId: number;
  /** @legacyName anchoring structure id — Capital or StrategicSite, not a Temple */
  templeId: string;
  pairedId: string | null; // id of the partner portal (null until pair is complete)
}

export interface GameState {
  players: Player[];
  units: Unit[];
  strategicSites: StrategicSite[];
  capitals: Capital[];
  farms: Farm[];
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
  selectedSiteId: string | null;
  /** @uiOnly see above */
  selectionMode: SelectionMode;
  /** @uiOnly see above */
  moveHexes: HexCoord[];
  /** @uiOnly see above */
  attackHexes: HexCoord[];
  /** @uiOnly enemy STRUCTURES (Capital/City/Temple) the selected unit can attack this turn — separate from attackHexes (enemy units) since structure combat is a distinct action (attackStructure). */
  structureAttackHexes: HexCoord[];
  /** @uiOnly see above */
  supportHexes: HexCoord[];
  // ── End UI-only fields ────────────────────────────────────────────────────
  spawnedSiteIds: Set<string>;     // structures that have already spawned a unit this turn
  playerTech: PlayerTech[];        // per-player tech research state
  teleportBuildings: TeleportBuilding[];
  /** @uiOnly hexes highlighted during build-placement mode */
  buildHexes: HexCoord[];
  // §19-22 (phase 6, Command system) — recruiting draws on a limited pool of
  // production slots (Capital + owned City/Temple expansions), not an
  // unlimited one. Each recruit occupies ONE of the recruiting player's slots
  // until the start of that player's next round (see getProductionSlots /
  // getBusyProductionSlotCount / resolveProductionForPlayer in game.ts) — the
  // unit itself still appears immediately, only the SLOT is on cooldown.
  productionOrders: ProductionOrder[];
  // §23-25 (phase 7) — Agrar-only physical road tiles. A road grants
  // ROAD_MOVEMENT_BONUS speed to WHOEVER stands on it (not just its owner's
  // units — it's a real road, not a magic one), but any unit that ends its
  // move on a road it does NOT own pillages (destroys) it on arrival — see
  // moveUnit. Temple has no equivalent way to build one (§25).
  roads: Road[];
  // Hexes that once had a road, got pillaged, and are cheaper to rebuild
  // (ROAD_PILLAGE_REBUILD_COST) than to build fresh (ROAD_COST_PER_HEX).
  pillagedRoadHexes: Set<string>;
}

export interface ProductionOrder {
  playerId: number;
  freeAtRound: number; // the round (turnNumber) at which this slot frees up
}

export interface Road {
  pos: HexCoord;
  ownerId: number; // the player who built it (only ever an Agrar player)
}
