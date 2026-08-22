// Phase 1 verification for the "Asymmetric Tribes v0.2" combat rewrite.
// Asserts the invariants from design brief §30-36, §75-76 against the real
// engine functions (combat.ts, game.ts) and the new faction roster
// (factions.ts). Exits non-zero on any failure — run with:
//   npx tsx scripts/verify-combat-v3.ts
import { calculateDamage, getTypeMultiplier, healthMultiplier, UnitClass } from '../src/combat';
import { calculateEncirclement } from '../src/game';
import { HILL_DEFENSE_BONUS } from '../src/types';
import { AGRAR_UNITS, TEMPLE_UNITS, FactionUnitDef, ENCIRCLEMENT_MAX_MULTIPLIER, SPLASH_FACTOR } from '../src/factions';
import type { GameState, Unit } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── §30: combat is deterministic ──
console.log('\n=== Determinism ===');
{
  const results = new Set<number>();
  for (let i = 0; i < 200; i++) {
    results.add(calculateDamage(10, 4, 1.2, 1.1, 0.7));
  }
  check('calculateDamage is deterministic across 200 calls with identical inputs', results.size === 1, `got ${results.size} distinct outputs`);
}

// ── §31: health multiplier table ──
console.log('\n=== Health multiplier (§31) ===');
{
  const cases: [number, number][] = [[1.0, 1.0], [0.75, 0.875], [0.5, 0.75], [0.25, 0.625]];
  for (const [frac, expected] of cases) {
    const got = healthMultiplier(frac);
    check(`healthMultiplier(${frac}) === ${expected}`, Math.abs(got - expected) < 1e-9, `got ${got}`);
  }
}

// ── §32: damage formula shape — 25% floor, subtractive above floor ──
console.log('\n=== Damage formula (§32) ===');
{
  // High attack vs low defense: subtractive term wins.
  const d1 = calculateDamage(20, 4, 1, 1, 1); // modifiedAttack=20, base=max(5,16)=16, dmg=round(16*1*1)=16
  check('subtractive term used when attack >> defense', d1 === 16, `got ${d1}`);

  // High defense vs the same attack: 25% floor kicks in.
  const d2 = calculateDamage(20, 19, 1, 1, 1); // base=max(5, 1)=5
  check('25% floor used when defense nearly matches attack', d2 === 5, `got ${d2}`);

  // Defense exceeding attack still deals real damage via the floor — no unit is unkillable.
  const d3 = calculateDamage(10, 50, 1, 1, 1); // base=max(2.5, -40)=2.5 -> round(2.5)=3 (JS round-half-up)
  check('defense far exceeding attack still deals floor damage (not 0)', d3 > 0, `got ${d3}`);
}

// ── §34: soft-counter matrix — soft (<=1.35x), never a hard immunity ──
console.log('\n=== Soft counters (§34) ===');
{
  const classes: UnitClass[] = ['warrior', 'pike', 'archer', 'cavalry', 'siege', 'heavy', 'support', 'structure'];
  let maxMult = 1;
  for (const a of classes) for (const b of classes) maxMult = Math.max(maxMult, getTypeMultiplier(a, b));
  check('no counter multiplier exceeds 1.35x (no hard counters)', maxMult <= 1.35 + 1e-9, `max found ${maxMult}`);
  check('pike beats cavalry at 1.35x', getTypeMultiplier('pike', 'cavalry') === 1.35);
  check('pike beats heavy at 1.35x', getTypeMultiplier('pike', 'heavy') === 1.35);
  check('unmatched pair defaults to 1.0x (no immunity, no bonus)', getTypeMultiplier('warrior', 'siege') === 1);
}

// ── §36: no equal-cost one-shot ──
console.log('\n=== No equal-cost one-shot (§36, §75-76) ===');
{
  const roster: FactionUnitDef[] = [...AGRAR_UNITS, ...TEMPLE_UNITS];
  let violations: string[] = [];
  for (const attacker of roster) {
    for (const defender of roster) {
      if (defender.cost < attacker.cost) continue; // equal-or-greater cost only
      const typeMult = getTypeMultiplier(attacker.unitClass, defender.unitClass);
      // Neutral terrain, full health, no encirclement, no support — the most
      // favorable single-hit case for the attacker.
      const dmg = calculateDamage(attacker.attack, defender.defense, 1, typeMult, 1);
      if (dmg >= defender.hp) {
        violations.push(`${attacker.id} (${attacker.cost}⚡) one-shots ${defender.id} (${defender.cost}⚡): ${dmg} >= ${defender.hp}hp`);
      }
    }
  }
  check(
    `no full-health unit one-shots a full-health equal-or-higher-cost unit (${roster.length * roster.length} pairs checked)`,
    violations.length === 0,
    violations.slice(0, 5).join('; '),
  );
}

// ── §47: hill defense bonus is +1 ──
console.log('\n=== Terrain (§47) ===');
check('HILL_DEFENSE_BONUS === 1', HILL_DEFENSE_BONUS === 1, `got ${HILL_DEFENSE_BONUS}`);

// ── §48-49: encirclement caps at 1.5x, map edges don't count ──
console.log('\n=== Encirclement (§48-49) ===');
{
  function mkUnit(id: string, playerId: number, q: number, r: number): Unit {
    return {
      id, type: 'warrior', playerId, pos: { q, r }, hp: 15,
      hasMoved: false, hasAttacked: false, hasCaptured: false,
      stats: { maxHp: 15, attack: 10, defense: 5, speed: 1, range: 1, splash: 0, splashFactor: 0, canBeRevenged: true, vision: 2, cantShootAfterMove: false },
    };
  }

  // Lone defender at the map's edge, far from the centre, with zero enemies —
  // the edge itself must not contribute encirclement pressure.
  const lonelyDefender = mkUnit('d', 0, 5, 0);
  const edgeState = { units: [lonelyDefender], mapRadius: 5 } as unknown as GameState;
  const edgeEnc = calculateEncirclement(edgeState, lonelyDefender);
  check('a unit alone at the map edge (no enemies) has attackMultiplier === 1.0', edgeEnc.attackMultiplier === 1.0, `got ${edgeEnc.attackMultiplier}`);

  // Fully surround + fully pinch a lone defender at the map centre with six
  // enemies (one per hex direction) — this should hit the 1.5x cap, not 2.0x.
  const centreDefender = mkUnit('d2', 0, 0, 0);
  const ring: Unit[] = [
    mkUnit('e0', 1, 1, 0), mkUnit('e1', 1, 1, -1), mkUnit('e2', 1, 0, -1),
    mkUnit('e3', 1, -1, 0), mkUnit('e4', 1, -1, 1), mkUnit('e5', 1, 0, 1),
  ];
  const surroundedState = { units: [centreDefender, ...ring], mapRadius: 5 } as unknown as GameState;
  const surroundedEnc = calculateEncirclement(surroundedState, centreDefender);
  check('fully surrounded + fully pinched attackMultiplier === 1.5 (cap)', Math.abs(surroundedEnc.attackMultiplier - ENCIRCLEMENT_MAX_MULTIPLIER) < 1e-9, `got ${surroundedEnc.attackMultiplier}`);
}

// ── §50: splash factor is 0.4 ──
console.log('\n=== Splash (§50) ===');
check('SPLASH_FACTOR === 0.4', SPLASH_FACTOR === 0.4, `got ${SPLASH_FACTOR}`);

// ── Summary ──
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
