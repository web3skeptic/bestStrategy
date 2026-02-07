import { GameState, HexCoord, Unit, UnitType, UNIT_COSTS } from './types';
import { hexDistance, getReachableHexes } from './hex';
import { getCurrentPlayer, getUnitAt, spawnUnit, calculateEncirclement, getEffectiveDefense } from './game';

const AI_PLAYER_ID = 1;

export interface AIAction {
  type: 'spawn' | 'move' | 'attack' | 'move+attack';
  pos: HexCoord; // where the action happens (for visibility check)
  description: string;
}

function findNearestEnemy(state: GameState, pos: HexCoord, playerId: number): Unit | null {
  const enemies = state.units.filter(u => u.hp > 0 && u.playerId !== playerId);
  if (enemies.length === 0) return null;
  let best: Unit | null = null;
  let bestDist = Infinity;
  for (const e of enemies) {
    const d = hexDistance(pos, e.pos);
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return best;
}

function bestMoveToward(state: GameState, unit: Unit, target: HexCoord): HexCoord | null {
  const occupied = state.units.filter(u => u.hp > 0 && u.id !== unit.id).map(u => u.pos);
  const wallPositions = [...state.walls].map(k => { const [q, r] = k.split(',').map(Number); return { q: q!, r: r! }; });
  const reachable = getReachableHexes(unit.pos, unit.stats.speed, state.mapRadius, [...occupied, ...wallPositions], state.hills);
  if (reachable.length === 0) return null;

  let best: HexCoord | null = null;
  let bestDist = hexDistance(unit.pos, target);
  for (const hex of reachable) {
    const d = hexDistance(hex, target);
    if (d < bestDist) { bestDist = d; best = hex; }
  }
  return best;
}

function findAttackTarget(state: GameState, unit: Unit): Unit | null {
  const enemies = state.units.filter(u => u.hp > 0 && u.playerId !== unit.playerId);
  let best: Unit | null = null;
  let bestHp = Infinity;
  for (const e of enemies) {
    if (hexDistance(unit.pos, e.pos) <= unit.stats.range) {
      if (e.hp < bestHp) { bestHp = e.hp; best = e; }
    }
  }
  return best;
}

function calcDamage(atk: number, def: number, encMult: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const multiplier = Math.max(0.5, Math.min(1.5, 1.0 + z * 0.2));
  return Math.max(0, Math.round(multiplier * encMult * (atk - def)));
}

function doAIAttack(state: GameState, attacker: Unit, target: Unit): void {
  const targetEnc = calculateEncirclement(state, target);
  const attackerEnc = calculateEncirclement(state, attacker);

  const targetDef = getEffectiveDefense(state, target);
  const attackerDef = getEffectiveDefense(state, attacker);

  const dmg = calcDamage(attacker.stats.attack, targetDef, targetEnc.attackMultiplier);
  target.hp -= dmg;
  if (target.hp <= 0) target.hp = 0;

  // Splash
  if (attacker.stats.splash > 0) {
    const splashTargets = state.units.filter(u =>
      u.hp > 0 && u.id !== target.id && u.playerId !== attacker.playerId &&
      hexDistance(target.pos, u.pos) <= attacker.stats.splash
    );
    for (const su of splashTargets) {
      const sEnc = calculateEncirclement(state, su);
      const suDef = getEffectiveDefense(state, su);
      const sDmg = Math.round(calcDamage(attacker.stats.attack, suDef, sEnc.attackMultiplier) * attacker.stats.splashFactor);
      su.hp -= sDmg;
      if (su.hp <= 0) su.hp = 0;
    }
  }

  const targetKilled = target.hp <= 0;

  // Revenge
  if (!targetKilled && attacker.stats.canBeRevenged) {
    const dist = hexDistance(attacker.pos, target.pos);
    if (dist <= target.stats.range) {
      const revDmg = calcDamage(target.stats.attack, attackerDef, attackerEnc.attackMultiplier);
      attacker.hp -= revDmg;
      if (attacker.hp <= 0) attacker.hp = 0;
    }
  }

  // Warrior steps onto killed unit's tile (melee only)
  if (targetKilled && attacker.hp > 0 && attacker.stats.range === 1) {
    attacker.pos = { ...target.pos };
  }

  attacker.hasAttacked = true;
  attacker.hasMoved = true;
}

// Run one full AI turn
export function runAITurn(state: GameState): AIAction[] {
  const actions: AIAction[] = [];
  const player = getCurrentPlayer(state);
  if (player.id !== AI_PLAYER_ID) return actions;

  // 1. Spawn — prefer archer, fallback warrior
  const aiTemples = state.temples.filter(t => t.ownerId === AI_PLAYER_ID);
  for (const temple of aiTemples) {
    if (getUnitAt(state, temple.pos)) continue;

    let spawnType: UnitType | null = null;
    if (player.aura >= UNIT_COSTS.sniper && Math.random() < 0.3) {
      spawnType = 'sniper';
    } else if (player.aura >= UNIT_COSTS.bomber && Math.random() < 0.25) {
      spawnType = 'bomber';
    } else if (player.aura >= UNIT_COSTS.archer) {
      spawnType = 'archer';
    } else if (player.aura >= UNIT_COSTS.warrior) {
      spawnType = 'warrior';
    }
    if (!spawnType) continue;

    if (spawnUnit(state, temple.id, spawnType)) {
      actions.push({
        type: 'spawn',
        pos: { ...temple.pos },
        description: `AI spawns ${spawnType} at (${temple.pos.q},${temple.pos.r})`,
      });
    }
  }

  // 2. Move + attack each unit
  const aiUnits = state.units.filter(u => u.hp > 0 && u.playerId === AI_PLAYER_ID);

  for (const unit of aiUnits) {
    if (unit.hasAttacked) continue;

    // Try attack from current position
    const immediateTarget = findAttackTarget(state, unit);
    if (immediateTarget) {
      doAIAttack(state, unit, immediateTarget);
      actions.push({
        type: 'attack',
        pos: { ...unit.pos },
        description: `AI ${unit.type} attacks at (${immediateTarget.pos.q},${immediateTarget.pos.r})`,
      });
      continue;
    }

    // Move toward nearest enemy
    if (unit.hasMoved) continue;
    const nearestEnemy = findNearestEnemy(state, unit.pos, AI_PLAYER_ID);
    if (!nearestEnemy) continue;

    const moveHex = bestMoveToward(state, unit, nearestEnemy.pos);
    if (moveHex) {
      unit.pos = { ...moveHex };
      unit.hasMoved = true;

      // cantShootAfterMove: skip attack after moving
      if (unit.stats.cantShootAfterMove) {
        actions.push({
          type: 'move',
          pos: { ...moveHex },
          description: `AI ${unit.type} moves to (${moveHex.q},${moveHex.r})`,
        });
      } else {
        // Try attack after move
        const targetAfterMove = findAttackTarget(state, unit);
        if (targetAfterMove) {
          doAIAttack(state, unit, targetAfterMove);
          actions.push({
            type: 'move+attack',
            pos: { ...moveHex },
            description: `AI ${unit.type} moves to (${moveHex.q},${moveHex.r}) and attacks`,
          });
        } else {
          actions.push({
            type: 'move',
            pos: { ...moveHex },
            description: `AI ${unit.type} moves to (${moveHex.q},${moveHex.r})`,
          });
        }
      }
    }
  }

  return actions;
}
