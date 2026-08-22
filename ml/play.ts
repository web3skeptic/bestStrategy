// Turn policies + full-game runner shared by training and eval.
import { GameState } from '../src/types';
import { applyMicro, cloneState, reset, isAlive, Micro } from './gameEnv';
import { runHardAITurn, runAITurn } from '../src/ai';
import { endTurn, canAfford, canResearch, canBuildTeleportPair,
  getUnlockedUnits, getPopulationCap, getPopulationCount, getUnitAt,
  getValidTeleportHexes, getValidTeleportHexesForOtherTemples, getOwnedStructures,
  getEffectiveRange, getPlayerVisible, isForestUnitRevealed, canStartFounding } from '../src/game';
import { TECH_NODES, UnitType } from '../src/types';
import { hexDistance, hexKey, hexEqual, getReachableHexes } from '../src/hex';
import { featurize } from './features';
import { MLP } from './mlp';

// Bot-side pruned candidate set — keeps 1-ply lookahead tractable regardless of
// army size (the env's legalMicros stays COMPLETE for correctness; this only
// limits what the bot bothers to evaluate). Attacks/captures are computed WITHOUT
// the reachable-BFS; only the few most-relevant MOVABLE units get a BFS + a
// handful of pruned move targets. Moves + per-unit BFS are the dominant cost.
const MOVES_PER_UNIT = 4;
const MOVE_UNITS = 8;
export function botCandidates(s: GameState): Micro[] {
  const pid = s.currentPlayerIndex;
  const out: Micro[] = [];
  const myUnits = s.units.filter(u => u.hp > 0 && u.playerId === pid);
  const enemies = s.units.filter(u => u.hp > 0 && u.playerId !== pid);
  const objectives = [
    ...s.strategicSites.filter(t => t.ownerId !== pid).map(t => t.pos),
    ...s.capitals.filter(c => c.playerId !== pid).map(c => c.pos),
    ...enemies.map(e => e.pos),
  ];
  const nearestObj = (p: { q: number; r: number }) => {
    let m = Infinity; for (const o of objectives) m = Math.min(m, hexDistance(p, o)); return m;
  };
  const visible = getPlayerVisible(s, pid);

  // Cheap captures + the single best attack per unit (lowest-HP reachable target
  // = easiest kill). One attack/unit keeps the lookahead candidate count bounded.
  for (const u of myUnits) {
    if (canStartFounding(s, u)) out.push({ action: 'found', params: { unitId: u.id } });
    if (u.hasAttacked || (u.stats.cantShootAfterMove && u.hasMoved)) continue;
    const rng = getEffectiveRange(s, u);
    let best: string | null = null, bestHp = Infinity;
    for (const e of enemies) {
      if (hexDistance(u.pos, e.pos) <= rng && visible.has(hexKey(e.pos)) && isForestUnitRevealed(s, e.pos, pid)) {
        if (e.hp < bestHp) { bestHp = e.hp; best = e.id; }
      }
    }
    if (best) out.push({ action: 'attack', params: { unitId: u.id, targetId: best } });
  }

  // Moves: only the MOVE_UNITS movable units nearest an objective get a BFS.
  const wallPositions = [...s.walls].map(k => { const [q, r] = k.split(',').map(Number); return { q: q!, r: r! }; });
  const movable = myUnits.filter(u => !u.hasMoved && !u.hasAttacked)
    .map(u => ({ u, d: nearestObj(u.pos) }))
    .sort((a, b) => a.d - b.d).slice(0, MOVE_UNITS);
  for (const { u } of movable) {
    const occupied = s.units.filter(x => x.hp > 0 && x.id !== u.id).map(x => x.pos);
    const reachable = getReachableHexes(u.pos, u.stats.speed, s.mapRadius, [...occupied, ...wallPositions], s.hills);
    const scored = reachable.map(h => ({
      to: h,
      adj: enemies.some(e => hexDistance(h, e.pos) === 1) ? 0 : 1,
      d: nearestObj(h),
    })).sort((x, y) => x.adj - y.adj || x.d - y.d);
    for (const m of scored.slice(0, MOVES_PER_UNIT)) out.push({ action: 'move', params: { unitId: u.id, to: m.to } });
  }

  // Recruit (few free structures × unlocked affordable types).
  if (getPopulationCount(s, pid) < getPopulationCap(s, pid)) {
    const unlocked = getUnlockedUnits(s.playerTech[pid]!, s.players[pid]?.faction);
    for (const structure of getOwnedStructures(s, pid)) {
      if (getUnitAt(s, structure.pos)) continue;
      for (const type of unlocked) if (canAfford(s, type)) out.push({ action: 'recruit', params: { unitType: type as UnitType, templeId: structure.id } });
    }
  }
  for (const structure of getOwnedStructures(s, pid)) {
    if (canBuildTeleportPair(s, structure.id)) {
      const a = getValidTeleportHexes(s, structure.id); const bs = getValidTeleportHexesForOtherTemples(s, structure.id);
      if (a.length && bs.length) {
        let posB = bs[0]!, bd = -1; for (const h of bs) { const d = hexDistance(structure.pos, h); if (d > bd) { bd = d; posB = h; } }
        out.push({ action: 'build-teleport', params: { templeId: structure.id, pos: a[0]!, targetPos: posB } });
      }
    }
  }
  for (const tech of TECH_NODES) if (canResearch(s, tech.id)) out.push({ action: 'research', params: { techId: tech.id } });
  return out;
}

// Decide a bounded-game outcome when the round cap is hit: winner = highest
// Capital HP (the real win condition, §11), tie-broken by owned structures
// then total unit HP; otherwise a draw.
export function materialWinner(s: GameState): number | null {
  let best: number | null = null, bestCap = -1, bestT = -1, bestHp = -1;
  for (const p of s.players) {
    if (!isAlive(s, p.id)) continue;
    const cap = s.capitals.find(c => c.playerId === p.id)?.hp ?? 0;
    const t = getOwnedStructures(s, p.id).length;
    const hp = s.units.filter(u => u.hp > 0 && u.playerId === p.id).reduce((a, u) => a + u.hp, 0);
    if (cap > bestCap || (cap === bestCap && (t > bestT || (t === bestT && hp > bestHp)))) {
      best = p.id; bestCap = cap; bestT = t; bestHp = hp;
    } else if (cap === bestCap && t === bestT && hp === bestHp) {
      best = null; // ambiguous tie
    }
  }
  return best;
}

// A TurnFn plays ONE full turn for the current player, INCLUDING end-turn.
export type TurnFn = (s: GameState) => void;

export const hardTurn: TurnFn = (s) => { runHardAITurn(s); if (s.phase === 'playing') endTurn(s); };
export const normalTurn: TurnFn = (s) => { runAITurn(s); if (s.phase === 'playing') endTurn(s); };

// Value-bot: 1-ply lookahead over V with a GREEDY-IMPROVE-OR-STOP turn policy.
// At each within-turn decision it scores the current mid-turn position and every
// legal non-end-turn action's resulting position (all with isMyTurn=1, so the
// comparison is apples-to-apples), then takes the best action ONLY if it improves
// the position past a small margin — otherwise it ends the turn. This both plays
// well (only value-improving actions) and terminates fast (no wasted micros).
// `temp>0` adds softmax exploration among improving actions for data generation.
export function makeValueBot(net: MLP, opts: { temp?: number; rng?: () => number; maxMicros?: number; margin?: number } = {}): TurnFn {
  const temp = opts.temp ?? 0;
  const rng = opts.rng ?? Math.random;
  const maxMicros = opts.maxMicros ?? 16;
  const margin = opts.margin ?? 0.0;
  return (s) => {
    const botId = s.currentPlayerIndex;
    const budget = s as unknown as { __botBudget?: number };
    for (let step = 0; step < maxMicros; step++) {
      if (s.phase !== 'playing') return;
      if (budget.__botBudget !== undefined && budget.__botBudget <= 0) { endTurn(s); return; } // per-game safety cap
      const micros = botCandidates(s); // pruned, no end-turn
      if (micros.length === 0) { endTurn(s); return; }
      if (budget.__botBudget !== undefined) budget.__botBudget--;
      const curV = net.value(featurize(s, botId));
      const vals = new Float64Array(micros.length);
      for (let k = 0; k < micros.length; k++) {
        const c = cloneState(s);
        applyMicro(c, micros[k]!);
        vals[k] = net.value(featurize(c, botId));
      }
      let choice = 0;
      for (let k = 1; k < micros.length; k++) if (vals[k]! > vals[choice]!) choice = k;
      if (temp > 0) {
        // softmax over improving actions only
        let mx = -Infinity; for (const v of vals) if (v > mx) mx = v;
        let sum = 0; const p = new Float64Array(vals.length);
        for (let k = 0; k < vals.length; k++) { p[k] = vals[k]! > curV ? Math.exp((vals[k]! - mx) / temp) : 0; sum += p[k]!; }
        if (sum > 0) { let r = rng() * sum, acc = 0; for (let k = 0; k < vals.length; k++) { acc += p[k]!; if (r <= acc) { choice = k; break; } } }
      }
      if (vals[choice]! <= curV + margin) { endTurn(s); return; } // nothing improves → stop
      applyMicro(s, micros[choice]!);
    }
    if (s.phase === 'playing') endTurn(s);
  };
}

// Turn-level 1-ply search bot: the strong lever for beating a greedy opponent.
// It generates K candidate turns (one pure-greedy-by-V, the rest greedy+explore),
// simulates the OPPONENT's reply (modelled by `opp`, e.g. the hard AI) after each,
// and commits the candidate whose post-reply position has the highest value. This
// makes the bot anticipate the opponent instead of playing 0-ply greedy — the
// classic way a value net + shallow lookahead tops a hand-crafted greedy AI. Uses
// the SAME engine/dispatcher throughout (no forked rules).
export function makeSearchBot(net: MLP, opp: TurnFn, opts: { K?: number; temp?: number; rng?: () => number; margin?: number; leaf?: (s: GameState, botId: number) => number } = {}): TurnFn {
  const K = opts.K ?? 6;
  const rng = opts.rng ?? Math.random;
  const margin = opts.margin ?? 0;
  // Search-leaf evaluator (post-opponent-reply position scorer). Defaults to the
  // value net; M0.2 swaps in the material heuristic / a V+H blend to quantify V's
  // marginal contribution. The bot's WITHIN-turn candidate generation stays V-based.
  const leaf = opts.leaf ?? ((s: GameState, botId: number) => net.value(featurize(s, botId)));
  const greedy = makeValueBot(net, { temp: 0, margin });
  const explore = makeValueBot(net, { temp: opts.temp ?? 0.12, rng, margin });
  const terminalVal = (s: GameState, botId: number): number | null =>
    s.phase !== 'playing' ? (s.winner ? (s.winner.id === botId ? 1e6 : -1e6) : 0) : null;
  return (s) => {
    const botId = s.currentPlayerIndex;
    const candidates: GameState[] = [];
    { const c = cloneState(s); greedy(c); candidates.push(c); }
    for (let k = 1; k < K; k++) { const c = cloneState(s); explore(c); candidates.push(c); }
    let best = candidates[0]!, bestV = -Infinity;
    for (const c of candidates) {
      let v = terminalVal(c, botId);
      if (v === null) {
        const r = cloneState(c);
        opp(r); // opponent (hard AI) replies
        const tv = terminalVal(r, botId);
        v = tv !== null ? tv : leaf(r, botId);
      }
      if (v > bestV) { bestV = v; best = c; }
    }
    Object.assign(s, best); // commit the chosen turn (already ended → opponent to move)
  };
}

export interface Sample { x: Float64Array; y: number; }

// Play one full game. Returns winner + optional labeled training samples (one per
// turn-boundary per player POV, labelled by the final outcome for that POV).
export function runGame(opts: {
  seed: number; nPlayers?: number; forceFirst?: number; turns: TurnFn[];
  maxRounds?: number; collect?: boolean; collectEvery?: number; maxDecisions?: number;
}): { winner: number | null; rounds: number; halfTurns: number; samples: Sample[] } {
  const n = opts.nPlayers ?? opts.turns.length;
  const s = reset({ seed: opts.seed, nPlayers: n, forceFirst: opts.forceFirst });
  (s as unknown as { __botBudget?: number }).__botBudget = opts.maxDecisions ?? 500; // hard per-game lookahead budget
  const maxRounds = opts.maxRounds ?? 90;
  const every = opts.collectEvery ?? 1;
  const staged: { x: Float64Array; ref: number }[] = [];
  let half = 0;
  while (s.phase === 'playing' && s.turnNumber <= maxRounds && half < maxRounds * n) {
    if (opts.collect && half % every === 0) {
      for (let r = 0; r < n; r++) staged.push({ x: featurize(s, r), ref: r });
    }
    opts.turns[s.currentPlayerIndex]!(s);
    half++;
  }
  // Bounded games: if the round cap was hit without a game-over, decide by material.
  const winner = s.winner ? s.winner.id : (s.phase === 'playing' ? materialWinner(s) : null);
  const samples: Sample[] = staged.map(st => ({
    x: st.x,
    y: winner === null ? 0 : (winner === st.ref ? 1 : -1),
  }));
  return { winner, rounds: s.turnNumber, halfTurns: half, samples };
}
