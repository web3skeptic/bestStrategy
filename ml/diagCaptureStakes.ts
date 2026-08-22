// Pivotal-capture / frequency-vs-leverage diagnostic (G3 report fold).
//
// PHASE 3: OBSOLETE. This tool analyzed the old "own ALL temples → win"
// capture mechanic, which no longer exists (replaced by founding + Capital-HP
// combat — see src/game.ts §5-11). Left compiling (onMicro is now a
// permanent no-op — 'capture' can never match) rather than deleted, per the
// project's "don't delete reusable/historical code" policy, but this script
// produces empty output and would need a full redesign around the new
// founding/structure-attack mechanics to be meaningful again.
import { GameState } from '../src/types';
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

  const onMicro = (_st: GameState, _m: Micro, _pid: number) => {
    // no-op — see OBSOLETE note above.
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
