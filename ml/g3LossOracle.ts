// STEP-0 oracle (M4): re-run ONLY the Gate-G3 losing games with a per-decision
// CAPTURE-AVAILABILITY oracle, so losses can be bucketed by A50/A69's exact spec:
//   B1 ROBUST-PATH  — a reachable IMMEDIATE-WIN (terminal) capture existed at a
//                     decision point but was not converted → the ±1e6 short-circuit
//                     never locked it ⇒ the winning turn was never sampled. EXPECTED ~0;
//                     any B1>0 is the P0 alarm (the "robust" path isn't robust).
//   B2 V-DEPENDENT  — a reachable VALUABLE non-terminal capture (HIGH / PIVOTAL-ELIM)
//                     existed but was not taken → v2mc mis-rated the post-capture state.
//                     The drift-fragile insurance target.
//   B3 NON-ADDRESSABLE — no recovery capture reachable on the board ⇒ lost on the merits.
//
// DISCIPLINE: assignment is by capture-availability AT THE DECISION POINT (reachability),
// not post-hoc outcome. "Reachable capture of temple T this turn" = some fresh bot unit
// is already on T, or can move onto T's hex within its speed (getReachableHexes handles
// occupancy/walls/hills) — the dominant single-unit move-onto-then-capture pattern. (Multi-
// unit setups needing a defender killed first are NOT counted reachable — conservative,
// which biases AGAINST inflating B1/B2, exactly per the anti-leak discipline.)
//
// Determinism: wrapper only READS state (no Math.random) and calls the real search
// TurnFn once per turn → RNG stream bit-identical to the gate. Reads losingGameIds
// from /tmp/g3buckets/ref-winners.json (the ground-truth anchored to the gate headline).
import { runGame, hardTurn, TurnFn } from './play';
import { makePolicySearchBot } from './searchPolicy';
import { MLP } from './mlp';
import { featurize } from './features';
import { heuristicLeaf } from './heuristicLeaf';
import { canCaptureTemple, getEffectiveRange } from '../src/game';
import { getReachableHexes, hexEqual, hexKey, hexDistance } from '../src/hex';
import { GameState, HexCoord } from '../src/types';
import * as fs from 'fs';

const POLICY = 'ml/weights/policy-g2.json';
const VALUE = 'ml/weights/value-net-v2mc-best.json';
const K = 12, TEMP = 1, DEPTH = 1, SEED_BASE = 800000;

interface Reach { templeId: string; klass: string; level: number }
// Brink diagnostic: when the bot owns total-1 temples, describe the missing (4th)
// temple so a NOT-single-unit-reachable pivotal-win can be hand-adjudicated for a
// kill-then-capture / teleport combo (A50: affirmatively scan reached-3/4, bias to B1).
interface Brink {
  templeId: string; reachableSingleUnit: boolean;
  occupantPlayer: number | null;      // who sits on the temple hex (null = empty)
  minBotDist: number;                 // nearest bot unit's hex-distance to the temple
  occupantAttackableByBot: boolean;   // can a bot unit attack the occupant this turn (in range)
}
interface OracleTurn {
  turn: number; myBefore: number; myAfter: number; total: number;
  reachable: Reach[];            // reachable non-owned temples this turn + stakes
  convertedIds: string[];        // temple ids the bot owned after the turn that it didn't before
  brink: Brink[];                // populated only when myBefore == total-1
}

function reachableCaptures(s: GameState, pid: number): Reach[] {
  const out: Reach[] = [];
  const total = s.temples.length;
  const myBefore = s.temples.filter(t => t.ownerId === pid).length;
  const myUnits = s.units.filter(u => u.hp > 0 && u.playerId === pid && !u.hasCaptured);
  const wallPos: HexCoord[] = [...s.walls].map(k => { const [q, r] = k.split(',').map(Number); return { q: q!, r: r! }; });
  for (const t of s.temples) {
    if (t.ownerId === pid) continue;
    let reachable = false;
    for (const u of myUnits) {
      if (hexEqual(u.pos, t.pos)) { reachable = canCaptureTemple(s, u) !== null; if (reachable) break; continue; }
      const occupied = s.units.filter(x => x.hp > 0 && x.id !== u.id).map(x => x.pos);
      const hexes = getReachableHexes(u.pos, u.stats.speed, s.mapRadius, [...occupied, ...wallPos], s.hills);
      if (hexes.some(h => hexEqual(h, t.pos))) { reachable = true; break; }
    }
    if (!reachable) continue;
    const winsGame = myBefore + 1 === total;
    const prevOwner = t.ownerId;
    const prevCount = prevOwner === null ? 0 : s.temples.filter(x => x.ownerId === prevOwner).length;
    const prevLast = prevOwner !== null && prevCount === 1;
    const klass = winsGame ? 'PIVOTAL-WIN' : prevLast ? 'PIVOTAL-ELIM' : t.level >= 2 ? 'HIGH' : 'MINOR';
    out.push({ templeId: t.id, klass, level: t.level });
  }
  return out;
}

function brinkScan(s: GameState, pid: number): Brink[] {
  const total = s.temples.length;
  if (s.temples.filter(t => t.ownerId === pid).length !== total - 1) return [];
  const myUnits = s.units.filter(u => u.hp > 0 && u.playerId === pid);
  const wallPos: HexCoord[] = [...s.walls].map(k => { const [q, r] = k.split(',').map(Number); return { q: q!, r: r! }; });
  const out: Brink[] = [];
  for (const t of s.temples) {
    if (t.ownerId === pid) continue; // the missing temple(s)
    const occ = s.units.find(u => u.hp > 0 && hexEqual(u.pos, t.pos));
    let single = false, minDist = Infinity, attackable = false;
    for (const u of myUnits) {
      minDist = Math.min(minDist, hexDistance(u.pos, t.pos));
      if (hexEqual(u.pos, t.pos)) { if (canCaptureTemple(s, u)) single = true; continue; }
      const occupied = s.units.filter(x => x.hp > 0 && x.id !== u.id).map(x => x.pos);
      const hexes = getReachableHexes(u.pos, u.stats.speed, s.mapRadius, [...occupied, ...wallPos], s.hills);
      if (hexes.some(h => hexEqual(h, t.pos))) single = true;
      if (occ && occ.playerId !== pid && !u.hasAttacked && hexDistance(u.pos, occ.pos) <= getEffectiveRange(s, u)) attackable = true;
    }
    out.push({ templeId: t.id, reachableSingleUnit: single, occupantPlayer: occ ? occ.playerId : null, minBotDist: minDist, occupantAttackableByBot: attackable });
  }
  return out;
}

function makeBot(botId: number, rows: OracleTurn[]): TurnFn {
  const pnet = MLP.load(POLICY), vnet = MLP.load(VALUE);
  const leaf = (st: GameState, b: number) => 0.5 * vnet.value(featurize(st, b)) + 0.5 * heuristicLeaf(st, b);
  const real = makePolicySearchBot(pnet, vnet, hardTurn, { K, temp: TEMP, leaf, depth: DEPTH });
  return (s) => {
    const pid = s.currentPlayerIndex;
    const total = s.temples.length;
    const ownedBefore = new Set(s.temples.filter(t => t.ownerId === pid).map(t => t.id));
    const reachable = reachableCaptures(s, pid);
    const brink = brinkScan(s, pid);
    const turn = s.turnNumber;
    real(s);
    const ownedAfter = new Set(s.temples.filter(t => t.ownerId === pid).map(t => t.id));
    const convertedIds = [...ownedAfter].filter(id => !ownedBefore.has(id));
    rows.push({ turn, myBefore: ownedBefore.size, myAfter: ownedAfter.size, total, reachable, convertedIds, brink });
  };
}

function bucket(rows: OracleTurn[]): { bucket: string; evidence: string } {
  // A reachable stake is "declined" if it was reachable at a turn-start but the bot did
  // NOT own that temple after the turn (converted set excludes it).
  let b1 = false, b2 = false, anyReach = false;
  const b1turns: number[] = [], b2turns: number[] = [];
  for (const r of rows) {
    const conv = new Set(r.convertedIds);
    for (const rc of r.reachable) {
      anyReach = true;
      const declined = !conv.has(rc.templeId);
      if (rc.klass === 'PIVOTAL-WIN' && declined) { b1 = true; b1turns.push(r.turn); }
      if ((rc.klass === 'HIGH' || rc.klass === 'PIVOTAL-ELIM') && declined) { b2 = true; b2turns.push(r.turn); }
    }
  }
  if (b1) return { bucket: 'B1-ROBUST', evidence: `reachable PIVOTAL-WIN declined @turns [${b1turns.join(',')}]` };
  if (b2) return { bucket: 'B2-VDEP', evidence: `reachable HIGH/ELIM declined @turns [${b2turns.join(',')}]` };
  return { bucket: 'B3-NONADDR', evidence: anyReach ? 'only MINOR reachable captures on board' : 'no recovery capture reachable at any decision point' };
}

function gameParams(gameId: number) {
  const pair = Math.floor(gameId / 2);
  return { seed: SEED_BASE + pair, forceFirst: pair % 2, botSlot: gameId % 2 };
}

(function main() {
  const ref = JSON.parse(fs.readFileSync('/tmp/g3buckets/ref-winners.json', 'utf8')) as { losingGameIds: number[]; wins: number; losses: number };
  console.log(`\n===== G3 LOSS ORACLE (ground truth: ${ref.wins}W ${ref.losses}L, losers=[${ref.losingGameIds.join(',')}]) =====\n`);
  const counts = new Map<string, number>();
  for (const gid of ref.losingGameIds) {
    const { seed, forceFirst, botSlot } = gameParams(gid);
    const rows: OracleTurn[] = [];
    const bot = makeBot(botSlot, rows);
    const turns: TurnFn[] = botSlot === 0 ? [bot, hardTurn] : [hardTurn, bot];
    const r = runGame({ seed, forceFirst, turns, maxRounds: 90, maxDecisions: 1e9 });
    const won = r.winner === botSlot;
    const maxOwned = Math.max(0, ...rows.map(x => Math.max(x.myBefore, x.myAfter)));
    const totalCaps = rows.reduce((a, x) => a + Math.max(0, x.myAfter - x.myBefore), 0);
    const { bucket: bk, evidence } = bucket(rows);
    const coarse = bk.slice(0, 2);
    counts.set(coarse, (counts.get(coarse) ?? 0) + 1);
    console.log(`gameId=${gid} seed=${seed} slot=${botSlot} forceFirst=${forceFirst} → ${won ? 'W(!!)' : 'L'}  maxOwned=${maxOwned}/${rows[0]?.total ?? '?'} capsMade=${totalCaps}`);
    console.log(`   BUCKET ${bk}  —  ${evidence}`);
    // brief trajectory of reachable stakes (non-MINOR) for the record
    const highlights = rows.filter(x => x.reachable.some(rc => rc.klass !== 'MINOR'))
      .map(x => `t${x.turn}:{${x.reachable.filter(rc => rc.klass !== 'MINOR').map(rc => rc.klass).join('|')}}→conv[${x.convertedIds.length}]`);
    if (highlights.length) console.log(`   valuable-reachable turns: ${highlights.join('  ')}`);
    // BRINK-SCAN (A50): affirmatively surface every reached-3/4 turn's missing temple so
    // a not-single-unit-reachable pivotal-win (kill-then-capture / teleport combo) is NOT
    // silently defaulted to B3. If any brink turn shows occupantAttackableByBot=true or a
    // tiny minBotDist with an empty temple, hand-adjudicate as a possible move-level B1.
    const brinkTurns = rows.filter(x => x.brink.length > 0);
    if (brinkTurns.length) {
      const flag = brinkTurns.some(x => x.brink.some(b => b.reachableSingleUnit || b.occupantAttackableByBot));
      console.log(`   BRINK-SCAN (reached 3/4 on ${brinkTurns.length} turns)${flag ? '  ⚠ MANUAL-B1-CHECK' : ''}:`);
      for (const x of brinkTurns) for (const b of x.brink)
        console.log(`     t${x.turn} temple=${b.templeId} single-reach=${b.reachableSingleUnit} occupant=${b.occupantPlayer === null ? 'empty' : 'P' + b.occupantPlayer} minBotDist=${b.minBotDist} occAttackable=${b.occupantAttackableByBot}`);
    }
    console.log('');
  }
  console.log('===== SPLIT =====');
  for (const k of ['B1', 'B2', 'B3']) console.log(`  ${k} ${counts.get(k) ?? 0}`);
  const addressable = (counts.get('B1') ?? 0) + (counts.get('B2') ?? 0);
  console.log(`\nQUANTIFY: ${ref.losses}/${ref.wins + ref.losses} recovery-relevant losses.  LOCATE: B1=${counts.get('B1') ?? 0} B2=${counts.get('B2') ?? 0} B3=${counts.get('B3') ?? 0}.  addressable(B1+B2)=${addressable}.`);
})();
