// Data model for the "Asymmetric Tribes v0.2" redesign (Agrar vs Temple).
//
// STATUS: fully wired — sites/farms/structures (phase 3-4), the full unit
// roster (phase 5), Command population (phase 6), Agrar Roads (phase 7),
// ZOC (phase 8, keyed off unitClass — see game.ts ZOC_CLASSES), the
// per-faction visual banner accent (phase 9, see voxelFactionAccent.ts), the
// Farm-network macro-economy correction (phase 10), and the opening/
// recruitment correction (phase 11 — no Founding Round, Builder/Acolyte
// recruitable, training queue, adjacency-only Farms, Agrar-only Road speed)
// all read from this file rather than duplicating numbers.
import type { UnitClass } from './combat';
import type { FactionId, UnitType } from './types';

export type { FactionId };

export interface FactionUnitDef {
  id: string;
  faction: FactionId;
  // Which universal-roster "slot" (see src/game.ts UNIT_CLASS) this def
  // flavors — the engine still has one shared UnitType space (phase 2
  // decision: no forked action vocab / no ML checkpoint dimension changes),
  // so Agrar and Temple's differently-named units for the same role (e.g.
  // Pikeman vs Spearsman) both key off UnitType 'spearsman'.
  slot: UnitType;
  displayName: string;
  // Recruitable immediately on faction reveal, no tech required (§39).
  earlyUnlock: boolean;
  unitClass: UnitClass;
  cost: number;
  hp: number;
  attack: number;
  defense: number;
  speed: number;
  range: number;
  vision: number;
  commandCost: number;
  isSupport: boolean;
  isSiege: boolean;
  // ZOC: warrior/pike/cavalry/heavy project it; archer/siege/support/builder don't (§26).
  projectsZOC: boolean;
  assetReference: string;
  // Phase 9: every unit now gets a faction-flavored banner accent on top of
  // its shared base rig (see voxelFactionAccent.ts) — that's the baseline,
  // so this is false everywhere. Only set true for a slot that still needs
  // genuinely bespoke geometry beyond the shared banner treatment.
  placeholderAsset: boolean;
}

// §37 (economy/pacing balance pass §12 — reverted the too-extreme "every
// Agrar unit is speed 1" call) — Agrar roster. Slower, tankier, formation-
// oriented: infantry/ranged/siege/support sit at speed 1, but cavalry/heavy/
// the Builder keep speed 2 — an entirely helpless early game wasn't the
// goal, and the Builder needs to match the Acolyte's strategic mobility so
// economic-expansion units aren't asymmetrical in basic travel speed. Roads
// (Agrar-only +1 SPD) are how Agrar's ground forces reach Temple-equivalent
// mobility on their own infrastructure — see ROAD_MOVEMENT_BONUS.
export const AGRAR_UNITS: FactionUnitDef[] = [
  { id: 'agrar_warrior',  faction: 'agrar', slot: 'warrior',  displayName: 'Warrior',     earlyUnlock: true,  unitClass: 'warrior', cost: 1, hp: 15, attack: 9,  defense: 5, speed: 1, range: 1, vision: 2, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'voxelWarrior',     placeholderAsset: false },
  { id: 'agrar_archer',   faction: 'agrar', slot: 'archer',   displayName: 'Archer',      earlyUnlock: true,  unitClass: 'archer',  cost: 2, hp: 14, attack: 10, defense: 4, speed: 1, range: 2, vision: 2, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: false, assetReference: 'archer_standing',  placeholderAsset: false },
  { id: 'agrar_pikeman',  faction: 'agrar', slot: 'spearsman', displayName: 'Pikeman',    earlyUnlock: true,  unitClass: 'pike',    cost: 2, hp: 16, attack: 9,  defense: 6, speed: 1, range: 1, vision: 2, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'spearsman_standing', placeholderAsset: false },
  { id: 'agrar_knight',   faction: 'agrar', slot: 'horserider', displayName: 'Knight',    earlyUnlock: true,  unitClass: 'cavalry', cost: 4, hp: 19, attack: 13, defense: 6, speed: 2, range: 1, vision: 2, commandCost: 2, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'horserider_standing', placeholderAsset: false },
  { id: 'agrar_catapult', faction: 'agrar', slot: 'catapult', displayName: 'Catapult',    earlyUnlock: false, unitClass: 'siege',   cost: 4, hp: 16, attack: 13, defense: 3, speed: 1, range: 3, vision: 4, commandCost: 2, isSupport: false, isSiege: true,  projectsZOC: false, assetReference: 'catapult_standing', placeholderAsset: false },
  { id: 'agrar_heavyknight', faction: 'agrar', slot: 'heavyknight', displayName: 'Heavy Knight', earlyUnlock: false, unitClass: 'heavy', cost: 6, hp: 21, attack: 16, defense: 6, speed: 2, range: 1, vision: 2, commandCost: 2, isSupport: false, isSiege: false, projectsZOC: true, assetReference: 'heavyknight_standing', placeholderAsset: false },
  { id: 'agrar_healer',   faction: 'agrar', slot: 'healer',   displayName: 'Healer',      earlyUnlock: false, unitClass: 'support', cost: 3, hp: 15, attack: 6,  defense: 3, speed: 1, range: 1, vision: 3, commandCost: 1, isSupport: true,  isSiege: false, projectsZOC: false, assetReference: 'healer_standing',  placeholderAsset: false },
  { id: 'agrar_dmg_support', faction: 'agrar', slot: 'damageBooster', displayName: 'Drummer', earlyUnlock: false, unitClass: 'support', cost: 3, hp: 14, attack: 6, defense: 3, speed: 1, range: 1, vision: 3, commandCost: 1, isSupport: true, isSiege: false, projectsZOC: false, assetReference: 'damagebooster_standing', placeholderAsset: false },
  { id: 'agrar_rng_support', faction: 'agrar', slot: 'rangeBooster', displayName: 'Scout', earlyUnlock: false, unitClass: 'support', cost: 3, hp: 14, attack: 6, defense: 3, speed: 1, range: 1, vision: 3, commandCost: 1, isSupport: true, isSiege: false, projectsZOC: false, assetReference: 'rangebooster_standing', placeholderAsset: false },
  { id: 'agrar_builder',  faction: 'agrar', slot: 'founder',  displayName: 'Builder',     earlyUnlock: true,  unitClass: 'support', cost: 2, hp: 12, attack: 5,  defense: 3, speed: 2, range: 1, vision: 3, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: false, assetReference: 'warrior_standing', placeholderAsset: false },
];

// §38 — Temple roster. Faster, lighter, mobility/pressure-oriented.
export const TEMPLE_UNITS: FactionUnitDef[] = [
  { id: 'temple_warrior',   faction: 'temple', slot: 'warrior',  displayName: 'Warrior',   earlyUnlock: true,  unitClass: 'warrior', cost: 1, hp: 13, attack: 10, defense: 4, speed: 2, range: 1, vision: 2, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'voxelWarrior',     placeholderAsset: false },
  { id: 'temple_archer',    faction: 'temple', slot: 'archer',   displayName: 'Archer',    earlyUnlock: true,  unitClass: 'archer',  cost: 2, hp: 12, attack: 11, defense: 3, speed: 2, range: 2, vision: 2, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: false, assetReference: 'archer_standing',  placeholderAsset: false },
  { id: 'temple_spearsman', faction: 'temple', slot: 'spearsman', displayName: 'Spearsman', earlyUnlock: true,  unitClass: 'pike',    cost: 2, hp: 14, attack: 10, defense: 5, speed: 2, range: 1, vision: 2, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'spearsman_standing', placeholderAsset: false },
  { id: 'temple_raider',    faction: 'temple', slot: 'horserider', displayName: 'Raider',  earlyUnlock: true,  unitClass: 'cavalry', cost: 3, hp: 14, attack: 13, defense: 4, speed: 3, range: 1, vision: 3, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'horserider_standing', placeholderAsset: false },
  { id: 'temple_mobile_siege', faction: 'temple', slot: 'catapult', displayName: 'Mobile Siege', earlyUnlock: false, unitClass: 'siege', cost: 4, hp: 15, attack: 12, defense: 3, speed: 2, range: 3, vision: 4, commandCost: 2, isSupport: false, isSiege: true, projectsZOC: false, assetReference: 'catapult_standing', placeholderAsset: false },
  { id: 'temple_champion',  faction: 'temple', slot: 'heavyknight', displayName: 'Champion', earlyUnlock: false, unitClass: 'heavy',  cost: 6, hp: 18, attack: 17, defense: 5, speed: 3, range: 1, vision: 3, commandCost: 2, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'heavyknight_standing', placeholderAsset: false },
  // hp bumped 13/12/12 -> 15 (brief §38 listed values): the brief's own §34
  // Cavalry-beats-Support 1.25x bonus made a full-health 3⚡ Raider one-shot
  // these at listed HP, violating the brief's own §36 no-one-shot invariant
  // for an equal-cost matchup. Smallest fix per §95 — raise HP just past the
  // threshold (14 dmg from a full-health Raider) rather than touch the
  // shared counter matrix or the Raider itself.
  { id: 'temple_priest',    faction: 'temple', slot: 'healer',   displayName: 'Priest',    earlyUnlock: false, unitClass: 'support', cost: 3, hp: 15, attack: 7,  defense: 2, speed: 2, range: 1, vision: 3, commandCost: 1, isSupport: true,  isSiege: false, projectsZOC: false, assetReference: 'healer_standing',  placeholderAsset: false },
  { id: 'temple_war_support', faction: 'temple', slot: 'damageBooster', displayName: 'Chanter', earlyUnlock: false, unitClass: 'support', cost: 3, hp: 15, attack: 7, defense: 2, speed: 2, range: 1, vision: 3, commandCost: 1, isSupport: true, isSiege: false, projectsZOC: false, assetReference: 'damagebooster_standing', placeholderAsset: false },
  { id: 'temple_rng_support', faction: 'temple', slot: 'rangeBooster', displayName: 'Oracle', earlyUnlock: false, unitClass: 'support', cost: 3, hp: 15, attack: 7, defense: 2, speed: 2, range: 1, vision: 3, commandCost: 1, isSupport: true, isSiege: false, projectsZOC: false, assetReference: 'rangebooster_standing', placeholderAsset: false },
  // v13 — the Acolyte is BACK (v12's brief removal reverted): founding a
  // neutral/ruined site, or reconsecrating Ruins after a Temple is
  // destroyed, is once again gated to this dedicated founder-slot unit —
  // see isFounderUnit/canStartFounding in game.ts.
  { id: 'temple_acolyte',   faction: 'temple', slot: 'founder',  displayName: 'Acolyte',   earlyUnlock: true,  unitClass: 'support', cost: 2, hp: 12, attack: 5, defense: 3, speed: 2, range: 1, vision: 3, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: false, assetReference: 'warrior_standing', placeholderAsset: false },
];

export const FACTION_UNITS: Record<FactionId, FactionUnitDef[]> = {
  agrar: AGRAR_UNITS,
  temple: TEMPLE_UNITS,
};

// §39 — units available immediately after faction lock, before any tech
// (derived from each def's earlyUnlock flag — single source of truth).
// Phase 11: Builder/Acolyte (slot 'founder') is an ordinary recruitable
// early-unlock unit now, same as Warrior/Archer/Pikeman-or-Spearsman/
// Knight-or-Raider — there's no more "on-board only, never recruitable"
// restriction (§4-5). If one dies, the player can just recruit another.
export const EARLY_UNLOCKED_SLOTS: Record<FactionId, UnitType[]> = {
  agrar: AGRAR_UNITS.filter(u => u.earlyUnlock).map(u => u.slot),
  temple: TEMPLE_UNITS.filter(u => u.earlyUnlock).map(u => u.slot),
};

// §51 — structure stats. No more 'city' — Agrar's only structures are its
// Capital and its Farms (phase 10 correction).
// Structure/UX polish pass: Farm HP 12->18, DEF 4->5 — a healthy Farm should
// generally survive one ordinary non-siege hit instead of being deleted by
// a single casual touch; still far more fragile than a Temple/Capital.
export interface StructureDef { hp: number; defense: number; }
export const STRUCTURES: Record<'farm' | 'temple' | 'capital', StructureDef> = {
  farm: { hp: 18, defense: 5 },
  temple: { hp: 26, defense: 5 },
  capital: { hp: 40, defense: 6 },
};

// §6 (economy/pacing balance pass) — Command cap tiers, slowed down to
// visibly separate opening/mid/late army sizes. Only Command I/II raise the
// cap; territory never does.
export const COMMAND_TIERS = { start: 6, commandI: 9, commandII: 12 } as const;

// §16-19 (phase 10) — production is centralized for Agrar (scales with
// active Farm count) and distributed for Temple (scales with FULLY-developed
// — Temple II, v11 — owned-Temple count) — see getProductionSlots in game.ts
// for the actual per-faction curve. Both start from the same base and cap
// at the same max.
export const PRODUCTION_BASE_SLOTS = 2;
export const PRODUCTION_MAX_SLOTS = 4;
export const UNIT_TRAINING_ROUNDS = 1;

// §1 (economy/pacing balance pass) — shared economy constants (identical
// for both factions). The whole Energy scale was too liquid relative to
// unit/tech/economy costs — one round of base income used to buy most of an
// opening. Halved so army, economy and tech genuinely compete for the same
// Energy instead of all being affordable at once. New normal maximum
// income is 7⚡/round (was 10) — see AGRAR_FARM_INCOME/TEMPLE_LEVEL_INCOME.
export const STARTING_ENERGY = 3;
export const BASE_INCOME_PER_ROUND = 3;
// v11 — 4->6, matching AGRAR_FARM_COST exactly (Temple conquest/upgrade
// system's macro-investment-equality invariant: 1 Farm == Temple I == 6⚡ ==
// +1 income). Temple founding only — Agrar never founds a site (§28).
export const SITE_ESTABLISH_COST = 6;

// §6-14 (phase 10; placement simplified phase 11; split back into two
// distinct radii in the economy/pacing balance pass — see AGRAR_TERRITORY_
// RADIUS/CULTIVATION_RADIUS below) — Agrar's Farm network: its ONLY
// economic expansion, built directly by the Builder on open land, never
// tied to a captured site. A new Farm must be a hex NEIGHBOUR of the
// Builder (distance 1, so the Builder's own movement still matters) AND
// land INSIDE existing AGRAR_TERRITORY_RADIUS infrastructure reach — the
// network only grows as a connected bunker, it can't leapfrog across the
// map, and completing a new Farm itself immediately EXPANDS that reach for
// the next one. Adjacent to the CAPITAL or another Farm is fine — there is
// no minimum Farm-to-Farm spacing (removed — it rejected legitimate-looking
// adjacent tiles for a rule players found confusing rather than meaningful).
// A Farm costing 6⚡ against +1⚡/round income is a deliberate 6-round
// payback — a meaningful long-term investment, not something bought
// casually alongside a full army.
export const AGRAR_FARM_COST = 6;
export const AGRAR_FARM_INCOME = 1;
export const MAX_ACTIVE_FARMS = 4;
// Infrastructure reach ONLY (Farm/Road placement) — see getAgrarTerritory.
// Grants NO combat bonus (removed in the economy/pacing balance pass §9 —
// Agrar's edge is structural: higher HP/DEF, Roads, ZOC, Farms, area denial;
// a flat +DEF aura on top of all that was a huge, invisible swing since DEF
// is subtractive).
export const AGRAR_TERRITORY_RADIUS = 2; // around the Capital, and around each active Farm
// Shrine-denial reach ONLY (blocks Temple founding/rebuilding) — deliberately
// SMALLER and farm-only (no Capital projection) so a Farm can't block
// founding from two hexes away — see getAgrarCultivation.
export const CULTIVATION_RADIUS = 1; // an active Farm's own hex + its 6 neighbours — Capital projects none of this

// v11 (Temple conquest + upgrade system) — replaces the old Devotion I/II
// purchase ladder with a simple two-stage build/upgrade, matching Agrar's
// Farm curve one-for-one: Temple I costs SITE_ESTABLISH_COST (6⚡, 1 round,
// via founding) for +1 income; Temple II costs an ADDITIONAL
// TEMPLE_UPGRADE_COST (6⚡, 1 round) on top for +2 income TOTAL (not +1 on
// top of Temple I's +1) and +1 production slot. A fully developed neutral
// Temple totals 6+6=12⚡ for +2⚡/round — exactly 2 Farms (12⚡, +2 income,
// +1 production). See TEMPLE_LEVEL_INCOME/canStartTempleUpgrade in game.ts.
export const TEMPLE_UPGRADE_COST = 6;
export const TEMPLE_LEVEL_INCOME: Record<1 | 2, number> = { 1: 1, 2: 2 };
export const TEMPLE_II_PRODUCTION_BONUS = 1;

// §14-15 — Agrar-only physical Roads. Temple gets no equivalent bonus. Kept
// cheap deliberately: at 3⚡ base income (down from 6), 1⚡ is already
// substantially more expensive relative to the economy, and Builder
// activation is itself part of the cost.
export const ROAD_COST_PER_HEX = 1;
export const ROAD_MOVEMENT_BONUS = 1;
export const ROAD_PILLAGE_REBUILD_COST = 1;

// §32-36 — combat constants relevant to the data model (TECH_COST lives in
// types.ts, next to TECH_NODES — the single source of truth for tech cost).
export const SPLASH_FACTOR = 0.4;
export const EFFECTIVE_RANGE_CAP = 4;       // §46 — absolute, after all modifiers
export const ENCIRCLEMENT_MAX_MULTIPLIER = 1.5;
