import { supportFalloffAmount, getSupportBoostsForUnit, getEffectiveAttack, getEffectiveRange } from '../src/game';
import { DAMAGE_BOOST_AMOUNT, HEALER_HEAL_AMOUNT, RANGE_BOOST_AMOUNT } from '../src/game';
import type { GameState, Unit } from '../src/types';

console.log('=== supportFalloffAmount (base=5) across distance 0..3 ===');
for (const d of [0, 1, 2, 3]) {
  console.log(`  dist ${d}: heal/dmg base 5 -> ${supportFalloffAmount(5, d)}`);
}

console.log('\n=== Constants ===');
console.log('  DAMAGE_BOOST_AMOUNT =', DAMAGE_BOOST_AMOUNT);
console.log('  HEALER_HEAL_AMOUNT  =', HEALER_HEAL_AMOUNT);
console.log('  RANGE_BOOST_AMOUNT  =', RANGE_BOOST_AMOUNT);

// Build a minimal fake state: a warrior at origin, and one booster we relocate.
function mkUnit(type: string, q: number, r: number, id: string): Unit {
  return {
    id, type, playerId: 0, pos: { q, r },
    hp: 20, hasMoved: false, hasAttacked: false,
    stats: { maxHp: 20, attack: 10, defense: 5, range: 1, speed: 3, vision: 3, splashFactor: 0 } as any,
  } as unknown as Unit;
}

const warrior = mkUnit('warrior', 0, 0, 'w');
console.log('\n=== Damage booster: effective ATK of a warrior (base ATK 10) vs booster distance ===');
for (const d of [0, 1, 2, 3]) {
  const booster = mkUnit('damageBooster', d, 0, 'b'); // distance d along +q axis == hex dist d
  const state = { units: [warrior, booster], hills: new Set() } as unknown as GameState;
  const { damageBonus } = getSupportBoostsForUnit(state, warrior);
  const atk = getEffectiveAttack(state, warrior);
  console.log(`  booster at dist ${d}: +${damageBonus} ATK -> effective ${atk}`);
}

console.log('\n=== Range booster: effective RANGE of a warrior (base RNG 1) vs booster distance ===');
for (const d of [0, 1, 2, 3]) {
  const booster = mkUnit('rangeBooster', d, 0, 'b');
  const state = { units: [warrior, booster], hills: new Set() } as unknown as GameState;
  const { rangeBonus } = getSupportBoostsForUnit(state, warrior);
  const rng = getEffectiveRange(state, warrior);
  console.log(`  booster at dist ${d}: +${rangeBonus} RNG -> effective ${rng}`);
}

console.log('\n=== Healer heal amount vs distance (uses supportFalloffAmount(HEAL,dist)) ===');
for (const d of [0, 1, 2, 3]) {
  console.log(`  ally at dist ${d}: heals ${supportFalloffAmount(HEALER_HEAL_AMOUNT, d)} HP`);
}
