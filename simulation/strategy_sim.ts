// Strategy Tournament Simulation
// Run: npx tsx simulation/strategy_sim.ts [--games=N]
//
// 1D map, positions 0..30
//   P0 home temple: pos 2  |  neutral temple: pos 15  |  P1 home temple: pos 28
// Full-game simulation: economy → research → spawn → combat → capture

import * as fs from 'fs';
import * as path from 'path';

// ─── Constants ───────────────────────────────────────────────────────────────
const FIELD_SIZE = 30;
const MAX_TURNS = 200;
const TECH_COST = 5;
const TEMPLE_INCOME_PER_LEVEL = 2;
const TEMPLE_MAX_LEVEL = 5;
const HEALER_HEAL_AMOUNT = 5;
const DAMAGE_BOOST_AMOUNT = 5;
const RANGE_BOOST_AMOUNT = 1;
const SUPPORT_RANGE = 2;
const POP_CAP_PER_TEMPLE_LEVEL = 2;

// ─── Unit definitions (inline, extends defs.ts) ───────────────────────────────
interface UnitDefSim {
  type: string;
  hp: number;
  attack: number;
  defense: number;
  speed: number;
  range: number;
  cost: number;
  splash: number;
  splashFactor: number;
  triggersRetaliation: boolean;
  isSupport: boolean;
  bonusAgainst?: string[];  // unit types this unit gets 3x damage against
  requiresResearch?: string;
}

const UNIT_DEFS: Record<string, UnitDefSim> = {
  warrior: {
    type: 'warrior', hp: 15, attack: 10, defense: 5,
    speed: 1, range: 1, cost: 1,
    splash: 0, splashFactor: 0, triggersRetaliation: true, isSupport: false,
  },
  archer: {
    type: 'archer', hp: 15, attack: 10, defense: 3,
    speed: 2, range: 2, cost: 2,
    splash: 0, splashFactor: 0, triggersRetaliation: true, isSupport: false,
  },
  horserider: {
    type: 'horserider', hp: 15, attack: 16, defense: 2,
    speed: 2, range: 1, cost: 3,
    splash: 0, splashFactor: 0, triggersRetaliation: true, isSupport: false,
  },
  spearsman: {
    type: 'spearsman', hp: 20, attack: 15, defense: 5,
    speed: 2, range: 1, cost: 2,
    splash: 0, splashFactor: 0, triggersRetaliation: true, isSupport: false,
    bonusAgainst: ['horserider', 'heavyknight'],
    requiresResearch: 'unlock_spearman',
  },
  catapult: {
    type: 'catapult', hp: 10, attack: 14, defense: 1,
    speed: 1, range: 3, cost: 4,
    splash: 0, splashFactor: 0, triggersRetaliation: false, isSupport: false,
    requiresResearch: 'unlock_catapult',
  },
  heavyknight: {
    type: 'heavyknight', hp: 22, attack: 20, defense: 8,
    speed: 3, range: 1, cost: 7,
    splash: 0, splashFactor: 0, triggersRetaliation: true, isSupport: false,
    requiresResearch: 'unlock_heavyknight',
  },
  healer: {
    type: 'healer', hp: 12, attack: 0, defense: 2,
    speed: 2, range: 2, cost: 3,
    splash: 0, splashFactor: 0, triggersRetaliation: false, isSupport: true,
    requiresResearch: 'unlock_healer',
  },
  damageBooster: {
    type: 'damageBooster', hp: 12, attack: 0, defense: 2,
    speed: 2, range: 1, cost: 3,
    splash: 0, splashFactor: 0, triggersRetaliation: false, isSupport: true,
    requiresResearch: 'unlock_damagebooster',
  },
  rangeBooster: {
    type: 'rangeBooster', hp: 12, attack: 0, defense: 2,
    speed: 2, range: 1, cost: 3,
    splash: 0, splashFactor: 0, triggersRetaliation: false, isSupport: true,
    requiresResearch: 'unlock_rangebooster',
  },
};

// Tech prereqs
const TECH_PREREQS: Record<string, string> = {
  catapult_splash: 'unlock_catapult',
};

// ─── State types ──────────────────────────────────────────────────────────────
interface SimUnit {
  id: number;
  playerId: 0 | 1;
  type: string;
  hp: number;
  maxHp: number;
  pos: number;
  attack: number;
  defense: number;
  speed: number;
  range: number;
  splash: number;
  splashFactor: number;
  triggersRetaliation: boolean;
  isSupport: boolean;
  bonusAgainst?: string[];
}

interface SimPlayer {
  id: 0 | 1;
  aura: number;
  researched: Set<string>;
  // stats tracking
  totalAuraSpentOnTech: number;
  unitTypeCounts: Record<string, number>;
}

interface SimTemple {
  pos: number;
  ownerId: number | null;
  level: number;
}

interface SimState {
  players: SimPlayer[];
  units: SimUnit[];
  temples: SimTemple[];
  turn: number;
  unitIdCounter: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function randomMultiplier(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0.5, Math.min(1.5, 1.0 + z * 0.2));
}

function calcDamage(atk: number, def: number, multiplier = 1): number {
  return Math.max(0, Math.round(randomMultiplier() * multiplier * (atk - def)));
}

function dist(a: SimUnit, b: SimUnit): number {
  return Math.abs(a.pos - b.pos);
}

function alive(u: SimUnit): boolean {
  return u.hp > 0;
}

function upgradeTemple(state: SimState, temple: SimTemple): void {
  const upgradeCost = Math.pow(2, temple.level);
  const player = state.players[temple.ownerId!];
  if (player.aura >= upgradeCost && temple.level < TEMPLE_MAX_LEVEL) {
    player.aura -= upgradeCost;
    temple.level++;
  }
}

function totalPopCap(state: SimState, playerId: number): number {
  return state.temples
    .filter(t => t.ownerId === playerId)
    .reduce((s, t) => s + t.level * POP_CAP_PER_TEMPLE_LEVEL, 0);
}

function playerUnitCount(state: SimState, playerId: number): number {
  return state.units.filter(u => u.playerId === playerId && alive(u)).length;
}

function canResearch(player: SimPlayer, tech: string): boolean {
  if (player.researched.has(tech)) return false;
  if (player.aura < TECH_COST) return false;
  const prereq = TECH_PREREQS[tech];
  if (prereq && !player.researched.has(prereq)) return false;
  return true;
}

function doResearch(state: SimState, playerId: 0 | 1, tech: string): boolean {
  const player = state.players[playerId];
  if (!canResearch(player, tech)) return false;
  player.aura -= TECH_COST;
  player.totalAuraSpentOnTech += TECH_COST;
  player.researched.add(tech);
  return true;
}

function applyTechBonus(def: UnitDefSim, researched: Set<string>): { hp: number; speed: number; splash: number; splashFactor: number } {
  let hp = def.hp;
  let speed = def.speed;
  let splash = def.splash;
  let splashFactor = def.splashFactor;

  if (researched.has('longrange_hp') && (def.type === 'archer' || def.type === 'catapult')) {
    hp += 5;
  }
  if (researched.has('infantry_move') && (def.type === 'warrior' || def.type === 'spearsman')) {
    speed += 1;
  }
  if (researched.has('catapult_splash') && def.type === 'catapult') {
    splash = 1;
    splashFactor = 0.5;
  }
  return { hp, speed, splash, splashFactor };
}

function spawnUnit(state: SimState, playerId: 0 | 1, type: string): boolean {
  const player = state.players[playerId];
  const def = UNIT_DEFS[type];
  if (!def) return false;
  if (def.requiresResearch && !player.researched.has(def.requiresResearch)) return false;
  if (player.aura < def.cost) return false;
  if (playerUnitCount(state, playerId) >= totalPopCap(state, playerId)) return false;

  player.aura -= def.cost;
  player.unitTypeCounts[type] = (player.unitTypeCounts[type] ?? 0) + 1;

  const bonuses = applyTechBonus(def, player.researched);
  const homeTemple = state.temples.find(t => t.ownerId === playerId) ?? state.temples[playerId === 0 ? 0 : 2];
  const spawnPos = homeTemple.pos;

  const unit: SimUnit = {
    id: state.unitIdCounter++,
    playerId,
    type,
    hp: bonuses.hp,
    maxHp: bonuses.hp,
    pos: spawnPos,
    attack: def.attack,
    defense: def.defense,
    speed: bonuses.speed,
    range: def.range,
    splash: bonuses.splash,
    splashFactor: bonuses.splashFactor,
    triggersRetaliation: def.triggersRetaliation,
    isSupport: def.isSupport,
    bonusAgainst: def.bonusAgainst,
  };

  state.units.push(unit);
  return true;
}

// ─── Combat Engine ────────────────────────────────────────────────────────────
function combatTick(state: SimState): void {
  const aliveUnits = state.units.filter(alive);
  if (aliveUnits.length === 0) return;

  // Support: compute passive boosts for each unit
  function getDmgBoost(unit: SimUnit): number {
    return aliveUnits
      .filter(u => u.playerId === unit.playerId && u.type === 'damageBooster' && alive(u) && dist(u, unit) <= SUPPORT_RANGE)
      .length * DAMAGE_BOOST_AMOUNT;
  }

  function getRangeBoost(unit: SimUnit): number {
    return aliveUnits
      .filter(u => u.playerId === unit.playerId && u.type === 'rangeBooster' && alive(u) && dist(u, unit) <= SUPPORT_RANGE)
      .length * RANGE_BOOST_AMOUNT;
  }

  // Act in speed-descending order; ties: player 0 first
  const turnOrder = [...aliveUnits].sort((a, b) => b.speed - a.speed || a.playerId - b.playerId);

  for (const unit of turnOrder) {
    if (!alive(unit)) continue;

    const enemies = aliveUnits.filter(u => u.playerId !== unit.playerId && alive(u));
    const allies = aliveUnits.filter(u => u.playerId === unit.playerId && alive(u) && u.id !== unit.id);

    // ── Healer behavior ──
    if (unit.type === 'healer') {
      const injuredAllies = allies.filter(a => a.hp < a.maxHp && dist(unit, a) <= SUPPORT_RANGE);
      if (injuredAllies.length > 0) {
        // Heal most injured in range
        const target = injuredAllies.reduce((best, a) => a.hp < best.hp ? a : best);
        target.hp = Math.min(target.maxHp, target.hp + HEALER_HEAL_AMOUNT);
      } else {
        // Move toward most injured ally
        const injuredAll = allies.filter(a => a.hp < a.maxHp);
        if (injuredAll.length > 0) {
          const target = injuredAll.reduce((best, a) => a.hp < best.hp ? a : best);
          const d = target.pos > unit.pos ? 1 : -1;
          unit.pos += d * Math.min(unit.speed, Math.abs(target.pos - unit.pos));
        }
        // else stay put
      }
      continue;
    }

    // ── DamageBooster / RangeBooster behavior ──
    if (unit.type === 'damageBooster' || unit.type === 'rangeBooster') {
      // Follow the frontline: move toward own melee units
      const meleeAllies = allies.filter(a => a.range === 1);
      if (meleeAllies.length > 0) {
        const frontline = unit.playerId === 0
          ? Math.max(...meleeAllies.map(a => a.pos))
          : Math.min(...meleeAllies.map(a => a.pos));
        const targetPos = unit.playerId === 0 ? frontline - 1 : frontline + 1;
        if (unit.pos !== targetPos) {
          const d = targetPos > unit.pos ? 1 : -1;
          unit.pos += d * Math.min(unit.speed, Math.abs(targetPos - unit.pos));
        }
      }
      continue;
    }

    if (enemies.length === 0) continue;

    // ── Normal combat unit ──
    const effectiveRange = unit.range + getRangeBoost(unit);
    const distFn = (e: SimUnit) => Math.abs(e.pos - unit.pos);
    const closest = enemies.reduce((best, e) => distFn(e) < distFn(best) ? e : best);
    const closestDist = distFn(closest);

    if (closestDist <= effectiveRange) {
      // Attack: target lowest HP in range
      const inRange = enemies.filter(e => distFn(e) <= effectiveRange);
      const target = inRange.reduce((best, e) => e.hp < best.hp ? e : best);

      const dmgBoost = getDmgBoost(unit);
      const typeBonus = unit.bonusAgainst?.includes(target.type) ? 3 : 1;
      const dmg = calcDamage(unit.attack + dmgBoost, target.defense, typeBonus);
      target.hp -= dmg;

      // Splash
      if (unit.splash > 0) {
        for (const st of enemies.filter(e => e.id !== target.id && Math.abs(e.pos - target.pos) <= unit.splash)) {
          const splashDmg = Math.max(0, Math.round(
            randomMultiplier() * (unit.attack + dmgBoost - st.defense) * unit.splashFactor
          ));
          st.hp -= splashDmg;
        }
      }

      // Retaliation
      if (unit.triggersRetaliation && alive(target) && closestDist <= 1) {
        const retDmg = calcDamage(target.attack, unit.defense);
        unit.hp -= retDmg;
      }
    } else {
      // Move toward closest enemy
      const d = unit.playerId === 0 ? 1 : -1;
      const stepsNeeded = closestDist - effectiveRange;
      let move = Math.min(unit.speed, Math.max(0, stepsNeeded));

      // Ranged: don't advance past own front melee line
      if (unit.range >= 2) {
        const ownMelee = allies.filter(f => f.range === 1);
        if (ownMelee.length > 0) {
          const frontline = unit.playerId === 0
            ? Math.max(...ownMelee.map(f => f.pos))
            : Math.min(...ownMelee.map(f => f.pos));
          const targetPos = unit.playerId === 0
            ? Math.min(unit.pos + move, frontline - 1)
            : Math.max(unit.pos - move, frontline + 1);
          move = Math.abs(targetPos - unit.pos);
        }
      }

      unit.pos = Math.max(0, Math.min(FIELD_SIZE, unit.pos + d * move));
    }
  }

  // Remove dead units
  state.units = state.units.filter(alive);
}

// ─── Temple capture ───────────────────────────────────────────────────────────
function captureTemples(state: SimState): void {
  for (const temple of state.temples) {
    const unitsAt = state.units.filter(u => alive(u) && u.pos === temple.pos);
    const p0 = unitsAt.filter(u => u.playerId === 0);
    const p1 = unitsAt.filter(u => u.playerId === 1);

    if (p0.length > 0 && p1.length === 0 && temple.ownerId !== 0) {
      temple.ownerId = 0;
      if (temple.level === 0) temple.level = 1;
    } else if (p1.length > 0 && p0.length === 0 && temple.ownerId !== 1) {
      temple.ownerId = 1;
      if (temple.level === 0) temple.level = 1;
    }
  }
}

// ─── Win check ────────────────────────────────────────────────────────────────
function checkWin(state: SimState): { winner: 0 | 1 | null; reason: string } | null {
  const p0temples = state.temples.filter(t => t.ownerId === 0).length;
  const p1temples = state.temples.filter(t => t.ownerId === 1).length;

  if (p0temples === state.temples.length) return { winner: 0, reason: 'all temples' };
  if (p1temples === state.temples.length) return { winner: 1, reason: 'all temples' };

  const p0units = state.units.filter(u => u.playerId === 0 && alive(u)).length;
  const p1units = state.units.filter(u => u.playerId === 1 && alive(u)).length;

  if (p0units === 0 && p0temples === 0) return { winner: 1, reason: 'eliminated' };
  if (p1units === 0 && p1temples === 0) return { winner: 0, reason: 'eliminated' };

  return null;
}

// ─── AI Strategies ────────────────────────────────────────────────────────────
interface Strategy {
  name: string;
  decide(state: SimState, playerId: 0 | 1): void;
}

function getEnemyUnits(state: SimState, playerId: number) {
  return state.units.filter(u => u.playerId !== playerId && alive(u));
}

const Rusher: Strategy = {
  name: 'Rusher',
  decide(state, playerId) {
    const player = state.players[playerId];
    // Never researches, never upgrades, spam horserider > warrior
    let spawned = true;
    while (spawned) {
      spawned = false;
      if (player.aura >= 3) {
        if (spawnUnit(state, playerId, 'horserider')) { spawned = true; continue; }
      }
      if (player.aura >= 1) {
        if (spawnUnit(state, playerId, 'warrior')) { spawned = true; continue; }
      }
    }
  },
};

const TechHeavy: Strategy = {
  name: 'TechHeavy',
  decide(state, playerId) {
    const player = state.players[playerId];
    const researchDone = player.researched.has('unlock_heavyknight') && player.researched.has('unlock_catapult');

    if (!researchDone) {
      // Save up; spawn warrior only if very flush
      if (canResearch(player, 'unlock_heavyknight')) {
        doResearch(state, playerId, 'unlock_heavyknight');
      }
      if (canResearch(player, 'unlock_catapult')) {
        doResearch(state, playerId, 'unlock_catapult');
      }
      if (player.aura >= 12) {
        spawnUnit(state, playerId, 'warrior');
      }
      return;
    }

    // Upgrade home temple to level 2
    const homeTemple = state.temples.find(t => t.ownerId === playerId && t.pos === (playerId === 0 ? 2 : 28));
    if (homeTemple && homeTemple.level < 2 && player.aura >= 2) {
      upgradeTemple(state, homeTemple);
    }

    // Spam heavyknight + 1 catapult per 3 knights
    let spawned = true;
    while (spawned) {
      spawned = false;
      const knights = state.units.filter(u => u.playerId === playerId && u.type === 'heavyknight' && alive(u)).length;
      const cats = state.units.filter(u => u.playerId === playerId && u.type === 'catapult' && alive(u)).length;
      if (cats * 3 < knights && player.aura >= 4) {
        if (spawnUnit(state, playerId, 'catapult')) { spawned = true; continue; }
      }
      if (spawnUnit(state, playerId, 'heavyknight')) { spawned = true; continue; }
    }
  },
};

const Economic: Strategy = {
  name: 'Economic',
  decide(state, playerId) {
    const player = state.players[playerId];
    const homeTemple = state.temples.find(t => t.ownerId === playerId && t.pos === (playerId === 0 ? 2 : 28));
    const phase2 = homeTemple && homeTemple.level >= 3;

    if (!phase2) {
      // Upgrade home temple toward level 3
      if (homeTemple) {
        const upgradeCost = Math.pow(2, homeTemple.level);
        if (player.aura >= upgradeCost && homeTemple.level < 3) {
          upgradeTemple(state, homeTemple);
        }
      }
      // Spawn 1 warrior as defender if we have none
      const defenders = state.units.filter(u => u.playerId === playerId && alive(u)).length;
      if (defenders === 0 && player.aura >= 1) {
        spawnUnit(state, playerId, 'warrior');
      }
      return;
    }

    // Phase 2: research spearman, spawn spearsmen + archers 2:1
    if (canResearch(player, 'unlock_spearman')) {
      doResearch(state, playerId, 'unlock_spearman');
    }

    // Upgrade neutral temple if owned
    const neutral = state.temples.find(t => t.pos === 15 && t.ownerId === playerId);
    if (neutral && neutral.level < 2 && player.aura >= Math.pow(2, neutral.level)) {
      upgradeTemple(state, neutral);
    }

    let spawned = true;
    while (spawned) {
      spawned = false;
      const spears = state.units.filter(u => u.playerId === playerId && u.type === 'spearsman' && alive(u)).length;
      const archers = state.units.filter(u => u.playerId === playerId && u.type === 'archer' && alive(u)).length;
      // 2:1 spears:archers
      if (spears < archers * 2 || archers === 0) {
        if (player.researched.has('unlock_spearman') && spawnUnit(state, playerId, 'spearsman')) { spawned = true; continue; }
        if (spawnUnit(state, playerId, 'warrior')) { spawned = true; continue; }
      }
      if (spawnUnit(state, playerId, 'archer')) { spawned = true; continue; }
    }
  },
};

const Counter: Strategy = {
  name: 'Counter',
  decide(state, playerId) {
    const player = state.players[playerId];

    // Research spearman first
    if (canResearch(player, 'unlock_spearman')) {
      doResearch(state, playerId, 'unlock_spearman');
    }

    // Upgrade home temple to level 2
    const homeTemple = state.temples.find(t => t.ownerId === playerId && t.pos === (playerId === 0 ? 2 : 28));
    if (homeTemple && homeTemple.level < 2 && player.aura >= 6) {
      upgradeTemple(state, homeTemple);
    }

    const enemyCavalry = getEnemyUnits(state, playerId).filter(u => u.type === 'horserider' || u.type === 'heavyknight');
    const useSpearmsman = player.researched.has('unlock_spearman') && enemyCavalry.length > 0;

    let spawned = true;
    while (spawned) {
      spawned = false;
      if (useSpearmsman) {
        if (spawnUnit(state, playerId, 'spearsman')) { spawned = true; continue; }
      }
      if (spawnUnit(state, playerId, 'archer')) { spawned = true; continue; }
    }
  },
};

const SupportArmy: Strategy = {
  name: 'SupportArmy',
  decide(state, playerId) {
    const player = state.players[playerId];

    // Research healer then damageBooster
    if (canResearch(player, 'unlock_healer')) {
      doResearch(state, playerId, 'unlock_healer');
    }
    if (canResearch(player, 'unlock_damagebooster')) {
      doResearch(state, playerId, 'unlock_damagebooster');
    }
    if (canResearch(player, 'unlock_spearman')) {
      doResearch(state, playerId, 'unlock_spearman');
    }

    // Upgrade home temple to level 2
    const homeTemple = state.temples.find(t => t.ownerId === playerId && t.pos === (playerId === 0 ? 2 : 28));
    if (homeTemple && homeTemple.level < 2 && player.aura >= 2) {
      upgradeTemple(state, homeTemple);
    }

    let spawned = true;
    while (spawned) {
      spawned = false;
      const myUnits = state.units.filter(u => u.playerId === playerId && alive(u));
      const combatUnits = myUnits.filter(u => !u.isSupport);
      const healers = myUnits.filter(u => u.type === 'healer');
      const boosters = myUnits.filter(u => u.type === 'damageBooster');
      const supporters = healers.length + boosters.length;

      // For every 3 combat units: want 1 healer + 1 damageBooster
      const desiredSupporters = Math.floor(combatUnits.length / 3) * 2;

      if (supporters < desiredSupporters) {
        if (healers.length <= boosters.length && player.researched.has('unlock_healer')) {
          if (spawnUnit(state, playerId, 'healer')) { spawned = true; continue; }
        }
        if (player.researched.has('unlock_damagebooster')) {
          if (spawnUnit(state, playerId, 'damageBooster')) { spawned = true; continue; }
        }
      }

      // Combat units: spearman if researched, else warrior
      if (player.researched.has('unlock_spearman')) {
        if (spawnUnit(state, playerId, 'spearsman')) { spawned = true; continue; }
      } else {
        if (spawnUnit(state, playerId, 'warrior')) { spawned = true; continue; }
      }
    }
  },
};

const STRATEGIES: Strategy[] = [Rusher, TechHeavy, Economic, Counter, SupportArmy];

// ─── Game initialization ──────────────────────────────────────────────────────
function initState(): SimState {
  return {
    players: [
      { id: 0, aura: 3, researched: new Set(), totalAuraSpentOnTech: 0, unitTypeCounts: {} },
      { id: 1, aura: 3, researched: new Set(), totalAuraSpentOnTech: 0, unitTypeCounts: {} },
    ],
    units: [],
    temples: [
      { pos: 2, ownerId: 0, level: 1 },
      { pos: 15, ownerId: null, level: 0 },
      { pos: 28, ownerId: 1, level: 1 },
    ],
    turn: 0,
    unitIdCounter: 0,
  };
}

// ─── Game loop ────────────────────────────────────────────────────────────────
interface GameResult {
  winner: 0 | 1 | null;
  turns: number;
  reason: string;
  playerStats: Array<{
    auraSpentOnTech: number;
    unitTypeCounts: Record<string, number>;
    templesOwned: number;
    avgTempleLevel: number;
  }>;
}

function runGame(strategy0: Strategy, strategy1: Strategy): GameResult {
  const state = initState();
  const strategies = [strategy0, strategy1];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    state.turn = turn;

    // Each player: collect aura + AI decision
    for (let pid = 0 as 0 | 1; pid <= 1; pid = (pid + 1) as 0 | 1) {
      const player = state.players[pid];
      // Collect aura
      for (const temple of state.temples) {
        if (temple.ownerId === pid) {
          player.aura += temple.level * TEMPLE_INCOME_PER_LEVEL;
        }
      }
      // AI decision
      strategies[pid].decide(state, pid);
    }

    // Combat
    combatTick(state);

    // Temple capture
    captureTemples(state);

    // Win check
    const win = checkWin(state);
    if (win) {
      return makeResult(state, win.winner, turn + 1, win.reason);
    }
  }

  // Turn limit: winner by total HP
  const hp0 = state.units.filter(u => u.playerId === 0).reduce((s, u) => s + Math.max(0, u.hp), 0);
  const hp1 = state.units.filter(u => u.playerId === 1).reduce((s, u) => s + Math.max(0, u.hp), 0);
  const winner: 0 | 1 | null = hp0 > hp1 ? 0 : hp1 > hp0 ? 1 : null;
  return makeResult(state, winner, MAX_TURNS, 'turn limit');
}

function makeResult(state: SimState, winner: 0 | 1 | null, turns: number, reason: string): GameResult {
  return {
    winner,
    turns,
    reason,
    playerStats: [0, 1].map(pid => {
      const ownedTemples = state.temples.filter(t => t.ownerId === pid);
      return {
        auraSpentOnTech: state.players[pid].totalAuraSpentOnTech,
        unitTypeCounts: { ...state.players[pid].unitTypeCounts },
        templesOwned: ownedTemples.length,
        avgTempleLevel: ownedTemples.length > 0
          ? ownedTemples.reduce((s, t) => s + t.level, 0) / ownedTemples.length
          : 0,
      };
    }),
  };
}

// ─── Tournament ───────────────────────────────────────────────────────────────
function runTournament(gamesPerMatchup: number): void {
  const N = STRATEGIES.length;

  interface StrategyRecord {
    wins: number;
    losses: number;
    draws: number;
    totalTurns: number;
    totalAuraOnTech: number;
    unitTypeTotals: Record<string, number>;
    totalTemplesOwned: number;
    totalTempleLevel: number;
    vsWins: number[];  // wins against each strategy index
    vsGames: number[]; // games against each strategy index
  }

  const records: StrategyRecord[] = STRATEGIES.map(() => ({
    wins: 0, losses: 0, draws: 0, totalTurns: 0,
    totalAuraOnTech: 0, unitTypeTotals: {},
    totalTemplesOwned: 0, totalTempleLevel: 0,
    vsWins: new Array(N).fill(0),
    vsGames: new Array(N).fill(0),
  }));

  console.log(`Running tournament: ${N} strategies, ${gamesPerMatchup} games/matchup, ${N * (N - 1) / 2} matchups`);
  console.log(`Total games: ${N * (N - 1) / 2 * gamesPerMatchup}\n`);

  let matchupNum = 0;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      matchupNum++;
      process.stdout.write(`  [${matchupNum}/${N * (N - 1) / 2}] ${STRATEGIES[i].name} vs ${STRATEGIES[j].name}... `);

      let wins = [0, 0, 0]; // [i wins, j wins, draws]

      for (let g = 0; g < gamesPerMatchup; g++) {
        // Alternate who goes first
        let result: GameResult;
        if (g % 2 === 0) {
          result = runGame(STRATEGIES[i], STRATEGIES[j]);
        } else {
          result = runGame(STRATEGIES[j], STRATEGIES[i]);
          // flip winner
          if (result.winner === 0) result = { ...result, winner: 1 };
          else if (result.winner === 1) result = { ...result, winner: 0 };
          // flip stats
          result = {
            ...result,
            playerStats: [result.playerStats[1], result.playerStats[0]],
          };
        }

        const iWon = result.winner === 0;
        const jWon = result.winner === 1;

        if (iWon) { wins[0]++; records[i].wins++; records[j].losses++; }
        else if (jWon) { wins[1]++; records[j].wins++; records[i].losses++; }
        else { wins[2]++; records[i].draws++; records[j].draws++; }

        records[i].vsWins[j] += iWon ? 1 : 0;
        records[j].vsWins[i] += jWon ? 1 : 0;
        records[i].vsGames[j]++;
        records[j].vsGames[i]++;

        records[i].totalTurns += result.turns;
        records[j].totalTurns += result.turns;

        // Accumulate stats (i = playerStats[0], j = playerStats[1])
        records[i].totalAuraOnTech += result.playerStats[0].auraSpentOnTech;
        records[j].totalAuraOnTech += result.playerStats[1].auraSpentOnTech;
        records[i].totalTemplesOwned += result.playerStats[0].templesOwned;
        records[j].totalTemplesOwned += result.playerStats[1].templesOwned;
        records[i].totalTempleLevel += result.playerStats[0].avgTempleLevel;
        records[j].totalTempleLevel += result.playerStats[1].avgTempleLevel;

        for (const [k, v] of Object.entries(result.playerStats[0].unitTypeCounts)) {
          records[i].unitTypeTotals[k] = (records[i].unitTypeTotals[k] ?? 0) + v;
        }
        for (const [k, v] of Object.entries(result.playerStats[1].unitTypeCounts)) {
          records[j].unitTypeTotals[k] = (records[j].unitTypeTotals[k] ?? 0) + v;
        }
      }

      const pct = (wins[0] / gamesPerMatchup * 100).toFixed(1);
      console.log(`${STRATEGIES[i].name} wins ${pct}% (${wins[0]}-${wins[1]}-${wins[2]})`);
    }
  }

  // ─── Output ───────────────────────────────────────────────────────────────
  const totalGamesPerStrategy = (N - 1) * gamesPerMatchup;
  const lines: string[] = [];

  const line = (s: string = '') => { lines.push(s); console.log(s); };

  line('\n════════════════════════════════════════════════════════════');
  line('                 STRATEGY TOURNAMENT RESULTS');
  line(`           ${gamesPerMatchup} games/matchup · ${N * (N - 1) / 2} matchups`);
  line('════════════════════════════════════════════════════════════');

  // Rankings
  const ranked = STRATEGIES.map((s, i) => ({ s, i, r: records[i] }))
    .sort((a, b) => {
      const aWinPct = a.r.wins / totalGamesPerStrategy;
      const bWinPct = b.r.wins / totalGamesPerStrategy;
      return bWinPct - aWinPct;
    });

  line('\n── Strategy Rankings ──────────────────────────────────────');
  line(`${'#'.padEnd(3)} ${'Strategy'.padEnd(15)} ${'Win%'.padStart(6)} ${'W'.padStart(6)} ${'L'.padStart(6)} ${'D'.padStart(6)} ${'AvgTurns'.padStart(9)}`);
  line('─'.repeat(55));

  for (let rank = 0; rank < ranked.length; rank++) {
    const { s, i, r } = ranked[rank];
    const games = r.wins + r.losses + r.draws;
    const winPct = games > 0 ? (r.wins / games * 100).toFixed(1) : '0.0';
    const avgTurns = (r.totalTurns / games).toFixed(1);
    line(`${(rank + 1).toString().padEnd(3)} ${s.name.padEnd(15)} ${winPct.padStart(6)}% ${r.wins.toString().padStart(6)} ${r.losses.toString().padStart(6)} ${r.draws.toString().padStart(6)} ${avgTurns.padStart(9)}`);
  }

  // Head-to-head matrix
  line('\n── Head-to-Head Win Rate Matrix (row beats column) ────────');
  const COL_W = 12;
  const header = ''.padEnd(15) + STRATEGIES.map(s => s.name.padStart(COL_W)).join('');
  line(header);
  line('─'.repeat(15 + COL_W * N));

  for (let i = 0; i < N; i++) {
    let row = STRATEGIES[i].name.padEnd(15);
    for (let j = 0; j < N; j++) {
      if (i === j) {
        row += '----'.padStart(COL_W);
      } else {
        const g = records[i].vsGames[j];
        const w = records[i].vsWins[j];
        const pct = g > 0 ? (w / g * 100).toFixed(1) + '%' : 'N/A';
        row += pct.padStart(COL_W);
      }
    }
    line(row);
  }

  // Strategy profiles
  line('\n── Strategy Profiles ──────────────────────────────────────');
  for (let i = 0; i < N; i++) {
    const r = records[i];
    const games = r.wins + r.losses + r.draws;
    const avgTech = (r.totalAuraOnTech / games).toFixed(1);
    const avgTemples = (r.totalTemplesOwned / games).toFixed(2);
    const avgLevel = (r.totalTempleLevel / games).toFixed(2);
    const topUnit = Object.entries(r.unitTypeTotals)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';

    line(`\n${STRATEGIES[i].name}:`);
    line(`  Avg aura on tech: ${avgTech}`);
    line(`  Avg temples owned at end: ${avgTemples}`);
    line(`  Avg temple level at end: ${avgLevel}`);
    line(`  Most spawned unit: ${topUnit}`);
    const unitBreakdown = Object.entries(r.unitTypeTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${t}:${c}`)
      .join(', ');
    line(`  Unit totals: ${unitBreakdown}`);
  }

  // Key insights
  line('\n── Key Insights ────────────────────────────────────────────');
  const insights: string[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      const g = records[i].vsGames[j];
      if (g === 0) continue;
      const pct = records[i].vsWins[j] / g;
      if (pct >= 0.70) {
        insights.push(`  ${STRATEGIES[i].name} dominates ${STRATEGIES[j].name} (${(pct * 100).toFixed(1)}% win rate)`);
      }
    }
  }
  if (insights.length === 0) {
    line('  No strategy dominates another by ≥70%. Balanced field.');
  } else {
    insights.forEach(s => line(s));
  }

  line('\n════════════════════════════════════════════════════════════\n');

  // Write to file
  const outPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'strategy_results.txt');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`Results written to: ${outPath}`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const gamesArg = args.find(a => a.startsWith('--games='));
const gamesPerMatchup = gamesArg ? parseInt(gamesArg.split('=')[1], 10) : 500;

runTournament(gamesPerMatchup);
