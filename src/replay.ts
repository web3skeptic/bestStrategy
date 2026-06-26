// Replay viewer entry. Fetches a replay from /api/headless/:gameId/replay,
// reconstructs a GameState per stored event, and lets the user scrub through
// them using the Renderer. Supports a P0/P1/All fog-of-war toggle.

import { Renderer } from './renderer';
import {
  GameState, Unit, UnitType, UnitStats, Temple, Player, PlayerTech,
  TeleportBuilding, HexCoord, TechId,
} from './types';
import { generateHexMap, hexKey } from './hex';

// ── Snapshot types — mirror what serializeStateForApi() emits in headlessApi.ts ──

interface SnapshotPlayer { id: number; name: string; color: string; aura: number; popCap: number; currentPop: number; }
interface SnapshotUnit {
  id: string;
  type: UnitType;
  playerId: number;
  pos: HexCoord;
  hp: number;
  maxHp: number;
  hasMoved: boolean;
  hasAttacked: boolean;
  hasCaptured?: boolean;
  stats: {
    atk: number; def: number; spd: number; rng: number; vision: number;
    splash: number; splashFactor: number; canBeRevenged: boolean;
  };
}
interface SnapshotTemple { id: string; pos: HexCoord; ownerId: number | null; level: number; }
interface SnapshotTeleport {
  id: string; pos: HexCoord; builtByPlayerId: number; templeId: string; pairedId: string | null;
}
interface ApiSnapshot {
  phase: 'playing' | 'gameOver';
  currentPlayer: number;
  turnNumber: number;
  tick: number;
  players: SnapshotPlayer[];
  map: {
    radius: number;
    terrain: Record<string, string>;
    temples: SnapshotTemple[];
    teleportBuildings: SnapshotTeleport[];
  };
  units: SnapshotUnit[];
  tech: { playerId: number; researched: string[] }[];
  winner: { id: number; name: string } | null;
}

interface ReplayEventDto {
  seq: number;
  tick: number;
  turnNumber: number;
  currentPlayer: number;
  playerId: number;
  action: string;
  params: Record<string, unknown>;
  stateBefore: ApiSnapshot;
  stateAfter: ApiSnapshot | null;
  actionLog: string[];
  ok: boolean;
  error: string | null;
  timestamp: number;
}
interface ReplayDto {
  gameId: string;
  createdAt: number;
  finishedAt: number | null;
  players: { id: number; name: string; color: string }[];
  events: ReplayEventDto[];
}

// ── Default unit stat shape (used to fill in fields not carried by the API
//    snapshot: cantShootAfterMove, attackBonusAgainst, defenseBonusAgainst).
//    We mirror only the boolean / bonus fields, since speed/range/etc come
//    from the snapshot.
// ──────────────────────────────────────────────────────────────────────────
const UNIT_DEFAULTS: Record<UnitType, Pick<UnitStats, 'cantShootAfterMove' | 'attackBonusAgainst' | 'defenseBonusAgainst'>> = {
  warrior:       { cantShootAfterMove: false },
  archer:        { cantShootAfterMove: false },
  catapult:      { cantShootAfterMove: false },
  horserider:    { cantShootAfterMove: false },
  heavyknight:   { cantShootAfterMove: false },
  spearsman:     {
    cantShootAfterMove: false,
    attackBonusAgainst:  { horserider: 3.0, heavyknight: 4.0 },
    defenseBonusAgainst: { horserider: 3.0, heavyknight: 6.0 },
  },
  healer:        { cantShootAfterMove: false },
  damageBooster: { cantShootAfterMove: false },
  rangeBooster:  { cantShootAfterMove: false },
};

// ── Convert an API snapshot back into a (rendering-only) GameState. ──
// We don't reconstruct UI/selection fields (left empty) or per-turn state
// (spawnedTempleIds). Explored is populated lazily based on viewer.
function apiSnapshotToGameState(s: ApiSnapshot): GameState {
  const players: Player[] = s.players.map(p => ({
    id: p.id, name: p.name, color: p.color, aura: p.aura,
  }));

  const hills = new Set<string>();
  const walls = new Set<string>();
  const forests = new Set<string>();
  for (const [k, v] of Object.entries(s.map.terrain)) {
    if (v === 'hill') hills.add(k);
    else if (v === 'wall') walls.add(k);
    else if (v === 'forest') forests.add(k);
  }

  const temples: Temple[] = s.map.temples.map(t => ({
    id: t.id, pos: t.pos, ownerId: t.ownerId, level: t.level,
  }));

  const teleportBuildings: TeleportBuilding[] = s.map.teleportBuildings.map(tp => ({
    id: tp.id, pos: tp.pos, builtByPlayerId: tp.builtByPlayerId,
    templeId: tp.templeId, pairedId: tp.pairedId,
  }));

  const units: Unit[] = s.units.map(u => {
    const def = UNIT_DEFAULTS[u.type] ?? { cantShootAfterMove: false };
    const stats: UnitStats = {
      maxHp: u.maxHp,
      attack: u.stats.atk,
      defense: u.stats.def,
      speed: u.stats.spd,
      range: u.stats.rng,
      vision: u.stats.vision,
      splash: u.stats.splash,
      splashFactor: u.stats.splashFactor,
      canBeRevenged: u.stats.canBeRevenged,
      cantShootAfterMove: def.cantShootAfterMove,
    };
    if (def.attackBonusAgainst) stats.attackBonusAgainst = def.attackBonusAgainst;
    if (def.defenseBonusAgainst) stats.defenseBonusAgainst = def.defenseBonusAgainst;
    return {
      id: u.id, type: u.type, playerId: u.playerId, stats,
      hp: u.hp, pos: u.pos, hasMoved: u.hasMoved, hasAttacked: u.hasAttacked,
      hasCaptured: u.hasCaptured ?? false,
    };
  });

  // Explored: fully-populated for every map hex so that the renderer doesn't
  // black-out unexplored tiles regardless of view mode. For "P0/P1" view we
  // still rely on the renderer's per-player visibility calculation to apply
  // the dim overlay.
  const allHexes = generateHexMap(s.map.radius);
  const fullyExplored = new Set<string>(allHexes.map(h => hexKey(h)));

  const playerTech: PlayerTech[] = players.map((_, i) => {
    const entry = s.tech.find(t => t.playerId === i);
    return { researched: new Set<TechId>((entry?.researched ?? []) as TechId[]) };
  });

  // Winner — find full Player object by id.
  let winner: Player | null = null;
  if (s.winner) {
    winner = players.find(p => p.id === s.winner!.id) ?? null;
  }

  return {
    players, units, temples,
    hills, walls, forests,
    explored: players.map(() => new Set<string>(fullyExplored)),
    currentPlayerIndex: s.currentPlayer,
    // Replay viewer doesn't have direct access to who started first; assume 0
    // for legacy replays (pre-v2.2 always started P0). The turnNumber from the
    // snapshot is authoritative anyway.
    firstPlayerIndex: 0,
    phase: s.phase,
    mapRadius: s.map.radius,
    winner,
    turnNumber: s.turnNumber,
    selectedUnitId: null, selectedTempleId: null, selectionMode: null,
    moveHexes: [], attackHexes: [], supportHexes: [],
    spawnedTempleIds: new Set<string>(),
    playerTech,
    teleportBuildings,
    buildHexes: [],
  };
}

// ── Diff helpers for the sidebar info ──────────────────────────────────────

function describeAction(ev: ReplayEventDto): string {
  if (ev.action === 'new-game') return 'Game start';
  const p = ev.params as Record<string, unknown>;
  switch (ev.action) {
    case 'move': {
      const to = p.to as HexCoord | undefined;
      return `move ${String(p.unitId)} → (${to?.q ?? '?'},${to?.r ?? '?'})`;
    }
    case 'attack':
      return `attack ${String(p.unitId)} → ${String(p.targetId)}`;
    case 'recruit':
      return `recruit ${String(p.unitType)} at ${String(p.templeId)}`;
    case 'capture':
      return `capture w/ ${String(p.unitId)}`;
    case 'upgrade-temple':
      return `upgrade ${String(p.templeId)}`;
    case 'research':
      return `research ${String(p.techId)}`;
    case 'build-teleport':
      return `build teleport @ ${String(p.templeId)}`;
    case 'end-turn':
      return 'end turn';
    case 'resign':
      return 'resign';
    default:
      return ev.action;
  }
}

function summariseDiff(before: ApiSnapshot | null, after: ApiSnapshot | null): string {
  if (!before || !after) return '';
  const parts: string[] = [];

  // Aura diff for the acting player (or both, if it's an end-turn).
  for (const pa of after.players) {
    const pb = before.players.find(p => p.id === pa.id);
    if (!pb) continue;
    if (pa.aura !== pb.aura) {
      parts.push(`<span class="chg">P${pa.id} Aura ${pb.aura}→${pa.aura}</span>`);
    }
    if (pa.currentPop !== pb.currentPop) {
      parts.push(`<span class="chg">P${pa.id} Pop ${pb.currentPop}→${pa.currentPop}</span>`);
    }
  }

  // Unit births / deaths
  const beforeIds = new Set(before.units.map(u => u.id));
  const afterIds = new Set(after.units.map(u => u.id));
  for (const u of after.units) {
    if (!beforeIds.has(u.id)) {
      parts.push(`<span class="new">+${u.id} (${u.type}) @ (${u.pos.q},${u.pos.r})</span>`);
    }
  }
  for (const u of before.units) {
    if (!afterIds.has(u.id)) {
      parts.push(`<span class="del">−${u.id} (${u.type})</span>`);
    }
  }

  // Temple ownership changes
  for (const ta of after.map.temples) {
    const tb = before.map.temples.find(t => t.id === ta.id);
    if (!tb) continue;
    if (tb.ownerId !== ta.ownerId) {
      parts.push(`<span class="chg">${ta.id} owner ${tb.ownerId ?? 'neutral'}→${ta.ownerId ?? 'neutral'}</span>`);
    }
    if (tb.level !== ta.level) {
      parts.push(`<span class="chg">${ta.id} Lv ${tb.level}→${ta.level}</span>`);
    }
  }

  return parts.join(' &middot; ');
}

// ── Main ──

type FogMode = 0 | 1 | 'all';

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const gameId = params.get('gameId');

  const errorBox = document.getElementById('errorBox')!;
  const gameTitle = document.getElementById('gameTitle')!;
  const gameIdLabel = document.getElementById('gameIdLabel')!;
  const playersList = document.getElementById('playersList')!;
  const turnLine = document.getElementById('turnLine')!;
  const actionDesc = document.getElementById('actionDesc')!;
  const diffLine = document.getElementById('diffLine')!;
  const homeBtn = document.getElementById('homeBtn') as HTMLButtonElement;
  const endBtn = document.getElementById('endBtn') as HTMLButtonElement;
  const prevBtn = document.getElementById('prevBtn') as HTMLButtonElement;
  const nextBtn = document.getElementById('nextBtn') as HTMLButtonElement;
  const slider = document.getElementById('moveSlider') as HTMLInputElement;
  const seqLabel = document.getElementById('seqLabel')!;
  const canvas = document.getElementById('replayCanvas') as HTMLCanvasElement;
  const winnerSection = document.getElementById('winnerSection')!;
  const winnerBanner = document.getElementById('winnerBanner')!;
  const fog0 = document.getElementById('fog0')!;
  const fog1 = document.getElementById('fog1')!;
  const fogAll = document.getElementById('fogAll')!;

  if (!gameId) {
    errorBox.innerHTML = '<div class="error-banner">No <code>gameId</code> query param. Use <code>/replay?gameId=...</code>.</div>';
    return;
  }

  gameIdLabel.textContent = gameId;
  gameTitle.textContent = `Game Replay`;

  let replay: ReplayDto;
  try {
    const resp = await fetch(`${import.meta.env.BASE_URL}api/headless/${encodeURIComponent(gameId)}/replay`);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${resp.status}`);
    }
    const data = await resp.json() as { ok: boolean; replay: ReplayDto; error?: string };
    if (!data.ok) throw new Error(data.error ?? 'Unknown error');
    replay = data.replay;
  } catch (err) {
    errorBox.innerHTML = `<div class="error-banner">Failed to load replay: ${err instanceof Error ? err.message : String(err)}</div>`;
    return;
  }

  // ── Populate player list ──
  playersList.innerHTML = '';
  for (const p of replay.players) {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `<div class="swatch" style="background:${p.color}"></div><div>${escapeHtml(p.name)} <span style="color:#778;font-size:11px">(P${p.id})</span></div>`;
    playersList.appendChild(row);
  }

  // ── Build states[]: one GameState per event ──
  // For event[i] we render `stateBefore` of event[i+1] (i.e. the state AFTER
  // event[i] was applied), EXCEPT for the very first event where we show its
  // own `stateBefore` (the initial state). For the final event we render its
  // `stateAfter`.
  //
  // Mental model: index i corresponds to "world state after events[i] has
  // resolved". index 0 = initial state. index N = state after final event.
  const events = replay.events;
  const states: GameState[] = [];

  if (events.length === 0) {
    errorBox.innerHTML = '<div class="error-banner">Replay has no events.</div>';
    return;
  }

  // State 0 = initial state (stateBefore of new-game event)
  states.push(apiSnapshotToGameState(events[0]!.stateBefore));

  // For each subsequent event: state after it = its stateAfter (fallback to
  // next event's stateBefore if stateAfter is null, e.g. failed actions).
  for (let i = 1; i < events.length; i++) {
    const ev = events[i]!;
    const snap = ev.stateAfter ?? ev.stateBefore;
    states.push(apiSnapshotToGameState(snap));
  }

  // ── Renderer ──
  const renderer = new Renderer(canvas);
  renderer.init(replay.players.length > 0 ? states[0]!.mapRadius : 6);

  let index = 0;
  let fogMode: FogMode = 'all';

  slider.max = String(states.length - 1);
  slider.value = '0';

  // ── Winner banner ──
  const lastState = states[states.length - 1]!;
  if (lastState.phase === 'gameOver' && lastState.winner) {
    winnerSection.style.display = '';
    winnerBanner.textContent = `🏆 Winner: ${lastState.winner.name}`;
    winnerBanner.classList.remove('none');
  } else if (replay.finishedAt !== null) {
    winnerSection.style.display = '';
    winnerBanner.textContent = 'Game ended without a winner';
    winnerBanner.classList.add('none');
  }

  function render(): void {
    const state = states[index]!;
    const ev = events[index]!;

    // Sidebar info
    seqLabel.textContent = `${index} / ${states.length - 1}`;
    slider.value = String(index);

    const actingPlayerName = (() => {
      if (ev.playerId === -1) return '—';
      const p = replay.players.find(pl => pl.id === ev.playerId);
      return p?.name ?? `P${ev.playerId}`;
    })();
    turnLine.textContent = `Move ${ev.seq + 1}/${states.length} — Turn ${ev.turnNumber} — ${actingPlayerName}'s move`;

    const desc = describeAction(ev);
    actionDesc.textContent = desc + (ev.ok ? '' : `  ✗ ${ev.error ?? 'failed'}`);
    actionDesc.classList.toggle('failed', !ev.ok);

    diffLine.innerHTML = summariseDiff(ev.stateBefore, ev.stateAfter);

    // Renderer
    if (fogMode === 'all') {
      renderer.render(state, undefined, true);
    } else {
      renderer.render(state, fogMode);
    }

    // Button states
    prevBtn.disabled = index <= 0;
    homeBtn.disabled = index <= 0;
    nextBtn.disabled = index >= states.length - 1;
    endBtn.disabled = index >= states.length - 1;
  }

  function goTo(i: number): void {
    index = Math.max(0, Math.min(states.length - 1, i));
    render();
  }

  prevBtn.addEventListener('click', () => goTo(index - 1));
  nextBtn.addEventListener('click', () => goTo(index + 1));
  homeBtn.addEventListener('click', () => goTo(0));
  endBtn.addEventListener('click', () => goTo(states.length - 1));
  slider.addEventListener('input', () => goTo(parseInt(slider.value, 10)));

  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { goTo(index - 1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { goTo(index + 1); e.preventDefault(); }
    else if (e.key === 'Home') { goTo(0); e.preventDefault(); }
    else if (e.key === 'End') { goTo(states.length - 1); e.preventDefault(); }
  });

  // Fog toggle
  function setFog(mode: FogMode): void {
    fogMode = mode;
    fog0.classList.toggle('active', mode === 0);
    fog1.classList.toggle('active', mode === 1);
    fogAll.classList.toggle('active', mode === 'all');
    render();
  }
  fog0.addEventListener('click', () => setFog(0));
  fog1.addEventListener('click', () => setFog(1));
  fogAll.addEventListener('click', () => setFog('all'));

  // Resize handler
  window.addEventListener('resize', render);

  // First render
  render();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

main().catch(err => {
  console.error('Replay viewer fatal error:', err);
  const errorBox = document.getElementById('errorBox');
  if (errorBox) {
    errorBox.innerHTML = `<div class="error-banner">Fatal error: ${err instanceof Error ? err.message : String(err)}</div>`;
  }
});
