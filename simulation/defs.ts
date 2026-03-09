// Unit definitions for simulation
// Stats: post-balance values, no tech bonuses applied.
//
// AURA = placement budget (unit cost only).
// Research cost is NOT deducted from aura — it is a one-time unlock fee paid separately.
// This means all unit types, including heavy knight, compete on their raw unit cost.

export interface UnitDef {
  type: string;
  hp: number;
  attack: number;
  defense: number;
  speed: number;
  range: number;         // attack range in 1D positions
  cost: number;          // aura cost per unit (research NOT included)
  requiresResearch: boolean; // informational only — not counted in aura
  splash: number;        // splash radius (positions around primary target)
  splashFactor: number;  // damage multiplier for splash hits
  // if false, target CANNOT retaliate when THIS unit attacks (catapult fires from long range)
  triggersRetaliation: boolean;
}

export const UNIT_DEFS: Record<string, UnitDef> = {
  warrior: {
    type: 'warrior', hp: 15, attack: 10, defense: 5,
    speed: 1, range: 1, cost: 1, requiresResearch: false,
    splash: 0, splashFactor: 0, triggersRetaliation: true,
  },
  archer: {
    type: 'archer', hp: 15, attack: 10, defense: 3,
    speed: 2, range: 2, cost: 2, requiresResearch: false,
    splash: 0, splashFactor: 0, triggersRetaliation: true,
  },
  horserider: {
    type: 'horserider', hp: 15, attack: 16, defense: 2,
    speed: 2, range: 1, cost: 3, requiresResearch: false,
    splash: 0, splashFactor: 0, triggersRetaliation: true,
  },
  spearsman: {
    type: 'spearsman', hp: 20, attack: 15, defense: 5,
    speed: 2, range: 1, cost: 2, requiresResearch: true,
    splash: 0, splashFactor: 0, triggersRetaliation: true,
  },
  catapult: {
    type: 'catapult', hp: 10, attack: 14, defense: 1,
    speed: 1, range: 3, cost: 4, requiresResearch: true,
    splash: 0, splashFactor: 0, triggersRetaliation: false,
  },
  heavyknight: {
    type: 'heavyknight', hp: 22, attack: 20, defense: 8,
    speed: 3, range: 1, cost: 7, requiresResearch: true,
    splash: 0, splashFactor: 0, triggersRetaliation: true,
  },
};
