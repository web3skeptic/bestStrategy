import { GameState, HexCoord, Unit, UnitType, UNIT_COSTS, templeUpgradeCost } from './types';
import { hexDistance, getReachableHexes } from './hex';
import { getCurrentPlayer, getUnitAt, spawnUnit, calculateEncirclement, getEffectiveDefense, getEffectiveAttack, getEffectiveRange, isForestUnitRevealed, getPopulationCap, getPopulationCount, getUnlockedUnits, canResearch, researchTech, upgradeTemple, captureTemple, canCaptureTemple } from './game';
import { hexKey, hexEqual } from './hex';

const AI_PLAYER_ID = 1;

export interface AIAction {
  type: 'spawn' | 'move' | 'attack' | 'move+attack' | 'upgrade';
  pos: HexCoord;
  description: string;
}

function findNearestEnemy(state: GameState, pos: HexCoord, playerId: number): Unit | null {
  const enemies = state.units.filter(u =>
    u.hp > 0 && u.playerId !== playerId &&
    isForestUnitRevealed(state, u.pos, playerId)
  );
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
  const effRange = getEffectiveRange(state, unit);
  const enemies = state.units.filter(u => u.hp > 0 && u.playerId !== unit.playerId);
  let best: Unit | null = null;
  let bestHp = Infinity;
  for (const e of enemies) {
    if (hexDistance(unit.pos, e.pos) <= effRange) {
      if (!isForestUnitRevealed(state, e.pos, unit.playerId)) continue;
      if (e.hp < bestHp) { bestHp = e.hp; best = e; }
    }
  }
  return best;
}

// Mirrors src/game.ts calculateDamage exactly: a SINGLE round of
// multiplier * enc * typeBonus * (atk - def). typeBonus is folded INTO the
// round here so callers must NOT round again after applying a type bonus.
function calcDamage(atk: number, def: number, encMult: number, typeBonus = 1): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const multiplier = Math.max(0.5, Math.min(1.5, 1.0 + z * 0.2));
  return Math.max(0, Math.round(multiplier * encMult * typeBonus * (atk - def)));
}

function doAIAttack(state: GameState, attacker: Unit, target: Unit): void {
  const targetEnc = calculateEncirclement(state, target);
  const attackerEnc = calculateEncirclement(state, attacker);

  const targetDef = getEffectiveDefense(state, target);
  const attackerDef = getEffectiveDefense(state, attacker);

  // Apply type bonus multipliers (attack bonus / defense bonus)
  const typeBonus = (attacker.stats.attackBonusAgainst?.[target.type] ?? 1) / (target.stats.defenseBonusAgainst?.[attacker.type] ?? 1);

  // Fold typeBonus into the single round so this matches the engine's
  // calculateDamage exactly: round(multiplier * enc * typeBonus * (atk - def)).
  const dmg = calcDamage(getEffectiveAttack(state, attacker), targetDef, targetEnc.attackMultiplier, typeBonus);
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
    const targetEffRange = getEffectiveRange(state, target);
    if (dist <= targetEffRange) {
      const revDmg = calcDamage(getEffectiveAttack(state, target), attackerDef, attackerEnc.attackMultiplier);
      attacker.hp -= revDmg;
      if (attacker.hp <= 0) attacker.hp = 0;
    }
  }

  // Melee unit steps onto killed unit's tile
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

  // 1. Spawn — pick best affordable unit within population cap
  const aiTemples = state.temples.filter(t => t.ownerId === AI_PLAYER_ID);
  const cap = getPopulationCap(state, AI_PLAYER_ID);
  const count = getPopulationCount(state, AI_PLAYER_ID);

  const aiUnlocked = getUnlockedUnits(state.playerTech[AI_PLAYER_ID]!);

  for (const temple of aiTemples) {
    if (getUnitAt(state, temple.pos)) continue;
    if (getPopulationCount(state, AI_PLAYER_ID) >= getPopulationCap(state, AI_PLAYER_ID)) break;

    let spawnType: UnitType | null = null;
    if (aiUnlocked.has('heavyknight') && player.aura >= UNIT_COSTS.heavyknight && Math.random() < 0.2) {
      spawnType = 'heavyknight';
    } else if (aiUnlocked.has('catapult') && player.aura >= UNIT_COSTS.catapult && Math.random() < 0.2) {
      spawnType = 'catapult';
    } else if (aiUnlocked.has('horserider') && player.aura >= UNIT_COSTS.horserider && Math.random() < 0.25) {
      spawnType = 'horserider';
    } else if (aiUnlocked.has('spearsman') && player.aura >= UNIT_COSTS.spearsman && Math.random() < 0.25) {
      spawnType = 'spearsman';
    } else if (aiUnlocked.has('healer') && player.aura >= UNIT_COSTS.healer && Math.random() < 0.15) {
      spawnType = 'healer';
    } else if (aiUnlocked.has('damageBooster') && player.aura >= UNIT_COSTS.damageBooster && Math.random() < 0.15) {
      spawnType = 'damageBooster';
    } else if (aiUnlocked.has('rangeBooster') && player.aura >= UNIT_COSTS.rangeBooster && Math.random() < 0.15) {
      spawnType = 'rangeBooster';
    } else if (aiUnlocked.has('archer') && player.aura >= UNIT_COSTS.archer) {
      spawnType = 'archer';
    } else if (aiUnlocked.has('warrior') && player.aura >= UNIT_COSTS.warrior) {
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

    // Capture a temple we're standing on. captureTemple only sets hasCaptured
    // (not hasMoved/hasAttacked), so fall through to still move+attack this turn.
    const capturable = canCaptureTemple(state, unit);
    if (capturable) {
      captureTemple(state, unit, capturable);
      actions.push({
        type: 'upgrade',
        pos: { ...unit.pos },
        description: `AI captures temple at (${unit.pos.q},${unit.pos.r})`,
      });
    }

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

    if (unit.hasMoved) continue;
    const nearestEnemy = findNearestEnemy(state, unit.pos, AI_PLAYER_ID);
    if (!nearestEnemy) continue;

    const moveHex = bestMoveToward(state, unit, nearestEnemy.pos);
    if (moveHex) {
      unit.pos = { ...moveHex };
      unit.hasMoved = true;

      // no current unit sets this; kept as a forward-compat hook
      if (unit.stats.cantShootAfterMove) {
        actions.push({
          type: 'move',
          pos: { ...moveHex },
          description: `AI ${unit.type} moves to (${moveHex.q},${moveHex.r})`,
        });
      } else {
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

// ── Hard AI (Economic strategy) ──────────────────────────────────────────────
//
// Based on simulation results: Economic strategy wins ~99% of games.
// Phase 1: Upgrade home temple toward level 3; keep ≥1 warrior as guard.
// Phase 2 (home temple ≥ 3): Research unlock_spearsman; spawn spearsmen+archers 2:1.
// Always: upgrade captured neutral temples to level 2; capture temples explicitly.

export function runHardAITurn(state: GameState): AIAction[] {
  const actions: AIAction[] = [];
  const player = getCurrentPlayer(state);
  if (player.id !== AI_PLAYER_ID) return actions;

  const aiTemples = state.temples.filter(t => t.ownerId === AI_PLAYER_ID);
  // Identify the AI's home (starting) temple. createGameState seeds player 1's
  // start temple at {q:4, r:-2} — see createTemple({ q: 4, r: -2 }, 1) in
  // game.ts. There's currently no ownedAtStart flag / stable temple id to key
  // off, so we match the known home coordinate and fall back to the first owned
  // temple if the map layout ever changes. (If a durable signal is added, prefer
  // it here.)
  const HOME_TEMPLE_POS: HexCoord = { q: 4, r: -2 };
  const homeTemple =
    aiTemples.find(t => t.pos.q === HOME_TEMPLE_POS.q && t.pos.r === HOME_TEMPLE_POS.r) ?? aiTemples[0];
  const homeLevel = homeTemple?.level ?? 0;
  const phase2 = homeLevel >= 3;

  // 1. Research unlock_spearsman once in phase 2
  if (phase2 && canResearch(state, 'unlock_spearsman')) {
    researchTech(state, 'unlock_spearsman');
  }

  // 2. Upgrade home temple toward level 3
  if (homeTemple && homeLevel < 3) {
    const cost = templeUpgradeCost(homeLevel);
    if (cost !== null && player.aura >= cost) {
      upgradeTemple(state, homeTemple.id);
    }
  }

  // 3. Upgrade captured neutral temples toward level 2
  for (const temple of aiTemples) {
    if (temple === homeTemple) continue;
    if (temple.level < 2) {
      const cost = templeUpgradeCost(temple.level);
      if (cost !== null && player.aura >= cost) {
        upgradeTemple(state, temple.id);
      }
    }
  }

  // 4. Spawn units
  const aiUnlocked = getUnlockedUnits(state.playerTech[AI_PLAYER_ID]!);
  for (const temple of aiTemples) {
    if (getUnitAt(state, temple.pos)) continue;
    if (getPopulationCount(state, AI_PLAYER_ID) >= getPopulationCap(state, AI_PLAYER_ID)) break;

    let spawnType: UnitType | null = null;

    if (!phase2) {
      // Phase 1: keep at least 1 warrior alive as a guard
      const myCount = state.units.filter(u => u.hp > 0 && u.playerId === AI_PLAYER_ID).length;
      if (myCount === 0 && player.aura >= UNIT_COSTS.warrior) {
        spawnType = 'warrior';
      }
    } else {
      // Phase 2: spearsmen + archers in 2:1 ratio
      const spears = state.units.filter(u => u.hp > 0 && u.playerId === AI_PLAYER_ID && u.type === 'spearsman').length;
      const archers = state.units.filter(u => u.hp > 0 && u.playerId === AI_PLAYER_ID && u.type === 'archer').length;
      if (aiUnlocked.has('spearsman') && spears <= archers * 2 && player.aura >= UNIT_COSTS.spearsman) {
        spawnType = 'spearsman';
      } else if (player.aura >= UNIT_COSTS.archer) {
        spawnType = 'archer';
      } else if (player.aura >= UNIT_COSTS.warrior) {
        spawnType = 'warrior';
      }
    }

    if (!spawnType) continue;
    if (spawnUnit(state, temple.id, spawnType)) {
      actions.push({
        type: 'spawn',
        pos: { ...temple.pos },
        description: `Hard AI spawns ${spawnType} at (${temple.pos.q},${temple.pos.r})`,
      });
    }
  }

  // 5. Move + attack each unit (same logic as normal AI, plus explicit temple capture)
  const aiUnits = state.units.filter(u => u.hp > 0 && u.playerId === AI_PLAYER_ID);

  for (const unit of aiUnits) {
    if (unit.hasAttacked) continue;

    // Explicit temple capture: if standing on capturable temple, capture it.
    // captureTemple only sets hasCaptured (not hasMoved/hasAttacked), so we
    // fall through to the normal attack/move logic and let this unit also act
    // this turn instead of wasting its move+attack. canCaptureTemple returns
    // null once hasCaptured is set, so no double-capture is possible.
    const capturableTemple = canCaptureTemple(state, unit);
    if (capturableTemple) {
      captureTemple(state, unit, capturableTemple);
      actions.push({
        type: 'upgrade',
        pos: { ...unit.pos },
        description: `Hard AI captures temple at (${unit.pos.q},${unit.pos.r})`,
      });
    }

    const immediateTarget = findAttackTarget(state, unit);
    if (immediateTarget) {
      doAIAttack(state, unit, immediateTarget);
      actions.push({
        type: 'attack',
        pos: { ...unit.pos },
        description: `Hard AI ${unit.type} attacks at (${immediateTarget.pos.q},${immediateTarget.pos.r})`,
      });
      continue;
    }

    if (unit.hasMoved) continue;

    // Move priority: uncaptured temple > nearest enemy
    const unownedTemple = state.temples
      .filter(t => t.ownerId !== AI_PLAYER_ID)
      .sort((a, b) => hexDistance(unit.pos, a.pos) - hexDistance(unit.pos, b.pos))[0];
    const nearestEnemy = findNearestEnemy(state, unit.pos, AI_PLAYER_ID);

    // Pick closer of uncaptured temple vs nearest enemy
    let moveTarget: HexCoord | null = null;
    const templeDist = unownedTemple ? hexDistance(unit.pos, unownedTemple.pos) : Infinity;
    const enemyDist = nearestEnemy ? hexDistance(unit.pos, nearestEnemy.pos) : Infinity;
    if (templeDist <= enemyDist && unownedTemple) {
      moveTarget = unownedTemple.pos;
    } else if (nearestEnemy) {
      moveTarget = nearestEnemy.pos;
    }

    if (!moveTarget) continue;

    const moveHex = bestMoveToward(state, unit, moveTarget);
    if (moveHex) {
      unit.pos = { ...moveHex };
      unit.hasMoved = true;

      // no current unit sets this; kept as a forward-compat hook
      if (unit.stats.cantShootAfterMove) {
        actions.push({
          type: 'move',
          pos: { ...moveHex },
          description: `Hard AI ${unit.type} moves to (${moveHex.q},${moveHex.r})`,
        });
      } else {
        const targetAfterMove = findAttackTarget(state, unit);
        if (targetAfterMove) {
          doAIAttack(state, unit, targetAfterMove);
          actions.push({
            type: 'move+attack',
            pos: { ...moveHex },
            description: `Hard AI ${unit.type} moves to (${moveHex.q},${moveHex.r}) and attacks`,
          });
        } else {
          actions.push({
            type: 'move',
            pos: { ...moveHex },
            description: `Hard AI ${unit.type} moves to (${moveHex.q},${moveHex.r})`,
          });
        }
      }
    }
  }

  return actions;
}
