import { WebSocket } from 'ws';
import { ClientSession, RoomState } from './types';
import { ClientMessage, ServerMessage, RoomSummary, ActiveGameSummary } from '../src/protocol';
import {
  upsertPlayer, createRoom, joinRoom, setRoomStatus,
  getOpenRooms, getRoomById, saveGameState, loadGameState,
} from './db';
import { serialize, deserialize, SerializedGameState } from '../src/serializer';
import { createGameState, selectUnit, selectTemple, deselectAll } from '../src/game';
import { GameState, HexCoord, UnitType, TechId } from '../src/types';
import { headlessSessions, setHeadlessSpectatorPush } from './headlessApi';
import { resyncCounters } from './stateUtils';
import {
  executeAction,
  UnifiedActionName,
  computeUnitActions,
  computePlayerLegalMoves,
  buildRulesPayload,
} from './actionDispatcher';

// ── In-memory session/room store ──

const sessions = new Map<WebSocket, ClientSession>();
const rooms    = new Map<string, RoomState>();
const hlSpectators = new Map<string, ClientSession[]>();

// ── Push state updates to headless spectators ──

export function pushHeadlessStateUpdate(gameId: string): void {
  const specs = hlSpectators.get(gameId);
  if (!specs || specs.length === 0) return;
  const hl = headlessSessions.get(gameId);
  if (!hl) return;
  const serialized = serialize(hl.gameState);
  const strippedState = stripSelectionState(serialized);
  for (const spec of specs) {
    send(spec.ws, { type: 'state_update', state: strippedState, lastAction: '' });
  }
}

// Register spectator push callback with headlessApi
setHeadlessSpectatorPush(pushHeadlessStateUpdate);

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

function broadcastToSpectators(room: RoomState, msg: ServerMessage): void {
  for (const spec of room.spectators) {
    send(spec.ws, msg);
  }
}

function getSession(ws: WebSocket): ClientSession {
  let sess = sessions.get(ws);
  if (!sess) {
    sess = { ws, username: null, roomId: null, playerSlot: null, isSpectator: false };
    sessions.set(ws, sess);
  }
  return sess;
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

  // Always send full (stripped) state to spectators on any broadcast
  const spectatorState = stripSelectionState(serialized);
  broadcastToSpectators(room, { type: 'state_update', state: spectatorState, lastAction });

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
      if (sess.isSpectator) {
        // Remove spectator from room
        room.spectators = room.spectators.filter(s => s.ws !== ws);
      } else {
        const other = room.sessions[sess.playerSlot === 0 ? 1 : 0];
        if (other) send(other.ws, { type: 'opponent_disconnected' });
        // Keep room in memory for rejoin; nullify the slot
        room.sessions[sess.playerSlot!] = null;
      }
    }
  }
  // Headless spectators live in hlSpectators (keyed by headless gameId), not in
  // `rooms`, so the cleanup above never reaches them. Remove this ws from any
  // headless spectator list it appears in.
  for (const [gameId, specs] of hlSpectators) {
    const filtered = specs.filter(s => s.ws !== ws);
    if (filtered.length !== specs.length) hlSpectators.set(gameId, filtered);
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
    case 'list_games': return handleListGames(sess);
    case 'spectate': return handleSpectate(sess, msg.gameId);
    case 'request_legal_moves': return handleLegalMovesQuery(sess, msg.unitId);
    case 'request_rules': return handleRulesQuery(sess);
    default: return handleAction(sess, msg);
  }
}

// ── Read-only queries (no state mutation, no broadcast) ──

function handleLegalMovesQuery(sess: ClientSession, unitId: string | undefined): void {
  if (!sess.roomId || sess.playerSlot === null) {
    send(sess.ws, { type: 'action_error', message: 'Not in a room' });
    return;
  }
  const room = rooms.get(sess.roomId);
  if (!room || !room.state) {
    send(sess.ws, { type: 'action_error', message: 'Game not started' });
    return;
  }
  const state = room.state;
  if (unitId) {
    // Per-unit query: only allowed for the requester's own unit.
    const unit = state.units.find(u => u.id === unitId && u.hp > 0);
    if (!unit) {
      send(sess.ws, { type: 'legal_moves', unitId, actions: [], legalMoves: null });
      return;
    }
    if (unit.playerId !== sess.playerSlot) {
      send(sess.ws, { type: 'action_error', message: 'Cannot query legal moves for opponent unit' });
      return;
    }
    const actions = computeUnitActions(state, unit) as unknown as Record<string, unknown>[];
    send(sess.ws, { type: 'legal_moves', unitId, actions, legalMoves: null });
    return;
  }
  // Whole-player query.
  const legalMoves = computePlayerLegalMoves(state, sess.playerSlot) as unknown as Record<string, unknown>;
  send(sess.ws, { type: 'legal_moves', unitId: null, actions: [], legalMoves });
}

function handleRulesQuery(sess: ClientSession): void {
  send(sess.ws, { type: 'rules', rules: buildRulesPayload() });
}

function handleLogin(sess: ClientSession, username: string): void {
  if (!username || username.length < 1 || username.length > 24) {
    send(sess.ws, { type: 'error', message: 'Invalid username (1-24 chars)' });
    return;
  }
  // Reject a name that another live session is already using. Without this two
  // clients can log in as the same identity, which maps to one DB player id and
  // corrupts room slot detection (both resolve to player1). A disconnect clears
  // the old session (see handleDisconnect), so reconnecting under the same name
  // still works.
  for (const other of sessions.values()) {
    if (other !== sess && other.username === username) {
      send(sess.ws, { type: 'error', message: 'Username already taken — pick another' });
      return;
    }
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
    spectators: [],
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
    room = { id: roomId, status: 'active', sessions: [null, null], spectators: [], state: null };
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
    room = { id: roomId, status: dbRoom.status as 'open' | 'active' | 'done', sessions: [null, null], spectators: [], state: null };
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

// ── List active games (for spectator lobby) ──

// Single source of truth for the active-games summary, built from both the
// live PvP rooms and the headless sessions. Used by the WS list_games handler
// and the REST getter below.
function buildActiveGames(): ActiveGameSummary[] {
  const games: ActiveGameSummary[] = [];
  for (const [id, room] of rooms) {
    if (!room.state || room.status === 'open') continue;
    const p1 = room.state.players[0];
    const p2 = room.state.players[1];
    const currentPlayer = room.state.players[room.state.currentPlayerIndex];
    games.push({
      gameId: id,
      player1Name: p1?.name ?? 'Player 1',
      player2Name: p2?.name ?? 'Player 2',
      turnNumber: room.state.turnNumber,
      currentPlayerName: currentPlayer?.name ?? '?',
      status: room.status as 'active' | 'done',
      spectatorCount: room.spectators.length,
    });
  }
  for (const [id, hl] of headlessSessions) {
    const p1 = hl.gameState.players[0];
    const p2 = hl.gameState.players[1];
    const currentPlayer = hl.gameState.players[hl.gameState.currentPlayerIndex];
    games.push({
      gameId: id,
      player1Name: p1?.name ?? 'Player 1',
      player2Name: p2?.name ?? 'Player 2',
      turnNumber: hl.gameState.turnNumber,
      currentPlayerName: currentPlayer?.name ?? '?',
      status: hl.gameState.phase === 'gameOver' ? 'done' : 'active',
      spectatorCount: 0,
    });
  }
  return games;
}

function handleListGames(sess: ClientSession): void {
  send(sess.ws, { type: 'game_list', games: buildActiveGames() });
}

// ── Public getter for REST API ──

export function getActiveGames(): ActiveGameSummary[] {
  return buildActiveGames();
}

// ── Spectate a game ──

function handleSpectate(sess: ClientSession, gameId: string): void {
  if (!sess.username) { send(sess.ws, { type: 'error', message: 'Login first' }); return; }

  // Check headless games first
  const hl = headlessSessions.get(gameId);
  if (hl) {
    // Remove from old room if any
    if (sess.roomId) {
      const oldRoom = rooms.get(sess.roomId);
      if (oldRoom && sess.isSpectator) {
        oldRoom.spectators = oldRoom.spectators.filter(s => s.ws !== sess.ws);
      }
    }
    sess.roomId = gameId;
    sess.playerSlot = null;
    sess.isSpectator = true;
    // Store in a special headless spectators list (guard against duplicates)
    if (!hlSpectators.has(gameId)) hlSpectators.set(gameId, []);
    const hlList = hlSpectators.get(gameId)!;
    if (!hlList.includes(sess)) hlList.push(sess);

    const serialized = serialize(hl.gameState);
    const strippedState = stripSelectionState(serialized);
    send(sess.ws, {
      type: 'spectate_start',
      state: strippedState,
      player1Name: hl.gameState.players[0]?.name ?? 'Player 1',
      player2Name: hl.gameState.players[1]?.name ?? 'Player 2',
    });
    return;
  }

  const room = rooms.get(gameId);
  if (!room || !room.state) {
    send(sess.ws, { type: 'error', message: 'Game not found' });
    return;
  }

  // If already spectating another room, remove from old room
  if (sess.roomId) {
    const oldRoom = rooms.get(sess.roomId);
    if (oldRoom && sess.isSpectator) {
      oldRoom.spectators = oldRoom.spectators.filter(s => s.ws !== sess.ws);
    }
  }

  sess.roomId = gameId;
  sess.playerSlot = null;
  sess.isSpectator = true;
  if (!room.spectators.includes(sess)) room.spectators.push(sess);

  const serialized = serialize(room.state);
  const strippedState = stripSelectionState(serialized);

  send(sess.ws, {
    type: 'spectate_start',
    state: strippedState,
    player1Name: room.state.players[0]?.name ?? 'Player 1',
    player2Name: room.state.players[1]?.name ?? 'Player 2',
  });
}

// ── Map a legacy WS message into a unified-dispatcher action ──
// Returns null if the message is UI-only (select/deselect — handled separately).
// Returns { error } if the legacy params are malformed (missing/ill-shaped
// required fields) so the caller can surface an action_error instead of letting
// a TypeError throw out of the handler.
type LegacyMapResult =
  | { action: UnifiedActionName; params: Record<string, unknown> }
  | { error: string }
  | null;

// A HexCoord is valid when it has numeric q and r.
function isHexCoord(v: unknown): v is HexCoord {
  return typeof v === 'object' && v !== null
    && typeof (v as { q?: unknown }).q === 'number'
    && typeof (v as { r?: unknown }).r === 'number';
}

function legacyToUnified(
  state: GameState,
  msg: ClientMessage,
): LegacyMapResult {
  switch (msg.type) {
    case 'action_move':
      if (!isHexCoord(msg.dest)) return { error: 'Invalid move: missing destination hex' };
      return { action: 'move', params: { unitId: state.selectedUnitId, to: msg.dest } };
    case 'action_attack': {
      if (!isHexCoord(msg.targetPos)) return { error: 'Invalid attack: missing target position' };
      // Legacy carries targetPos; dispatcher wants targetId. Resolve here so
      // the dispatcher contract stays uniform.
      const target = state.units.find(u => u.hp > 0 && u.pos.q === msg.targetPos.q && u.pos.r === msg.targetPos.r);
      return { action: 'attack', params: { unitId: state.selectedUnitId, targetId: target?.id } };
    }
    case 'action_spawn':
      if (typeof msg.unitType !== 'string') return { error: 'Invalid spawn: missing unitType' };
      if (typeof msg.templeId !== 'string') return { error: 'Invalid spawn: missing templeId' };
      return { action: 'recruit', params: { unitType: msg.unitType, templeId: msg.templeId } };
    case 'action_capture':
      // Uses current selection; dispatcher will fall back to state.selectedUnitId.
      return { action: 'capture', params: {} };
    case 'action_upgrade_temple':
      if (typeof msg.templeId !== 'string') return { error: 'Invalid upgrade: missing templeId' };
      return { action: 'upgrade-temple', params: { templeId: msg.templeId } };
    case 'action_research':
      if (typeof msg.techId !== 'string') return { error: 'Invalid research: missing techId' };
      return { action: 'research', params: { techId: msg.techId } };
    case 'action_build_teleport':
      if (typeof msg.templeIdA !== 'string') return { error: 'Invalid build-teleport: missing templeId' };
      if (!isHexCoord(msg.posA) || !isHexCoord(msg.posB)) return { error: 'Invalid build-teleport: missing position(s)' };
      return { action: 'build-teleport', params: { templeId: msg.templeIdA, pos: msg.posA, targetPos: msg.posB } };
    case 'action_end_turn':
      return { action: 'end-turn', params: {} };
    case 'action_resign':
      return { action: 'resign', params: {} };
    default:
      return null;
  }
}

function handleAction(sess: ClientSession, msg: ClientMessage): void {
  if (sess.isSpectator) {
    send(sess.ws, { type: 'action_error', message: 'Spectators cannot perform actions' });
    return;
  }
  if (!sess.roomId || sess.playerSlot === null) {
    send(sess.ws, { type: 'action_error', message: 'Not in a room' });
    return;
  }
  const room = rooms.get(sess.roomId);
  if (!room || !room.state) {
    send(sess.ws, { type: 'action_error', message: 'Game not started' });
    return;
  }
  const state = room.state;

  // ── UI-only selection messages: not game-state mutations, so they don't
  // broadcast to the opponent. Don't even need to run through the dispatcher.
  if (msg.type === 'action_select_unit') {
    if (state.currentPlayerIndex !== sess.playerSlot) {
      send(sess.ws, { type: 'action_error', message: 'Not your turn' });
      return;
    }
    selectUnit(state, msg.unitId);
    pushStateUpdate(room, msg.type, sess.playerSlot, false);
    return;
  }
  if (msg.type === 'action_select_temple') {
    if (state.currentPlayerIndex !== sess.playerSlot) {
      send(sess.ws, { type: 'action_error', message: 'Not your turn' });
      return;
    }
    selectTemple(state, msg.templeId);
    pushStateUpdate(room, msg.type, sess.playerSlot, false);
    return;
  }
  if (msg.type === 'action_deselect') {
    deselectAll(state);
    pushStateUpdate(room, msg.type, sess.playerSlot, false);
    return;
  }

  // ── Mutating actions go through the shared dispatcher. ──
  // Accept both: (a) the new unified shape `{ type: 'action', action, params }`
  // for bots/agents, and (b) all legacy `action_*` messages used by the FE.
  let unified: { action: UnifiedActionName; params: Record<string, unknown> } | { error: string } | null;
  if (msg.type === 'action') {
    unified = { action: msg.action as UnifiedActionName, params: (msg.params ?? {}) as Record<string, unknown> };
  } else {
    unified = legacyToUnified(state, msg);
  }
  if (!unified) {
    send(sess.ws, { type: 'action_error', message: `Unknown action: ${msg.type}` });
    return;
  }
  if ('error' in unified) {
    // Malformed legacy params — surface a proper action_error instead of
    // letting a TypeError propagate out of the message handler.
    send(sess.ws, { type: 'action_error', message: unified.error });
    return;
  }

  const result = executeAction(state, sess.playerSlot, unified.action, unified.params);

  if (!result.ok) {
    // Enriched error: include legalMoves so agents can recover without polling.
    send(sess.ws, {
      type: 'action_error',
      message: result.error,
      legalMoves: result.legalMoves as unknown as Record<string, unknown>,
    });
    return;
  }

  const lastAction = result.log.join('; ') || unified.action;
  pushStateUpdate(room, lastAction, sess.playerSlot, result.broadcastToBoth);
}
