// Behavioural-cloning data source + observer-fidelity test (plan M2.1).
//
// The hard AI is instrumented (src/ai.ts setAIObserver) to emit the dispatcher
// micro for every mutation it makes. Here we:
//   • streamHardDecisions — play hard-vs-hard games and hand each (pre-state,
//     expert micro, pid) to a callback for STREAMING behavioural cloning (M2.3);
//     no state storage.
//   • fidelityCheck — validate the hook: replay each turn's recorded micros
//     through the authoritative dispatcher on a same-seed clone UNDER THE SAME
//     combat rolls (rng snapshot/restore) and confirm the turn end-state matches
//     the AI's, for ≥99% of ≥500 turns.
import { GameState } from '../src/types';
import { setAIObserver, runHardAITurn, AIMicro } from '../src/ai';
import { reset, cloneState, applyMicro, legalMicros, Micro } from './gameEnv';
import { endTurn, getCounters, resetCounters, getTeleportAt } from '../src/game';
import { materialWinner } from './play';
import { getRngState, setRngState } from './rng';

// Snapshot a micro's params (plain JSON data) so later mutations can't touch it.
export function copyMicro(m: AIMicro): Micro {
  return { action: m.action as Micro['action'], params: JSON.parse(JSON.stringify(m.params)) };
}

// Canonical signature of the game-relevant state (order-independent) for equality.
export function stateSig(s: GameState): string {
  const units = s.units.map(u =>
    `${u.id}:${u.playerId}:${u.hp}:${u.pos.q},${u.pos.r}:${u.hasMoved ? 1 : 0}${u.hasAttacked ? 1 : 0}${u.hasCaptured ? 1 : 0}`
  ).sort().join('|');
  const temples = s.temples.map(t => `${t.id}:${t.ownerId}:${t.level}`).sort().join('|');
  const players = s.players.map(p => `${p.id}:${p.aura}`).sort().join('|');
  const tech = s.playerTech.map((pt, i) => `${i}:${[...pt.researched].sort().join(',')}`).join('|');
  const tp = s.teleportBuildings.map(b =>
    `${b.builtByPlayerId}:${b.templeId}:${b.pos.q},${b.pos.r}:${b.pairedId ?? ''}`
  ).sort().join('|');
  return `U[${units}]T[${temples}]P[${players}]R[${tech}]X[${tp}]#${s.phase}`;
}

// Find the candidate index in `cands` matching an expert micro (by action + ids +
// coords). Returns -1 if not present (should be rare; expert action is always
// legal by construction, but coord/id representation must line up).
export function matchMicro(cands: Micro[], expert: Micro): number {
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]!;
    if (c.action !== expert.action) continue;
    const cp = c.params as Record<string, unknown>, ep = expert.params as Record<string, unknown>;
    if ((cp.unitId ?? null) !== (ep.unitId ?? null)) continue;
    if ((cp.targetId ?? null) !== (ep.targetId ?? null)) continue;
    if ((cp.templeId ?? null) !== (ep.templeId ?? null)) continue;
    if ((cp.techId ?? null) !== (ep.techId ?? null)) continue;
    if ((cp.unitType ?? null) !== (ep.unitType ?? null)) continue;
    const ct = cp.to as { q: number; r: number } | undefined, et = ep.to as { q: number; r: number } | undefined;
    if (!!ct !== !!et) continue;
    if (ct && et && (ct.q !== et.q || ct.r !== et.r)) continue;
    return i;
  }
  return -1;
}

// Streaming BC source: play a hard-vs-hard game; call onMicro(pre-state, expert
// micro, pid) BEFORE each mutation. Returns the winner id (or null).
export function streamHardDecisions(
  seed: number,
  onMicro: (state: GameState, micro: Micro, pid: number) => void,
  maxRounds = 90,
): number | null {
  const s = reset({ seed, nPlayers: 2 });
  let half = 0;
  while (s.phase === 'playing' && s.turnNumber <= maxRounds && half < maxRounds * 2) {
    const pid = s.currentPlayerIndex;
    // Skip any micros the AI emits AFTER a mid-turn win (game already ended) — the
    // dispatcher refuses post-terminal actions and BC must not clone them.
    setAIObserver((st, m) => { if (st.phase === 'playing') onMicro(st, copyMicro(m), pid); });
    runHardAITurn(s);
    setAIObserver(null);
    // Synthetic terminal decision: at the AI's final state, the expert action is
    // end-turn (chosen over every still-legal action). Without this, BC never
    // teaches the policy WHEN to stop.
    if (s.phase === 'playing') { onMicro(s, { action: 'end-turn', params: {} }, pid); endTurn(s); }
    half++;
  }
  return s.winner ? s.winner.id : (s.phase === 'playing' ? materialWinner(s) : null);
}

export interface FidelityReport {
  turns: number; identical: number; fidelity: number; allOkTurns: number;
  avgMicros: number; unmatchedMicros: number; teleFails: number; nonTeleFails: number; fails: unknown[];
}

// Replay each hard-AI turn's recorded micros on a same-seed clone under the same
// combat RNG and compare end-states.
export function fidelityCheck(nGames: number, seedBase: number, maxRounds = 90, stopAtTurns = Infinity): FidelityReport {
  let turns = 0, identical = 0, allOkTurns = 0, totalMicros = 0, unmatched = 0;
  let teleFails = 0, nonTeleFails = 0;
  const fails: unknown[] = [];
  for (let g = 0; g < nGames && turns < stopAtTurns; g++) {
    const s = reset({ seed: seedBase + g, nPlayers: 2 });
    let half = 0;
    while (s.phase === 'playing' && s.turnNumber <= maxRounds && half < maxRounds * 2) {
      const pid = s.currentPlayerIndex;
      const pre = cloneState(s);
      const rngBefore = getRngState();
      const cntBefore = getCounters();
      const micros: Micro[] = [];
      // Record only playing-phase micros. If the game ends mid-turn (a winning
      // capture), snapshot the state AT THE WIN as the reference — the AI's post-
      // win moves are terminal flailing the dispatcher refuses and BC ignores.
      let winSig: string | null = null;
      setAIObserver((st, m) => {
        if (st.phase === 'playing') micros.push(copyMicro(m));
        else if (winSig === null) winSig = stateSig(st);
      });
      runHardAITurn(s);
      setAIObserver(null);
      const postSig = winSig ?? stateSig(s);   // reference = win-state, else turn end-state
      const rngAfter = getRngState();
      const cntAfter = getCounters();

      // Replay on the pre-state clone under the SAME rolls and SAME id counters,
      // so recruited units/temples/portals get identical ids.
      setRngState(rngBefore);
      resetCounters(cntBefore[0], cntBefore[1], cntBefore[2]);
      const replay = cloneState(pre);
      let allOk = true;
      for (const m of micros) {
        // each micro must be legal at ITS OWN replay state (candidate-set check).
        if (m.action !== 'end-turn' && matchMicro(legalMicros(replay), m) < 0) unmatched++;
        if (!applyMicro(replay, m)) allOk = false;
      }
      setRngState(rngAfter);                // restore real stream for the live game
      resetCounters(cntAfter[0], cntAfter[1], cntAfter[2]);

      const same = stateSig(replay) === postSig;
      const hasTeleportMove = micros.some(m => m.action === 'move' && m.params.to && getTeleportAt(pre, m.params.to as { q: number; r: number }));
      turns++; totalMicros += micros.length;
      if (allOk) allOkTurns++;
      if (same) identical++;
      else {
        if (hasTeleportMove) teleFails++; else nonTeleFails++;
        if (fails.length < 10) fails.push({ seed: seedBase + g, turn: s.turnNumber, pid, nMicros: micros.length, allOk, hasTeleportMove });
      }

      if (s.phase === 'playing') endTurn(s);
      half++;
      if (turns >= stopAtTurns) break;
    }
  }
  return {
    turns, identical, fidelity: turns ? identical / turns : 0, allOkTurns,
    avgMicros: turns ? totalMicros / turns : 0, unmatchedMicros: unmatched,
    teleFails, nonTeleFails, fails,
  };
}

// ── CLI ──  npx tsx ml/bcRecord.ts fidelity [nGames] [seedBase] [minTurns]
if (process.argv[1] && process.argv[1].endsWith('bcRecord.ts')) {
  const cmd = process.argv[2] ?? 'fidelity';
  if (cmd === 'fidelity') {
    const nGames = Number(process.argv[3] ?? 60);
    const seedBase = Number(process.argv[4] ?? 800000);
    const minTurns = Number(process.argv[5] ?? 500);
    const t0 = Date.now();
    const r = fidelityCheck(nGames, seedBase, 90, Infinity);
    // ensure we sampled enough turns; if not, run more games
    let extra = nGames;
    while (r.turns < minTurns) { const r2 = fidelityCheck(1, seedBase + extra, 90); r.turns += r2.turns; r.identical += r2.identical; r.allOkTurns += r2.allOkTurns; extra++; }
    r.fidelity = r.turns ? r.identical / r.turns : 0;
    console.log(`FIDELITY: ${r.identical}/${r.turns} turns end-state-identical = ${(r.fidelity * 100).toFixed(2)}%`);
    const nonTeleTurns = r.turns - (r.teleFails + r.nonTeleFails > 0 ? 0 : 0);
    console.log(`  allOkTurns=${r.allOkTurns}/${r.turns}  avgMicros/turn=${r.avgMicros.toFixed(1)}  unmatchedMicros=${r.unmatchedMicros}  in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    console.log(`  fails: teleport-move turns=${r.teleFails}, non-teleport turns=${r.nonTeleFails}  → non-teleport fidelity = ${(((r.turns - r.nonTeleFails) / r.turns) * 100).toFixed(2)}%`);
    if (r.fails.length) console.log(`  first fails:`, JSON.stringify(r.fails.slice(0, 5)));
    console.log(r.fidelity >= 0.99 ? 'RESULT: observer fidelity ≥99% ✓' : 'RESULT: fidelity < 99% ✗');
    process.exit(r.fidelity >= 0.99 ? 0 : 1);
  }
}
