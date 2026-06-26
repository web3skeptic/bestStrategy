import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'game.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname      TEXT UNIQUE NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS players (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id           TEXT PRIMARY KEY,
    status       TEXT NOT NULL DEFAULT 'open',
    player1_id   INTEGER NOT NULL REFERENCES players(id),
    player2_id   INTEGER REFERENCES players(id),
    winner_name  TEXT,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS game_states (
    room_id    TEXT PRIMARY KEY REFERENCES rooms(id),
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS game_replays (
    game_id      TEXT PRIMARY KEY,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch('now', 'subsec') * 1000),
    finished_at  INTEGER,
    player1_name TEXT NOT NULL,
    player2_name TEXT NOT NULL,
    winner_name  TEXT
  );

  CREATE TABLE IF NOT EXISTS replay_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id             TEXT NOT NULL REFERENCES game_replays(game_id),
    seq                 INTEGER NOT NULL,
    tick                INTEGER NOT NULL,
    turn_number         INTEGER NOT NULL,
    current_player      INTEGER NOT NULL,
    player_id           INTEGER NOT NULL,
    action              TEXT NOT NULL,
    params_json         TEXT NOT NULL DEFAULT '{}',
    state_before_json   TEXT NOT NULL,
    state_after_json    TEXT,
    action_log_json     TEXT NOT NULL DEFAULT '[]',
    ok                  INTEGER NOT NULL DEFAULT 1,
    error_msg           TEXT,
    timestamp_ms        INTEGER NOT NULL,
    UNIQUE(game_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_replay_events_game_seq
    ON replay_events(game_id, seq);
`);

// Re-export the underlying database instance so other modules
// (e.g. gameLogger) can issue their own prepared statements.
export { db };

// ── Player helpers ──

export function upsertPlayer(username: string): number {
  db.prepare(`INSERT OR IGNORE INTO players (username) VALUES (?)`).run(username);
  const row = db.prepare(`SELECT id FROM players WHERE username = ?`).get(username) as { id: number };
  return row.id;
}

// ── Room helpers ──

function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function createRoom(player1Id: number): string {
  let id: string;
  let tries = 0;
  do {
    id = generateRoomId();
    tries++;
    if (tries > 100) throw new Error('Could not generate unique room ID');
  } while (db.prepare(`SELECT id FROM rooms WHERE id = ?`).get(id));
  db.prepare(`INSERT INTO rooms (id, player1_id) VALUES (?, ?)`).run(id, player1Id);
  return id;
}

export function joinRoom(roomId: string, player2Id: number): boolean {
  const room = db.prepare(`SELECT status, player2_id FROM rooms WHERE id = ?`).get(roomId) as
    { status: string; player2_id: number | null } | undefined;
  if (!room || room.status !== 'open' || room.player2_id !== null) return false;
  db.prepare(`UPDATE rooms SET player2_id = ?, status = 'active', updated_at = unixepoch() WHERE id = ?`)
    .run(player2Id, roomId);
  return true;
}

export function setRoomStatus(roomId: string, status: 'open' | 'active' | 'done', winnerName?: string): void {
  db.prepare(`UPDATE rooms SET status = ?, winner_name = ?, updated_at = unixepoch() WHERE id = ?`)
    .run(status, winnerName ?? null, roomId);
}

export interface RoomRow {
  id: string;
  status: string;
  player1_id: number;
  player2_id: number | null;
  player1_name?: string;
}

export function getOpenRooms(): RoomRow[] {
  return db.prepare(`
    SELECT r.id, r.status, r.player1_id, r.player2_id, p.username as player1_name
    FROM rooms r
    JOIN players p ON p.id = r.player1_id
    WHERE r.status = 'open'
    ORDER BY r.created_at DESC
    LIMIT 20
  `).all() as RoomRow[];
}

export function getRoomById(roomId: string): RoomRow | undefined {
  return db.prepare(`
    SELECT r.id, r.status, r.player1_id, r.player2_id
    FROM rooms r WHERE r.id = ?
  `).get(roomId) as RoomRow | undefined;
}

// ── Game state persistence ──

export function saveGameState(roomId: string, stateJson: string): void {
  db.prepare(`
    INSERT INTO game_states (room_id, state_json, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(room_id) DO UPDATE SET state_json = excluded.state_json, updated_at = unixepoch()
  `).run(roomId, stateJson);
}

export function loadGameState(roomId: string): string | null {
  const row = db.prepare(`SELECT state_json FROM game_states WHERE room_id = ?`).get(roomId) as
    { state_json: string } | undefined;
  return row?.state_json ?? null;
}
