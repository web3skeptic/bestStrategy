// ── AI 2.0 — rich whole-state evaluator ─────────────────────────────────────
//
// Deliberately dependency-light (game.ts/types.ts/factions.ts/combat.ts
// only, never ai.ts) so it can be shared by both the existing heuristic AI
// (ai.ts) and the new search layer (aiSearch.ts) without a circular import.
//
// evaluateState(state, perspectivePlayerId) always returns a single number:
// positive = better for perspectivePlayerId, negative = better for the
// opponent(s), computed as sum-over-players(sign * playerScore(player))
// where sign = +1 for the perspective player and −1 for everyone else — a
// symmetric, zero-sum-style shape (negating perspective negates the score).
//
// evaluateStateDetailed exposes the same computation as a named breakdown,
// purely for development/tuning — see AI_EVAL_WEIGHTS below for every
// tunable knob in one place instead of scattered magic numbers.
import type {
  GameState, Unit, Player, Farm, StrategicSite, FertileSite, Capital, FactionId, UnitType,
} from './types';
import { TECH_NODES } from './types';
import { hexDistance } from './hex';
import { calculateDamage, getTypeMultiplier } from './combat';
import {
  getPlayerCapital, getEffectiveAttack, getEffectiveDefense, getEffectiveRange, getEffectiveSpeed,
  getPlayerIncome, getPopulationCap, getPopulationCount, getProductionSlots, getUnitCost,
  getAgrarTerritory, calculateEncirclement, isForestUnitRevealed, getUnitClass,
} from './game';
import {
  AGRAR_FARM_COST, TEMPLE_UPGRADE_COST, SITE_ESTABLISH_COST, ROAD_MOVEMENT_BONUS,
} from './factions';

// A win/loss is worth far more than any accumulation of material — nothing
// else on the board should ever be able to outweigh it. Ply-adjusted so a
// faster forced win scores higher than a slower one, and a slower loss
// scores higher (less bad) than a faster one (§6 of the AI 2.0 brief).
export const MATE_SCORE = 100000;

// Every tunable weight in one place (§28) — nothing else in this file
// should have a bare numeric literal driving a strategic judgement; if you
// find one, it belongs here.
export const AI_EVAL_WEIGHTS = {
  material: 1,
  threatenedMaterialFraction: 0.7,  // fraction of a hanging unit's value already "lost"
  guaranteedKillFraction: 0.6,      // fraction of a killable enemy's value already "won"
  capitalPenalty: [0, 15, 45, 110, 220] as const, // by HP-fraction bracket, see capitalSafety()
  capitalCredibleLethalPenalty: 150,
  income: 6,
  energyLinear: 0.4,
  energySoftCap: 12,          // beyond this, energy value diminishes
  energyNearThreshold: 4,     // bonus for being within one round's income of a real threshold
  production: 3,
  productionUnusableFactor: 0.35, // multiplier when there's no Energy/Command room to use a slot
  commandHeadroom: 0.6,
  tech: 1,                    // multiplies each tech's own rough value below
  farmStructure: 1.5,
  farmProductionThreshold: 5,
  farmRoadAnchor: 1,
  templeBase: 4,
  templeIIBonus: 6,
  fertileSite: 3,
  roadConnectivity: 0.6,
  mobility: 0.8,
  boardControl: 0.5,
  formation: 1,
  supportCoverage: 1,
  encirclement: 4,
  tempo: 0.8,
};

// ── Small, self-contained helpers (deliberately NOT imported from ai.ts —
// this module must stay independent of it) ──────────────────────────────

function estimateDamageQuick(state: GameState, attacker: Unit, target: Unit): number {
  const enc = calculateEncirclement(state, target);
  const attackerFaction = state.players.find(p => p.id === attacker.playerId)?.faction;
  const targetFaction = state.players.find(p => p.id === target.playerId)?.faction;
  const typeBonus = getTypeMultiplier(getUnitClass(attacker.type, attackerFaction), getUnitClass(target.type, targetFaction));
  const atk = getEffectiveAttack(state, attacker);
  const def = getEffectiveDefense(state, target);
  const hpFraction = attacker.hp / attacker.stats.maxHp;
  return Math.max(1, calculateDamage(atk, def, enc.attackMultiplier, typeBonus, hpFraction));
}

// Fog-respecting the same way every other AI query in this codebase is —
// only ever looks at units not hidden in an unrevealed forest (§84, no
// cheating: the evaluator must never see something the acting player couldn't).
function revealedEnemiesOf(state: GameState, playerId: number): Unit[] {
  return state.units.filter(u => u.hp > 0 && u.playerId !== playerId && isForestUnitRevealed(state, u.pos, playerId));
}

function isSupport(t: UnitType): boolean {
  return t === 'healer' || t === 'damageBooster' || t === 'rangeBooster';
}

const FRONTLINE: ReadonlySet<UnitType> = new Set(['warrior', 'spearsman', 'horserider', 'heavyknight']);
const BACKLINE: ReadonlySet<UnitType> = new Set(['archer', 'catapult']);

export interface EvalBreakdown {
  terminal: number;
  material: number;
  threatenedMaterial: number;
  capitalSafety: number;
  income: number;
  energy: number;
  production: number;
  command: number;
  tech: number;
  farms: number;
  temples: number;
  fertileSites: number;
  roads: number;
  mobility: number;
  boardControl: number;
  formation: number;
  support: number;
  encirclement: number;
  tempo: number;
  total: number;
}

function emptyBreakdown(): EvalBreakdown {
  return {
    terminal: 0, material: 0, threatenedMaterial: 0, capitalSafety: 0, income: 0, energy: 0,
    production: 0, command: 0, tech: 0, farms: 0, temples: 0, fertileSites: 0, roads: 0,
    mobility: 0, boardControl: 0, formation: 0, support: 0, encirclement: 0, tempo: 0, total: 0,
  };
}

// ── Per-player component scores (each returns a value from THAT player's
// own perspective — evaluateStateDetailed combines them with the +/- sign
// for perspective vs everyone else) ─────────────────────────────────────

function materialScore(state: GameState, player: Player): { material: number; threatened: number } {
  const w = AI_EVAL_WEIGHTS;
  let material = 0;
  let threatened = 0;
  const myUnits = state.units.filter(u => u.hp > 0 && u.playerId === player.id);
  for (const u of myUnits) {
    const hpFraction = u.hp / u.stats.maxHp;
    const cost = getUnitCost(u.type, player.faction);
    const commandFactor = 1 + (u.stats.range > 2 || u.type === 'heavyknight' || u.type === 'horserider' ? 0.1 : 0);
    const classWeight = u.type === 'catapult' || u.type === 'heavyknight' ? 1.1 : 1;
    material += cost * hpFraction * commandFactor * classWeight * w.material;
  }
  // Threatened material: any of my units a currently-revealed enemy could
  // one-shot right now already counts as partially lost — and any enemy
  // unit I could one-shot right now already counts as partially won. Both
  // read only revealedEnemiesOf (fog-respecting).
  // Both credits are scaled by the AT-RISK unit's OWN hp fraction — the
  // same weighting `material` itself uses — so a threat's pre-charged
  // value can never exceed what actually changes in `material` once it's
  // resolved. Without this a nearly-dead enemy (hpFraction ~ 0, almost
  // nothing left to lose) still handed out a full flat guaranteedKill
  // bonus for merely being "killable", which made ACTUALLY taking a free
  // kill look worse than leaving the corpse-to-be standing forever (the
  // bonus disappears the instant the target is actually dead, while the
  // real material gained from finishing off a 1-hp unit is nearly zero) —
  // a real evaluation-symmetry bug, not a search bug: search correctly
  // preferred whatever the evaluator actually scored higher.
  for (const u of myUnits) {
    const enemies = revealedEnemiesOf(state, player.id);
    const lethal = enemies.some(e => {
      const rng = getEffectiveRange(state, e);
      return hexDistance(e.pos, u.pos) <= rng && estimateDamageQuick(state, e, u) >= u.hp;
    });
    if (lethal) threatened -= getUnitCost(u.type, player.faction) * (u.hp / u.stats.maxHp) * w.threatenedMaterialFraction;
  }
  const visibleEnemies = revealedEnemiesOf(state, player.id);
  for (const e of visibleEnemies) {
    const canKill = myUnits.some(u => {
      const rng = getEffectiveRange(state, u);
      return hexDistance(u.pos, e.pos) <= rng && estimateDamageQuick(state, u, e) >= e.hp;
    });
    if (canKill) {
      const enemyPlayer = state.players.find(p => p.id === e.playerId);
      threatened += getUnitCost(e.type, enemyPlayer?.faction) * (e.hp / e.stats.maxHp) * w.guaranteedKillFraction;
    }
  }
  return { material, threatened };
}

// Nonlinear — see the brief's own worked example: 40->39 is not the same as
// 4->3. Bracketed by HP fraction, plus a large extra penalty for a
// currently-credible lethal hit on the Capital itself (estimated total
// damage from every revealed enemy in range >= remaining HP).
function capitalSafetyScore(state: GameState, player: Player): number {
  const w = AI_EVAL_WEIGHTS;
  const capital = getPlayerCapital(state, player.id);
  if (!capital) return 0;
  const frac = capital.hp / capital.maxHp;
  let penalty: number;
  if (frac > 0.75) penalty = w.capitalPenalty[0];
  else if (frac > 0.5) penalty = w.capitalPenalty[1];
  else if (frac > 0.25) penalty = w.capitalPenalty[2];
  else if (frac > 0) penalty = w.capitalPenalty[3];
  else penalty = w.capitalPenalty[4];

  const enemies = revealedEnemiesOf(state, player.id);
  let potentialDamage = 0;
  for (const e of enemies) {
    const rng = getEffectiveRange(state, e);
    if (hexDistance(e.pos, capital.pos) <= rng + 1) { // +1: could still move adjacent/into range this activation
      const atk = getEffectiveAttack(state, e);
      potentialDamage += Math.max(1, atk - capital.defense);
    }
  }
  const credibleLethal = potentialDamage >= capital.hp;
  return -(penalty + (credibleLethal ? w.capitalCredibleLethalPenalty : 0));
}

function incomeScore(state: GameState, player: Player): number {
  return getPlayerIncome(state, player.id) * AI_EVAL_WEIGHTS.income;
}

// Diminishing beyond a soft cap (a stockpile stops being "more options" and
// starts being "aura doing nothing"), plus a bonus for sitting just short of
// a real, concrete threshold (the cheapest currently-unlocked recruit, a
// Farm, a Temple upgrade/founding) — §11's own example: 11 Energy with
// Command I at 12 is worth more than the raw number suggests.
function energyScore(state: GameState, player: Player): number {
  const w = AI_EVAL_WEIGHTS;
  const aura = player.aura;
  const linear = Math.min(aura, w.energySoftCap) * w.energyLinear;
  const excess = Math.max(0, aura - w.energySoftCap);
  const diminished = Math.sqrt(excess) * w.energyLinear;
  const thresholds = [1, 2, 3, 4, 6, AGRAR_FARM_COST, SITE_ESTABLISH_COST, TEMPLE_UPGRADE_COST, 12, 18];
  const nearestAbove = thresholds.filter(t => t >= aura).sort((a, b) => a - b)[0];
  const nearBonus = nearestAbove !== undefined && nearestAbove - aura <= 2 ? w.energyNearThreshold : 0;
  return linear + diminished + nearBonus;
}

// Value a production slot only to the extent it's actually usable right
// now (spare Energy AND spare Command headroom) — an unusable 4th slot is
// much closer to worthless than a flat per-slot bonus would suggest.
function productionScore(state: GameState, player: Player): number {
  const w = AI_EVAL_WEIGHTS;
  const slots = getProductionSlots(state, player.id);
  const headroom = getPopulationCap(state, player.id) - getPopulationCount(state, player.id);
  const usable = player.aura >= 1 && headroom > 0;
  return slots * w.production * (usable ? 1 : w.productionUnusableFactor);
}

function commandScore(state: GameState, player: Player): number {
  const cap = getPopulationCap(state, player.id);
  const used = getPopulationCount(state, player.id);
  const headroom = Math.max(0, cap - used);
  // Headroom only matters if there's Energy to actually spend it — same
  // "is this usable" gate as production.
  const usableHeadroom = player.aura >= 1 ? headroom : headroom * 0.3;
  // Only value headroom up to what production slots can actually put to
  // work soon — extra headroom beyond that is real but not yet actionable.
  // Without this cap, a single kill that frees up 1 population slot for an
  // opponent who was already nowhere near their cap scored as if it hands
  // them a whole new recruit THIS round, which could outweigh the material
  // value of the kill itself for a cheap/near-dead unit and made the
  // evaluator prefer leaving a free kill on the table over taking it.
  const slots = Math.max(1, getProductionSlots(state, player.id));
  return Math.min(usableHeadroom, slots) * AI_EVAL_WEIGHTS.commandHeadroom;
}

// Rough per-tech value — not "count of researched techs" (§14). A tech's
// worth depends on whether its precondition for mattering is currently
// true (enemy has attackable structures, army already has enough bodies to
// benefit from a support unit, population is actually constrained, etc.).
function techNodeValue(state: GameState, player: Player): Map<string, number> {
  const myUnits = state.units.filter(u => u.hp > 0 && u.playerId === player.id);
  const combatCount = myUnits.filter(u => !isSupport(u.type) && u.type !== 'founder').length;
  const capUsed = getPopulationCount(state, player.id);
  const cap = getPopulationCap(state, player.id);
  const populationConstrained = capUsed >= cap - 2;
  const enemyStructuresExist = state.players.some(p => p.id !== player.id) &&
    (state.strategicSites.some(s => s.state === 'temple') || true); // Capitals always exist as targets
  const values = new Map<string, number>();
  values.set('agrar_siegecraft', enemyStructuresExist ? 10 : 4);
  values.set('temple_mobile_siege_tech', enemyStructuresExist ? 10 : 4);
  values.set('agrar_siegecraft_splash', enemyStructuresExist ? 6 : 2);
  values.set('temple_mobile_siege_splash', enemyStructuresExist ? 6 : 2);
  values.set('agrar_heavy_armor', 4);
  values.set('temple_warrior_rite', 4);
  values.set('agrar_heavy_knight_tech', combatCount >= 3 ? 12 : 5);
  values.set('temple_champion_rite', combatCount >= 3 ? 12 : 5);
  values.set('longrange_hp', 5);
  values.set('horse_sight', 3);
  values.set('unlock_healer', combatCount >= 2 ? 8 : 3);
  values.set('unlock_damagebooster', combatCount >= 2 ? 8 : 3);
  values.set('unlock_rangebooster', combatCount >= 2 ? 6 : 2);
  values.set('command_1', populationConstrained ? 14 : 6);
  values.set('command_2', populationConstrained ? 12 : 4);
  return values;
}

function techScore(state: GameState, player: Player): number {
  const w = AI_EVAL_WEIGHTS;
  const tech = state.playerTech[player.id];
  if (!tech) return 0;
  const values = techNodeValue(state, player);
  let score = 0;
  for (const id of tech.researched) score += (values.get(id) ?? 5) * w.tech;
  // Active research counts as partially realized (§15) — discounted by how
  // far through its research time it is, not zero until the exact tick it
  // resolves.
  if (tech.researching) {
    const node = TECH_NODES.find(n => n.id === tech.researching!.techId);
    if (node) {
      const elapsed = node.researchTime - (tech.researching.completesRound - state.turnNumber);
      const progress = Math.max(0, Math.min(1, elapsed / Math.max(1, node.researchTime)));
      score += (values.get(node.id) ?? 5) * w.tech * progress * 0.6;
    }
  }
  return score;
}

// Farm #2/#4 crossing a production-slot threshold is worth more than "just
// another +1 income" (income itself is already counted separately via
// incomeScore, so this only adds the STRUCTURAL value: HP as a real asset,
// the threshold crossing, and a small anchor bonus for sitting near the
// Agrar's own Road network).
function farmScore(state: GameState, player: Player): number {
  if (player.faction !== 'agrar') return 0;
  const w = AI_EVAL_WEIGHTS;
  const myFarms = state.farms.filter((f: Farm) => f.ownerId === player.id);
  const activeFarms = myFarms.filter(f => f.state === 'farm');
  let score = 0;
  for (const f of activeFarms) {
    score += (f.hp / f.maxHp) * w.farmStructure;
    const nearRoad = state.roads.some(r => r.ownerId === player.id && hexDistance(r.pos, f.pos) <= 1);
    if (nearRoad) score += w.farmRoadAnchor;
  }
  // Threshold: production slots WITH this farm count vs one fewer.
  const withCount = getProductionSlots(state, player.id);
  const fakeStateFarmCountMinusOne = Math.max(0, activeFarms.length - 1);
  const withoutBonus = fakeStateFarmCountMinusOne >= 2 ? 1 : 0;
  const withBonus = activeFarms.length >= 2 ? 1 : 0;
  if (withBonus > withoutBonus) score += w.farmProductionThreshold;
  const withBonus4 = activeFarms.length >= 4 ? 1 : 0;
  const withoutBonus4 = fakeStateFarmCountMinusOne >= 4 ? 1 : 0;
  if (withBonus4 > withoutBonus4) score += w.farmProductionThreshold;
  void withCount;
  // Founding farms (not yet active) still represent committed investment.
  score += myFarms.filter(f => f.state === 'foundingFarm').length * (w.farmStructure * 0.5);
  return score;
}

// Temple II must be worth substantially more than "one structure" — it's
// +2 income total (not +1 on top of I — see TEMPLE_LEVEL_INCOME, already
// captured by incomeScore) plus +1 production slot and a forward-position
// asset. This term is the STRUCTURAL value on top of that income.
function templeScore(state: GameState, player: Player): number {
  const w = AI_EVAL_WEIGHTS;
  let score = 0;
  for (const s of state.strategicSites as StrategicSite[]) {
    if (s.ownerId !== player.id) continue;
    if (s.state === 'temple' || s.state === 'upgradingTemple') {
      score += w.templeBase * (s.hp / Math.max(1, s.maxHp));
      if (s.templeLevel === 2 || s.state === 'upgradingTemple') score += w.templeIIBonus;
    }
    if (s.state === 'foundingTemple') score += w.templeBase * 0.5;
  }
  return score;
}

function fertileSiteScore(state: GameState, player: Player): number {
  const owned = (state.fertileSites as FertileSite[]).filter(f => f.ownerId === player.id).length;
  return owned * AI_EVAL_WEIGHTS.fertileSite;
}

// Cheap connectivity approximation (§21 explicitly allows this instead of a
// real pathfinding response-time calc): reward Roads that sit near the
// Capital AND near an owned Farm — i.e. actually bridging Capital<->economy
// — over an isolated segment that connects nothing of value.
function roadScore(state: GameState, player: Player): number {
  if (player.faction !== 'agrar') return 0;
  const capital = getPlayerCapital(state, player.id);
  if (!capital) return 0;
  const myRoads = state.roads.filter(r => r.ownerId === player.id);
  const myFarms = state.farms.filter((f: Farm) => f.ownerId === player.id && f.state === 'farm');
  let score = 0;
  for (const r of myRoads) {
    const nearCapital = hexDistance(r.pos, capital.pos) <= 4;
    const nearFarm = myFarms.some(f => hexDistance(f.pos, r.pos) <= 2);
    const nearFrontline = state.units.some(u => u.hp > 0 && u.playerId !== player.id && hexDistance(u.pos, r.pos) <= 3);
    let value = 0.15; // an isolated segment still has SOME value (future extension point)
    if (nearCapital) value += 0.5;
    if (nearFarm) value += 0.4;
    if (nearCapital && nearFrontline) value += 0.5; // actively useful reinforcement route right now
    score += value;
  }
  return score * AI_EVAL_WEIGHTS.roadConnectivity;
}

// Practical mobility: how much of my combat army is CURRENTLY enjoying a
// speed bonus (standing on its own Road/Farm) — Temple gets broad mobility
// for free (base speed alone), Agrar's is conditional on network reach, so
// reward Agrar specifically for units actually on it right now.
function mobilityScore(state: GameState, player: Player): number {
  const myUnits = state.units.filter(u => u.hp > 0 && u.playerId === player.id && !isSupport(u.type) && u.type !== 'founder');
  if (myUnits.length === 0) return 0;
  const avgEffectiveSpeed = myUnits.reduce((s, u) => s + getEffectiveSpeed(state, u), 0) / myUnits.length;
  const avgBaseSpeed = myUnits.reduce((s, u) => s + u.stats.speed, 0) / myUnits.length;
  return (avgEffectiveSpeed - avgBaseSpeed) * myUnits.length * AI_EVAL_WEIGHTS.mobility * (1 / ROAD_MOVEMENT_BONUS);
}

// Approximate influence: count of my combat units within reach-3 of each
// strategically relevant zone (Capital approaches, owned/contested Temples
// and Fertile Sites, owned Farms, Road junctions) minus the enemy's same,
// not a full flood-fill influence map (§23 explicitly allows this).
function boardControlScore(state: GameState, player: Player): number {
  const zones: { pos: { q: number; r: number }; weight: number }[] = [];
  const capital = getPlayerCapital(state, player.id);
  if (capital) zones.push({ pos: capital.pos, weight: 1 });
  for (const s of state.strategicSites as StrategicSite[]) zones.push({ pos: s.pos, weight: 1.5 });
  for (const f of state.fertileSites as FertileSite[]) zones.push({ pos: f.pos, weight: 1.5 });
  for (const f of (state.farms as Farm[]).filter(f => f.ownerId === player.id)) zones.push({ pos: f.pos, weight: 0.6 });
  if (zones.length === 0) return 0;
  const myUnits = state.units.filter(u => u.hp > 0 && u.playerId === player.id);
  let control = 0;
  for (const z of zones) {
    const nearMine = myUnits.filter(u => hexDistance(u.pos, z.pos) <= 3).length;
    control += Math.min(nearMine, 3) * z.weight;
  }
  return control * AI_EVAL_WEIGHTS.boardControl;
}

// Formation: reward a backline unit (archer/catapult/support) that has a
// frontline ally standing between it and the nearest revealed enemy
// (screened); penalize one with no ally within 2 hexes at all (isolated).
function formationScore(state: GameState, player: Player): number {
  const w = AI_EVAL_WEIGHTS;
  const enemies = revealedEnemiesOf(state, player.id);
  if (enemies.length === 0) return 0;
  const mine = state.units.filter(u => u.hp > 0 && u.playerId === player.id);
  let score = 0;
  for (const u of mine) {
    if (!BACKLINE.has(u.type) && !isSupport(u.type)) continue;
    const nearestEnemyDist = Math.min(...enemies.map(e => hexDistance(u.pos, e.pos)));
    const allyNearby = mine.some(a => a.id !== u.id && hexDistance(a.pos, u.pos) <= 2);
    if (!allyNearby) { score -= w.formation; continue; }
    const screened = mine.some(a =>
      a.id !== u.id && FRONTLINE.has(a.type) &&
      Math.min(...enemies.map(e => hexDistance(a.pos, e.pos))) < nearestEnemyDist);
    if (screened) score += w.formation;
    else if (nearestEnemyDist <= 2) score -= w.formation * 0.5; // exposed backline, in real danger
  }
  return score;
}

// Actual value delivered by support units right now, not just headcount —
// same "missing HP for healers, valuable-ally-count for boosters" idea the
// per-unit heuristic already uses, evaluated at the state level.
function supportScore(state: GameState, player: Player): number {
  const w = AI_EVAL_WEIGHTS;
  const supports = state.units.filter(u => u.hp > 0 && u.playerId === player.id && isSupport(u.type));
  if (supports.length === 0) return 0;
  const combat = state.units.filter(u => u.hp > 0 && u.playerId === player.id && !isSupport(u.type) && u.type !== 'founder');
  let score = 0;
  for (const s of supports) {
    const radius = s.type === 'rangeBooster' ? 1 : 2;
    for (const ally of combat) {
      const d = hexDistance(s.pos, ally.pos);
      if (d > radius) continue;
      const cost = getUnitCost(ally.type, player.faction);
      if (s.type === 'healer') score += cost * (1 - ally.hp / ally.stats.maxHp);
      else if (s.type === 'rangeBooster') score += ally.stats.range > 1 ? cost * 0.3 : 0;
      else score += cost * 0.2; // damageBooster — flat benefit to any nearby combat ally
    }
  }
  return score * w.supportCoverage;
}

// Reuses the engine's own real encirclement math (game.ts) rather than
// reimplementing it — positional pressure the moment it exists, before any
// damage is actually dealt (§26).
function encirclementScore(state: GameState, player: Player): number {
  const w = AI_EVAL_WEIGHTS;
  const enemies = revealedEnemiesOf(state, player.id);
  if (enemies.length === 0) return 0;
  let score = 0;
  const myUnits = state.units.filter(u => u.hp > 0 && u.playerId === player.id);
  for (const u of myUnits) {
    const nearestEnemyDist = Math.min(...enemies.map(e => hexDistance(e.pos, u.pos)));
    if (nearestEnemyDist > 1) continue; // only matters in actual contact
    const info = calculateEncirclement(state, u);
    score -= (info.attackMultiplier - 1) * w.encirclement; // enemy's encirclement bonus against ME is bad for me
  }
  for (const e of enemies) {
    const nearestMineDist = Math.min(...myUnits.map(u => hexDistance(u.pos, e.pos)), Infinity);
    if (nearestMineDist > 1) continue;
    const info = calculateEncirclement(state, e);
    score += (info.attackMultiplier - 1) * w.encirclement; // my encirclement bonus against THEM is good for me
  }
  return score;
}

// Activation economy (§27, §94): a valuable unit that can still act this
// turn is worth more right now than the same unit after it's already
// spent its activation — otherwise the evaluator can't tell "I have 3
// strong unactivated units" from "those 3 already went".
function tempoScore(state: GameState, player: Player): number {
  const w = AI_EVAL_WEIGHTS;
  const mine = state.units.filter(u => u.hp > 0 && u.playerId === player.id);
  let score = 0;
  for (const u of mine) {
    if (u.hasMoved || u.hasAttacked) continue;
    score += getUnitCost(u.type, player.faction) * 0.15;
  }
  return score * w.tempo;
}

function playerScore(state: GameState, player: Player, breakdown: EvalBreakdown, sign: number): void {
  const { material, threatened } = materialScore(state, player);
  breakdown.material += sign * material;
  breakdown.threatenedMaterial += sign * threatened;
  breakdown.capitalSafety += sign * capitalSafetyScore(state, player);
  breakdown.income += sign * incomeScore(state, player);
  breakdown.energy += sign * energyScore(state, player);
  breakdown.production += sign * productionScore(state, player);
  breakdown.command += sign * commandScore(state, player);
  breakdown.tech += sign * techScore(state, player);
  breakdown.farms += sign * farmScore(state, player);
  breakdown.temples += sign * templeScore(state, player);
  breakdown.fertileSites += sign * fertileSiteScore(state, player);
  breakdown.roads += sign * roadScore(state, player);
  breakdown.mobility += sign * mobilityScore(state, player);
  breakdown.boardControl += sign * boardControlScore(state, player);
  breakdown.formation += sign * formationScore(state, player);
  breakdown.support += sign * supportScore(state, player);
  breakdown.encirclement += sign * encirclementScore(state, player);
  breakdown.tempo += sign * tempoScore(state, player);
}

// plyFromRoot lets a search prefer a faster forced win / slower forced loss
// over an equally "won"/"lost" position further out — see MATE_SCORE.
export function evaluateStateDetailed(state: GameState, perspectivePlayerId: number, plyFromRoot = 0): EvalBreakdown {
  const b = emptyBreakdown();
  if (state.phase === 'gameOver') {
    if (state.winner?.id === perspectivePlayerId) b.terminal = MATE_SCORE - plyFromRoot;
    else if (state.winner) b.terminal = -MATE_SCORE + plyFromRoot;
    b.total = b.terminal;
    return b;
  }
  for (const player of state.players) {
    const sign = player.id === perspectivePlayerId ? 1 : -1;
    playerScore(state, player, b, sign);
  }
  b.total = b.terminal + b.material + b.threatenedMaterial + b.capitalSafety + b.income + b.energy
    + b.production + b.command + b.tech + b.farms + b.temples + b.fertileSites + b.roads
    + b.mobility + b.boardControl + b.formation + b.support + b.encirclement + b.tempo;
  return b;
}

export function evaluateState(state: GameState, perspectivePlayerId: number, plyFromRoot = 0): number {
  return evaluateStateDetailed(state, perspectivePlayerId, plyFromRoot).total;
}
