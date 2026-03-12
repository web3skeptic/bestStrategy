---
name: project_overview
description: Tech stack, deployment, build commands, entry points for the bestStrategy hex game
type: project
---

# bestStrategy/implementation — Project Overview

Hex-based turn-by-turn strategy game playable single-player (vs AI) or multiplayer (WebSocket).

## Tech Stack
- **Frontend:** TypeScript + Vite 7.3.1 (Canvas rendering, no framework)
- **Backend:** Node.js, Express 5.2.1, ws 8.19.0 (WebSocket)
- **Database:** better-sqlite3 12.6.2 (SQLite, WAL mode)
- **Language:** TypeScript 5.9.3 throughout
- **Build:** `vite build` → `dist/`, served as SPA by Express

## Scripts
- `npm run dev` — Vite dev server (frontend only)
- `npm run build` — Production build to `dist/`
- `npm run server` — Run backend (`tsx server/server.ts`)
- `npm run server:dev` — Watch mode backend

## Deployment
- **Railway** (backend + static files) — `railway.toml`
- **Netlify** (frontend static) — `netlify.toml`
- **Docker** — `Dockerfile` present

## Key Entry Points
- `index.html` → `src/main.ts` — game bootstrap
- `server/server.ts` — Express + WebSocket server (port from `process.env.PORT` or OS-assigned)
- `simulation/` — standalone simulation scripts (run with tsx, not part of the web app)

## Source Layout
| Path | Lines | Role |
|------|-------|------|
| src/types.ts | 170 | All game type definitions, constants, unit/tech definitions |
| src/game.ts | 1054 | Core game logic (combat, movement, spawning, win conditions) |
| src/ai.ts | 381 | Basic AI + Hard AI implementations |
| src/main.ts | ~300 | Game bootstrap, single-player entry |
| src/multiplayer.ts | — | Multiplayer client logic |
| src/renderer.ts | — | Canvas rendering |
| src/hex.ts | — | Hex grid math |
| src/serializer.ts | — | GameState serialization |
| src/protocol.ts | 45 | WebSocket message type definitions |
| server/server.ts | 49 | Express + WebSocket server |
| server/gameManager.ts | — | Room and game state management |
| server/db.ts | 120 | SQLite schema and queries |
| server/types.ts | — | Server-side types |
| simulation/strategy_sim.ts | 904 | Strategy tournament simulation |
| simulation/armies.ts | — | Army composition helpers |
| simulation/battle.ts | — | Battle simulation |
| simulation/duel.ts | — | 1v1 duel simulation |
| simulation/runner.ts | — | Simulation runner |
| simulation/defs.ts | — | Simulation definitions |
