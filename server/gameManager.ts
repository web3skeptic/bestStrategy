import { WebSocket } from 'ws';
import { ClientSession, RoomState } from './types';
import { ClientMessage, ServerMessage, RoomSummary, ActiveGameSummary } from '../src/protocol';
import {
  upsertPlayer, createRoom, joinRoom, setRoomStatus,
  getRoomById, saveGameState, loadGameState,
} from './db';
import { serialize, deserialize, SerializedGameState, IncompatibleRulesVersionError } from '../src/serializer';
import { createGameState, selectUnit, selectSite, deselectAll, resignGame, getPlayerVisible, isForestUnitRevealed } from '../src/game';
import { hexKey } from '../src/hex';
import { GameState, HexCoord, UnitType, TechId, PLAYER_COLORS } from '../src/types';
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

// How long a seated player may be gone before the server acts: in a running
// game they forfeit (resign) and the other player wins; in a room that hasn't
// started, their seat is freed (and an empty room is removed from the list).
export const RECONNECT_GRACE_MS = 30_000;
// Pending grace timers, keyed "roomId:slot".
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearGraceTimer(roomId: string, slot: number): void {
  const key = `${roomId}:${slot}`;
  const t = graceTimers.get(key);
  if (t) { clearTimeout(t); graceTimers.delete(key); }
}

// ── Push state updates to headless spectators ──

export function pushHeadlessStateUpdate(gameId: string): void {
  const specs = hlSpectators.get(gameId);
  if (!specs || specs.length === 0) return;
  const hl = headlessSessions.get(gameId);
  if (!hl) return;
  const serialized = serialize(hl.gameState);
  const strippedState = viewPayload(serialized, null, null);
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
    selectedSiteId: null,
    selectionMode: null,
    moveHexes: [],
    attackHexes: [],
    structureAttackHexes: [],
    supportHexes: [],
    buildHexes: [],
  };
}

// The immediate, pre-Round-1 secret faction pick (§3, phase 11) is a real
// information boundary, not just a UI nicety: until BOTH players have chosen, a viewer
// may see their OWN pick (if they made one) but never the opponent's —
// regardless of whether they're the acting player, the other seat, or a
// spectator. `viewerSlot` is null for spectators (and anyone else with no
// seat), who see neither pick until reveal. This is applied to every
// broadcast payload below, independently of stripSelectionState.
function stripHiddenFaction(s: ReturnType<typeof serialize>, viewerSlot: number | null): ReturnType<typeof serialize> {
  const bothChosen = s.players.every(p => p.faction !== null);
  if (bothChosen) return s;
  return {
    ...s,
    players: s.players.map(p => (p.id === viewerSlot ? p : { ...p, faction: null })),
  };
}

// Fog of war is an information boundary too: the client hides what a seat
// can't see only while drawing, so anything sent is readable in DevTools.
// Each seat therefore gets only:
//   • enemy units it can currently see (same test the client renders with:
//     in vision, and in a forest only with an adjacent friendly),
//   • its own training queue and its own explored set.
// Structures and roads stay (the client shows them as last seen in the fog).
// Spectators (viewerSlot null) and finished games get the full state.
function stripFogged(s: ReturnType<typeof serialize>, state: GameState | null, viewerSlot: number | null): ReturnType<typeof serialize> {
  if (!state || viewerSlot === null || state.phase === 'gameOver') return s;
  const viewer = state.players[viewerSlot]?.id ?? viewerSlot;
  const visible = getPlayerVisible(state, viewer);
  return {
    ...s,
    units: s.units.filter(u => u.playerId === viewer
      || (u.hp > 0 && visible.has(hexKey(u.pos)) && isForestUnitRevealed(state, u.pos, viewer))),
    trainingQueue: s.trainingQueue.filter(t => t.playerId === viewer),
    explored: s.explored.map((e, i) => (i === viewer ? e : [])),
  };
}

// Log lines name hex coordinates ("Unit unit_7 moved to (3,-2)"). For a seat
// that didn't act, drop every segment that mentions a hex it can't see, so the
// combat log can't reveal what the fog hides.
function fogLogFor(lastAction: string, state: GameState | null, viewerSlot: number | null, actingSlot: number | null): string {
  if (!state || viewerSlot === null || viewerSlot === actingSlot || state.phase === 'gameOver') return lastAction;
  const viewer = state.players[viewerSlot]?.id ?? viewerSlot;
  const visible = getPlayerVisible(state, viewer);
  return lastAction.split('; ').filter(seg => {
    for (const m of seg.matchAll(/\((-?\d+),\s*(-?\d+)\)/g)) {
      if (!visible.has(`${m[1]},${m[2]}`)) return false;
    }
    return true;
  }).join('; ');
}

// Build the exact payload a given seat (or spectator, slot=null) is allowed
// to see: hidden-faction stripping always applies; selection-state stripping
// applies to every seat except the one that just acted; fog-of-war stripping
// applies to every seat.
function viewPayload(serialized: ReturnType<typeof serialize>, viewerSlot: number | null, actingSlot: number | null, state: GameState | null = null): ReturnType<typeof serialize> {
  let payload = stripHiddenFaction(serialized, viewerSlot);
  if (viewerSlot !== actingSlot) payload = stripSelectionState(payload);
  payload = stripFogged(payload, state, viewerSlot);
  return payload;
}

function pushStateUpdate(room: RoomState, lastAction: string, actingSlot: number, toAll: boolean): void {
  const serialized = serialize(room.state!);
  const gameOver = room.state!.phase === 'gameOver';

  if (toAll || gameOver) {
    // Send each player their own view: acting player sees full state (minus
    // any still-hidden opponent faction pick), opponent sees selection AND
    // hidden-faction stripped.
    for (let slot = 0; slot < room.sessions.length; slot++) {
      const sess = room.sessions[slot];
      if (!sess) continue;
      send(sess.ws, { type: 'state_update', state: viewPayload(serialized, slot, actingSlot, room.state), lastAction: fogLogFor(lastAction, room.state, slot, actingSlot) });
    }
  } else {
    const actingSess = room.sessions[actingSlot];
    if (actingSess) send(actingSess.ws, { type: 'state_update', state: viewPayload(serialized, actingSlot, actingSlot, room.state), lastAction });
  }

  // Spectators never see an unrevealed faction pick, from either seat.
  const spectatorState = viewPayload(serialized, null, actingSlot);
  broadcastToSpectators(room, { type: 'state_update', state: spectatorState, lastAction });

  // The DB always stores the true, authoritative, unstripped state — stripping
  // only ever happens on the outbound broadcast payload (same precedent as
  // selection state).
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
      } else if (sess.playerSlot !== null && room.sessions[sess.playerSlot] === sess) {
        // Notify every other seated player, then nullify this slot (kept in the
        // room for rejoin; playerNames retains the username→slot mapping).
        const slot = sess.playerSlot;
        const playing = room.status === 'active' && room.state?.phase === 'playing';
        for (let i = 0; i < room.sessions.length; i++) {
          const other = room.sessions[i];
          if (other && i !== slot) {
            send(other.ws, { type: 'opponent_disconnected', playerSlot: slot, playerName: sess.username ?? undefined, graceMs: playing ? RECONNECT_GRACE_MS : undefined });
          }
        }
        room.sessions[slot] = null;
        startGraceTimer(room, slot, sess.username);
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
    case 'create_room': return handleCreateRoom(sess, msg.expectedPlayers);
    case 'join_room': return handleJoinRoom(sess, msg.roomId);
    case 'list_rooms': return handleListRooms(sess);
    case 'rejoin_room': return handleRejoinRoom(sess, msg.roomId);
    case 'leave_room': return handleLeaveRoom(sess, msg.roomId);
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

// A seated player left: give them RECONNECT_GRACE_MS to rejoin (rejoin_room
// clears the timer). Running game → they resign and the other player wins.
// Room still waiting for players → their seat is freed; an empty room is removed.
function startGraceTimer(room: RoomState, slot: number, username: string | null): void {
  clearGraceTimer(room.id, slot);
  const playing = room.status === 'active' && room.state?.phase === 'playing';
  if (room.status === 'done') return;
  graceTimers.set(`${room.id}:${slot}`, setTimeout(() => {
    graceTimers.delete(`${room.id}:${slot}`);
    if (rooms.get(room.id) !== room || room.sessions[slot]) return; // gone, or rejoined
    if (playing && room.state && room.state.phase === 'playing') {
      if (resignGame(room.state, slot)) {
        pushStateUpdate(room, `${username ?? `Player ${slot + 1}`} did not reconnect in time and forfeits.`, slot, true);
      }
    } else if (room.status === 'open') {
      freeOpenSeat(room, slot);
    }
  }, RECONNECT_GRACE_MS));
}

// Remove a player from a room that hasn't started. The room is dropped from the
// lobby once nobody is left in it.
function freeOpenSeat(room: RoomState, slot: number): void {
  room.sessions[slot] = null;
  room.playerNames[slot] = null;
  if (room.sessions.every(s => s === null)) {
    rooms.delete(room.id);
    setRoomStatus(room.id, 'done');
    for (let i = 0; i < room.expectedPlayers; i++) clearGraceTimer(room.id, i);
  }
}

// The waiting screen's Back button. Only for rooms that haven't started — a
// running game is left by resigning or by disconnecting (grace timer).
function handleLeaveRoom(sess: ClientSession, roomId: string): void {
  const room = rooms.get(roomId);
  if (!room || sess.roomId !== roomId || sess.playerSlot === null) return;
  if (room.status !== 'open') return;
  clearGraceTimer(roomId, sess.playerSlot);
  freeOpenSeat(room, sess.playerSlot);
  sess.roomId = null;
  sess.playerSlot = null;
  const joined = room.sessions.filter(s => s !== null).length;
  for (const s of room.sessions) {
    if (s) send(s.ws, { type: 'room_waiting', roomId, joined, expected: room.expectedPlayers });
  }
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

// The Asymmetric Tribes redesign is 1v1 only. Room size is pinned to 2
// server-side regardless of what a (possibly stale) client requests — the
// old N-player room machinery below is left in place since it's harmless and
// still generic/reusable, but nothing can actually create a room for more
// than 2 seats any more.
function normalizeExpectedPlayers(_n: unknown): number {
  return 2;
}

// Once a room is full, build the N-player game state and broadcast game_start
// with each session's own slot. Shared by 2-player and N-player rooms.
function startGameInRoom(room: RoomState): void {
  const configs = room.playerNames.map((name, i) => ({
    name: name ?? `Player ${i + 1}`,
    color: PLAYER_COLORS[i % PLAYER_COLORS.length]!,
  }));
  room.state = createGameState(configs);
  room.status = 'active';

  const serialized = serialize(room.state);
  saveGameState(room.id, JSON.stringify(serialized));

  for (let slot = 0; slot < room.sessions.length; slot++) {
    const s = room.sessions[slot];
    if (s) send(s.ws, { type: 'game_start', playerSlot: slot, state: viewPayload(serialized, slot, slot, room.state) });
  }
}

function handleCreateRoom(sess: ClientSession, expectedPlayers?: number): void {
  if (!sess.username) { send(sess.ws, { type: 'error', message: 'Login first' }); return; }
  const expected = normalizeExpectedPlayers(expectedPlayers);
  const playerId = upsertPlayer(sess.username);
  const roomId = createRoom(playerId);
  const room: RoomState = {
    id: roomId,
    status: 'open',
    sessions: new Array(expected).fill(null),
    expectedPlayers: expected,
    playerNames: new Array(expected).fill(null),
    spectators: [],
    state: null,
  };
  room.sessions[0] = sess;
  room.playerNames[0] = sess.username;
  rooms.set(roomId, room);
  sess.roomId = roomId;
  sess.playerSlot = 0;
  send(sess.ws, { type: 'room_created', roomId, expectedPlayers: expected });
}

function handleJoinRoom(sess: ClientSession, roomId: string): void {
  if (!sess.username) { send(sess.ws, { type: 'error', message: 'Login first' }); return; }

  // In-memory room is authoritative for open (waiting) rooms — this supports N
  // players without needing extra DB columns.
  const room = rooms.get(roomId);
  if (!room || room.status !== 'open') {
    send(sess.ws, { type: 'error', message: 'Room not found or already started' });
    return;
  }
  if (room.playerNames.includes(sess.username)) {
    send(sess.ws, { type: 'error', message: 'You are already in this room' });
    return;
  }
  const slot = room.sessions.findIndex(s => s === null);
  if (slot === -1) {
    send(sess.ws, { type: 'error', message: 'Room is full' });
    return;
  }

  const playerId = upsertPlayer(sess.username);
  // Keep the DB's 2-player columns populated for the classic case so existing
  // 2-player rejoin-after-restart keeps working. For slots ≥2 we rely on the
  // in-memory room (rejoin for N>2 is best-effort — see handleRejoinRoom).
  if (slot === 1) joinRoom(roomId, playerId);

  room.sessions[slot] = sess;
  room.playerNames[slot] = sess.username;
  sess.roomId = roomId;
  sess.playerSlot = slot;

  const joined = room.sessions.filter(s => s !== null).length;
  if (joined >= room.expectedPlayers) {
    startGameInRoom(room);
  } else {
    // Not full yet — tell the joiner (and everyone waiting) the progress.
    for (const s of room.sessions) {
      if (s) send(s.ws, { type: 'room_waiting', roomId, joined, expected: room.expectedPlayers });
    }
  }
}

function handleListRooms(sess: ClientSession): void {
  // Open (waiting) rooms are ephemeral and now support N players, so list them
  // from the in-memory store — this is the single source of truth for the
  // expected/joined counts. (Persistence + rejoin still go through the DB.)
  const roomList: RoomSummary[] = [];
  for (const [id, room] of rooms) {
    if (room.status !== 'open') continue;
    const joined = room.sessions.filter(s => s !== null).length;
    roomList.push({
      id,
      player1Name: room.playerNames[0] ?? 'Unknown',
      status: 'open',
      expectedPlayers: room.expectedPlayers,
      joinedPlayers: joined,
    });
  }
  send(sess.ws, { type: 'room_list', rooms: roomList });
}

function handleRejoinRoom(sess: ClientSession, roomId: string): void {
  if (!sess.username) { send(sess.ws, { type: 'error', message: 'Login first' }); return; }

  let room = rooms.get(roomId);

  // Determine the rejoining player's slot. Prefer the in-memory room (which
  // tracks all N slots by username); fall back to the DB's 2-player columns so a
  // classic 2-player room survives a server restart.
  let slot: number | null = null;
  if (room) {
    const idx = room.playerNames.indexOf(sess.username);
    if (idx !== -1) slot = idx;
  }
  if (slot === null) {
    const dbRoom = getRoomById(roomId);
    if (!dbRoom) { send(sess.ws, { type: 'error', message: 'Room not found' }); return; }
    const playerId = upsertPlayer(sess.username);
    if (dbRoom.player1_id === playerId) slot = 0;
    else if (dbRoom.player2_id === playerId) slot = 1;
    if (slot === null) { send(sess.ws, { type: 'error', message: 'Not a player in this room' }); return; }
    if (!room) {
      // Reconstruct a minimal 2-player room from the DB (N>2 rooms can't be fully
      // rebuilt after a restart — that's the documented rejoin caveat).
      room = {
        id: roomId, status: dbRoom.status as 'open' | 'active' | 'done',
        sessions: [null, null], expectedPlayers: 2, playerNames: [null, null],
        spectators: [], state: null,
      };
      rooms.set(roomId, room);
    }
  }

  if (!room) { send(sess.ws, { type: 'error', message: 'Room not found' }); return; }

  // Restore state from DB if not in memory
  if (!room.state) {
    const savedJson = loadGameState(roomId);
    if (savedJson) {
      const parsed = JSON.parse(savedJson) as SerializedGameState;
      try {
        room.state = deserialize(parsed);
        resyncCounters(room.state);
      } catch (err) {
        if (err instanceof IncompatibleRulesVersionError) {
          send(sess.ws, { type: 'error', message: err.message });
          return;
        }
        throw err;
      }
    }
  }

  clearGraceTimer(roomId, slot);
  room.sessions[slot] = sess;
  room.playerNames[slot] = sess.username;
  sess.roomId = roomId;
  sess.playerSlot = slot;

  if (!room.state && room.status !== 'open') {
    send(sess.ws, { type: 'error', message: 'That room is no longer open.' });
    return;
  }
  if (!room.state && room.status === 'open') {
    // Reconnected while still waiting for an opponent: put them back on the
    // waiting screen.
    const joined = room.sessions.filter(s => s !== null).length;
    send(sess.ws, { type: 'room_waiting', roomId, joined, expected: room.expectedPlayers });
    return;
  }

  if (room.state) {
    const currentTurnSlot = room.state.currentPlayerIndex;
    const serialized = serialize(room.state);
    // If rejoining player is NOT the acting player, strip selections so they
    // cannot see the acting player's in-progress moves from the saved state.
    // Either way, an unrevealed opponent faction pick stays hidden (§5-6) —
    // this matters especially here: "reconnect before the opponent chooses"
    // must show MY own locked pick but never theirs.
    const payload = viewPayload(serialized, slot, currentTurnSlot, room.state);
    send(sess.ws, { type: 'game_start', playerSlot: slot, state: payload });
    for (let i = 0; i < room.sessions.length; i++) {
      const other = room.sessions[i];
      if (other && i !== slot) send(other.ws, { type: 'opponent_reconnected', playerSlot: slot, playerName: sess.username ?? undefined });
    }
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
    const strippedState = viewPayload(serialized, null, null);
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
  const strippedState = viewPayload(serialized, null, null);

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
    case 'action_destroy':
      // Disband carries unitId explicitly (no selection fallback).
      if (typeof msg.unitId !== 'string') return { error: 'Invalid destroy: missing unitId' };
      return { action: 'destroy', params: { unitId: msg.unitId } };
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
    selectSite(state, msg.templeId);
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
