// Shared WebSocket message protocol types (client + server)
import { HexCoord, UnitType, TechId } from './types';
import { SerializedGameState } from './serializer';

// ── Client → Server messages ──

export type ClientMessage =
  | { type: 'login';                username: string }
  | { type: 'create_room' }
  | { type: 'join_room';            roomId: string }
  | { type: 'list_rooms' }
  | { type: 'rejoin_room';          roomId: string }
  | { type: 'action_select_unit';   unitId: string }
  | { type: 'action_select_temple'; templeId: string }
  | { type: 'action_deselect' }
  | { type: 'action_move';          dest: HexCoord }
  | { type: 'action_attack';        targetPos: HexCoord }
  | { type: 'action_spawn';         templeId: string; unitType: UnitType }
  | { type: 'action_capture' }
  | { type: 'action_upgrade_temple'; templeId: string }
  | { type: 'action_research';      techId: TechId }
  | { type: 'action_build_teleport'; templeIdA: string; posA: HexCoord; posB: HexCoord }
  | { type: 'action_end_turn' }
  ;

// ── Server → Client messages ──

export interface RoomSummary {
  id: string;
  player1Name: string;
  status: 'open' | 'active' | 'done';
}

export type ServerMessage =
  | { type: 'logged_in';             username: string }
  | { type: 'error';                 message: string }
  | { type: 'room_created';          roomId: string }
  | { type: 'room_list';             rooms: RoomSummary[] }
  | { type: 'game_start';            playerSlot: 0 | 1; state: SerializedGameState }
  | { type: 'state_update';          state: SerializedGameState; lastAction: string }
  | { type: 'action_error';          message: string }
  | { type: 'opponent_disconnected' }
  | { type: 'opponent_reconnected' }
  ;
