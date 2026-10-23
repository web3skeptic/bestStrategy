// Pure, faction-agnostic combat math. Deliberately has no dependency on
// GameState/Unit — game.ts (live engine), ai.ts (target scoring) and the
// faction data model / tests all call into this one place so the damage
// formula is never duplicated. See the "Asymmetric Tribes v0.2" design brief
// §30-36 for the source rules this implements.

export type UnitClass = 'warrior' | 'pike' | 'archer' | 'cavalry' | 'siege' | 'heavy' | 'support' | 'structure';

// Soft-counter multipliers: attacker class -> defender class -> multiplier.
// Deliberately soft (max 1.35x, never a hard immunity) so an equal-cost
// counter is a strong answer, not an auto-win. Unlisted pairs default to 1.
const COUNTER_MATRIX: Partial<Record<UnitClass, Partial<Record<UnitClass, number>>>> = {
  pike:    { cavalry: 1.35, heavy: 1.35 },
  cavalry: { archer: 1.25, siege: 1.25, support: 1.25 },
  archer:  { pike: 1.25 },
  siege:   { heavy: 1.30, structure: 1.30 },
  heavy:   { warrior: 1.20, archer: 1.20 },
};

export function getTypeMultiplier(attackerClass: UnitClass, defenderClass: UnitClass): number {
  return COUNTER_MATRIX[attackerClass]?.[defenderClass] ?? 1;
}

// Wounded units fight weaker but never drop below half strength, so a
// near-dead unit is still a real threat instead of a free kill.
export function healthMultiplier(hpFraction: number): number {
  return 0.5 + 0.5 * Math.max(0, Math.min(1, hpFraction));
}

// A landed hit always deals at least 25% of modified attack, regardless of
// defense — no stat combination can make a unit unkillable or make an elite
// deal zero damage into a hard-countering defender.
export function calculateDamage(
  attackerAtk: number,
  defenderDef: number,
  encirclementMultiplier: number,
  typeMultiplier = 1,
  hpFraction = 1,
): number {
  const modifiedAttack = attackerAtk * typeMultiplier;
  const baseDamage = Math.max(0.25 * modifiedAttack, modifiedAttack - defenderDef);
  const raw = baseDamage * healthMultiplier(hpFraction) * encirclementMultiplier;
  return Math.max(0, Math.round(raw));
}
