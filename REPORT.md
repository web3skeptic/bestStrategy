# Bot Tournament & Balance Report

A session log of (1) building a bot tournament framework against the existing
hex-strategy game, (2) running iterative tournaments to surface game-design
imbalances, (3) shipping balance changes, and (4) training a neural-network
bot from past replay data.

## 1. Framework changes

### 1.1 Unified action dispatcher

Before: the WebSocket transport (`server/gameManager.ts`) and the REST headless
transport (`server/headlessApi.ts`) each had their own `switch(action)` block
that validated and executed actions. Same rules, two divergent codepaths.

After: a single `server/actionDispatcher.ts` exports `executeAction(state,
playerSlot, action, params)` returning `{ok, error?, log, legalMoves?}`. Both
transports are now thin adapters. The WebSocket protocol gained:
- `{ type: 'action', action, params }` — unified action shape for agents
- `request_legal_moves` / `request_rules` — read-only queries
- enriched `action_error` carrying `legalMoves`

The REST `/legal-moves` endpoint now returns moves as `{q, r}` objects (was
strings) so the shape matches `POST /action` input exactly.

### 1.2 Replays browser

`replays.html` + `src/replays.ts` — a searchable, sortable table of every
recorded game at `/replays`. Filters: text search, finished-only, decisive-only.
Sort by date, players, winner, event count, duration. Each row links to the
existing `/replay?gameId=…` viewer.

### 1.3 Vite proxy fix

`vite.config.ts` had `proxy: { "/api": "http://localhost:3000" }` but the
backend runs on 4567. Replaced with `process.env.VITE_API_TARGET ?? "http://localhost:4567"`.

## 2. Bot framework

```
bots/
  client.ts             HTTP client + types
  helpers.ts            terrain, smart targeting, damage estimator, playStandardTurn
  registry.ts           BotDef interface + bot registry
  bot_*.ts              one file per bot (13 sophisticated + 2 baselines)
  runMatch.ts           single-match CLI
  runTournament.ts      double round-robin CLI
  stats.ts              aggregate results.jsonl into win-rate tables
  results.jsonl         append-only match log
  neural/               imitation-learning MLP infrastructure
```

Bots are pure REST clients of `/api/headless/*` — they authenticate, create
a game, then alternate turns calling `legal-moves` + `action`. The unified
dispatcher means a future bot could speak WebSocket instead with no rule
changes.

### Bot identities (sophisticated pool)

| ID | Strategy |
|---|---|
| `adaptive_v1` | Reads opponent each turn, counter-picks tech + recruits |
| `flex_v1` | Adaptive++ with teleport building + turtle-cracker |
| `cavalry_v1` | Heavy Knight + horse_sight + roads, speed-3 wedge |
| `counter_v1` | Spearsman + infantry_move + damageBooster (anti-cavalry) |
| `assassin_v1` | HK rush, snipes enemy support / races enemy temple |
| `lategame_v1` | Home temple to L4, then HK + spearsman mix |
| `econ_titan_v1` | Home temple to L5, ramps slowly |
| `teleport_v1` | Teleport pair early for force projection |
| `encircle_v1` | Surrounds targets for up to 2× encirclement damage |
| `swarm_v1` | Warrior spam + damageBooster |
| `siege_v2` | Catapult + splash (rebalanced post-v2) |
| `healer_blob_v2` | Combat units cluster around healer (rebalanced) |
| `neural_v1` | Imitation MLP trained on prior winning replays |

Baselines kept for comparison: `rush_v1`, `econ_v1`.

## 3. Tournament evolution

| Tournament | Pool | Winner | Winner rate | First-mover skew (P0 win %) |
|---|---|---|---|---|
| **v1** | 10 sophisticated | `adaptive_v1` | 94.4% | 63.0% |
| **v2** | 10 sophisticated (replaced bottom 5) | `counter_v1` | 88.9% | 62.6% |
| **balance-v2** | 10 sophisticated, post-rebalance | `adaptive_v1` | 77.3% | 62.6% |
| **balance-v2.1** | same, P1 starting aura +2 | `cavalry_v1` | 81.8% | 59.2% |
| **balance-v2.2** | same, random first-mover | `cavalry_v1` | 81.8% | 48.1% |
| **neural-v1 (initial)** | + neural_v1 (broken) | `cavalry_v1` | 83.3% | — |
| **neural-v1 (fixed)** | + neural_v1 (retrained) | `neural_v1` | 83.3% | — |

Each row's `results.*.jsonl` is preserved as an archive.

## 4. Balance changes (committed)

### balance-v2

| Change | Reason | Effect |
|---|---|---|
| Spearsman def bonus vs horse 3→2, vs HK 6→2.5 | counter_v1 swept v2 at 88.9%; 2⚡ spearsman 1v1'd 7⚡ HK with HP to spare | counter dropped to 45.5%; cavalry archetype rose from 61% → 73% |
| Catapult HP 10→16 | `unlock_catapult` had 0% win share | siege_v2 went from "impossible" to 31.8%; tech branch is viable |
| Healer HP 12→18 | Healer died in 1-2 hits before its 5HP aura paid back | healer_blob still bottom (~12%), suggesting strategy is broken at a higher level than stats |
| P1 starting aura 2→3 | First-mover P0 won 63% of games | barely moved the needle (62.6%) |

### balance-v2.1

- P1 starting aura 3→4 (compounding attempt). Skew → 59.2%. Still skewed.

### balance-v2.2 (the real fix)

- **Random first-mover** in `createGameState()`. Skew dropped to 48.1% — within
  noise of 50/50.
- Reverted P1 aura to 2 (asymmetric aura unfair with random first-mover).
- Added `firstPlayerIndex` to GameState so `endTurn()` correctly increments
  `turnNumber` regardless of who started.

Insight: the +1/+2 aura experiments closed ~7 points across two iterations;
**one structural fix closed 22 points in one change**. Surface-level
parameter tuning was the wrong lens for the problem.

## 5. Neural bot

### Design

Imitation learning from existing winning replays.

- **Features**: 32-dim per `(state, player)` — aura, popcap usage, unit counts
  by type for both players, temple control, neutral temples available, average
  own-temple level, tech researched (one-hot for 8 key techs).
- **Network**: 32 → 64 (ReLU) → 8 (softmax) — small from-scratch MLP, no deps.
  ~200 lines including forward, backprop, and SGD-with-momentum.
- **Output**: one of 8 action types (move, attack, recruit, capture,
  upgrade-temple, research, build-teleport, end-turn).
- **Training**: SQLite `replay_events ⨝ game_replays` filtered to winner's
  events. Sqrt-inverse class weights to handle imbalance (move 52%, end-turn 9%,
  build-teleport 0.1%).
- **Bot logic**: each turn, predict action probabilities, iterate in rank
  order, execute first feasible action via existing micro-helpers. Masks
  end-turn while any unit has unused actions.

### Training run

```
593 finished games / 117k samples
8 action classes, sqrt-inverse weighted cross-entropy
20 epochs, hidden=64, lr=0.005
final: train acc 53.8%, val acc 55.3%
```

### First attempt failed

Full-inverse class weights pushed `end-turn` predictions to ~5% even at game
start — high enough to fire after the first macro action succeeded. Bot ended
turns before doing anything useful. **0 wins / 23 losses / 1 timeout** in
24 games.

Diagnosis took five minutes (run a single inference, print the rank order).
Two fixes:

1. **Sqrt-inverse class weights** instead of full inverse. Val accuracy
   jumped 35% → 55%.
2. **Bot-side mask** on `end-turn` while any unit still has unused actions.

After fixes: **20 wins / 4 losses (83.3%, #1 in tournament)**.

### Limitations

- It's imitation, not RL. No reward signal, no policy gradient, no self-play.
  Just "predict what a winner would do here."
- Features are shallow — no per-hex board encoding, no positional info, no
  fog-of-war. The model knows composition but not geometry.
- The 1-1 splits with the top 4 fixed strategies (cavalry, counter, assassin,
  lategame) mean it's not strictly better than committed plans — it's an
  "average winner" meta-strategy that beats whichever specific plan didn't
  match this game's context.
- Trained on this tournament's data. Major meta changes (new units, new map)
  would require retraining.

## 6. Bugs surfaced

### Bug — tech effects apply only to newly-spawned units (except `catapult_splash`)

`applyTechToStats()` in `src/game.ts:103-111` rewrites a unit's stats based on
researched tech, but is only called from `createUnit()` (line 127) — i.e., at
spawn time. After research:

- `researchTech()` (line 554) retroactively patches `splash` on already-living
  catapults if `catapult_splash` is researched (lines 562-568).
- For **every other tech**, existing units do **not** get the bonus
  retroactively.

The four affected techs and their descriptions:

| Tech | Description | Affected stat | Retroactive? |
|---|---|---|---|
| `roads` | "All your units gain +1 movement speed" | `speed` | **No (bug)** |
| `infantry_move` | "Warriors and Spearsmen gain +1 movement speed" | `speed` | **No (bug)** |
| `longrange_hp` | "Archers and Catapults gain +5 max HP" | `maxHp` | **No (bug)** |
| `horse_sight` | "Horseriders and Heavy Knights gain +1 vision range" | `vision` | **No (bug)** |
| `catapult_splash` | "Increases Catapult splash radius by 1" | `splash` | Yes ✅ |

Concretely: a player who starts the game with 2 warriors (speed 1) and
researches `roads` on turn 1 (with `aura: 5`) will see their warriors stay at
speed 1. New warriors recruited afterward will have speed 2. The description
says "All your units" — implying retroactive.

### Same bug affects:
- `infantry_move` (warrior + spearsman speed)
- `longrange_hp` (archer + catapult max HP — players researching this with
  existing archers see their archers unchanged)
- `horse_sight` (cavalry vision)

### Fix sketch

Replicate the `catapult_splash` retroactive loop for the other four cases:

```ts
// researchTech() — after .add(techId)
if (techId === 'roads' || techId === 'infantry_move' || ...) {
  for (const unit of state.units) {
    if (unit.playerId !== player.id) continue;
    if (unit.hp <= 0) continue;
    // Re-apply tech to unit's current stats (idempotent via the same fn).
    applyTechToStats(unit.stats, unit.type, state.playerTech[player.id]!);
  }
}
```

Note: `applyTechToStats` is not idempotent as written — it would double-apply
on re-research. The fix needs either a tracking field or a "rebuild from base
stats then apply all tech" pattern.

### Why it didn't show up in bot tournaments

The bots that researched `roads` (cavalry_v1, teleport_v1, occasionally
others) usually do so on **turn 2-3** after their starting warriors have
already died or been replaced. The effect is on **future** spawns, which is
where the bot's army comes from anyway. So the bug exists but the bots'
strategy patterns mostly don't depend on the retroactive part.

In a human PvP game this would feel like a bug ("I researched roads, why
didn't my warriors get faster?").

## 7. Commits

```
2b52554 feat(bots/neural): imitation-learned MLP bot trained on tournament replays
58255f9 balance(v2.2): randomize first-mover across all game paths
0c20f8f balance(v2.1): P1 starting aura 3 -> 4
178d38a feat(bots+balance): tournament framework + balance-v2 rebalance
```

## 8. Suggested next work

In rough priority order:

1. **Fix the tech-retroactive bug.** `roads` + 3 others currently lie to the
   player. Single-function change in `researchTech()`.
2. **Heavier healer buff.** 18 HP wasn't enough — `healer_blob_v2` stayed at
   12.5%. Try +heal amount 5→8 OR +radius 2→3.
3. **Self-play for neural_v1.** Replace imitation with policy gradient over
   actual win/loss reward. Should turn 1-1 splits with cavalry/counter into
   2-0 sweeps.
4. **Richer features for neural_v1.** Add per-hex board encoding (~50×3 = 150
   dims), distance-to-nearest-enemy, terrain bitmap. Lets the network learn
   positional micro the current bot delegates to hand-coded helpers.
5. **L4 / L5 temple cost rebalance.** Curve `2^n` (2, 4, 8, 16) is too steep
   — `econ_titan_v1` only viable when no one pressures. Linear or `n*3` would
   make late-game economic plans real.

## 9. Reproducing

```bash
# Run dev servers
nvm use 22 && PORT=4567 npm run server:dev   # backend
nvm use 22 && npm run dev                    # vite

# Train neural bot from scratch
npx tsx bots/neural/train.ts --epochs 12 --hidden 64 --lr 0.005

# Run a tournament
npx tsx bots/runTournament.ts                # all sophisticated
npx tsx bots/runTournament.ts --include-baselines

# Inspect win-rate stats
npx tsx bots/stats.ts                        # all time
npx tsx bots/stats.ts --bot neural_v1        # one bot

# Browse replays in the UI
open http://localhost:4567/replays
```
