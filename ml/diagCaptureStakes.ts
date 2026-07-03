// Pivotal-capture / frequency-vs-leverage diagnostic (G3 report fold). diagCapture
// showed captures are only 0.57% of decisions — but FREQUENCY ≠ LEVERAGE. Captures
// here are TEMPLE captures (the win condition: own ALL temples → win). This tool
// replays the SAME fixed hard-vs-hard games as diagCapture (seed 900k, n=5) and, at
// each EXPERT capture decision, classifies the target temple by STAKES:
//   • PIVOTAL-WIN  — capturer would then own every temple → game-winning
//   • PIVOTAL-ELIM — target is the prior owner's LAST temple → drops them to 0 temples
//   • HIGH         — high-level temple (level>=2, large economy swing), non-pivotal
//   • MINOR        — neutral / level-1 grab, non-pivotal
// No policy net needed — stakes are a property of the STATE + expert action, identical
// across proposers. Usage: npx tsx ml/diagCaptureStakes.ts [--n 5] [--seed 900000]
import { GameState } from '../src/types';
import { getTempleAt } from '../src/game';
import { Micro } from './gameEnv';
import { streamHardDecisions } from './bcRecord';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

(async () => {
  const nGames = Number(arg('n', '5'));
  const seedBase = Number(arg('seed', '900000'));
  type Row = { game: number; pid: number; level: number; prevOwner: number | null;
    myBefore: number; total: number; winsGame: boolean; prevLastTemple: boolean; klass: string };
  const rows: Row[] = [];

  const onMicro = (st: GameState, m: Micro, pid: number) => {
    if (m.action !== 'capture') return;
    const unit = st.units.find(u => u.id === (m.params as { unitId?: string }).unitId);
    if (!unit) return;
    const temple = getTempleAt(st, unit.pos);
    if (!temple) return;
    const total = st.temples.length;
    const myBefore = st.temples.filter(t => t.ownerId === pid).length;
    const prevOwner = temple.ownerId;
    const winsGame = myBefore + 1 === total;                                   // owns all after
    const prevCount = prevOwner === null ? 0 : st.temples.filter(t => t.ownerId === prevOwner).length;
    const prevLastTemple = prevOwner !== null && prevCount === 1;              // their last temple
    const klass = winsGame ? 'PIVOTAL-WIN' : prevLastTemple ? 'PIVOTAL-ELIM'
      : temple.level >= 2 ? 'HIGH' : 'MINOR';
    rows.push({ game: 0, pid, level: temple.level, prevOwner, myBefore, total, winsGame, prevLastTemple, klass });
  };

  for (let g = 0; g < nGames; g++) {
    const before = rows.length;
    streamHardDecisions(seedBase + g, onMicro);
    for (let i = before; i < rows.length; i++) rows[i]!.game = g;
  }

  console.log('\n===== CAPTURE STAKES (frequency-vs-leverage) =====');
  console.log(`games=${nGames} seed=${seedBase}  total expert-capture decisions=${rows.length}`);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.klass, (counts.get(r.klass) ?? 0) + 1);
  console.log('\nstakes breakdown:');
  for (const k of ['PIVOTAL-WIN', 'PIVOTAL-ELIM', 'HIGH', 'MINOR'])
    console.log(`  ${k.padEnd(13)} ${counts.get(k) ?? 0}`);
  const pivotal = (counts.get('PIVOTAL-WIN') ?? 0) + (counts.get('PIVOTAL-ELIM') ?? 0);
  console.log(`\nPIVOTAL (game-deciding) = ${pivotal}/${rows.length}   HIGH+MINOR (tactical) = ${rows.length - pivotal}/${rows.length}`);
  console.log('\nper-state detail:');
  console.log('  game  pid  templeLvl  prevOwner  myTemples(before)/total  winsGame  prevLastTemple  class');
  for (const r of rows)
    console.log(`  ${r.game}     ${r.pid}    L${r.level}         ${r.prevOwner === null ? 'neutral' : 'P' + r.prevOwner}      ${r.myBefore}/${r.total}                      ${r.winsGame}     ${r.prevLastTemple}          ${r.klass}`);
})().catch(e => { console.error(e); process.exit(1); });
