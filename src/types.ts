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
// v9 (economy/pacing balance pass): STARTING_ENERGY/BASE_INCOME_PER_ROUND
// halved (6->3), new max income 7 (was 10); AGRAR_FARM_COST 5->6;
// TEMPLE_DEVOTION_COST 3->4 per level; Temple production slots now require
// Devotion II (a merely founded/partially-developed Temple grants none,
// was any owned Temple); COMMAND_TIERS 8/10/12 -> 6/9/12; TECH_COST 5->6
// (and the redundant duplicate TECH_COST export in factions.ts removed —
// types.ts, next to TECH_NODES, is the only source of truth now);
// FARM_DEFENSE_BONUS removed entirely (Agrar Territory grants no combat
// bonus); the old unified "Agrar Territory" split back into two distinct
// radii — AGRAR_TERRITORY_RADIUS (2, infrastructure/placement only, no area
// denial) and CULTIVATION_RADIUS (1, farm-only, shrine-denial only);
// 'infantry_move' tech removed from TechId/TECH_NODES; 'longrange_hp' now
// +3 HP (was +5); Agrar Knight/Heavy Knight/Builder speed restored to 2
// (was 1 for every Agrar unit).
// v10 (tech-tree pacing pass): research is single-slot and timed now —
// PlayerTech gains `researching: ResearchProgress | null`; TECH_COST (a
// single flat constant) removed, every TechNode carries its own cost and a
// new `researchTime` (rounds until the effect applies, same semantics as
// Farm/Temple founding); new cost/time table (Command I 12⚡/1rd, Support/
// Stat-bonus 14⚡/2rd, Siege unlock 16⚡/2rd, Heavy prereq 16⚡/2rd, Splash
// 18⚡/2rd, Command II 18⚡/2rd, Heavy Knight/Champion Rite 22⚡/3rd);
// Command II now additionally requires >=2 other completed technologies
// (COMMAND_2_MIN_OTHER_TECHS in game.ts) on top of Command I; the Champion
// unlock renamed to 'temple_champion_rite' ("Champion Rite"), and the splash
// upgrades renamed to 'agrar_siegecraft_splash' ("Explosive Shot") /
// 'temple_mobile_siege_splash' ("Blast Rite").
// v11 (Temple conquest + upgrade system): the old Devotion I/II (4+4⚡,
// +1 income each) purchase ladder is GONE — StrategicSite drops
// `devotionLevel`/`investmentOwnerId` entirely, gains `templeLevel: 1 | 2 |
// null` and `upgrade: TempleUpgradeProgress | null`. Two flat 6⚡/1-round
// steps now: founding a neutral/ruined site (SITE_ESTABLISH_COST 4->6)
// produces Temple I (+1 income, +0 production); a second 6⚡/1-round
// TEMPLE_UPGRADE_COST step turns it into Temple II (+2 income total, +1
// production — matching 2 Farms exactly). A destroyed Temple (either level,
// mid-upgrade or not) always becomes Ruins with template level cleared —
// investment is NEVER preserved across a Ruins state any more, not even for
// the same player re-founding their own former site (no more "reclaim"
// exception) — every reconstruction restarts at Temple I. See
// canStartTempleUpgrade/startTempleUpgrade/resolveTempleUpgradeForPlayer in
// game.ts.
// v12 (conquest redesign — instant-presence conquest, Agrar-only destruction):
// the Acolyte ('temple_acolyte') is REMOVED from TEMPLE_UNITS entirely —
// Temple no longer has a founder-slot unit at all. Founding/conquering a
// site is no longer Acolyte-gated: ANY Temple-faction unit standing on a
// valid site with an unused attack action can start it (may move onto the
// site the same turn — "just step on it"), still resolving one round later
// (FoundingProgress unchanged in shape). The big behavioral flip: a Temple
// player can now target an ACTIVE enemy-owned Temple directly (no need to
// destroy it first) — completing that conquest INHERITS the site's current
// templeLevel as-is (a Temple II stays Temple II under the new owner)
// rather than resetting to Temple I; the defender keeps full income/
// production throughout the contest. Conversely, ONLY Agrar may attack/
// destroy an active Temple structure via attack-structure any more —
// Temple-faction players can no longer reduce a rival Temple to Ruins by
// combat, only by walking onto it and outlasting the 1-round contest.
// Founding a virgin neutral site, or reconsecrating Ruins (destroyed via
// Agrar combat — those have no level on record), is unchanged: always
// produces Temple I.
export const RULES_VERSION = 12;

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
  | 'foundingTemple'  // a Temple-faction unit founding a neutral/ruined site; 0 income/production until complete
  | 'temple'          // completed Temple-faction structure (see templeLevel for I vs II) — also the target state while being CONQUERED (site stays fully active/owned throughout, see FoundingProgress)
  | 'upgradingTemple' // Temple I -> II upgrade in progress; still grants Temple I-level economy
  | 'ruins';          // a destroyed temple (Agrar-only, via combat) — refoundable by Temple, always restarts at Temple I

// In-progress founding OR conquest, tracked with explicit round numbers
// rather than a loose "turn count" (§6 of the brief): resolves at the START
// of the acting player's NEXT round, giving the opponent the rest of the
// current round to respond. v12 — ANY Temple-faction unit can start this
// (no more Acolyte-only restriction), and it now also covers conquering an
// ACTIVE enemy Temple directly (fromState 'temple') — no destruction
// required first; see canStartFounding/completeFounding in game.ts.
export interface FoundingProgress {
  playerId: number;
  unitId: string;               // the unit performing the founding/conquest
  targetState: 'temple';
  // What to revert `state`/`ownerId` to if interrupted (§9 — no half-built
  // garbage states). 'temple' means an active enemy Temple being conquered
  // — its state/ownerId/templeLevel were never touched in the first place
  // (see startFounding), so failure is a true no-op there.
  fromState: 'neutral' | 'ruins' | 'temple';
  startedRound: number;
  completesRound: number;       // startedRound + 1 — see resolveFoundingForPlayer in game.ts
}

// Temple I -> Temple II upgrade (v11 Temple conquest/upgrade system) — same
// "commit the round" shape as FoundingProgress, but there's no fromState:
// an interrupted upgrade never reverts, it just never completes (the Temple
// simply stays at Temple I unless destroyed first, which goes to Ruins
// regardless — see resolveTempleUpgradeForPlayer in game.ts).
export interface TempleUpgradeProgress {
  playerId: number;
  startedRound: number;
  completesRound: number;       // startedRound + 1
}

export interface StrategicSite {
  id: string;
  pos: HexCoord;
  state: StrategicSiteState;
  // Only meaningful (non-null) once state is 'temple' or 'upgradingTemple'.
  // A ruined or founding site has no owner — do not read this as "who's
  // founding it", use `founding.playerId` for that.
  ownerId: number | null;
  founding: FoundingProgress | null;
  upgrade: TempleUpgradeProgress | null;
  // Combat stats — 0 while neutral/founding/ruins (not a valid attack
  // target in those states; see getStructureAt/isAttackableStructure).
  hp: number;
  maxHp: number;
  defense: number;
  /**
   * v11 — Temple's economic level once founded: 1 (Temple I, +1 income) or
   * 2 (Temple II, +2 income/+1 production). Null while neutral/ruins/
   * founding. Set to 1 the instant founding completes, and to 1 again
   * (while `state` is 'upgradingTemple') during an in-progress upgrade —
   * the Temple II bonus only applies once the upgrade actually resolves.
   * Cleared to null whenever the site becomes Ruins — investment is NEVER
   * preserved through a Ruins state, not even for the original owner
   * re-founding their own former site (deliberate — see RULES_VERSION v11
   * note: "Temple owns points... destroying economic infrastructure
   * destroys its accumulated investment instead of transferring it").
   */
  templeLevel: 1 | 2 | null;
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
// radius-7 board (169 hexes); 3+ players keep the classic radius 6 at 2p
// baseline, growing by 1 per extra player so every player still gets a fair start.
export function mapRadiusForPlayers(numPlayers: number): number {
  // 1v1 radius 7 (169 hexes) is the closest a hex ring can get to doubling
  // the old radius-5 board (91 hexes) — hex-count only ever lands on
  // 3R²+3R+1, so an exact 2x (182) isn't reachable at any integer radius.
  return numPlayers <= 2 ? 7 : 6 + Math.max(0, numPlayers - 2);
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
// underlying unitUnlock slot) rather than one flat unlock. The old
// Roads/Teleports "movement" branch is gone — Agrar's physical Roads (see
// factions.ts) are the only speed mechanic now, and Teleports directly
// conflicted with the Temple-mobility/Agrar-infrastructure asymmetry.
// Economy/pacing balance pass: 'infantry_move' (Infantry March, +1 SPD
// warrior/pike) removed entirely — it undermined the Roads/native-speed
// faction identity too directly; may return after further balance testing.
export type TechId =
  | 'agrar_siegecraft'
  | 'agrar_siegecraft_splash'
  | 'agrar_heavy_armor'
  | 'agrar_heavy_knight_tech'
  | 'temple_mobile_siege_tech'
  | 'temple_mobile_siege_splash'
  | 'temple_warrior_rite'
  | 'temple_champion_rite'
  | 'longrange_hp'
  | 'horse_sight'
  | 'unlock_healer'
  | 'unlock_damagebooster'
  | 'unlock_rangebooster'
  | 'command_1'
  | 'command_2'
  ;

// Tech-tree pacing pass — research is a real, single-slot, multi-round
// civilization investment now, not a cheap instant menu purchase. See
// ResearchProgress/PlayerTech.researching, canResearch, researchTech and
// resolveResearchForPlayer in game.ts. TECH_COST as a single flat constant
// is gone — every node sets its own cost per the pacing table below (§10 of
// the design brief); `researchTime` (in rounds, same semantics as Farm/
// Temple-founding — resolves at the start of the researching player's Nth
// round from now) is new on every node.
export interface TechNode {
  id: TechId;
  name: string;
  description: string;
  cost: number;
  researchTime: number;    // rounds until the effect applies — see resolveResearchForPlayer
  prereqs: TechId[];
  branch?: string;         // branch id — only one per branch can be researched
  unitUnlock?: UnitType;   // if set, this tech unlocks a unit type
  faction?: FactionId;     // if set, only that faction can research/see this node
}

export const TECH_NODES: TechNode[] = [
  // Siege line — faction-specific, no prereq for the base unlock.
  { id: 'agrar_siegecraft',        name: 'Siegecraft',      description: 'Unlock the Catapult — long-range siege weapon with area splash damage.', cost: 16, researchTime: 2, prereqs: [], unitUnlock: 'catapult', faction: 'agrar' },
  { id: 'agrar_siegecraft_splash', name: 'Explosive Shot',  description: 'Catapults gain splash radius 1. Requires Siegecraft.',                    cost: 18, researchTime: 2, prereqs: ['agrar_siegecraft'], faction: 'agrar' },
  { id: 'temple_mobile_siege_tech',   name: 'Mobile Siege',    description: 'Unlock Mobile Siege — long-range siege weapon with area splash damage.', cost: 16, researchTime: 2, prereqs: [], unitUnlock: 'catapult', faction: 'temple' },
  { id: 'temple_mobile_siege_splash', name: 'Blast Rite',      description: 'Mobile Siege gains splash radius 1. Requires Mobile Siege.',             cost: 18, researchTime: 2, prereqs: ['temple_mobile_siege_tech'], faction: 'temple' },
  // Heavy-unit line — faction-specific, genuinely gated (needs the tier-1
  // tech AND Command I, not a single flat unlock — §30). The final unlock
  // is a deliberate 3-round, 22⚡ late-game commitment — do not shorten it.
  { id: 'agrar_heavy_armor',      name: 'Heavy Armor',      description: 'Prerequisite for Heavy Knight.',                                                cost: 16, researchTime: 2, prereqs: [], faction: 'agrar' },
  { id: 'agrar_heavy_knight_tech', name: 'Heavy Knight',    description: 'Unlock the Heavy Knight — heavily armoured mounted unit with high HP and attack. Requires Heavy Armor and Command I.', cost: 22, researchTime: 3, prereqs: ['agrar_heavy_armor', 'command_1'], unitUnlock: 'heavyknight', faction: 'agrar' },
  { id: 'temple_warrior_rite',    name: 'Warrior Rite',     description: 'Prerequisite for Champion Rite.',                                               cost: 16, researchTime: 2, prereqs: [], faction: 'temple' },
  { id: 'temple_champion_rite',   name: 'Champion Rite',    description: 'Unlock the Champion — heavily armoured mounted unit with high HP and attack. Requires Warrior Rite and Command I.', cost: 22, researchTime: 3, prereqs: ['temple_warrior_rite', 'command_1'], unitUnlock: 'heavyknight', faction: 'temple' },
  // Branch: Stat Bonus (pick ONE) — shared by both factions. Infantry March
  // (Warrior/Pike +1 SPD) removed (economy/pacing balance pass §17) —
  // undermined the Roads/native-speed faction identity too directly.
  { id: 'longrange_hp',        name: 'Fortified Ranged',  description: 'Archers and Catapults gain +3 max HP.',                                                    cost: 14, researchTime: 2, prereqs: [], branch: 'stat_bonus' },
  { id: 'horse_sight',         name: 'Scout Cavalry',     description: 'Horseriders and Heavy Knights gain +1 vision range.',                                       cost: 14, researchTime: 2, prereqs: [], branch: 'stat_bonus' },
  // Branch: Support Unit (pick ONE) — shared by both factions.
  { id: 'unlock_healer',       name: 'Healer',            description: 'Unlock Healer — support unit that restores HP to nearby allies each turn.',                 cost: 14, researchTime: 2, prereqs: [], branch: 'support', unitUnlock: 'healer' },
  { id: 'unlock_damagebooster',name: 'Damage Booster',    description: 'Unlock Damage Booster — support unit that increases attack of nearby allies.',             cost: 14, researchTime: 2, prereqs: [], branch: 'support', unitUnlock: 'damageBooster' },
  { id: 'unlock_rangebooster', name: 'Range Booster',     description: 'Unlock Range Booster — support unit that increases attack range of nearby allies.',        cost: 14, researchTime: 2, prereqs: [], branch: 'support', unitUnlock: 'rangeBooster' },
  // §21 — Command tiers, linear (not a branch): only Command I/II raise the
  // population cap — territory never does (see COMMAND_TIERS in factions.ts).
  // Command II ALSO requires at least 2 completed non-Command technologies
  // (checked separately in canResearch — not expressible via `prereqs`,
  // which means "all of these", not "at least N of anything else") so a
  // player can't rush straight from Command I into Command II with no other
  // development.
  { id: 'command_1',           name: 'Command I',         description: 'Raise your population cap (6 -> 9).',                                                      cost: 12, researchTime: 1, prereqs: [] },
  { id: 'command_2',           name: 'Command II',        description: 'Raise your population cap further (9 -> 12). Requires Command I and at least 2 other completed technologies.', cost: 18, researchTime: 2, prereqs: ['command_1'] },
];

// One in-progress research per player — see canResearch/researchTech/
// resolveResearchForPlayer. Mirrors FoundingProgress/Farm.founding: the
// Energy is committed the instant research STARTS, the effect only applies
// once `completesRound` is reached.
export interface ResearchProgress {
  techId: TechId;
  startedRound: number;
  completesRound: number;
}

export interface PlayerTech {
  researched: Set<TechId>;
  researching: ResearchProgress | null;
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
