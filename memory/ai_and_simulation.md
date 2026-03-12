---
name: ai_and_simulation
description: Normal AI and Hard AI behavior, simulation system, strategy tournament results
type: project
---

# AI and Simulation

## Normal AI (`runAITurn` in `src/ai.ts` — 381 lines)

**Spawn phase** (at each temple):
Priority order: heavyknight (20% if unlocked+affordable), catapult (20%), horserider (25%), spearsman (25%), healer (15%), damageBooster (15%), rangeBooster (15%), archer (fallback), warrior (fallback).

**Unit action loop:**
1. If enemy in range → attack lowest HP enemy
2. Else if not moved → find nearest enemy, move toward it
3. After move, if enemy in range → attack

**Helper functions:**
- `findNearestEnemy(pos, playerId)` — closest visible enemy
- `bestMoveToward(unit, target)` — best reachable hex minimizing distance
- `findAttackTarget(unit)` — lowest HP enemy in effective range
- `calcDamage(atk, def, encMult)` — matches game.ts Box-Muller formula
- `doAIAttack(attacker, target)` — full combat (splash + revenge) matching game.ts

## Hard AI (`runHardAITurn` in `src/ai.ts`)

Based on Economic strategy (proven ~99% win rate by simulation).

**Phase 1** (home temple level < 3):
- Upgrade home temple toward level 3
- Spawn 1 warrior as guard if none alive

**Phase 2** (home temple level ≥ 3):
- Research `unlock_spearman`
- Upgrade captured neutral temples to level 2
- Spawn spearsmen and archers in 2:1 ratio (2 spearsmen per 1 archer)

**Movement priority (each unit):**
1. Standing on uncaptured temple → capture it
2. Enemy in attack range → attack
3. Move toward closest of: uncaptured temple OR nearest enemy (whichever is nearer)

Home temple position for Player 1: `(q:4, r:-2)`.

---

## Simulation System (`simulation/`)

Standalone scripts run with `tsx`. Simulate games on a 1D linear field (not hex).

**Map layout:**
- Field size: 30 positions
- Player 0 home temple: pos 2
- Neutral temple: pos 15
- Player 1 home temple: pos 28

**Key constants (match game.ts):**
- `MAX_TURNS`: 200
- `TECH_COST`: 5
- `TEMPLE_INCOME_PER_LEVEL`: 2
- `TEMPLE_MAX_LEVEL`: 5
- `HEALER_HEAL_AMOUNT`: 5

**Combat engine (`combatTick`):**
- Turn order: by speed descending (ties favor player 0)
- Ranged units don't advance past own melee frontline
- Healers: heal most-injured nearby ally or move toward them
- Support boosters: follow own frontline (closest melee unit)
- Normal units: attack lowest HP in range OR move toward closest enemy

---

## Strategy Tournament

5 strategies tested in round-robin (500 games per matchup):

| Strategy | Description |
|----------|-------------|
| **Rusher** | Never researches; spams horserider (cost 3) → warrior (cost 1). Pure rush. |
| **TechHeavy** | Research unlock_heavyknight + unlock_catapult first; spam heavyknights + catapults. Upgrade home temple to L2 after research. ~1 catapult per 3 heavyknights. |
| **Economic** | **Phase 1:** Upgrade home temple to L3, spawn 1 warrior guard. **Phase 2:** Research unlock_spearman, spawn spearsmen:archers 2:1, upgrade neutral temples to L2. |
| **Counter** | Research unlock_spearman early; spawn spearsmen (if cavalry seen) + archers. Upgrade home temple to L2. No heavyknight/catapult. |
| **SupportArmy** | Research healer + damageBooster + spearsman. Spawn 1 healer + 1 damageBooster per 3 combat units. Spearsmen as primary combat. |

**Key finding: Economic wins ~99% of the time against all other strategies.**

**Why Economic wins:**
- Early temple income investment (L3 = 6 aura/turn) far outpaces all other strategies' income
- High aura income enables continuous unit production that overwhelms early rushers
- Spearsmen (cost 2, strong stats, 3× bonus vs cavalry) are cost-efficient against common units
- Neutral temple capture adds additional income stream

**Tournament output includes:**
- Wins/losses/draws per strategy
- Head-to-head matrix
- Unit type counts per strategy
- Aura spent on tech
- Average temples owned at game end
