// Data model for the "Asymmetric Tribes v0.2" redesign (Agrar vs Temple).
//
// STATUS: sites/farms/structures (phase 3-4) and the full unit roster (phase
// 5) are wired up — every AGRAR_UNITS/TEMPLE_UNITS entry drives real stats,
// display names, and unlock timing via its `slot` (see src/game.ts
// factionUnitDef/applyFactionToStats/getUnlockedUnits). Roads and the Command
// population system (§19-26) are still inert data, pending a later phase.
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
  placeholderAsset: boolean;
}

// §37 — Agrar roster. Slower, tankier, formation-oriented.
export const AGRAR_UNITS: FactionUnitDef[] = [
  { id: 'agrar_warrior',  faction: 'agrar', slot: 'warrior',  displayName: 'Warrior',     earlyUnlock: true,  unitClass: 'warrior', cost: 1, hp: 15, attack: 9,  defense: 5, speed: 1, range: 1, vision: 2, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'voxelWarrior',     placeholderAsset: false },
  { id: 'agrar_archer',   faction: 'agrar', slot: 'archer',   displayName: 'Archer',      earlyUnlock: true,  unitClass: 'archer',  cost: 2, hp: 14, attack: 10, defense: 4, speed: 1, range: 2, vision: 2, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: false, assetReference: 'archer_standing',  placeholderAsset: false },
  { id: 'agrar_pikeman',  faction: 'agrar', slot: 'spearsman', displayName: 'Pikeman',    earlyUnlock: true,  unitClass: 'pike',    cost: 2, hp: 16, attack: 9,  defense: 6, speed: 1, range: 1, vision: 2, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'spearsman_standing', placeholderAsset: true },
  { id: 'agrar_knight',   faction: 'agrar', slot: 'horserider', displayName: 'Knight',    earlyUnlock: true,  unitClass: 'cavalry', cost: 4, hp: 19, attack: 13, defense: 6, speed: 2, range: 1, vision: 2, commandCost: 2, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'horserider_standing', placeholderAsset: true },
  { id: 'agrar_catapult', faction: 'agrar', slot: 'catapult', displayName: 'Catapult',    earlyUnlock: false, unitClass: 'siege',   cost: 4, hp: 16, attack: 13, defense: 3, speed: 1, range: 3, vision: 4, commandCost: 2, isSupport: false, isSiege: true,  projectsZOC: false, assetReference: 'catapult_standing', placeholderAsset: false },
  { id: 'agrar_heavyknight', faction: 'agrar', slot: 'heavyknight', displayName: 'Heavy Knight', earlyUnlock: false, unitClass: 'heavy', cost: 6, hp: 21, attack: 16, defense: 6, speed: 2, range: 1, vision: 2, commandCost: 2, isSupport: false, isSiege: false, projectsZOC: true, assetReference: 'heavyknight_standing', placeholderAsset: false },
  { id: 'agrar_healer',   faction: 'agrar', slot: 'healer',   displayName: 'Healer',      earlyUnlock: false, unitClass: 'support', cost: 3, hp: 15, attack: 6,  defense: 3, speed: 1, range: 1, vision: 3, commandCost: 1, isSupport: true,  isSiege: false, projectsZOC: false, assetReference: 'healer_standing',  placeholderAsset: false },
  { id: 'agrar_dmg_support', faction: 'agrar', slot: 'damageBooster', displayName: 'Drummer', earlyUnlock: false, unitClass: 'support', cost: 3, hp: 14, attack: 6, defense: 3, speed: 1, range: 1, vision: 3, commandCost: 1, isSupport: true, isSiege: false, projectsZOC: false, assetReference: 'damagebooster_standing', placeholderAsset: false },
  { id: 'agrar_rng_support', faction: 'agrar', slot: 'rangeBooster', displayName: 'Scout', earlyUnlock: false, unitClass: 'support', cost: 3, hp: 14, attack: 6, defense: 3, speed: 1, range: 1, vision: 3, commandCost: 1, isSupport: true, isSiege: false, projectsZOC: false, assetReference: 'rangebooster_standing', placeholderAsset: false },
  { id: 'agrar_builder',  faction: 'agrar', slot: 'founder',  displayName: 'Builder',     earlyUnlock: true,  unitClass: 'support', cost: 2, hp: 12, attack: 5,  defense: 3, speed: 2, range: 1, vision: 3, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: false, assetReference: 'warrior_standing', placeholderAsset: true },
];

// §38 — Temple roster. Faster, lighter, mobility/pressure-oriented.
export const TEMPLE_UNITS: FactionUnitDef[] = [
  { id: 'temple_warrior',   faction: 'temple', slot: 'warrior',  displayName: 'Warrior',   earlyUnlock: true,  unitClass: 'warrior', cost: 1, hp: 13, attack: 10, defense: 4, speed: 2, range: 1, vision: 2, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'voxelWarrior',     placeholderAsset: true },
  { id: 'temple_archer',    faction: 'temple', slot: 'archer',   displayName: 'Archer',    earlyUnlock: true,  unitClass: 'archer',  cost: 2, hp: 12, attack: 11, defense: 3, speed: 2, range: 2, vision: 2, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: false, assetReference: 'archer_standing',  placeholderAsset: true },
  { id: 'temple_spearsman', faction: 'temple', slot: 'spearsman', displayName: 'Spearsman', earlyUnlock: true,  unitClass: 'pike',    cost: 2, hp: 14, attack: 10, defense: 5, speed: 2, range: 1, vision: 2, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'spearsman_standing', placeholderAsset: false },
  { id: 'temple_raider',    faction: 'temple', slot: 'horserider', displayName: 'Raider',  earlyUnlock: true,  unitClass: 'cavalry', cost: 3, hp: 14, attack: 13, defense: 4, speed: 3, range: 1, vision: 3, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'horserider_standing', placeholderAsset: false },
  { id: 'temple_mobile_siege', faction: 'temple', slot: 'catapult', displayName: 'Mobile Siege', earlyUnlock: false, unitClass: 'siege', cost: 4, hp: 15, attack: 12, defense: 3, speed: 2, range: 3, vision: 4, commandCost: 2, isSupport: false, isSiege: true, projectsZOC: false, assetReference: 'catapult_standing', placeholderAsset: true },
  { id: 'temple_champion',  faction: 'temple', slot: 'heavyknight', displayName: 'Champion', earlyUnlock: false, unitClass: 'heavy',  cost: 6, hp: 18, attack: 17, defense: 5, speed: 3, range: 1, vision: 3, commandCost: 2, isSupport: false, isSiege: false, projectsZOC: true,  assetReference: 'heavyknight_standing', placeholderAsset: true },
  // hp bumped 13/12/12 -> 15 (brief §38 listed values): the brief's own §34
  // Cavalry-beats-Support 1.25x bonus made a full-health 3⚡ Raider one-shot
  // these at listed HP, violating the brief's own §36 no-one-shot invariant
  // for an equal-cost matchup. Smallest fix per §95 — raise HP just past the
  // threshold (14 dmg from a full-health Raider) rather than touch the
  // shared counter matrix or the Raider itself.
  { id: 'temple_priest',    faction: 'temple', slot: 'healer',   displayName: 'Priest',    earlyUnlock: false, unitClass: 'support', cost: 3, hp: 15, attack: 7,  defense: 2, speed: 2, range: 1, vision: 3, commandCost: 1, isSupport: true,  isSiege: false, projectsZOC: false, assetReference: 'healer_standing',  placeholderAsset: true },
  { id: 'temple_war_support', faction: 'temple', slot: 'damageBooster', displayName: 'Chanter', earlyUnlock: false, unitClass: 'support', cost: 3, hp: 15, attack: 7, defense: 2, speed: 2, range: 1, vision: 3, commandCost: 1, isSupport: true, isSiege: false, projectsZOC: false, assetReference: 'damagebooster_standing', placeholderAsset: true },
  { id: 'temple_rng_support', faction: 'temple', slot: 'rangeBooster', displayName: 'Oracle', earlyUnlock: false, unitClass: 'support', cost: 3, hp: 15, attack: 7, defense: 2, speed: 2, range: 1, vision: 3, commandCost: 1, isSupport: true, isSiege: false, projectsZOC: false, assetReference: 'rangebooster_standing', placeholderAsset: true },
  { id: 'temple_acolyte',   faction: 'temple', slot: 'founder',  displayName: 'Acolyte',   earlyUnlock: true,  unitClass: 'support', cost: 2, hp: 12, attack: 5, defense: 3, speed: 2, range: 1, vision: 3, commandCost: 1, isSupport: false, isSiege: false, projectsZOC: false, assetReference: 'warrior_standing', placeholderAsset: true },
];

export const FACTION_UNITS: Record<FactionId, FactionUnitDef[]> = {
  agrar: AGRAR_UNITS,
  temple: TEMPLE_UNITS,
};

// §39 — units available immediately after faction lock, before any tech
// (derived from each def's earlyUnlock flag — single source of truth).
// Founder/Builder/Acolyte is deliberately excluded even though earlyUnlock is
// true for it (present on the board from turn 1) — it's never RECRUITABLE
// via a structure at any point, regardless of tech (§6).
export const EARLY_UNLOCKED_SLOTS: Record<FactionId, UnitType[]> = {
  agrar: AGRAR_UNITS.filter(u => u.earlyUnlock && u.slot !== 'founder').map(u => u.slot),
  temple: TEMPLE_UNITS.filter(u => u.earlyUnlock && u.slot !== 'founder').map(u => u.slot),
};

// §51 — structure stats.
export interface StructureDef { hp: number; defense: number; }
export const STRUCTURES: Record<'farm' | 'temple' | 'city' | 'capital', StructureDef> = {
  farm: { hp: 12, defense: 4 },
  temple: { hp: 26, defense: 5 },
  city: { hp: 30, defense: 6 },
  capital: { hp: 40, defense: 6 },
};

// §21 — Command cap tiers. Only Command I/II raise the cap; territory never does.
export const COMMAND_TIERS = { start: 8, commandI: 10, commandII: 12 } as const;

// §19-20 — production slots: Capital gives 2, each controlled expansion +1.
export const CAPITAL_PRODUCTION_SLOTS = 2;
export const PRODUCTION_SLOTS_PER_EXPANSION = 1;
export const UNIT_TRAINING_ROUNDS = 1;

// §4, §12-19 — shared economy constants (identical for both factions).
export const STARTING_ENERGY = 6;
export const BASE_INCOME_PER_ROUND = 6;
export const INCOME_PER_DEVELOPED_SITE = 2;
export const SITE_ESTABLISH_COST = 4;      // City / Temple founding
export const AGRAR_FARM_COST = 3;          // x2 farm slots per City
export const AGRAR_FARM_INCOME = 1;
export const FARM_SLOTS_PER_CITY = 2;
export const TEMPLE_DEVOTION_COST = 3;     // x2 devotion levels per Temple
export const TEMPLE_DEVOTION_INCOME = 1;
export const TEMPLE_DEVOTION_MAX_LEVEL = 2;
export const FARM_DISTANCE_FROM_CITY = 2;  // §14

// §23-25 — Agrar-only physical Roads. Temple gets no equivalent bonus.
export const ROAD_COST_PER_HEX = 1;
export const ROAD_MOVEMENT_BONUS = 1;
export const ROAD_PILLAGE_REBUILD_COST = 1;

// §32-36 — combat/tech shared constants relevant to the data model.
export const TECH_COST = 5;
export const SPLASH_FACTOR = 0.4;
export const EFFECTIVE_RANGE_CAP = 4;       // §46 — absolute, after all modifiers
export const ENCIRCLEMENT_MAX_MULTIPLIER = 1.5;
