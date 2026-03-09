// 1D Battle Simulation Engine
//
// Field: positions 0..FIELD_SIZE (integers).
//   Army 0 starts on the left, faces right (+).
//   Army 1 starts on the right, faces left (-).
//
// Placement (key requirement):
//   Long-range units (range ≥ 2) placed BEHIND short-range units.
//   Army 0: ranged at 0..R-1, melee at R..R+M-1  (ranged further from enemy)
//   Army 1: ranged at FIELD_SIZE..FIELD_SIZE-R+1, melee at FIELD_SIZE-R..FIELD_SIZE-R-M+1
//
// Movement:
//   Each unit moves up to speed steps toward the closest enemy.
//   Ranged units stop as soon as an enemy is within their range.
//   Ranged units never advance past their own front melee line.
//
// Combat (per turn, ordered by speed descending):
//   If an enemy is within range: attack. Otherwise: move.
//   Damage = max(0, round(randomMultiplier() * (attacker.attack - target.defense)))
//   Splash: catapult hits units within splash radius of target.
//   Retaliation: if attacker.triggersRetaliation && target survives && dist ≤ 1.
//
// Win condition: all units of one army reach 0 HP.
// Draw: MAX_ROUNDS exceeded → winner decided by remaining total HP.

import { UnitDef } from './defs.ts';

const FIELD_SIZE = 20;
const MAX_ROUNDS = 120;

export interface BattleResult {
  winner: 0 | 1 | null;  // null = true draw
  rounds: number;
  survivorHp: [number, number];  // total remaining HP per army
}

interface BattleUnit {
  id: number;
  def: UnitDef;
  army: 0 | 1;
  hp: number;
  pos: number;
}

function randomMultiplier(): number {
  // Box-Muller: Gaussian around 1.0, stddev 0.2, clamped [0.5, 1.5]
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0.5, Math.min(1.5, 1.0 + z * 0.2));
}

function calcDamage(atk: number, def: number): number {
  return Math.max(0, Math.round(randomMultiplier() * (atk - def)));
}

function placeArmy(defs: UnitDef[], army: 0 | 1, idBase: number): BattleUnit[] {
  // Sort: melee first (range 1), then ranged (range ≥ 2)
  const melee  = defs.filter(u => u.range === 1);
  const ranged = defs.filter(u => u.range >= 2);

  const units: BattleUnit[] = [];
  let id = idBase;

  if (army === 0) {
    // Ranged at left edge (back), melee in front of them (closer to enemy)
    ranged.forEach((u, i) => {
      units.push({ id: id++, def: u, army: 0, hp: u.hp, pos: i });
    });
    melee.forEach((u, i) => {
      units.push({ id: id++, def: u, army: 0, hp: u.hp, pos: ranged.length + i });
    });
  } else {
    // Ranged at right edge (back), melee in front of them (closer to enemy)
    ranged.forEach((u, i) => {
      units.push({ id: id++, def: u, army: 1, hp: u.hp, pos: FIELD_SIZE - i });
    });
    melee.forEach((u, i) => {
      units.push({ id: id++, def: u, army: 1, hp: u.hp, pos: FIELD_SIZE - ranged.length - i });
    });
  }

  return units;
}

export function simulateBattle(army0Defs: UnitDef[], army1Defs: UnitDef[]): BattleResult {
  const units: BattleUnit[] = [
    ...placeArmy(army0Defs, 0, 0),
    ...placeArmy(army1Defs, 1, 1000),
  ];

  const dir = (army: 0 | 1) => army === 0 ? 1 : -1;
  const alive = (u: BattleUnit) => u.hp > 0;
  const enemies = (u: BattleUnit) => units.filter(e => e.army !== u.army && alive(e));
  const friends = (u: BattleUnit) => units.filter(f => f.army === u.army && alive(f));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const a0 = units.filter(u => u.army === 0 && alive(u));
    const a1 = units.filter(u => u.army === 1 && alive(u));
    if (a0.length === 0 || a1.length === 0) break;

    // Act in speed-descending order; ties: army 0 first (slight attacker advantage)
    const turnOrder = [...a0, ...a1].sort((a, b) => b.def.speed - a.def.speed);

    for (const unit of turnOrder) {
      if (!alive(unit)) continue;

      const foes = enemies(unit);
      if (foes.length === 0) break;

      // Distance to each enemy
      const dist = (e: BattleUnit) => Math.abs(e.pos - unit.pos);
      const closest = foes.reduce((best, e) => dist(e) < dist(best) ? e : best);
      const closestDist = dist(closest);

      if (closestDist <= unit.def.range) {
        // ── Attack ──
        const inRange = foes.filter(e => dist(e) <= unit.def.range);
        // Target: lowest HP in range (focus fire)
        const target = inRange.reduce((best, e) => e.hp < best.hp ? e : best);

        const dmg = calcDamage(unit.def.attack, target.def.defense);
        target.hp -= dmg;

        // Splash (1D: hits units within splash radius of target position)
        if (unit.def.splash > 0) {
          for (const st of foes.filter(e => e.id !== target.id && Math.abs(e.pos - target.pos) <= unit.def.splash)) {
            const splashDmg = Math.max(0, Math.round(
              randomMultiplier() * (unit.def.attack - st.def.defense) * unit.def.splashFactor
            ));
            st.hp -= splashDmg;
          }
        }

        // Retaliation: only if adjacent (dist ≤ 1) and target survives and attack triggers it
        if (unit.def.triggersRetaliation && alive(target) && closestDist <= 1) {
          const retDmg = calcDamage(target.def.attack, unit.def.defense);
          unit.hp -= retDmg;
        }
      } else {
        // ── Move ──
        const d = dir(unit.army);

        // How far to move: stop when within attack range of closest enemy
        const stepsNeeded = closestDist - unit.def.range;
        let move = Math.min(unit.def.speed, Math.max(0, stepsNeeded));

        // Ranged units: don't advance past own front melee line
        if (unit.def.range >= 2) {
          const ownMelee = friends(unit).filter(f => f.def.range === 1);
          if (ownMelee.length > 0) {
            const frontline = unit.army === 0
              ? Math.max(...ownMelee.map(f => f.pos))
              : Math.min(...ownMelee.map(f => f.pos));
            const maxPos = unit.army === 0
              ? Math.max(unit.pos, frontline - 1)
              : Math.min(unit.pos, frontline + 1);
            const capped = unit.army === 0
              ? Math.min(unit.pos + move, maxPos)
              : Math.max(unit.pos - move, maxPos);
            move = Math.abs(capped - unit.pos);
          }
        }

        unit.pos += d * move;
      }
    }
  }

  const hp0 = units.filter(u => u.army === 0).reduce((s, u) => s + Math.max(0, u.hp), 0);
  const hp1 = units.filter(u => u.army === 1).reduce((s, u) => s + Math.max(0, u.hp), 0);

  const a0alive = units.filter(u => u.army === 0 && alive(u)).length;
  const a1alive = units.filter(u => u.army === 1 && alive(u)).length;

  let winner: 0 | 1 | null;
  if      (a0alive > 0 && a1alive === 0) winner = 0;
  else if (a1alive > 0 && a0alive === 0) winner = 1;
  else if (hp0 > hp1) winner = 0;
  else if (hp1 > hp0) winner = 1;
  else winner = null;

  const rounds = Math.min(MAX_ROUNDS, units.reduce((_, __) => MAX_ROUNDS, 0)); // placeholder
  return { winner, rounds: MAX_ROUNDS, survivorHp: [hp0, hp1] };
}
