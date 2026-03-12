---
name: game_mechanics
description: Complete game rules — units, combat, temples, tech tree, terrain, win conditions, teleports
type: project
---

# Game Mechanics

## Unit Types, Stats & Costs

| Unit | Cost | HP | Attack | Defense | Speed | Range | Vision | Notes |
|------|------|----|--------|---------|-------|-------|--------|-------|
| warrior | 1 | 15 | 10 | 5 | 1 | 1 | 2 | Default unlocked |
| archer | 2 | 15 | 10 | 3 | 2 | 2 | 2 | Default unlocked |
| horserider | 3 | 15 | 16 | 2 | 2 | 1 | 3 | Default unlocked |
| spearsman | 2 | 20 | 15 | 5 | 2 | 1 | 2 | Needs unlock_spearman; 3× bonus vs horserider/heavyknight |
| catapult | 4 | 10 | 14 | 1 | 1 | 3 | 4 | Needs unlock_catapult; canBeRevenged:false |
| heavyknight | 7 | 22 | 20 | 8 | 3 | 1 | 2 | Needs unlock_heavyknight |
| healer | 3 | 12 | 4 | 2 | 2 | 1 | 3 | Support; heals 5 HP/turn to allies within 2 |
| damageBooster | 3 | 12 | 4 | 2 | 2 | 1 | 3 | Support; +5 attack to allies within 2 |
| rangeBooster | 3 | 12 | 4 | 2 | 2 | 1 | 3 | Support; +1 range to allies within 2 |

Default unlocked units: warrior, archer, horserider.

## Combat Formula

```
damage = max(0, round(randomMult × encirclementMult × typeBonus × (attacker.attack - defender.defense)))

randomMult = 1.0 + Normal(0, 0.2), clamped to [0.5, 1.5]   // Box-Muller distribution
typeBonus   = unit.stats.bonusAgainst[targetType] ?? 1.0     // spearsman: 3.0 vs horserider/heavyknight
```

## Encirclement System (`calculateEncirclement`)
- `ratio` = perimeter hexes blocked / total perimeter (0–1)
- `opposingRatio` = pinch count / pinch max (opposite-side blocks)
- `attackMultiplier`:
  - if ratio > 0.5: encirclementBonus = ((ratio − 0.5) / 0.5) × 0.5
  - opposingBonus = opposingRatio × 0.5
  - max multiplier = 2.0 (fully encircled + fully opposing)

## Combat Flow (`attackUnit`)
1. Calculate encirclement for attacker and target
2. Apply terrain bonuses (hill: +2 defense, +1 range, +1 vision)
3. Apply support bonuses (damageBooster: +5 attack; rangeBooster: +1 range)
4. Apply type bonus multiplier
5. Deal damage to target
6. Splash damage: catapult only (with catapult_splash tech: splash radius 1, factor 0.5)
7. Retaliation: if target survives and `canBeRevenged=true` and attacker in range → target retaliates
8. If melee attacker kills ranged target → attacker steps onto that tile

## Temple System
- `TEMPLE_AURA_PER_LEVEL`: 2 aura/turn per level
- `TEMPLE_MAX_LEVEL`: 5
- `TEMPLE_POP_CAP_PER_LEVEL`: +2 population cap per level
- Upgrade costs: 2^currentLevel (L1→L2: 2, L2→L3: 4, L3→L4: 8, L4→L5: 16)
- Capture: move unit onto temple hex (without attacking that turn) → captureTemple()
- Income is granted at start of each player's turn: `aura += sum(temple.level × 2)` for owned temples
- Neutral temples start at level 1

## Healer Mechanics
- At turn start: for each allied healer, heal all allies within range 2 by 5 HP (capped at maxHp)

## Support Unit Ranges
- `SUPPORT_RANGE`: 2 hexes
- `HEALER_HEAL_AMOUNT`: 5
- `DAMAGE_BOOST_AMOUNT`: +5 attack
- `RANGE_BOOST_AMOUNT`: +1 range

## Tech Tree (14 entries, cost 5 aura each)
| Tech ID | Prerequisites | Effect |
|---------|--------------|--------|
| unlock_spearman | — | Unlocks spearsman unit |
| unlock_heavyknight | — | Unlocks heavyknight unit |
| unlock_catapult | — | Unlocks catapult unit |
| catapult_splash | unlock_catapult | Catapult gains splash:1, splashFactor:0.5 |
| roads | — | +1 speed for all units |
| teleports | — | Unlock teleport portal building |
| infantry_move | — | +1 speed for warrior & spearsman |
| longrange_hp | — | +5 HP for archer & catapult |
| horse_sight | — | +1 vision for horserider & heavyknight |
| unlock_healer | — | Unlocks healer unit |
| unlock_damagebooster | — | Unlocks damageBooster unit |
| unlock_rangebooster | — | Unlocks rangeBooster unit |

Some branches are mutually exclusive (see `canResearch` in game.ts).

## Terrain System
- **Hills:** +2 defense, +1 vision, +1 range for occupying unit
- **Forests:** Observer in forest → vision capped at 1; forests block line of sight
- **Walls:** impassable, block movement and sight
- Owned temples provide 2 vision range (even without a unit)

## Teleport Portal System
- `TELEPORT_BUILD_COST`: 5 aura (per pair)
- `TELEPORT_RADIUS`: 2 hexes from a temple
- `TELEPORT_MAX_PER_TEMPLE`: 1 portal per temple
- Requires `teleports` tech to build
- Portals come in pairs (templeA ↔ templeB)
- Movement: unit steps on portal → auto-teleported to paired exit → placed on free neighbor of exit
- If no free neighbors at exit, unit stays on portal tile

## Win Conditions
1. Control all temples (every temple owned by same player)
2. Eliminate all opponents (only one player has units or temples remaining)
3. Draw on simultaneous elimination

## Turn Flow (`endTurn`)
1. Deselect units, reset hasMoved/hasAttacked for current player
2. Clear spawnedTempleIds
3. Advance to next player with units or temples
4. Grant aura income (sum of owned temple levels × 2)
5. Apply healer healing for new current player
6. Update visibility
7. Check win condition

## Map Setup (`createGameState`)
- Hex grid radius 6
- 4 temples: 2 player-owned (start), 2 neutral
- 4 starter warriors (2 per player)
- Player 0 home temple: (q:-4, r:2); Player 1 home temple: (q:4, r:-2)
