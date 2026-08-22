// Run the trained NN value-bot vs the hard AI in the headless engine and print a
// readable game log (per-turn actions + board summary). Usage:
//   npx tsx ml/runNNHeadless.ts [weights.json] [seed] [nnSlot 0|1]
import { GameState } from '../src/types';
import { legalMicros, applyMicro, cloneState, reset, isAlive } from './gameEnv';
import { runHardAITurn } from '../src/ai';
import { endTurn, getPopulationCap, getPopulationCount, getOwnedStructures } from '../src/game';
import { featurize } from './features';
import { loadNet } from './mlpIO';

const path = process.argv[2] ?? 'ml/weights/value-net.json';
const seed = Number(process.argv[3] ?? 424242);
const nnSlot = Number(process.argv[4] ?? 0);
const net = loadNet(path);

function summary(s: GameState, pid: number): string {
  const u = s.units.filter(x => x.hp > 0 && x.playerId === pid);
  const t = getOwnedStructures(s, pid);
  const capitalHp = s.capitals.find(c => c.playerId === pid)?.hp ?? 0;
  const tech = s.playerTech[pid]!.researched.size;
  const byType: Record<string, number> = {};
  for (const x of u) byType[x.type] = (byType[x.type] ?? 0) + 1;
  const comp = Object.entries(byType).map(([k, v]) => `${v}${k.slice(0, 3)}`).join(',');
  return `aura=${s.players[pid]!.aura} units=${u.length}(${comp}) structures=${t.length} capitalHp=${capitalHp} pop=${getPopulationCount(s, pid)}/${getPopulationCap(s, pid)} tech=${tech}`;
}

// NN turn with per-action logging.
function nnTurn(s: GameState): string[] {
  const botId = s.currentPlayerIndex;
  const acts: string[] = [];
  for (let step = 0; step < 40; step++) {
    if (s.phase !== 'playing') break;
    const micros = legalMicros(s).filter(m => m.action !== 'end-turn');
    if (micros.length === 0) { endTurn(s); break; }
    const curV = net.value(featurize(s, botId));
    let best = 0, bestV = -Infinity;
    for (let k = 0; k < micros.length; k++) {
      const c = cloneState(s); applyMicro(c, micros[k]!);
      const v = net.value(featurize(c, botId));
      if (v > bestV) { bestV = v; best = k; }
    }
    if (bestV <= curV) { endTurn(s); break; }
    const m = micros[best]!;
    applyMicro(s, m);
    const p = m.params as Record<string, unknown>;
    acts.push(m.action === 'recruit' ? `recruit ${p.unitType}`
      : m.action === 'research' ? `research ${p.techId}`
        : m.action === 'build-teleport' ? 'build-teleport'
          : m.action === 'found' ? 'found'
            : m.action === 'attack-structure' ? 'attack-structure'
              : m.action);
  }
  return acts;
}

const out: string[] = [];
const log = (m: string) => { out.push(m); console.log(m); };

log(`=== NN value-bot (slot ${nnSlot}) vs Hard AI — seed ${seed} ===`);
log(`weights: ${path}`);
const s = reset({ seed, nPlayers: 2, forceFirst: 0 });
let half = 0;
while (s.phase === 'playing' && s.turnNumber <= 250 && half < 500) {
  const cur = s.currentPlayerIndex;
  if (cur === nnSlot) {
    const acts = nnTurn(s);
    const counts: Record<string, number> = {};
    for (const a of acts) { const key = a.split(' ')[0]!; counts[key] = (counts[key] ?? 0) + 1; }
    log(`R${s.turnNumber} NN(P${cur}): ${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(' ')}`);
  } else {
    runHardAITurn(s); if (s.phase === 'playing') endTurn(s);
    log(`R${s.turnNumber} HARD(P${cur}) played`);
  }
  if (half % 4 === 0 || s.phase !== 'playing') {
    log(`     NN[P${nnSlot}]: ${summary(s, nnSlot)}`);
    log(`     HARD[P${1 - nnSlot}]: ${summary(s, 1 - nnSlot)}`);
  }
  half++;
}
const winner = s.winner ? (s.winner.id === nnSlot ? 'NN WINS' : 'HARD WINS') : 'DRAW';
log(`\n=== RESULT: ${winner} (winner=P${s.winner?.id ?? 'none'}, ${s.turnNumber} rounds) ===`);
log(`Final NN:   ${summary(s, nnSlot)} alive=${isAlive(s, nnSlot)}`);
log(`Final HARD: ${summary(s, 1 - nnSlot)} alive=${isAlive(s, 1 - nnSlot)}`);

import { writeFileSync } from 'fs';
if (process.env.SAVE) writeFileSync(process.env.SAVE, out.join('\n'));
