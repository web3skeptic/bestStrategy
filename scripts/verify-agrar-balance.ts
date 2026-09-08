// Agrar elite/heavy balance pass verification: new Agrar combat-unit stats,
// unchanged Temple stats, the "Home Ground" +1 DEF passive (Capital/active
// Farm, non-stacking, Agrar-only), the ROAD_SEGMENTS_PER_ACTIVATION 3->2
// cap end-to-end (engine, server action dispatcher, human-UI-equivalent
// path building), and AI/evaluator awareness of Home Ground. Exercises the
// real engine mutators (no forked logic) — createGameState, buildRoadPath,
// executeAction (the same dispatcher the WebSocket/headless transports use).
//
// Run with: npx tsx scripts/verify-agrar-balance.ts
import {
  createGameState, chooseFaction, createUnit, getPlayerCapital, getEffectiveDefense,
  isOnAgrarHomeGround, HOME_GROUND_DEFENSE_BONUS, getValidRoadHexes, canBuildRoad,
  isLegalRoadTile, buildRoadPath, endTurn, getRoadAt,
} from '../src/game';
import { AGRAR_UNITS, TEMPLE_UNITS, ROAD_SEGMENTS_PER_ACTIVATION, ROAD_COST_PER_HEX } from '../src/factions';
import { estimateDamage, evaluateState } from '../src/ai';
import { executeAction } from '../server/actionDispatcher';
import { hexDistance, hexNeighbors, hexKey } from '../src/hex';
import type { GameState, HexCoord } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function setup(f0: 'agrar' | 'temple' = 'agrar', f1: 'agrar' | 'temple' = 'temple'): GameState {
  const state = createGameState();
  chooseFaction(state, 0, f0);
  chooseFaction(state, 1, f1);
  for (const p of state.players) p.aura = 200;
  return state;
}

// Same re-centering pattern used throughout the rest of this test suite
// (verify-economy.ts/verify-roads.ts) — pins a player's Capital to a known
// spot and clears the area so random map layout can never make placement
// flaky.
function clearArea(state: GameState, playerId: number, radius = 5): void {
  const capital = state.capitals.find(c => c.playerId === playerId)!;
  capital.pos = { q: 0, r: 0 };
  const far = state.mapRadius * 6;
  let offset = 0;
  for (const c of state.capitals) if (c.playerId !== playerId) c.pos = { q: far, r: far + offset++ };
  for (const s of state.strategicSites) s.pos = { q: far, r: far + offset++ };
  for (const u of state.units) u.pos = { q: far, r: far + offset++ };
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      const key = hexKey({ q: capital.pos.q + dq, r: capital.pos.r + dr });
      state.hills.delete(key); state.walls.delete(key); state.forests.delete(key);
    }
  }
}

function advanceOneRound(state: GameState): void {
  endTurn(state);
  endTurn(state);
}

// ── 1. Agrar combat-unit stats ──────────────────────────────────────────────
console.log('\n=== Agrar combat roster: new stats (elite/heavy pass) ===');
{
  const expected: Record<string, { cost: number; hp: number; attack: number; defense: number; speed: number; range: number; commandCost: number }> = {
    warrior:     { cost: 2, hp: 20, attack: 9,  defense: 5, speed: 1, range: 1, commandCost: 2 },
    archer:      { cost: 3, hp: 17, attack: 10, defense: 4, speed: 1, range: 2, commandCost: 2 },
    spearsman:   { cost: 3, hp: 22, attack: 9,  defense: 6, speed: 1, range: 1, commandCost: 2 }, // Pikeman
    horserider:  { cost: 5, hp: 25, attack: 13, defense: 6, speed: 1, range: 1, commandCost: 3 }, // Warden (roster pass — was the Knight, SPD 2)
    catapult:    { cost: 5, hp: 20, attack: 13, defense: 3, speed: 1, range: 3, commandCost: 3 },
    heavyknight: { cost: 7, hp: 29, attack: 16, defense: 6, speed: 2, range: 1, commandCost: 3 },
  };
  for (const [slot, want] of Object.entries(expected)) {
    const def = AGRAR_UNITS.find(u => u.slot === slot)!;
    check(`${def.displayName}: cost=${want.cost}`, def.cost === want.cost, `got ${def.cost}`);
    check(`${def.displayName}: hp=${want.hp}`, def.hp === want.hp, `got ${def.hp}`);
    check(`${def.displayName}: attack=${want.attack}`, def.attack === want.attack, `got ${def.attack}`);
    check(`${def.displayName}: defense=${want.defense}`, def.defense === want.defense, `got ${def.defense}`);
    check(`${def.displayName}: speed=${want.speed}`, def.speed === want.speed, `got ${def.speed}`);
    check(`${def.displayName}: range=${want.range}`, def.range === want.range, `got ${def.range}`);
    check(`${def.displayName}: commandCost=${want.commandCost}`, def.commandCost === want.commandCost, `got ${def.commandCost}`);
  }
}

console.log('\n=== Agrar support units + Builder are UNCHANGED by this pass ===');
{
  const expected: Record<string, { cost: number; hp: number; attack: number; defense: number; commandCost: number }> = {
    healer:        { cost: 3, hp: 15, attack: 6, defense: 3, commandCost: 1 },
    damageBooster: { cost: 3, hp: 14, attack: 6, defense: 3, commandCost: 1 },
    rangeBooster:  { cost: 3, hp: 14, attack: 6, defense: 3, commandCost: 1 },
    founder:       { cost: 2, hp: 12, attack: 5, defense: 3, commandCost: 1 },
  };
  for (const [slot, want] of Object.entries(expected)) {
    const def = AGRAR_UNITS.find(u => u.slot === slot)!;
    check(`${def.displayName}: unchanged (cost/hp/atk/def/command)`,
      def.cost === want.cost && def.hp === want.hp && def.attack === want.attack
      && def.defense === want.defense && def.commandCost === want.commandCost,
      JSON.stringify(def));
  }
}

console.log('\n=== Temple roster is completely UNCHANGED by this pass ===');
{
  const expected: Record<string, { cost: number; hp: number; attack: number; defense: number; speed: number; range: number; commandCost: number }> = {
    warrior:       { cost: 1, hp: 13, attack: 10, defense: 4, speed: 2, range: 1, commandCost: 1 },
    archer:        { cost: 2, hp: 12, attack: 11, defense: 3, speed: 2, range: 2, commandCost: 1 },
    spearsman:     { cost: 2, hp: 14, attack: 10, defense: 5, speed: 2, range: 1, commandCost: 1 }, // Spearsman
    horserider:    { cost: 3, hp: 14, attack: 13, defense: 4, speed: 3, range: 1, commandCost: 2 }, // Raider
    catapult:      { cost: 4, hp: 15, attack: 12, defense: 3, speed: 2, range: 3, commandCost: 2 }, // Mobile Siege
    heavyknight:   { cost: 6, hp: 18, attack: 17, defense: 5, speed: 3, range: 1, commandCost: 2 }, // Champion
    healer:        { cost: 3, hp: 15, attack: 7, defense: 2, speed: 2, range: 1, commandCost: 1 },
    damageBooster: { cost: 3, hp: 15, attack: 7, defense: 2, speed: 2, range: 1, commandCost: 1 },
    rangeBooster:  { cost: 3, hp: 15, attack: 7, defense: 2, speed: 2, range: 1, commandCost: 1 },
  };
  for (const [slot, want] of Object.entries(expected)) {
    const def = TEMPLE_UNITS.find(u => u.slot === slot)!;
    check(`Temple ${def.displayName} (${slot}): unchanged`,
      def.cost === want.cost && def.hp === want.hp && def.attack === want.attack && def.defense === want.defense
      && def.speed === want.speed && def.range === want.range && def.commandCost === want.commandCost,
      JSON.stringify(def));
  }
}

// ── 2. Home Ground ───────────────────────────────────────────────────────────
console.log('\n=== Home Ground: +1 DEF adjacent to the Capital ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const unit = createUnit('warrior', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(unit);
  check('adjacent to own Capital: isOnAgrarHomeGround is true', isOnAgrarHomeGround(state, unit));
  check('adjacent to own Capital: effective DEF is base + 1',
    getEffectiveDefense(state, unit) === unit.stats.defense + HOME_GROUND_DEFENSE_BONUS,
    `got ${getEffectiveDefense(state, unit)}, base=${unit.stats.defense}`);
  check('standing ON the Capital tile itself also counts (distance 0)',
    isOnAgrarHomeGround(state, { ...unit, pos: { ...cap.pos } }));
}

console.log('\n=== Home Ground: +1 DEF adjacent to an ACTIVE (not founding) Farm ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const farmPos = hexNeighbors(cap.pos).find(h => hexDistance(h, cap.pos) === 1)!;
  state.farms.push({ id: 'f1', pos: farmPos, ownerId: 0, state: 'foundingFarm', founding: null, hp: 18, maxHp: 18, defense: 5 });
  const unit = createUnit('warrior', 0, hexNeighbors(farmPos).find(h => hexDistance(h, cap.pos) > 1)!, state.playerTech[0], 'agrar');
  state.units.push(unit);
  check('adjacent to a still-FOUNDING Farm gets NO bonus yet', !isOnAgrarHomeGround(state, unit));
  state.farms[0]!.state = 'farm'; // now active
  check('adjacent to the same, now-ACTIVE Farm gets +1 DEF',
    getEffectiveDefense(state, unit) === unit.stats.defense + HOME_GROUND_DEFENSE_BONUS);
}

console.log('\n=== Home Ground does NOT stack from overlapping Capital/Farm coverage ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  // Two active Farms, both within 1 hex of the same unit position (and that
  // position also within 1 of the Capital) — every possible source of
  // Home Ground overlaps on this one tile at once.
  const unitPos = hexNeighbors(cap.pos)[0]!;
  const farmA = hexNeighbors(unitPos).find(h => hexDistance(h, cap.pos) <= 1 && !hexDistance(h, cap.pos))
    ?? hexNeighbors(unitPos)[0]!;
  const farmB = hexNeighbors(unitPos)[1]!;
  state.farms.push(
    { id: 'fA', pos: farmA, ownerId: 0, state: 'farm', founding: null, hp: 18, maxHp: 18, defense: 5 },
    { id: 'fB', pos: farmB, ownerId: 0, state: 'farm', founding: null, hp: 18, maxHp: 18, defense: 5 },
  );
  const unit = createUnit('warrior', 0, unitPos, state.playerTech[0], 'agrar');
  state.units.push(unit);
  check('within range of the Capital AND 2 Farms at once, the bonus is still exactly +1',
    getEffectiveDefense(state, unit) === unit.stats.defense + HOME_GROUND_DEFENSE_BONUS,
    `got ${getEffectiveDefense(state, unit) - unit.stats.defense} extra DEF`);
}

console.log('\n=== Outside Home Ground: no bonus ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const farPos = { q: cap.pos.q + 6, r: cap.pos.r };
  if (hexDistance({ q: 0, r: 0 }, farPos) <= state.mapRadius) {
    const unit = createUnit('warrior', 0, farPos, state.playerTech[0], 'agrar');
    state.units.push(unit);
    check('an Agrar unit far from Capital/Farms gets the plain base DEF',
      getEffectiveDefense(state, unit) === unit.stats.defense);
  }
}

console.log('\n=== Temple units get NO benefit from Agrar territory, even standing on it ===');
{
  const state = setup('agrar', 'temple');
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!; // the AGRAR Capital
  // A Temple unit standing directly adjacent to the ENEMY Agrar Capital
  // (e.g. mid-siege) must never receive Home Ground.
  const templeUnit = createUnit('warrior', 1, hexNeighbors(cap.pos)[0]!, state.playerTech[1], 'temple');
  state.units.push(templeUnit);
  check('a Temple unit next to an (enemy) Agrar Capital gets no Home Ground bonus',
    !isOnAgrarHomeGround(state, templeUnit) && getEffectiveDefense(state, templeUnit) === templeUnit.stats.defense);
}

console.log('\n=== Agrar-vs-Agrar: Home Ground only from YOUR OWN Capital/Farms, not the opponent\'s ===');
{
  const state = setup('agrar', 'agrar');
  clearArea(state, 0, 3);
  const cap0 = getPlayerCapital(state, 0)!;
  // Player 1's unit standing next to player 0's Capital — different Agrar
  // player, same faction, must still get nothing (ownership check, not just
  // a faction check).
  const rivalUnit = createUnit('warrior', 1, hexNeighbors(cap0.pos)[0]!, state.playerTech[1], 'agrar');
  state.units.push(rivalUnit);
  check('an Agrar unit next to a RIVAL Agrar player\'s Capital gets no bonus',
    !isOnAgrarHomeGround(state, rivalUnit));
}

// ── 3. Combat preview / AI evaluation awareness ─────────────────────────────
console.log('\n=== estimateDamage (feeds combat preview + AI target scoring) reflects Home Ground ===');
{
  const state = setup('agrar', 'temple');
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const attackerPos = { q: cap.pos.q + 4, r: cap.pos.r };
  const attacker = createUnit('warrior', 1, attackerPos, state.playerTech[1], 'temple');
  const onHome = createUnit('warrior', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  const offHome = createUnit('warrior', 0, { q: cap.pos.q + 3, r: cap.pos.r }, state.playerTech[0], 'agrar');
  state.units.push(attacker, onHome, offHome);
  const dmgOnHome = estimateDamage(state, attacker, onHome);
  const dmgOffHome = estimateDamage(state, attacker, offHome);
  check('estimated damage against a Home Ground defender is lower than against the same unit off it',
    dmgOnHome < dmgOffHome, `onHome=${dmgOnHome} offHome=${dmgOffHome}`);
}

console.log('\n=== evaluateState reflects Home Ground (a threatened unit is safer near home) ===');
{
  const makeScenario = (defenderOnHome: boolean): GameState => {
    const state = setup('agrar', 'temple');
    clearArea(state, 0);
    const cap = getPlayerCapital(state, 0)!;
    const defenderPos = defenderOnHome ? hexNeighbors(cap.pos)[0]! : { q: cap.pos.q + 3, r: cap.pos.r };
    const attackerPos = { q: cap.pos.q + 4, r: cap.pos.r };
    const defender = createUnit('warrior', 0, defenderPos, state.playerTech[0], 'agrar');
    defender.hp = 6; // low enough that DEF swings whether the hit is lethal
    const attacker = createUnit('warrior', 1, attackerPos, state.playerTech[1], 'temple');
    state.units.push(defender, attacker);
    return state;
  };
  const scoreOnHome = evaluateState(makeScenario(true), 0);
  const scoreOffHome = evaluateState(makeScenario(false), 0);
  check('Agrar\'s own position scores at least as well with its threatened unit on Home Ground',
    scoreOnHome >= scoreOffHome, `onHome=${scoreOnHome} offHome=${scoreOffHome}`);
}

// ── 4. Road building: 3 -> 2 segments per activation ────────────────────────
console.log('\n=== ROAD_SEGMENTS_PER_ACTIVATION is 2 ===');
{
  check('ROAD_SEGMENTS_PER_ACTIVATION === 2', ROAD_SEGMENTS_PER_ACTIVATION === 2, `got ${ROAD_SEGMENTS_PER_ACTIVATION}`);
}

function straightRoadChain(state: GameState, from: HexCoord, len: number): HexCoord[] {
  const DIRECTIONS = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
  for (const dir of DIRECTIONS) {
    const chain: HexCoord[] = [];
    let cur = from;
    let ok = true;
    for (let i = 0; i < len; i++) {
      cur = { q: cur.q + dir.q, r: cur.r + dir.r };
      if (hexDistance({ q: 0, r: 0 }, cur) > state.mapRadius) { ok = false; break; }
      chain.push(cur);
    }
    if (ok) return chain;
  }
  throw new Error('no open straight direction — regenerate the map');
}

// Same 2-step construction main.ts's own roadCandidatesFor uses for the
// human multi-select UI: hex1 is a legal-and-affordable first-tile
// candidate (getValidRoadHexes + canBuildRoad); hex2 chains directly off
// hex1 and only needs to satisfy isLegalRoadTile (terrain/occupancy), same
// rule buildRoadPath itself applies to every segment past the first.
function twoHexRoadPath(state: GameState, builder: { id: string; pos: HexCoord }): HexCoord[] {
  const first = getValidRoadHexes(state, state.units.find(u => u.id === builder.id)!)
    .find(h => canBuildRoad(state, state.units.find(u => u.id === builder.id)!, h));
  if (!first) return [];
  const second = hexNeighbors(first).find(h =>
    hexDistance({ q: 0, r: 0 }, h) <= state.mapRadius && isLegalRoadTile(state, h));
  return second ? [first, second] : [first];
}

console.log('\n=== Builder builds exactly 2 contiguous Roads for 2⚡ in one activation ===');
{
  const state = setup('agrar', 'temple');
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  const path = twoHexRoadPath(state, builder);
  check('setup: found 2 contiguous legal Road hexes', path.length === 2, `got ${path.length}`);
  const auraBefore = state.players[0]!.aura;
  const built = buildRoadPath(state, builder.id, path);
  check('exactly 2 Road segments were built', built.length === 2, `built=${built.length}`);
  check(`exactly ${2 * ROAD_COST_PER_HEX}⚡ was deducted`, state.players[0]!.aura === auraBefore - 2 * ROAD_COST_PER_HEX);
  check('both Road tiles exist', path.every(h => !!getRoadAt(state, h)));
  check('the whole build consumed the Builder\'s action slot, but not its move', builder.hasAttacked && !builder.hasMoved);
}

console.log('\n=== Server action dispatcher: build-road with a 2-hex path uses buildRoadPath (same rules as AI/headless) ===');
{
  const state = setup('agrar', 'temple');
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  state.currentPlayerIndex = 0;
  const first = getValidRoadHexes(state, builder)[0]!;
  const auraBefore = state.players[0]!.aura;
  const result = executeAction(state, 0, 'build-road', { unitId: builder.id, path: [first] });
  check('server dispatcher accepts a path-based build-road action', result.ok, JSON.stringify(result));
  check('the road actually exists after dispatching through the server layer', !!getRoadAt(state, first));
  check('Energy was deducted through the server layer too', state.players[0]!.aura === auraBefore - ROAD_COST_PER_HEX);
}

console.log('\n=== Server action dispatcher rejects a 3rd Road hex in one path (cap enforced server-side too) ===');
{
  const state = setup('agrar', 'temple');
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  state.currentPlayerIndex = 0;
  const chain = straightRoadChain(state, builder.pos, 3);
  const result = executeAction(state, 0, 'build-road', { unitId: builder.id, path: chain });
  // The dispatcher itself doesn't need to reject the request outright — the
  // underlying buildRoadPath silently truncates — the important invariant
  // is that a 3rd Road tile is NEVER actually created no matter what path
  // is submitted through the server layer.
  const builtCount = chain.filter(h => !!getRoadAt(state, h)).length;
  check('at most ROAD_SEGMENTS_PER_ACTIVATION Road tiles exist after the request, regardless of path length',
    builtCount <= ROAD_SEGMENTS_PER_ACTIVATION, `builtCount=${builtCount}`);
  void result;
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
