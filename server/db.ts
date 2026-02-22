import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'game.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
`);

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
