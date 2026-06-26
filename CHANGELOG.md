# Changelog

## [balance-v2.2] — 2026-05-17

- **Randomized first-mover** in `createGameState()`. The +1/+2 aura
  compensations (v2.0/v2.1) only nudged the first-mover skew from 63% to
  ~59% — never enough. Random first-mover removes the asymmetry by
  construction. Applies to every game-creation path: local AI vs AI, online
  multiplayer rooms, headless API, bot tournament. Single source of truth.
- **Reverted P1 aura compensation** to a symmetric `aura: 2` for both
  players. With random first-mover, asymmetric aura would itself be unfair.
- **`firstPlayerIndex` added to `GameState`** so `endTurn()` correctly
  increments `turnNumber` when wrapping back to whoever started, regardless
  of which slot that was. Serializer defaults the field to `0` for
  backwards-compat with replays saved before this change.

## [balance-v2.1] — 2026-05-17

- **Player 1 starting aura `3 → 4`.** The +1 from v2.0 only nudged the
  first-mover skew from 63% to 62%. +2 lets P1 afford a horserider + warrior
  combo (4⚡), or upgrade-temple + recruit, on turn 1 vs P0's one-choice 2⚡.
  Targeting ~55/45 win split.

## [balance-v2] — 2026-05-17

### Game mechanics

- **Spearsman defense bonus capped.** Spearsman's `defenseBonusAgainst`:
  - vs horserider: `3.0 → 2.0`
  - vs heavyknight: `6.0 → 2.5`
  - Rationale: tournament-v2 showed counter_v1 (88.9%) sweeping the field because a
    2⚡ spearsman 1v1'd a 7⚡ heavy knight with HP to spare. Spearsman remains
    the cavalry counter, just no longer a hard-win-button.
- **Catapult max HP `10 → 16`.** The `unlock_catapult` tech branch had 0 winning
  uses in the v2 tournament — catapults died in 1 hit before they could fire
  their splash shot. The HP bump restores viability without changing attack/range.
- **Healer max HP `12 → 18`.** Healer aura (5HP/turn, radius 2) is supposed to
  pay back over several turns, but a 12HP body died in one focus-fire round and
  the strategy never materialised. 18HP gives sustain a turn to actually heal.
- **Player 1 starting aura `2 → 3`.** First-mover (P0) won 63% of v2 games — a
  26-point asymmetry. The extra 1⚡ doesn't fit any turn-1 unit cost difference
  perfectly so it tilts toward fairness without inverting the asymmetry.

### Bots

- **Adapted `bots/helpers.ts`** so the per-bot `estimateDamage()` matches the new
  defensive bonuses (otherwise bots would over-rate spearsman attacks vs HK).
- **Re-added `siege_v2` and `healer_blob_v2`**. Their v1 predecessors were removed
  after going winless in tournament v1; the balance changes make both viable again.
- **Cleared `bots/results.jsonl`** (archived to `bots/results.pre-balance-v2.jsonl`)
  so the new tournament starts from a clean slate. Stats from prior tournaments
  are not comparable across this rebalance.

## [pre-balance-v2] — 2026-05-16

Initial bot framework, REST + WS dispatcher unification, replays browser. See
git history for detail.
