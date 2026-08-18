// Shared WebSocket message protocol types (client + server)
import { HexCoord, UnitType, TechId } from './types';
import { SerializedGameState } from './serializer';

// Unified action name vocabulary (matches the REST headless API).
// Mirrors actionDispatcher.UnifiedActionName but is duplicated here so the
// client bundle doesn't pull in server-only modules.
export type UnifiedActionName =
  | 'move'
  | 'attack'
  | 'recruit'
  | 'capture'
  | 'destroy'
  | 'upgrade-temple'
  | 'research'
  | 'build-teleport'
  | 'end-turn'
  | 'resign';

// ── Client → Server messages ──

export type ClientMessage =
  | { type: 'login';                username: string }
  // expectedPlayers: how many players the room waits for before starting (2..6).
  // Omitted / undefined → 2, preserving the classic 2-player room behaviour.
  | { type: 'create_room';          expectedPlayers?: number }
  | { type: 'join_room';            roomId: string }
  | { type: 'list_rooms' }
  | { type: 'rejoin_room';          roomId: string }
  | { type: 'list_games' }
  | { type: 'spectate';             gameId: string }
  | { type: 'action_select_unit';   unitId: string }
  | { type: 'action_select_temple'; templeId: string }
  | { type: 'action_deselect' }
  | { type: 'action_move';          dest: HexCoord }
  | { type: 'action_attack';        targetPos: HexCoord }
  | { type: 'action_spawn';         templeId: string; unitType: UnitType }
  | { type: 'action_capture' }
  // Disband an owned unit. Carries unitId explicitly (unlike capture, which
  // relies on server-side selection) so the remote destroys the SAME unit.
  | { type: 'action_destroy';       unitId: string }
  | { type: 'action_upgrade_temple'; templeId: string }
  | { type: 'action_research';      techId: TechId }
  | { type: 'action_build_teleport'; templeIdA: string; posA: HexCoord; posB: HexCoord }
  | { type: 'action_end_turn' }
  | { type: 'action_resign' }
  // Unified action shape — accepted by the server alongside the legacy
  // `action_*` family. Bots / agents should prefer this since it uses the
  // same vocabulary as the REST headless API.
  | { type: 'action';               action: UnifiedActionName; params?: Record<string, unknown> }
  // Read-only queries for agent ergonomics.
  | { type: 'request_legal_moves';  unitId?: string }   // omit unitId → all units
  | { type: 'request_rules' }
  ;

// ── Server → Client messages ──

export interface RoomSummary {
  id: string;
  player1Name: string;
  status: 'open' | 'active' | 'done';
  /** How many players the room is waiting for, and how many have joined. */
  expectedPlayers: number;
  joinedPlayers: number;
}

export interface ActiveGameSummary {
  gameId: string;
  player1Name: string;
  player2Name: string;
  turnNumber: number;
  currentPlayerName: string;
  status: 'active' | 'done';
  spectatorCount: number;
}

export type ServerMessage =
  | { type: 'logged_in';             username: string }
  | { type: 'error';                 message: string }
  | { type: 'room_created';          roomId: string; expectedPlayers: number }
  // Sent to a player who has joined a not-yet-full room, and (as a progress
  // ping) to everyone in the room whenever the joined count changes.
  | { type: 'room_waiting';          roomId: string; joined: number; expected: number }
  | { type: 'room_list';             rooms: RoomSummary[] }
  | { type: 'game_list';             games: ActiveGameSummary[] }
  | { type: 'game_start';            playerSlot: number; state: SerializedGameState }
  | { type: 'spectate_start';        state: SerializedGameState; player1Name: string; player2Name: string }
  | { type: 'state_update';          state: SerializedGameState; lastAction: string }
  // action_error now optionally carries legalMoves so agents can recover from
  // bad actions without polling. The field is additive — existing FE clients
  // that ignore unknown keys are unaffected.
  | { type: 'action_error';          message: string; legalMoves?: Record<string, unknown> }
  | { type: 'opponent_disconnected' }
  | { type: 'opponent_reconnected' }
  // Replies to the read-only query messages.
  | { type: 'legal_moves';           unitId: string | null; actions: Record<string, unknown>[]; legalMoves: Record<string, unknown> | null }
  | { type: 'rules';                 rules: Record<string, unknown> }
  ;
