import { resetCounters } from '../src/game';
import { GameState } from '../src/types';

// ── Counter resync after deserialize / new game ──
// Re-derive the next-id counters (unit_/temple_/tp_) from the live entities so
// freshly created or restored states don't reuse existing ids.
export function resyncCounters(state: GameState): void {
  let unitMax = 0, templeMax = 0, tpMax = 0;
  for (const u of state.units) {
    const n = parseInt(u.id.replace('unit_', ''), 10);
    if (!isNaN(n) && n >= unitMax) unitMax = n + 1;
  }
  for (const t of state.temples) {
    const n = parseInt(t.id.replace('temple_', ''), 10);
    if (!isNaN(n) && n >= templeMax) templeMax = n + 1;
  }
  for (const tp of state.teleportBuildings) {
    const n = parseInt(tp.id.replace('tp_', ''), 10);
    if (!isNaN(n) && n >= tpMax) tpMax = n + 1;
  }
  resetCounters(unitMax, templeMax, tpMax);
}
