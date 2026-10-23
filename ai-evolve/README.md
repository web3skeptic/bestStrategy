# AI evolution

The AI's decisions are driven by a **genome** (`src/aiGenome.ts`): about 110 numbers covering

- per faction: target army mix, research priorities, the odds for each exclusive tech branch,
  Builders and Farm goal, when to save Energy, when the army is big enough to march out, when to
  press the enemy Capital, how many raiders to send at the enemy economy, whether siege units go
  straight for the Capital;
- tactics: how a unit scores a move (pull toward its objective, retreat penalty, kill/hit bonus,
  hills, threat exposure, formation), Capital guards, support-unit positioning, target priorities;
- switches for the heavier features (strategic plan, lookahead, alpha-beta search);
- multipliers on every weight of the search evaluator (`src/aiEval.ts`).

Each difficulty is a config (`AI_DIFFICULTY` in `src/ai.ts`: randomness, saving, threat map) plus a
genome from `src/aiGenomes.ts`, which is generated from evolution results.

Capability floors are built into the AI rather than left to evolution: every unlocked unit type is
fielded at least once, every tech gets a priority (so all are eventually researched), and each
mutually exclusive branch (Healer / Drummer / Scout, Fortified Ranged / Scout Cavalry) is rolled
per game with every option keeping at least a 15% chance. `npm run test:ai-capabilities` checks
this for all three levels.

## Tools

All tools run matches on the real engine in parallel worker processes (one per CPU core minus one),
with a seeded RNG. Every pairing is played on the same maps with seats swapped, across all four
faction matchups.

| Command | What it does |
|---|---|
| `npx tsx ai-evolve/evolve.ts --run=NAME ...` | Genetic algorithm: population, tournament selection, crossover, Gaussian mutation in each gene's normalized range; elites re-tested every generation on new maps. Output in `ai-evolve/out/NAME/`. `--resume` continues a run. |
| `npx tsx ai-evolve/select.ts --run=NAME --panel=...` | Re-tests the top candidates of the last generations on fresh maps against a fixed panel and writes `selected.json`. |
| `npx tsx ai-evolve/bench.ts --pairs=a:b,...` | Win/loss/timeout table; `--detail=1` splits it by faction matchup. |
| `npx tsx ai-evolve/bench.ts --coverage=hard` | Which units, techs and actions a side used, per faction. |
| `npx tsx ai-evolve/trace.ts --genome=FILE` | Round-by-round trace of one game. |
| `npx tsx ai-evolve/export.ts --hard=FILE` | Writes `src/aiGenomes.ts`. |

A side is a difficulty (`hard`), a difficulty playing a stored genome (`hard@path/to/genome.json`),
or the original pre-evolution AI (`old-normal`, `old-hard`, `old-expert`). The original AI needs
`LEGACY_AI_DIR` pointing at a checkout of the code from before this work, for example
`git worktree add /tmp/ai-before a827465` (the last commit before the genome AI) and
`LEGACY_AI_DIR=/tmp/ai-before`.

Fitness is the mean match score: 1 for a win, 0 for a loss, and 0.4–0.6 for a game that hits the
round cap, by material balance. The narrow band for timeouts matters: with a wider band a passive
"stay ahead on material" strategy scored almost as well as winning.

## How the shipped levels were made (October 2026)

Records of every step are in `ai-evolve/runs/`.

1. **Baseline** (`baseline-original-ai.txt`). The original four levels were badly ordered (Hard lost to
   Normal 2–5, Expert vs Hard was 15 timeouts in 16 games) and rarely finished a game: as Agrar, Expert
   never hit an enemy Capital in 12 games. It never recruited Archers, Healers, Scouts or Oracles and
   never researched Healer, Range Booster, Scout Cavalry or Command II.
2. **Bugs found while tracing games** and fixed in the AI:
   - when every open site already had a claimant, every further unit (Builder included) was sent to a
     claimed one, so the whole Agrar army camped on a contested Fertile Site for the rest of the game;
   - a unit parked on its own Capital/Temple hex blocked every recruit from deploying there;
   - the "mass before attacking" rule counted units, which Agrar (2–3 Command per unit) could never reach.
3. **Phase A** (`hard-a.log`): 40 generations × 16 genomes, 48 games each against Medium and the current
   champion, with search switched off for speed (a game takes about 0.5 s without it, 10–15 s with it).
4. **Phase B** (`hard-b.log`): 40 more generations from the Phase A champion with the fixes above, the
   tighter timeout scoring, and the Phase A champion as a fixed opponent (72 games per genome).
5. **Selection** (`hard-b-select.txt`): the top 3 of the last 6 generations re-tested on 144 fresh games.
   Search on top of the selected genome scored 0.47 against the same genome without it, 30× slower, so
   Hard ships with search, lookahead and the strategic plan switched off.
6. **Levels** (`levels.txt`): Hard = the selected genome; Medium = the Phase A champion with 20% second-best
   moves; Easy = the default genome made passive (marches out late, presses rarely, no raids), with 35%
   second-best moves and no saving.

| Result | Wins | Losses | Timeouts | Score |
|---|---|---|---|---|
| Hard vs original Normal | 34 | 0 | 14 | 0.87 |
| Hard vs original Hard | 37 | 0 | 11 | 0.90 |
| Hard vs original Expert | 33 | 0 | 15 | 0.86 |
| Hard vs Medium | 20 | 7 | 21 | 0.63 |
| Medium vs Easy | 22 | 0 | 26 | 0.74 |
| Easy vs original Easy | 27 | 0 | 21 | 0.81 |

48 games per row, all four faction matchups, both seats, 80-round cap.

**Balance note.** Between equal AIs, Temple beats Agrar about 9 games in 10, and Agrar mirrors mostly
time out: Agrar's 2–3 Command units cap its army at about five against Temple's eight to twelve, and the
Capital (40 HP, a new defender every round) is hard to crack with five. That's a rules question, not an
AI one — re-evolve after any balance change (`evolve.ts --from=<current hard genome>`).
