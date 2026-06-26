// Replays browser. Fetches /api/headless/replays once, renders a filterable
// + sortable table. Client-side only — the dataset is small enough (currently
// ~hundreds of rows) that we don't need pagination yet.

interface Replay {
  gameId: string;
  createdAt: number;
  finishedAt: number | null;
  player1Name: string;
  player2Name: string;
  winnerName: string | null;
  eventCount: number;
}

interface Row extends Replay {
  durationSec: number | null;
  isFinished: boolean;
}

type SortKey = 'createdAt' | 'player1Name' | 'player2Name' | 'winnerName' | 'eventCount' | 'durationSec' | 'gameId';

const state = {
  rows: [] as Row[],
  sortKey: 'createdAt' as SortKey,
  sortDir: -1 as 1 | -1,           // -1 = desc, 1 = asc
  search: '',
  finishedOnly: false,
  winsOnly: false,
};

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

async function loadReplays(): Promise<void> {
  $<HTMLDivElement>('#errorBox').innerHTML = '';
  $<HTMLDivElement>('#stats').textContent = 'Loading…';
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}api/headless/replays`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json() as { ok: boolean; replays: Replay[] };
    state.rows = d.replays.map(r => ({
      ...r,
      isFinished: r.finishedAt !== null,
      durationSec: r.finishedAt !== null ? (r.finishedAt - r.createdAt) / 1000 : null,
    }));
    render();
  } catch (err) {
    $<HTMLDivElement>('#errorBox').innerHTML = `<div class="error">Failed to load replays: ${(err as Error).message}</div>`;
    $<HTMLDivElement>('#stats').textContent = '';
  }
}

function applyFilters(): Row[] {
  const q = state.search.trim().toLowerCase();
  return state.rows.filter(r => {
    if (state.finishedOnly && !r.isFinished) return false;
    if (state.winsOnly && !r.winnerName) return false;
    if (!q) return true;
    return (
      r.player1Name.toLowerCase().includes(q) ||
      r.player2Name.toLowerCase().includes(q) ||
      (r.winnerName ?? '').toLowerCase().includes(q) ||
      r.gameId.toLowerCase().includes(q)
    );
  });
}

function sortRows(rows: Row[]): Row[] {
  const key = state.sortKey;
  const dir = state.sortDir;
  return [...rows].sort((a, b) => {
    const av = (a[key] ?? '') as number | string;
    const bv = (b[key] ?? '') as number | string;
    if (av < bv) return -1 * dir;
    if (av > bv) return  1 * dir;
    return 0;
  });
}

function render(): void {
  // Update sort arrows on headers.
  document.querySelectorAll('th[data-sort]').forEach(th => {
    const k = (th as HTMLElement).dataset.sort as SortKey;
    const arrow = th.querySelector('.arrow') as HTMLSpanElement;
    arrow.textContent = k === state.sortKey ? (state.sortDir === 1 ? '↑' : '↓') : '';
  });

  const filtered = sortRows(applyFilters());
  const tbody = $<HTMLTableSectionElement>('#tbody');

  $<HTMLDivElement>('#stats').textContent =
    `Showing ${filtered.length} of ${state.rows.length} replay${state.rows.length === 1 ? '' : 's'}`;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No replays match your filters.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const winnerCell = r.winnerName
      ? `<span class="winner-cell">${escapeHtml(r.winnerName)}</span>`
      : (r.isFinished
        ? '<span class="winner-cell none">draw</span>'
        : '<span class="winner-cell none">— <span class="badge badge-timeout">unfinished</span></span>');
    return `<tr>
      <td>${fmtDate(r.createdAt)}</td>
      <td>${escapeHtml(r.player1Name)}</td>
      <td>${escapeHtml(r.player2Name)}</td>
      <td>${winnerCell}</td>
      <td style="text-align: right;">${r.eventCount.toLocaleString()}</td>
      <td style="text-align: right;">${fmtDuration(r.durationSec)}</td>
      <td><span class="gid">${escapeHtml(r.gameId)}</span></td>
      <td><a class="watch" href="/replay?gameId=${encodeURIComponent(r.gameId)}" target="_blank">Watch ▶</a></td>
    </tr>`;
  }).join('');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ── Wire up events ──

document.querySelectorAll('th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const k = (th as HTMLElement).dataset.sort as SortKey;
    if (state.sortKey === k) state.sortDir = (state.sortDir * -1) as 1 | -1;
    else { state.sortKey = k; state.sortDir = (k === 'createdAt' || k === 'eventCount' || k === 'durationSec') ? -1 : 1; }
    render();
  });
});

$<HTMLInputElement>('#searchInput').addEventListener('input', e => {
  state.search = (e.target as HTMLInputElement).value;
  render();
});
$<HTMLInputElement>('#finishedOnly').addEventListener('change', e => {
  state.finishedOnly = (e.target as HTMLInputElement).checked;
  render();
});
$<HTMLInputElement>('#winsOnly').addEventListener('change', e => {
  state.winsOnly = (e.target as HTMLInputElement).checked;
  render();
});
$<HTMLButtonElement>('#refreshBtn').addEventListener('click', () => { void loadReplays(); });

void loadReplays();
