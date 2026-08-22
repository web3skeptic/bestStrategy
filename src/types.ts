// Axial hex coordinates (q, r)
export interface HexCoord {
  q: number;
  r: number;
}

export type UnitType = 'warrior' | 'archer' | 'catapult' | 'horserider' | 'heavyknight' | 'spearsman' | 'healer' | 'damageBooster' | 'rangeBooster' | 'founder';

// The two civilizations of the "Asymmetric Tribes v0.2" redesign. Chosen
// secretly right at match start, before Round 1 begins — see chooseFaction
// in game.ts and the reveal-secrecy handling in server/gameManager.ts.
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
// v8 (phase 11): opening/recruitment correction — no more Founding Round or
// starting units (players choose faction immediately, then start with an
// empty Capital); Builder/Acolyte are now ordinary recruitable units;
// recruiting queues a unit for one round instead of creating it instantly
// (ProductionOrder -> TrainingOrder, carries unitType/structureId); Farm
// placement is adjacency-only (drops the old distance-chain constants);
// Roads' speed bonus is Agrar-only; the tech tree drops the old
// Roads/Teleports movement techs and the flat Catapult/Heavy Knight
// unlocks in favor of faction-specific, prerequisite-gated ones.
export const RULES_VERSION = 8;

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
// owns one of those). Global cap MAX_ACTIVE_FARMS per player. Phase 11:
// placement is adjacency-only — a new Farm must be a hex NEIGHBOUR of the
// Builder's current position, and not adjacent to another Farm or to the
// Capital (§10-12) — the Builder's own movement is what limits expansion,
// not a separate distance-chain rule. A real attackable structure (see
// getStructureAt). Founds over one round like a strategic site, not
// instantly — the Builder must stay ADJACENT to the site until it
// completes (§14) — see startFarm/resolveFarmFoundingForPlayer in game.ts.
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
   * Civilization chosen right at the start of the match, before any
   * gameplay happens (phase 11 — there is no more neutral Founding Round) —
   * null while awaiting the opponent's pick. Set once by chooseFaction() and
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

// Phase 11: Pikeman/Spearsman no longer need research at all (both factions'
// early rosters already include them, §39/EARLY_UNLOCKED_SLOTS) — the old
// 'unlock_spearsman' tech was dead weight (it added a slot the player
// already had). Catapult/Heavy Knight unlocks are now faction-specific,
// prerequisite-gated techs (different names/flavor per faction, same
// underlying unitUnlock slot) rather than one flat 5⚡ unlock. The old
// Roads/Teleports "movement" branch is gone — Agrar's physical Roads (see
// factions.ts) are the only speed mechanic now, and Teleports directly
// conflicted with the Temple-mobility/Agrar-infrastructure asymmetry.
export type TechId =
  | 'agrar_siegecraft'
  | 'agrar_siegecraft_splash'
  | 'agrar_heavy_armor'
  | 'agrar_heavy_knight_tech'
  | 'temple_mobile_siege_tech'
  | 'temple_mobile_siege_splash'
  | 'temple_warrior_rite'
  | 'temple_champion_rite'
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
  branch?: string;         // branch id — only one per branch can be researched
  unitUnlock?: UnitType;   // if set, this tech unlocks a unit type
  faction?: FactionId;     // if set, only that faction can research/see this node
}

export const TECH_NODES: TechNode[] = [
  // Siege line — faction-specific, no prereq for the base unlock.
  { id: 'agrar_siegecraft',        name: 'Siegecraft',      description: 'Unlock the Catapult — long-range siege weapon with area splash damage.', cost: TECH_COST, prereqs: [], unitUnlock: 'catapult', faction: 'agrar' },
  { id: 'agrar_siegecraft_splash', name: 'Splash Range +1', description: 'Catapults gain splash radius 1.',                                        cost: TECH_COST, prereqs: ['agrar_siegecraft'], faction: 'agrar' },
  { id: 'temple_mobile_siege_tech',   name: 'Mobile Siege',    description: 'Unlock Mobile Siege — long-range siege weapon with area splash damage.', cost: TECH_COST, prereqs: [], unitUnlock: 'catapult', faction: 'temple' },
  { id: 'temple_mobile_siege_splash', name: 'Splash Range +1', description: 'Mobile Siege gains splash radius 1.',                                    cost: TECH_COST, prereqs: ['temple_mobile_siege_tech'], faction: 'temple' },
  // Heavy-unit line — faction-specific, genuinely gated (needs the tier-1
  // tech AND Command I, not a single flat 5⚡ unlock — §30).
  { id: 'agrar_heavy_armor',      name: 'Heavy Armor',      description: 'Prerequisite for Heavy Knight.',                                                cost: TECH_COST, prereqs: [], faction: 'agrar' },
  { id: 'agrar_heavy_knight_tech', name: 'Heavy Knight',    description: 'Unlock the Heavy Knight — heavily armoured mounted unit with high HP and attack. Requires Heavy Armor and Command I.', cost: TECH_COST, prereqs: ['agrar_heavy_armor', 'command_1'], unitUnlock: 'heavyknight', faction: 'agrar' },
  { id: 'temple_warrior_rite',    name: 'Warrior Rite',     description: 'Prerequisite for Champion.',                                                    cost: TECH_COST, prereqs: [], faction: 'temple' },
  { id: 'temple_champion_rite',   name: 'Champion',         description: 'Unlock the Champion — heavily armoured mounted unit with high HP and attack. Requires Warrior Rite and Command I.', cost: TECH_COST, prereqs: ['temple_warrior_rite', 'command_1'], unitUnlock: 'heavyknight', faction: 'temple' },
  // Branch: Stat Bonus (pick ONE) — shared by both factions.
  { id: 'infantry_move',       name: 'Infantry March',    description: 'Warriors and Spearsmen gain +1 movement speed.',                                            cost: TECH_COST, prereqs: [], branch: 'stat_bonus' },
  { id: 'longrange_hp',        name: 'Fortified Ranged',  description: 'Archers and Catapults gain +5 max HP.',                                                    cost: TECH_COST, prereqs: [], branch: 'stat_bonus' },
  { id: 'horse_sight',         name: 'Scout Cavalry',     description: 'Horseriders and Heavy Knights gain +1 vision range.',                                       cost: TECH_COST, prereqs: [], branch: 'stat_bonus' },
  // Branch: Support Unit (pick ONE) — shared by both factions.
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
// Fully dormant (phase 11): the 'teleports' tech no longer exists in
// TECH_NODES at all, so this can never be researched or built again —
// kept, not deleted, per the redesign brief's asset/code-reuse policy.
// `templeId` is a legacy field name — it anchors to any OWNED structure id
// (Capital or a completed Temple StrategicSite), not the old Temple type.
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
  // §5, §19-22 (phase 6 Command system, reworked phase 11) — recruiting
  // queues a TrainingOrder instead of creating the unit instantly: it
  // occupies one of the recruiting player's limited production slots AND
  // represents the pending unit itself. It deploys (the real Unit is
  // created) at the start of that player's next round if the structure's
  // tile is free — see getProductionSlots / getBusyProductionSlotCount /
  // resolveTrainingForPlayer in game.ts. If the tile stays blocked, the
  // order just keeps waiting (still occupying its slot) rather than being
  // lost — no unit is ever destroyed by a blocked deployment.
  trainingQueue: TrainingOrder[];
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

export interface TrainingOrder {
  playerId: number;
  unitType: UnitType;
  structureId: string;   // Capital or owned Temple site — where the unit deploys
  readyAtRound: number;  // turnNumber at/after which deployment is attempted
}

export interface Road {
  pos: HexCoord;
  ownerId: number; // the player who built it (only ever an Agrar player)
}
