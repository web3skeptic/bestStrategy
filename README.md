# Tactical Tribes

A two-player, turn-based hex strategy game (formerly *Best Strategy*). Two asymmetric tribes, Farmers (Agrar)
and Nomads (Temple), compete under fog of war. Every match is won by bringing down the enemy Capital.

**Play:** <https://interslavic.space/game-upgradable/>. You can play against the AI (Easy, Medium or Hard),
with a friend on the same device, or online.

**Apps:** the same game runs as a native iPhone app and Android app. Both bundle the game for offline play and
connect to the same server for online matches, so web, iPhone and Android players can play each other.

| Platform | How to build | Notes |
|---|---|---|
| Web | `npm run build` | Served by the game server below |
| iPhone | `npm run build:ios`, then Xcode | [IOS.md](IOS.md) |
| Android | `npm run build:android && npm run android:apk` | [ANDROID.md](ANDROID.md) |

## Run locally

```bash
npm ci
npm run build          # web build into dist/ (base path /game-upgradable/)
npm run server         # Express + WebSocket game server, serves dist/
npm test               # rules, AI and multiplayer checks
```

For a root-path build (`/` instead of `/game-upgradable/`), use `npx vite build --base=/`.
[CODEBASE.md](CODEBASE.md) describes the code layout: `src/` for the game rules, AI and 3D renderer, and
`server/` for rooms, rejoin, per-player fog filtering and the headless API.

## Server configuration

Set these environment variables for the game server:

- `PORT` and `HOST`: the address to listen on.
- `DB_PATH`: the SQLite database. The default is `data/game.db`.
- `JWT_SECRET`: required in production.
- `CHAT_PASSWORD`: the passphrase for the optional in-game agent chat (`server/chatAgent.ts`).
  Without it the chat is disabled.

## AI

The AI's strategy (army mix, research order, economy, when to attack, how it scores moves) is a set
of about 110 numbers, its genome (`src/aiGenome.ts`). Hard's genome was evolved by self-play: a
genetic algorithm over roughly 77,000 games. Medium and Easy are weaker genomes that also make more
random second-best moves. Every level uses every unit type, tech and economic action. The tools, the
method and the results are in [ai-evolve/README.md](ai-evolve/README.md).

## History

This repository joins two lines of work:

1. The original *Best Strategy* history, up to July 2026.
2. The *game-upgradable* instance (August–October 2026). It started as a copy of the game, without
   shared git history. It brought the asymmetric-tribes redesign, fog of war enforced on the server,
   multiplayer reconnect and forfeit, the mobile performance pass, and the iPhone and Android apps.

The merge commit joins the two histories. In the second line, a hard-coded chat passphrase was replaced by
the `CHAT_PASSWORD` environment variable in every commit before publishing.
