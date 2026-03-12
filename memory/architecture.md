---
name: architecture
description: File/module breakdown, client-server separation, WebSocket protocol, database schema
type: project
---

# Architecture

## Client-Server Separation

- **Frontend** (`src/`): Pure TypeScript, compiled by Vite, runs in browser. No server imports.
- **Backend** (`server/`): Node.js, Express + WebSocket, manages rooms and persists game state.
- **Simulation** (`simulation/`): Standalone scripts run with `tsx`, not bundled into the web app.

Single-player games run entirely client-side (no server needed). Multiplayer routes through WebSocket.

## WebSocket Protocol (`src/protocol.ts` — 45 lines)

### Client → Server
| Message | Payload |
|---------|---------|
| `login` | `{username}` |
| `create_room` | `{}` |
| `join_room` | `{roomId}` |
| `list_rooms` | `{}` |
| `rejoin_room` | `{roomId}` |
| `action_select_unit` | `{unitId}` |
| `action_select_temple` | `{templeId}` |
| `action_deselect` | `{}` |
| `action_move` | `{dest: HexCoord}` |
| `action_attack` | `{targetPos: HexCoord}` |
| `action_spawn` | `{templeId, unitType}` |
| `action_capture` | `{}` |
| `action_upgrade_temple` | `{templeId}` |
| `action_research` | `{techId}` |
| `action_build_teleport` | `{templeIdA, posA: HexCoord, posB: HexCoord}` |
| `action_end_turn` | `{}` |

### Server → Client
| Message | Payload |
|---------|---------|
| `logged_in` | `{username}` |
| `error` | `{message}` |
| `room_created` | `{roomId}` |
| `room_list` | `{rooms: RoomSummary[]}` |
| `game_start` | `{playerSlot: 0\|1, state: SerializedGameState}` |
| `state_update` | `{state: SerializedGameState, lastAction}` |
| `action_error` | `{message}` |
| `opponent_disconnected` | `{}` |
| `opponent_reconnected` | `{}` |

`RoomSummary: {id, player1Name, status}`

## Data Flow

**Single-player:** `main.ts` → `createGameState()` → local `GameState` object → `renderer.ts` draws canvas → user actions call game.ts functions directly → `ai.ts` runs AI turn

**Multiplayer:** `multiplayer.ts` ↔ WebSocket ↔ `server/gameManager.ts` → calls same game.ts functions → serializes state → broadcasts `state_update` to both players

## Database Schema (`server/db.ts` — 120 lines)

SQLite3 with WAL mode, foreign keys enabled. Path: `process.cwd()/game.db`.

**players**
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `username` TEXT NOT NULL UNIQUE
- `created_at` INTEGER (unixepoch)

**rooms**
- `id` TEXT PRIMARY KEY (4-char alphanumeric, e.g. "A3KP")
- `status` TEXT: `'open'` | `'active'` | `'done'`
- `player1_id` INTEGER → players.id
- `player2_id` INTEGER → players.id (nullable)
- `winner_name` TEXT (nullable)
- `created_at` INTEGER
- `updated_at` INTEGER

**game_states**
- `room_id` TEXT PRIMARY KEY → rooms.id
- `state_json` TEXT
- `updated_at` INTEGER

**Key DB functions:**
- `upsertPlayer(username)` — INSERT OR IGNORE, returns id
- `createRoom(player1Id)` — generates unique 4-char room ID
- `joinRoom(roomId, player2Id)` — sets player2, status → 'active'
- `setRoomStatus(roomId, status, winnerName?)` — update status/winner
- `getOpenRooms()` — up to 20 open rooms, ordered by creation DESC
- `saveGameState(roomId, stateJson)` — INSERT OR REPLACE
- `loadGameState(roomId)` — returns stateJson or null

## Server Setup (`server/server.ts` — 49 lines)

- Express HTTP server + `ws` WebSocket server on same port
- Port: `process.env.PORT` or OS-assigned (0)
- Static files from `dist/`
- Catch-all `GET *` → `dist/index.html` (SPA routing)
- WebSocket: `handleConnect(ws)`, `handleMessage(ws, data)`, `handleDisconnect(ws)`

## Key Hex Coordinate System (`src/hex.ts`)

Uses axial coordinates `{q, r}`. Map radius 6. All movement and vision calculations in hex space.

## State Serialization (`src/serializer.ts`)

Converts `GameState` ↔ `SerializedGameState` (JSON-safe) for WebSocket transport and DB persistence.
