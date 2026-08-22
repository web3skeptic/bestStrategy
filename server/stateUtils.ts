import { resetCounters } from '../src/game';
import { GameState } from '../src/types';

// ── Counter resync after deserialize / new game ──
// Re-derive the next-id counters (unit_/site_/tp_) from the live entities so
// freshly created or restored states don't reuse existing ids. Capitals use
// deterministic per-player ids (capital_<playerId>), so they need no counter.
export function resyncCounters(state: GameState): void {
  let unitMax = 0, siteMax = 0, tpMax = 0;
  for (const u of state.units) {
    const n = parseInt(u.id.replace('unit_', ''), 10);
    if (!isNaN(n) && n >= unitMax) unitMax = n + 1;
  }
  for (const s of state.strategicSites) {
    const n = parseInt(s.id.replace('site_', ''), 10);
    if (!isNaN(n) && n >= siteMax) siteMax = n + 1;
  }
  for (const tp of state.teleportBuildings) {
    const n = parseInt(tp.id.replace('tp_', ''), 10);
    if (!isNaN(n) && n >= tpMax) tpMax = n + 1;
  }
  resetCounters(unitMax, siteMax, tpMax);
}
