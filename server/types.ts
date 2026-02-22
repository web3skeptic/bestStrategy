// Re-export protocol types from src/protocol for server use
export type { ClientMessage, ServerMessage, RoomSummary } from '../src/protocol';

// ── Internal server-only types ──

import { WebSocket } from 'ws';
import { GameState } from '../src/types';

export interface ClientSession {
  ws: WebSocket;
  username: string | null;
  roomId: string | null;
  playerSlot: 0 | 1 | null;
}

export interface RoomState {
  id: string;
  status: 'open' | 'active' | 'done';
  sessions: [ClientSession | null, ClientSession | null]; // slot 0, slot 1
  state: GameState | null;
}
