- range should not exeed the sight


⏺ ---                                                                                                                                               
  Analysis Results                                                                                                                                  
                                                                                                                                                    
  #1 — Damage Matrix (avg damage per hit)                                                                                                           
                                                                                                                                                    
               Warrior  Archer  Catapult  Horserider  HeavyKnight  Spearman                                                                         
  Warrior:        5       7        9          8            2           5                                                                            
  Archer:         5       7        9          8            2           5
  Catapult:       9      11       13         12            6           9                                                                            
  Horserider:     9      11       13         12            6           9
  HeavyKnight:   15      17       19         18           12          15
  Spearman:      10      12       14         13            7          10

  Hits to Kill

               Warrior  Archer  Catapult  Horserider  HeavyKnight  Spearman
  Warrior:        3       3        2          2           15           4
  Archer:         3       3        2          2           15           4
  Catapult:       2       2        1          2            5           3
  Horserider:     2       2        1          2            5           3
  HeavyKnight:    1       1        1          1            3           2
  Spearman:       2       2        1          2            5           2

  #3 — Cost-Effectiveness Score

  Unit          Cost  DPS/cost  EHP/cost  Score
  -----------   ----  --------  --------  -----
  Warrior:         1    5.00      3.00    8.00  ← cheapest, highest raw value
  Spearman:        3    3.33      1.33    4.67
  HeavyKnight:     7    2.14      2.14    4.29
  Horserider:      3    3.00      0.63    3.63  (speed 3 = avoids bad fights)
  Archer:          2    2.50      1.07    3.57  (range 2 = no retaliation)
  Catapult:        4    2.25      0.28    2.53  (AoE hits 2-3 targets simultaneously)

  ---
  Flags

  🚨 Heavy Knight needs a counter — warrior needs 15 hits to kill it (unreachable in practice). Only catapult (safe at range, 5 hits) or
  encirclement can beat it. This is probably intended given its cost 7, but worth knowing.

  ⚠️  Warrior vs Archer identical offense — same attack (10) means warrior adds zero offensive value over archer beyond being cheap cannon fodder.
  Warrior's only advantage is cost 1. If you want warriors to have a distinct role, consider bumping attack to 12.

  ✅ Catapult is fine — after your nerf (20→14), it kills catapult in 1 hit and warrior in 2, which is correct for a fragile siege unit. The score
  of 2.53 looks low but AoE typically hits 2-3 units per turn.

  ✅ Horserider now makes sense — 9 damage (up from 3), kills warrior in 2 hits, speed 3 for flanking. Well-differentiated from warrior.

  ✅ Spearman is the best frontline value — 4.67 score, 20 HP, survives warrior for 4 hits. Good tech purchase.
--------
  1. Horserider needs a redesign — either lower speed (1→2, flanker not rusher) or much higher HP/damage. Currently it's strictly worse than
  warriors despite costing 3x.
  2. Spearman research cost feels too expensive at this scale — maybe reduce to 3 or buff stats.
  3. Archers are strong but balanced — they require warrior cover to be effective.