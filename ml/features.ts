// Observation encoding: a fixed-size feature vector from the REFERENCE player's
// point of view ("me" vs aggregated "them"). Works for N players (them = all
// non-ref players aggregated); exact for the 1v1 focus.
//
// Design goal: besides economy/army/tech/territory scalars, include POSITIONAL
// features that CHANGE when a unit moves (advancement, temple contact, threats,
// engagement). Without these, a value net would score most move actions
// identically and 1-ply lookahead couldn't pick tactically — so these give the
// net a gradient over movement.
// PHASE 3 NOTE: FEATURE_NAMES/FEATURE_DIM are left UNCHANGED on purpose — the
// dimension is baked into already-trained value-net checkpoints. "Temple"
// features below are now computed against owned structures (Capital +
// completed City/Temple sites) as the closest equivalent; the old per-temple
// "level" no longer exists (leveling is gone) so myAvgLvl/themAvgLvl are
// left as zeroed dead slots rather than reused for something else, to avoid
// shifting any other index's meaning. A real retraining pass should replace
// these approximations once the new economy (phase 4) lands.
import { GameState, UnitType } from '../src/types';
import { TECH_NODES } from '../src/types';
import { getPopulationCap, getPopulationCount, getEffectiveRange, getOwnedStructures, getPlayerIncome } from '../src/game';
import { hexDistance } from '../src/hex';

const UNIT_TYPES: UnitType[] = ['warrior', 'archer', 'catapult', 'horserider', 'heavyknight', 'spearsman', 'healer', 'damageBooster', 'rangeBooster'];
const TECH_IDS = TECH_NODES.map(n => n.id);

function income(state: GameState, pid: number): number {
  return getPlayerIncome(state, pid);
}

// Human-readable feature names (documentation + debugging). Order === vector order.
export const FEATURE_NAMES: string[] = (() => {
  const n: string[] = [
    'me.aura', 'them.aura', 'me.income', 'them.income',
    'me.pop', 'me.popCap', 'them.pop', 'them.popCap',
    'me.temples', 'them.temples', 'neutral.temples',
    'me.avgTempleLvl', 'them.avgTempleLvl',
    'turnNumber', 'isMyTurn',
    'diff.temples', 'diff.hp', 'diff.income', 'diff.pop',
  ];
  for (const t of UNIT_TYPES) n.push(`me.count.${t}`);
  for (const t of UNIT_TYPES) n.push(`them.count.${t}`);
  n.push('me.totalHp', 'them.totalHp');
  for (const t of TECH_IDS) n.push(`me.tech.${t}`);
  for (const t of TECH_IDS) n.push(`them.tech.${t}`);
  n.push(
    'me.advancement', 'me.unitsOnCapturable', 'me.unitsAdjCapturable',
    'them.unitsThreatenMyTemples', 'me.unitsThreatenEnemy', 'them.unitsThreatenMe',
    'me.avgDistToEnemy', 'me.unitsOnHills', 'me.hasPortal', 'me.avgTempleContest',
  );
  return n;
})();

export const FEATURE_DIM = FEATURE_NAMES.length;

export function featurize(state: GameState, ref: number): Float64Array {
  const f = new Float64Array(FEATURE_DIM);
  const players = state.players;
  const others = players.filter(p => p.id !== ref).map(p => p.id);

  const me = players[ref]!;
  const myUnits = state.units.filter(u => u.hp > 0 && u.playerId === ref);
  const enemyUnits = state.units.filter(u => u.hp > 0 && others.includes(u.playerId));
  // "Temples" -> owned structures (Capital + completed City/Temple sites) —
  // the closest equivalent now that capture-by-presence and leveling are gone.
  const myTemples = getOwnedStructures(state, ref);
  const enemyTemples = others.flatMap(id => getOwnedStructures(state, id));
  const neutralTemples = state.strategicSites.filter(s => s.state === 'neutral' || s.state === 'ruins');
  const capturableTemples = state.strategicSites.filter(s => s.ownerId !== ref); // neutral/ruins + enemy-owned sites (Capitals are never "capturable")

  const myAura = me.aura;
  const themAura = others.reduce((s, id) => s + players[id]!.aura, 0);
  const myInc = income(state, ref);
  const themInc = others.reduce((s, id) => s + income(state, id), 0);
  const myPop = getPopulationCount(state, ref);
  const myCap = getPopulationCap(state, ref);
  const themPop = others.reduce((s, id) => s + getPopulationCount(state, id), 0);
  const themCap = others.reduce((s, id) => s + getPopulationCap(state, id), 0);
  const totT = Math.max(1, state.capitals.length + state.strategicSites.length);
  const myHp = myUnits.reduce((s, u) => s + u.hp, 0);
  const themHp = enemyUnits.reduce((s, u) => s + u.hp, 0);
  const myAvgLvl = 0;   // dead slot — see phase-3 note above (no more temple levels)
  const themAvgLvl = 0; // dead slot — see phase-3 note above

  let i = 0;
  f[i++] = myAura / 30; f[i++] = themAura / 30; f[i++] = myInc / 20; f[i++] = themInc / 20;
  f[i++] = myPop / 20; f[i++] = myCap / 20; f[i++] = themPop / 20; f[i++] = themCap / 20;
  f[i++] = myTemples.length / totT; f[i++] = enemyTemples.length / totT; f[i++] = neutralTemples.length / totT;
  f[i++] = myAvgLvl / 5; f[i++] = themAvgLvl / 5;
  f[i++] = Math.min(1, state.turnNumber / 60); f[i++] = state.currentPlayerIndex === ref ? 1 : 0;
  f[i++] = (myTemples.length - enemyTemples.length) / totT;
  f[i++] = (myHp - themHp) / 200;
  f[i++] = (myInc - themInc) / 20;
  f[i++] = (myPop - themPop) / 20;

  for (const t of UNIT_TYPES) f[i++] = myUnits.filter(u => u.type === t).length / 8;
  for (const t of UNIT_TYPES) f[i++] = enemyUnits.filter(u => u.type === t).length / 8;
  f[i++] = myHp / 200; f[i++] = themHp / 200;

  const myTech = state.playerTech[ref]!.researched;
  for (const t of TECH_IDS) f[i++] = myTech.has(t) ? 1 : 0;
  for (const t of TECH_IDS) {
    let any = 0;
    for (const id of others) if (state.playerTech[id]!.researched.has(t)) { any = 1; break; }
    f[i++] = any;
  }

  // ── Positional (movement-sensitive) ──
  const R = state.mapRadius;
  const nearestEnemyTempleDist = (pos: { q: number; r: number }): number => {
    let m = Infinity;
    for (const t of enemyTemples.length ? enemyTemples : capturableTemples) m = Math.min(m, hexDistance(pos, t.pos));
    return m === Infinity ? R : m;
  };
  let advSum = 0, onCap = 0, adjCap = 0, threatEnemy = 0, distSum = 0, onHills = 0;
  // Precompute effective ranges ONCE (getEffectiveRange is O(units); using it
  // inside nested unit loops would be O(units^3) and kills big-army performance).
  const myRange = myUnits.map(u => getEffectiveRange(state, u));
  const enemyRange = enemyUnits.map(e => getEffectiveRange(state, e));
  for (let ui = 0; ui < myUnits.length; ui++) {
    const u = myUnits[ui]!;
    advSum += 1 - Math.min(1, nearestEnemyTempleDist(u.pos) / (2 * R));
    for (const t of capturableTemples) {
      const d = hexDistance(u.pos, t.pos);
      if (d === 0) onCap++;
      if (d <= 1) adjCap++;
    }
    let nd = Infinity;
    for (const e of enemyUnits) nd = Math.min(nd, hexDistance(u.pos, e.pos));
    distSum += (nd === Infinity ? R : nd);
    for (const e of enemyUnits) if (hexDistance(u.pos, e.pos) <= myRange[ui]!) { threatEnemy++; break; }
    if (state.hills.has(`${u.pos.q},${u.pos.r}`)) onHills++;
  }
  let threatMyTemples = 0;
  for (const t of myTemples) for (const e of enemyUnits) if (hexDistance(e.pos, t.pos) <= 2) { threatMyTemples++; break; }
  let threatMe = 0;
  for (const u of myUnits) for (let ei = 0; ei < enemyUnits.length; ei++) if (hexDistance(u.pos, enemyUnits[ei]!.pos) <= enemyRange[ei]!) { threatMe++; break; }

  const nMy = Math.max(1, myUnits.length);
  f[i++] = advSum / nMy;
  f[i++] = onCap / 4;
  f[i++] = adjCap / 6;
  f[i++] = threatMyTemples / Math.max(1, myTemples.length);
  f[i++] = threatEnemy / 8;
  f[i++] = threatMe / 8;
  f[i++] = (distSum / nMy) / R;
  f[i++] = onHills / 8;
  f[i++] = state.teleportBuildings.some(tp => tp.builtByPlayerId === ref) ? 1 : 0;
  // avg "contest" of capturable temples: my units minus enemy units within 2 of each
  let contest = 0;
  for (const t of capturableTemples) {
    let mine = 0, theirs = 0;
    for (const u of myUnits) if (hexDistance(u.pos, t.pos) <= 2) mine++;
    for (const e of enemyUnits) if (hexDistance(e.pos, t.pos) <= 2) theirs++;
    contest += Math.sign(mine - theirs);
  }
  f[i++] = contest / Math.max(1, capturableTemples.length);

  return f;
}
