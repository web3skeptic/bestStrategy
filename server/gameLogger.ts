import type { HeadlessSession } from './headlessApi';
import { serializeStateForApi } from './headlessApi';
import { db } from './db';

// ── Types ──

export interface ReplayPlayer {
  id: number;
  name: string;
  color: string;
}

// GameSnapshot mirrors the shape of serializeStateForApi() with no viewerId
// (omniscient view, no fog-of-war). Kept loose because we cast the API
// serializer output directly into it.
export type GameSnapshot = Record<string, unknown>;

export interface ReplayEvent {
  seq: number;
  tick: number;
  turnNumber: number;
  currentPlayer: number;
  playerId: number;
  action: string;
  params: Record<string, unknown>;
  stateBefore: GameSnapshot;
  stateAfter: GameSnapshot | null;
  actionLog: string[];
  ok: boolean;
  error: string | null;
  timestamp: number;
}

export interface ReplayFile {
  gameId: string;
  createdAt: number;
  finishedAt: number | null;
  players: ReplayPlayer[];
  events: ReplayEvent[];
}

// ── Replay summary used by /api/headless/replays ──

export interface ReplaySummary {
  gameId: string;
  createdAt: number;
  finishedAt: number | null;
  player1Name: string;
  player2Name: string;
  winnerName: string | null;
  eventCount: number;
}

// ── Prepared statements (lazily compiled on first use) ──

const insertReplayStmt = db.prepare<[string, number, string, string]>(`
  INSERT INTO game_replays (game_id, created_at, player1_name, player2_name)
  VALUES (?, ?, ?, ?)
`);

const insertEventStmt = db.prepare(`
  INSERT INTO replay_events (
    game_id, seq, tick, turn_number, current_player, player_id, action,
    params_json, state_before_json, state_after_json, action_log_json,
    ok, error_msg, timestamp_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getMaxSeqStmt = db.prepare<[string]>(`
  SELECT MAX(seq) AS maxSeq FROM replay_events WHERE game_id = ?
`);

const getReplayHeaderStmt = db.prepare<[string]>(`
  SELECT game_id, created_at, finished_at, player1_name, player2_name, winner_name
    FROM game_replays WHERE game_id = ?
`);

const getEventsStmt = db.prepare<[string]>(`
  SELECT seq, tick, turn_number, current_player, player_id, action,
         params_json, state_before_json, state_after_json, action_log_json,
         ok, error_msg, timestamp_ms
    FROM replay_events
   WHERE game_id = ?
   ORDER BY seq ASC
`);

const updateFinalizeStmt = db.prepare<[number, string | null, string]>(`
  UPDATE game_replays
     SET finished_at = ?, winner_name = ?
   WHERE game_id = ?
`);

const replayExistsStmt = db.prepare<[string]>(`
  SELECT finished_at FROM game_replays WHERE game_id = ?
`);

const listReplaysStmt = db.prepare(`
  SELECT
    r.game_id      AS gameId,
    r.created_at   AS createdAt,
    r.finished_at  AS finishedAt,
    r.player1_name AS player1Name,
    r.player2_name AS player2Name,
    r.winner_name  AS winnerName,
    (SELECT COUNT(*) FROM replay_events e WHERE e.game_id = r.game_id) AS eventCount
  FROM game_replays r
  ORDER BY r.created_at DESC
`);

// ── Public API ──

export function initReplay(gameId: string, session: HeadlessSession): void {
  const now = Date.now();
  const state = session.gameState;

  const snapshot = serializeStateForApi(session) as GameSnapshot;

  const player1 = state.players[0];
  const player2 = state.players[1];
  if (!player1 || !player2) return;

  // Transaction so the header row + the seq=0 event land atomically.
  const tx = db.transaction(() => {
    insertReplayStmt.run(gameId, now, player1.name, player2.name);
    insertEventStmt.run(
      gameId,
      0,                                    // seq
      session.tick,                         // tick
      state.turnNumber,                     // turn_number
      state.currentPlayerIndex,             // current_player
      -1,                                   // player_id (new-game is system)
      'new-game',                           // action
      JSON.stringify({}),                   // params_json
      JSON.stringify(snapshot),             // state_before_json
      JSON.stringify(snapshot),             // state_after_json
      JSON.stringify(['Game created']),     // action_log_json
      1,                                    // ok
      null,                                 // error_msg
      now,                                  // timestamp_ms
    );
  });
  tx();
}

export function appendEvent(gameId: string, event: Omit<ReplayEvent, 'seq'>): void {
  const exists = replayExistsStmt.get(gameId);
  if (!exists) return; // defensive: no header row → no-op

  // Compute next seq + insert atomically so concurrent appends can't collide
  // on the UNIQUE(game_id, seq) constraint.
  const tx = db.transaction(() => {
    const row = getMaxSeqStmt.get(gameId) as { maxSeq: number | null } | undefined;
    const nextSeq = row && row.maxSeq !== null ? row.maxSeq + 1 : 0;

    insertEventStmt.run(
      gameId,
      nextSeq,
      event.tick,
      event.turnNumber,
      event.currentPlayer,
      event.playerId,
      event.action,
      JSON.stringify(event.params ?? {}),
      JSON.stringify(event.stateBefore ?? {}),
      event.stateAfter === null ? null : JSON.stringify(event.stateAfter),
      JSON.stringify(event.actionLog ?? []),
      event.ok ? 1 : 0,
      event.error ?? null,
      event.timestamp,
    );
  });
  tx();
}

export function finalizeReplay(gameId: string): void {
  const existing = replayExistsStmt.get(gameId) as { finished_at: number | null } | undefined;
  if (!existing) return;
  if (existing.finished_at !== null) return; // idempotent

  // Find the winner name from the last event's stateAfter.
  let winnerName: string | null = null;
  const lastEvent = db.prepare<[string]>(`
    SELECT state_after_json FROM replay_events
     WHERE game_id = ? AND state_after_json IS NOT NULL
     ORDER BY seq DESC LIMIT 1
  `).get(gameId) as { state_after_json: string } | undefined;

  if (lastEvent) {
    try {
      const parsed = JSON.parse(lastEvent.state_after_json) as { winner?: { name?: string } | null };
      if (parsed && parsed.winner && typeof parsed.winner.name === 'string') {
        winnerName = parsed.winner.name;
      }
    } catch {
      // ignore — keep winner null
    }
  }

  updateFinalizeStmt.run(Date.now(), winnerName, gameId);
}

interface ReplayEventRow {
  seq: number;
  tick: number;
  turn_number: number;
  current_player: number;
  player_id: number;
  action: string;
  params_json: string;
  state_before_json: string;
  state_after_json: string | null;
  action_log_json: string;
  ok: number;
  error_msg: string | null;
  timestamp_ms: number;
}

interface ReplayHeaderRow {
  game_id: string;
  created_at: number;
  finished_at: number | null;
  player1_name: string;
  player2_name: string;
  winner_name: string | null;
}

// Default colours used when the recorded snapshot doesn't carry one.
// Matches the colours used by serializeStateForApi → state.players[i].color
// but provides a safe fallback if the snapshot pre-dates colour storage.
const FALLBACK_COLORS = ['#ff4444', '#4488ff'];

export function readReplayFile(gameId: string): ReplayFile | null {
  const header = getReplayHeaderStmt.get(gameId) as ReplayHeaderRow | undefined;
  if (!header) return null;

  const eventRows = getEventsStmt.all(gameId) as ReplayEventRow[];

  // Extract player colours from the first event's stateBefore snapshot (the
  // serialised API state carries a `players` array including the colour). If
  // that's missing or malformed, fall back to hardcoded defaults.
  let p1Color = FALLBACK_COLORS[0]!;
  let p2Color = FALLBACK_COLORS[1]!;
  const first = eventRows.find(e => e.seq === 0);
  if (first) {
    try {
      const snap = JSON.parse(first.state_before_json) as {
        players?: { id: number; color?: string }[];
      };
      const sp0 = snap.players?.find(p => p.id === 0);
      const sp1 = snap.players?.find(p => p.id === 1);
      if (sp0?.color) p1Color = sp0.color;
      if (sp1?.color) p2Color = sp1.color;
    } catch {
      // ignore — use fallbacks
    }
  }

  const players: ReplayPlayer[] = [
    { id: 0, name: header.player1_name, color: p1Color },
    { id: 1, name: header.player2_name, color: p2Color },
  ];

  const events: ReplayEvent[] = eventRows.map(row => ({
    seq: row.seq,
    tick: row.tick,
    turnNumber: row.turn_number,
    currentPlayer: row.current_player,
    playerId: row.player_id,
    action: row.action,
    params: safeParse<Record<string, unknown>>(row.params_json, {}),
    stateBefore: safeParse<GameSnapshot>(row.state_before_json, {}),
    stateAfter: row.state_after_json === null
      ? null
      : safeParse<GameSnapshot>(row.state_after_json, {}),
    actionLog: safeParse<string[]>(row.action_log_json, []),
    ok: !!row.ok,
    error: row.error_msg,
    timestamp: row.timestamp_ms,
  }));

  return {
    gameId: header.game_id,
    createdAt: header.created_at,
    finishedAt: header.finished_at,
    players,
    events,
  };
}

export function listReplays(): ReplaySummary[] {
  const rows = listReplaysStmt.all() as Array<{
    gameId: string;
    createdAt: number;
    finishedAt: number | null;
    player1Name: string;
    player2Name: string;
    winnerName: string | null;
    eventCount: number;
  }>;
  return rows;
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
