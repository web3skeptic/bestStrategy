// Re-export protocol types from src/protocol for server use
export type { ClientMessage, ServerMessage, RoomSummary } from '../src/protocol';

// ── Internal server-only types ──

import { WebSocket } from 'ws';
import { GameState } from '../src/types';

export interface ClientSession {
  ws: WebSocket;
  username: string | null;
  roomId: string | null;
  playerSlot: number | null;
  isSpectator: boolean;
}

export interface RoomState {
  id: string;
  status: 'open' | 'active' | 'done';
  // One entry per player slot (length === expectedPlayers). A null entry is an
  // empty/disconnected seat awaiting a (re)join.
  sessions: (ClientSession | null)[];
  // How many players the room waits for before the game starts.
  expectedPlayers: number;
  // Username claimed by each slot (survives a disconnect so rejoin can map a
  // reconnecting user back to their slot even for N>2, where the DB only tracks
  // the first two players).
  playerNames: (string | null)[];
  spectators: ClientSession[];
  state: GameState | null;
}
