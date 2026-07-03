# Best-Strategy — self-trained neural-net game bot

A small value network that learns to play **Best Strategy** in the headless engine
and challenges the hand-crafted **hard AI** (`src/ai.ts`). Pure TypeScript/Node
driving the *real* game — no forked rules, no Python.

> **Results (2026-07-03): the goal was not met — the net does not beat the hard AI.**
> Best config (value net + turn-level search) reached **40%** (120 games,
> CI[31.7, 48.9]) vs the hard AI; plain 1-ply greedy is **6%** (200 games). See the
> "Results" section below and `docs/best-strategy-rl/final-eval.txt` for the full
> breakdown and next levers.

## Method (why this design)

Beating a strong greedy AI from scratch with a small net is best done with the
classic **value network + shallow lookahead** recipe (TD-Gammon style), which the
task spec explicitly blesses:

- **Value net** `V(features) ≈ expected game outcome (±1)` for a reference player
  — a small MLP (`ml/mlp.ts`, tanh, Adam, hand-rolled).
- **Policy = 1-ply lookahead over V**: on the bot's turn, for each legal
  micro-action it clones the state, applies the action through the **shared
  `executeAction` dispatcher** (`server/actionDispatcher.ts` — the same authority
  the interactive game uses), scores the resulting position with `V` from the
  bot's POV, and takes the best action that *improves* the position; otherwise it
  ends the turn (greedy-improve-or-stop). The intent was to turn a decent value
  estimate into a globally-aware policy; in practice this 1-ply extraction proved
  too shallow to top the hard AI (see Results).
- **Training**: warm-start by regressing `V` on the outcomes of many
  hard-AI-vs-hard-AI games, then **DAgger/self-play** — generate games where the
  bot plays (vs hard and vs itself, with softmax exploration), label every visited
  state by the final outcome, add to a replay buffer and retrain. This covers the
  bot's *own* state distribution and fixes its mistakes.

## Files

| File | Purpose |
|------|---------|
| `ml/rng.ts` | Seedable RNG (patches `Math.random`) → deterministic episodes. |
| `ml/gameEnv.ts` | Gym-like env over the real game: `reset` / `legalMicros` (discrete action set + legality mask) / `applyMicro` (step via dispatcher) / fast `cloneState`. |
| `ml/features.ts` | 73-dim POV-relative observation (economy, army-by-type, tech, territory + movement-sensitive positional features). `FEATURE_NAMES` documents every dim. |
| `ml/mlp.ts` | Hand-rolled MLP value net (tanh, MSE, Adam), alloc-free hot path. |
| `ml/play.ts` | Turn policies (`hardTurn`, `makeValueBot` with pruned `botCandidates`), full-game runner with labelled sample collection + material tiebreak. |
| `ml/train.ts` | Warm-start + DAgger training pipeline; logs win-rate curve, checkpoints. |
| `ml/eval.ts` | NN-vs-hard evaluation, alternating sides + first move, Wilson 95% CI. |
| `ml/runNNHeadless.ts` | Play + print a full NN-vs-hard game log. |
| `ml/verifyEnv.ts` | STEP-0 env verification (determinism, invariants, speed, clone). |
| `ml/weights/value-net.json` | Final trained weights (small, committed). |

## Reproduce

```bash
cd /opt/best-strategy

# 0. verify the RL env
npx tsx ml/verifyEnv.ts

# 1. train (warm-start + DAgger). Config via env vars (defaults in ml/train.ts):
WARM_GAMES=1200 ITERS=6 ITER_GAMES=160 EVAL_N=100 TAG=main npx tsx ml/train.ts
#   → checkpoints to ml/weights/, win-rate curve to
#     docs/best-strategy-rl/training-curve.txt

# 2. evaluate the final net vs the hard AI (≥200 games, Wilson CI)
npx tsx ml/eval.ts ml/weights/value-net.json 300

# 3. watch one NN-vs-hard game
SAVE=/tmp/game.txt npx tsx ml/runNNHeadless.ts ml/weights/value-net.json 424242 0
```

## Observation encoding (73 dims, POV-relative)

`featurize(state, ref)` builds features from `ref`'s point of view (`me` vs
aggregated `them`): aura/income, pop/pop-cap, temple counts + avg level, turn
number, whose-turn; per-unit-type counts for both sides; total HP; both sides'
12-tech bitmasks; and **movement-sensitive** positional features (advancement
toward enemy temples, units on/adjacent-to capturable temples, temples under
threat, units in striking range, mean distance to the enemy, units on hills,
portal presence, per-temple contest). The positional block changes when a unit
moves, giving the value net a gradient over movement so 1-ply lookahead can pick
tactically. See `FEATURE_NAMES` in `ml/features.ts`.

## Action space

The discrete action set is the set of legal `UnifiedAction` micro-actions from the
dispatcher, enumerated deterministically (`legalMicros`); the legality mask is
implicit (every enumerated action is legal). A turn is a sequence of micros ending
in `end-turn`. The bot evaluates a pruned subset (`botCandidates`) for tractability
while the env exposes the complete set.

## Reward

Sparse: **+1 win / −1 loss / 0 draw** at episode end, credited to every visited
state from that player's POV. Games are length-capped; unfinished games are
decided by material (temples, then HP) so training/eval never hang.

## Results (2026-07-03) — honest summary

**Goal:** NN beats the hard AI ≥55% over 200+ games (Wilson CI-low >50%).
**Outcome: not met.** No configuration beat the hard AI.

All win-rates are NN-vs-hard, 2p, Wilson 95% CI. **Authoritative** rows are the
final large-N evals on the best checkpoint (`value-net-main.json`):

| Config | Win-rate | Games | CI |
|--------|----------|-------|-----|
| Value net + 1-ply greedy (authoritative) | 6.0% | 12/200 | [3.5, 10.2] |
| **Value net + turn-level search (best overall, authoritative)** | **40.0%** | **48/120** | **[31.7, 48.9]** |
| — wider K=4 candidate search | 24.0% | 12/50 | [14.3, 37.4] |
| greedy warm-start (imitation) | 2.5% | 1/40 | [0.4, 12.9] |
| greedy DAgger iter 1 | 0.0% | 0/40 | [0.0, 8.8] |
| greedy DAgger iter 2 (best ckpt) | 5.0% | 2/40 | [1.4, 16.5] |
| greedy linear-output, warm-start | 7.5% | 6/80 | [3.5, 15.4] |

Greedy stays ≤7.5% (6% over 200 games). Turn-level search lifts that to **40%** —
a big jump that confirms `V` is a useful leaf evaluator — but the CI upper bound
(48.9%) is still below 50%, so it does not reach parity.

**Why:** the bottleneck is *policy extraction*, not value learning — training loss
fell steadily (0.48→0.42 MSE, i.e. `V` predicts outcomes fine) but a 1-ply greedy
read of `V` under-acts (often `bestV ≤ curV` → ends turn early) and gets
out-developed by the hard AI's multi-step plans (multi-spawn waves, teleport
flanks, focus-fire). See `docs/best-strategy-rl/sample-nn-vs-hard.log`: the NN is
eliminated by round 24 (0 units/temples) while the hard AI ends with 19 units and
3 L5–6 temples.

**Next levers (rough payoff order):** (1) a **stronger evaluator first** — a real
policy head (behavioural cloning of the hard AI + policy-gradient self-play) instead
of reading `V` greedily, plus richer features / bigger net / far more self-play
compute (this run was minutes: DAgger stopped at iter 2 of 12); (2) **then**
principled search on top (expectimax/alpha-beta over turns, or MCTS with the
improved net as leaf) — tuning width/depth empirically, since naive widening (K=4,
24%) scored *below* 1-ply (40%): over-searching a weak net amplifies its errors.
Full write-up: `docs/best-strategy-rl/final-eval.txt`.
