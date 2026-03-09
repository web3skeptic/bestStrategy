import { WebSocket } from 'ws';
import { ClientSession, RoomState } from './types';
import { ClientMessage, ServerMessage, RoomSummary } from '../src/protocol';
import {
  upsertPlayer, createRoom, joinRoom, setRoomStatus,
  getOpenRooms, getRoomById, saveGameState, loadGameState,
} from './db';
import { serialize, deserialize, SerializedGameState } from '../src/serializer';
import { createGameState, resetCounters, selectUnit, selectTemple, deselectAll, moveUnit, attackUnit, canCaptureTemple, captureTemple, spawnUnit, endTurn, upgradeTemple, researchTech, buildTeleportPair } from '../src/game';
import { GameState } from '../src/types';

// ── In-memory session/room store ──

const sessions = new Map<WebSocket, ClientSession>();
const rooms    = new Map<string, RoomState>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(room: RoomState, msg: ServerMessage): void {
  for (const sess of room.sessions) {
    if (sess) send(sess.ws, msg);
  }
}

function getSession(ws: WebSocket): ClientSession {
  let sess = sessions.get(ws);
  if (!sess) {
    sess = { ws, username: null, roomId: null, playerSlot: null };
    sessions.set(ws, sess);
  }
  return sess;
}

// ── Counter resync after deserialize ──

function resyncCounters(state: GameState): void {
  let unitMax = 0, templeMax = 0, tpMax = 0;
  for (const u of state.units) {
    const n = parseInt(u.id.replace('unit_', ''), 10);
    if (!isNaN(n) && n >= unitMax) unitMax = n + 1;
  }
  for (const t of state.temples) {
    const n = parseInt(t.id.replace('temple_', ''), 10);
    if (!isNaN(n) && n >= templeMax) templeMax = n + 1;
  }
  for (const tp of state.teleportBuildings) {
    const n = parseInt(tp.id.replace('tp_', ''), 10);
    if (!isNaN(n) && n >= tpMax) tpMax = n + 1;
  }
  resetCounters(unitMax, templeMax, tpMax);
}

// ── Push state update ──
// toAll=true  → broadcast to both players (used on end_turn and game_over)
// toAll=false → send only to the acting player (intermediate actions)

// Strip selection/move highlight state — sent to the non-acting player
// so they never see the opponent's in-progress selections or move hexes.
function stripSelectionState(s: ReturnType<typeof serialize>): ReturnType<typeof serialize> {
  return {
    ...s,
    selectedUnitId: null,
    selectedTempleId: null,
    selectionMode: null,
    moveHexes: [],
    attackHexes: [],
    supportHexes: [],
    buildHexes: [],
  };
}

function pushStateUpdate(room: RoomState, lastAction: string, actingSlot: 0 | 1, toAll: boolean): void {
  const serialized = serialize(room.state!);
  const gameOver = room.state!.phase === 'gameOver';

  if (toAll || gameOver) {
    // Send each player their own view: acting player sees full state,
    // opponent sees state with selection stripped.
    const strippedForOpponent = stripSelectionState(serialized);
    for (let slot = 0; slot < room.sessions.length; slot++) {
      const sess = room.sessions[slot];
      if (!sess) continue;
      const payload = slot === actingSlot ? serialized : strippedForOpponent;
      send(sess.ws, { type: 'state_update', state: payload, lastAction });
    }
  } else {
    const actingSess = room.sessions[actingSlot];
    if (actingSess) send(actingSess.ws, { type: 'state_update', state: serialized, lastAction });
  }

  saveGameState(room.id, JSON.stringify(serialized));

  if (gameOver) {
    setRoomStatus(room.id, 'done', room.state!.winner?.name ?? undefined);
    room.status = 'done';
  }
}

// ── Handle incoming messages ──

export function handleConnect(ws: WebSocket): void {
  getSession(ws);
}

export function handleDisconnect(ws: WebSocket): void {
  const sess = sessions.get(ws);
  if (sess?.roomId) {
    const room = rooms.get(sess.roomId);
    if (room) {
      const other = room.sessions[sess.playerSlot === 0 ? 1 : 0];
      if (other) send(other.ws, { type: 'opponent_disconnected' });
      // Keep room in memory for rejoin; nullify the slot
      room.sessions[sess.playerSlot!] = null;
    }
  }
  sessions.delete(ws);
}

export function handleMessage(ws: WebSocket, raw: string): void {
  let msg: ClientMessage;
  try { msg = JSON.parse(raw); } catch { return; }

  const sess = getSession(ws);

  switch (msg.type) {
    case 'login': return handleLogin(sess, msg.username);
    case 'create_room': return handleCreateRoom(sess);
    case 'join_room': return handleJoinRoom(sess, msg.roomId);
    case 'list_rooms': return handleListRooms(sess);
    case 'rejoin_room': return handleRejoinRoom(sess, msg.roomId);
    default: return handleAction(sess, msg);
  }
}

function handleLogin(sess: ClientSession, username: string): void {
  if (!username || username.length < 1 || username.length > 24) {
    send(sess.ws, { type: 'error', message: 'Invalid username (1-24 chars)' });
    return;
  }
  upsertPlayer(username);
  sess.username = username;
  send(sess.ws, { type: 'logged_in', username });
}

function handleCreateRoom(sess: ClientSession): void {
  if (!sess.username) { send(sess.ws, { type: 'error', message: 'Login first' }); return; }
  const playerId = upsertPlayer(sess.username);
  const roomId = createRoom(playerId);
  const room: RoomState = {
    id: roomId,
    status: 'open',
    sessions: [sess, null],
    state: null,
  };
  rooms.set(roomId, room);
  sess.roomId = roomId;
  sess.playerSlot = 0;
  send(sess.ws, { type: 'room_created', roomId });
}

function handleJoinRoom(sess: ClientSession, roomId: string): void {
  if (!sess.username) { send(sess.ws, { type: 'error', message: 'Login first' }); return; }
  const dbRoom = getRoomById(roomId);
  if (!dbRoom || dbRoom.status !== 'open') {
    send(sess.ws, { type: 'error', message: 'Room not found or already started' });
    return;
  }
  const playerId = upsertPlayer(sess.username);
  if (!joinRoom(roomId, playerId)) {
    send(sess.ws, { type: 'error', message: 'Could not join room' });
    return;
  }

  let room = rooms.get(roomId);
  if (!room) {
    room = { id: roomId, status: 'active', sessions: [null, null], state: null };
    rooms.set(roomId, room);
  }
  room.sessions[1] = sess;
  room.status = 'active';
  sess.roomId = roomId;
  sess.playerSlot = 1;

  // Create game state
  const player1Name = room.sessions[0]?.username ?? 'Player 1';
  const player2Name = sess.username!;
  const gameState = createGameState([
    { name: player1Name, color: '#ff4444' },
    { name: player2Name, color: '#4488ff' },
  ]);
  room.state = gameState;

  const serialized = serialize(gameState);
  saveGameState(roomId, JSON.stringify(serialized));

  // Send game_start to each player with their slot
  if (room.sessions[0]) send(room.sessions[0].ws, { type: 'game_start', playerSlot: 0, state: serialized });
  send(sess.ws, { type: 'game_start', playerSlot: 1, state: serialized });
}

function handleListRooms(sess: ClientSession): void {
  const rows = getOpenRooms();
  const roomList: RoomSummary[] = rows.map(r => ({
    id: r.id,
    player1Name: r.player1_name ?? 'Unknown',
    status: r.status as 'open',
  }));
  send(sess.ws, { type: 'room_list', rooms: roomList });
}

function handleRejoinRoom(sess: ClientSession, roomId: string): void {
  if (!sess.username) { send(sess.ws, { type: 'error', message: 'Login first' }); return; }

  const dbRoom = getRoomById(roomId);
  if (!dbRoom) { send(sess.ws, { type: 'error', message: 'Room not found' }); return; }

  let room = rooms.get(roomId);

  // Determine slot
  const playerId = upsertPlayer(sess.username);
  let slot: 0 | 1 | null = null;
  if (dbRoom.player1_id === playerId) slot = 0;
  else if (dbRoom.player2_id === playerId) slot = 1;
  if (slot === null) { send(sess.ws, { type: 'error', message: 'Not a player in this room' }); return; }

  if (!room) {
    room = { id: roomId, status: dbRoom.status as 'open' | 'active' | 'done', sessions: [null, null], state: null };
    rooms.set(roomId, room);
  }

  // Restore state from DB if not in memory
  if (!room.state) {
    const savedJson = loadGameState(roomId);
    if (savedJson) {
      const parsed = JSON.parse(savedJson) as SerializedGameState;
      room.state = deserialize(parsed);
      resyncCounters(room.state);
    }
  }

  room.sessions[slot] = sess;
  sess.roomId = roomId;
  sess.playerSlot = slot;

  if (room.state) {
    const currentTurnSlot = room.state.currentPlayerIndex as 0 | 1;
    const serialized = serialize(room.state);
    // If rejoining player is NOT the acting player, strip selections so they
    // cannot see the opponent's in-progress moves from the saved state.
    const payload = slot === currentTurnSlot ? serialized : stripSelectionState(serialized);
    send(sess.ws, { type: 'game_start', playerSlot: slot, state: payload });
    const other = room.sessions[slot === 0 ? 1 : 0];
    if (other) send(other.ws, { type: 'opponent_reconnected' });
  }
}

function handleAction(sess: ClientSession, msg: ClientMessage): void {
  if (!sess.roomId || sess.playerSlot === null) {
    send(sess.ws, { type: 'action_error', message: 'Not in a room' });
    return;
  }
  const room = rooms.get(sess.roomId);
  if (!room || !room.state) {
    send(sess.ws, { type: 'action_error', message: 'Game not started' });
    return;
  }

  // Turn guard
  if (room.state.currentPlayerIndex !== sess.playerSlot) {
    send(sess.ws, { type: 'action_error', message: 'Not your turn' });
    return;
  }

  const state = room.state;
  let lastAction: string = msg.type;

  switch (msg.type) {
    case 'action_select_unit':
      selectUnit(state, msg.unitId);
      break;
    case 'action_select_temple':
      selectTemple(state, msg.templeId);
      break;
    case 'action_deselect':
      deselectAll(state);
      break;
    case 'action_move': {
      const result = moveUnit(state, msg.dest);
      if (!result.moved) { send(sess.ws, { type: 'action_error', message: 'Invalid move' }); return; }
      lastAction = `move to (${msg.dest.q},${msg.dest.r})`;
      break;
    }
    case 'action_attack': {
      const result = attackUnit(state, msg.targetPos);
      if (!result) { send(sess.ws, { type: 'action_error', message: 'Invalid attack' }); return; }
      lastAction = `attack at (${msg.targetPos.q},${msg.targetPos.r}) — ${result.damageDealt} dmg`;
      break;
    }
    case 'action_spawn': {
      const ok = spawnUnit(state, msg.templeId, msg.unitType);
      if (!ok) { send(sess.ws, { type: 'action_error', message: 'Cannot spawn unit' }); return; }
      lastAction = `spawn ${msg.unitType}`;
      break;
    }
    case 'action_capture': {
      const unit = state.units.find(u => u.id === state.selectedUnitId);
      if (!unit) { send(sess.ws, { type: 'action_error', message: 'No unit selected' }); return; }
      const temple = canCaptureTemple(state, unit);
      if (!temple) { send(sess.ws, { type: 'action_error', message: 'Cannot capture' }); return; }
      captureTemple(state, unit, temple);
      lastAction = `capture temple`;
      break;
    }
    case 'action_upgrade_temple': {
      const ok = upgradeTemple(state, msg.templeId);
      if (!ok) { send(sess.ws, { type: 'action_error', message: 'Cannot upgrade' }); return; }
      lastAction = `upgrade temple`;
      break;
    }
    case 'action_research': {
      const ok = researchTech(state, msg.techId);
      if (!ok) { send(sess.ws, { type: 'action_error', message: 'Cannot research' }); return; }
      lastAction = `research ${msg.techId}`;
      break;
    }
    case 'action_build_teleport': {
      const ok = buildTeleportPair(state, msg.templeIdA, msg.posA, msg.posB);
      if (!ok) { send(sess.ws, { type: 'action_error', message: 'Cannot build teleport' }); return; }
      lastAction = `build teleport pair`;
      break;
    }
    case 'action_end_turn': {
      endTurn(state);
      lastAction = `end turn`;
      pushStateUpdate(room, lastAction, sess.playerSlot, true); // broadcast to both
      return;
    }
    default:
      send(sess.ws, { type: 'action_error', message: 'Unknown action' });
      return;
  }

  // Intermediate action: only send back to the acting player
  pushStateUpdate(room, lastAction, sess.playerSlot, false);
}
