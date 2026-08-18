# Best Strategy — Codebase Reference

## Overview

A 2-player hex-grid turn-based strategy game. Supports:
- **vs AI** (normal or hard difficulty)
- **Local 2-player** (same machine)
- **Online multiplayer** (WebSocket server, room lobby)

Frontend is a Vite + TypeScript SPA rendered on a `<canvas>`. Backend is an Express + WebSocket server with SQLite persistence.

---

## Running the Project

```bash
# Frontend (Vite dev server — http://localhost:5173)
npm run dev

# Backend (Express + WebSocket — picks a free port)
npm run server:dev   # with file watching (tsx watch)
npm run server       # one-shot

# Production build
npm run build        # outputs to /dist
# Then backend serves /dist as static files too
```

For online multiplayer locally: run both the frontend (`npm run dev`) and backend (`npm run server:dev`) concurrently in separate terminals. The frontend connects to the WebSocket at the same origin by default, or via `VITE_WS_URL` env var to point at a remote server.

---

## File Structure

```
src/
  types.ts        — All shared types, constants, tech tree definitions
  hex.ts          — Hex math: distance, pathfinding, pixel conversion
  game.ts         — Core game logic (pure functions on GameState)
  ai.ts           — Normal AI and Hard AI turn logic
  renderer.ts     — Canvas rendering (Renderer class)
  main.ts         — UI wiring, event handlers, game loop entry point
  multiplayer.ts  — WebSocket client wrapper (MultiplayerClient)
  protocol.ts     — WS message types (ClientMessage / ServerMessage)
  serializer.ts   — GameState ↔ JSON (Set/Map → Array for transport)

server/
  server.ts       — Express HTTP + WebSocketServer setup
  gameManager.ts  — Session/room management, action dispatch, state push
  db.ts           — SQLite DB (better-sqlite3): players, rooms, game_states
  types.ts        — Server-only types (ClientSession, RoomState)
```

---

## Core Data Model (`src/types.ts`)

### `GameState`
The single source of truth passed everywhere:

| Field | Type | Description |
|---|---|---|
| `players` | `Player[]` | Two players with id, name, color, aura |
| `units` | `Unit[]` | All units (alive and dead, dead have `hp=0`) |
| `temples` | `Temple[]` | 4 temples (2 starting, 2 neutral) |
| `hills/walls/forests` | `Set<string>` | Terrain hex keys (`"q,r"` format) |
| `explored` | `Set<string>[]` | Per-player fog-of-war explored hexes |
| `currentPlayerIndex` | `number` | 0 or 1 |
| `phase` | `'playing' \| 'gameOver'` | |
| `mapRadius` | `number` | 6 |
| `playerTech` | `PlayerTech[]` | Per-player researched tech set |
| `teleportBuildings` | `TeleportBuilding[]` | Placed portal pairs |
| `selectedUnitId/selectedTempleId/selectionMode` | UI state | Highlights, selection |
| `moveHexes/attackHexes/supportHexes/buildHexes` | `HexCoord[]` | Highlighted hexes for current selection |

### `Unit`
```
id, type, playerId, stats (UnitStats), hp, pos (HexCoord), hasMoved, hasAttacked
```

### `Temple`
```
id, pos, ownerId (null = neutral), level (1–10)
```
- Income per turn: `effectiveLevel × 2` aura (TEMPLE_AURA_PER_LEVEL = 2)
- Pop cap contribution: `effectiveLevel × 2` (TEMPLE_POP_CAP_PER_LEVEL = 2)
- Economy plateau: income and pop-cap use `effectiveLevel = min(level, 5)` (TEMPLE_ECONOMY_CAP_LEVEL = 5). Levels 6–10 are purely cosmetic/prestige and grant no further income or pop cap.
- Upgrade cost: from the `TEMPLE_UPGRADE_COSTS = [0,2,3,5,7,10,14,19,25,32]` table (index = current level), NOT `2^level`. Lv1→2: 2⚡, Lv2→3: 3⚡, Lv3→4: 5⚡, Lv4→5: 7⚡, Lv5→6: 10⚡, …, Lv9→10: 32⚡. Max level 10 (TEMPLE_MAX_LEVEL).

---

## Units (`src/game.ts`)

### Stats at a Glance

| Unit | HP | ATK | DEF | SPD | RNG | Cost | Unlock |
|---|---|---|---|---|---|---|---|
| Warrior | 15 | 10 | 5 | 1 | 1 | 1 | default |
| Archer | 15 | 10 | 3 | 2 | 2 | 2 | default |
| Horserider | 15 | 16 | 2 | 2 | 1 | 3 | default |
| Spearsman | 15 | 10 | 5 | 2 | 1 | 2 | tech |
| Catapult | 10 | 14 | 1 | 1 | 3 | 4 | tech |
| Heavy Knight | 22 | 20 | 8 | 3 | 1 | 7 | tech |
| Healer | 12 | 4 | 2 | 2 | 1 | 3 | tech |
| Damage Booster | 12 | 4 | 2 | 2 | 0 | 3 | tech |
| Range Booster | 12 | 4 | 2 | 2 | 0 | 3 | tech |

**Spearsman** has type bonuses: 3× attack vs horserider, 4× vs heavyknight; 3× defense vs horserider, 6× vs heavyknight.

**Boosters cannot attack**: Damage Booster and Range Booster have effective RNG 0 (`getEffectiveRange` returns 0 for both booster types, ignoring hill/range boosts). They can only move and provide support auras.

**Support range** = 2 hexes (SUPPORT_RANGE). Support units affect all allies within range:
- Healer: +5 HP/turn to nearby allies at turn start
- Damage Booster: +5 ATK to nearby allies
- Range Booster: +1 RNG to nearby allies

### Combat Formula
```
damage = round(randomMultiplier × encirclementMultiplier × typeBonus × (attackerATK - defenderDEF))
```
- `randomMultiplier` ≈ Normal(1.0, σ=0.2), clamped [0.5, 1.5]
- `typeBonus` = `attacker.attackBonusAgainst[target.type] / target.defenseBonusAgainst[attacker.type]`
- Revenge attack fires if target survives and attacker `canBeRevenged = true`
- Melee units (range=1) step onto killed unit's tile

### Terrain Effects
- **Hills**: +2 DEF, +1 vision, +1 RNG (ranged units only); moving onto/off costs full movement budget
- **Forests**: reduce vision to 1 when standing inside; units inside are hidden unless adjacent enemy
- **Walls**: impassable

---

## Tech Tree (`src/types.ts`)

All techs cost **5⚡**. Branches allow only ONE pick.

| Tech ID | Name | Effect |
|---|---|---|
| `unlock_catapult` | Catapult | Unlocks Catapult |
| `unlock_heavyknight` | Heavy Knight | Unlocks Heavy Knight |
| `unlock_spearsman` | Spearsman | Unlocks Spearsman |
| `catapult_splash` | Splash Range +1 | Catapult gets splash radius 1 (prereq: unlock_catapult) |
| `roads` *(branch: movement)* | Roads | All units +1 speed |
| `teleports` *(branch: movement)* | Teleports | Unlock portal building |
| `infantry_move` *(branch: stat_bonus)* | Infantry March | Warriors + Spearsment +1 speed |
| `longrange_hp` *(branch: stat_bonus)* | Fortified Ranged | Archers + Catapults +5 HP |
| `horse_sight` *(branch: stat_bonus)* | Scout Cavalry | Horseriders + Heavy Knights +1 vision |
| `unlock_healer` *(branch: support)* | Healer | Unlocks Healer |
| `unlock_damagebooster` *(branch: support)* | Damage Booster | Unlocks Damage Booster |
| `unlock_rangebooster` *(branch: support)* | Range Booster | Unlocks Range Booster |

---

## Teleport System

- Requires `teleports` tech
- Costs **5⚡** to build a **portal pair**
- Each portal must be within radius 2 of a different owned temple (one portal per temple max)
- Cannot be placed on hills, forests, walls, or the temple tile itself
- When a unit steps on a portal, it teleports to a free neighbour of the partner portal

---

## Encirclement System

Calculated dynamically before each combat. Increases attacker's damage multiplier up to **2×**:
- **Perimeter ratio**: fraction of the target's unit-group perimeter blocked by enemies/map edge (above 50% starts contributing)
- **Opposing axis ratio**: fraction of axis-pairs where both sides of a unit are blocked

Formula:
```
attackMultiplier = 1.0 + ((ratio - 0.5) / 0.5) × 0.5  (when ratio > 0.5)
                + opposingRatio × 0.5
```

---

## Game Flow

1. **Start**: 2 warriors each, 2 owned temples, 2 neutral temples; all players start with 2⚡
2. **Each turn**:
   - Receive aura income from temples
   - Healers restore HP to nearby allies
   - Player selects unit or temple and acts
3. **Win conditions** (checked after every action):
   - Own ALL temples → win
   - Opponent has no units AND no temples → win
   - Both conditions met by nobody → draw

---

## AI (`src/ai.ts`)

### Normal AI (`runAITurn`)
Probabilistic unit selection from a priority list. Each unit: attack if in range, else move toward nearest enemy.

### Hard AI (`runHardAITurn`)
Economic strategy (wins ~99% of simulated games):
- **Phase 1** (home temple < Lv3): Save aura, upgrade home temple. Spawn 1 warrior guard only.
- **Phase 2** (home temple ≥ Lv3): Research `unlock_spearsman`. Spawn spearsmen + archers 2:1 ratio.
- Always: Upgrade captured temples to Lv2; explicitly capture temples when standing on them; move toward closest of (uncaptured temple, nearest enemy).

---

## Multiplayer Architecture

### WebSocket Protocol (`src/protocol.ts`)

**Client → Server** actions:
`login`, `create_room`, `join_room`, `list_rooms`, `rejoin_room`,
`action_select_unit`, `action_select_temple`, `action_deselect`,
`action_move`, `action_attack`, `action_spawn`, `action_capture`,
`action_upgrade_temple`, `action_research`, `action_build_teleport`,
`action_end_turn`

**Server → Client** messages:
`logged_in`, `error`, `room_created`, `room_list`, `game_start`,
`state_update`, `action_error`, `opponent_disconnected`, `opponent_reconnected`

### Server Session Model (`server/gameManager.ts`)
- In-memory `Map<WebSocket, ClientSession>` for sessions
- In-memory `Map<string, RoomState>` for rooms (backed by SQLite on every state change)
- Selection/move highlights are **stripped** from the state sent to the non-acting player
- State is broadcast to both players on game-state-changing actions; selection-only actions only go back to the actor
- Reconnect: state is reloaded from SQLite if room was evicted from memory

### Database (`server/db.ts`, SQLite via `better-sqlite3`)
Tables:
- `players(id, username, created_at)`
- `rooms(id, status, player1_id, player2_id, winner_name, created_at, updated_at)`
- `game_states(room_id, state_json, updated_at)` — full serialized state, upserted after every action

Room IDs are 4-char alphanumeric codes (e.g. `A3KX`).

### Serialization (`src/serializer.ts`)
`GameState` uses `Set<string>` for terrain/explored/tech. These are converted to arrays for JSON transport and back on receive. `serialize()` / `deserialize()` handle this; `resetCounters()` is called after deserialize on the server to prevent ID collisions.

---

## Renderer (`src/renderer.ts`)
- Flat-top hexagonal grid, `BASE_HEX_SIZE = 48px` scaled by zoom
- Zoom: 0.4×–3.0× in 0.15 steps; pan only active when zoom > 1.0
- Fog of war: unexplored hexes rendered dark; explored-but-not-visible hexes rendered dimmed
- Supports `viewerPlayerId` to render the correct fog perspective in multiplayer
- Highlights: move hexes (green), attack hexes (red), support hexes (blue), build hexes (yellow)

---

## Key Constants

```ts
TECH_COST = 5
HILL_DEFENSE_BONUS = 2
HILL_VISION_BONUS = 1
HILL_RANGE_BONUS = 1
SUPPORT_RANGE = 2
TEMPLE_AURA_PER_LEVEL = 2
TEMPLE_MAX_LEVEL = 10
TEMPLE_POP_CAP_PER_LEVEL = 2
TEMPLE_ECONOMY_CAP_LEVEL = 5   (income + pop-cap plateau; levels 6–10 are cosmetic)
TEMPLE_UPGRADE_COSTS = [0,2,3,5,7,10,14,19,25,32]   (index = current level; not 2^level)
TELEPORT_BUILD_COST = 5
TELEPORT_RADIUS = 2
HEALER_HEAL_AMOUNT = 5
DAMAGE_BOOST_AMOUNT = 5
RANGE_BOOST_AMOUNT = 1
MAP_RADIUS = 6
AI_DELAY_MS = 600   (in main.ts, before AI takes its turn)
```

---

## Important Patterns

- **`sendOrCall(action, localFn)`** in `main.ts`: in multiplayer mode sends action to server; locally calls fn directly and re-renders. All player-initiated actions go through this.
- **Dead units stay in `state.units`** with `hp = 0`. Always filter `u.hp > 0` when iterating.
- **`hasMoved` and `hasAttacked`** are reset per unit at turn start. Attacking also sets `hasMoved = true`.
- **`spawnedTempleIds`** tracks which temples have spawned this turn (cleared on end turn).
- **`resetCounters`** must be called after deserializing on the server to keep unit/temple/teleport IDs unique.
- **Terrain generation** is procedural (random clusters) each new game; `reserved` buffer prevents terrain on starting positions and their neighbours.
