// Farmer Tribe roster change verification: the Knight is gone, replaced by
// the Warden (roster pass 2: the heavy 'heavyknight'-slot unit, unmounted;
// 'warrior' — no cavalry counters, no mount), and the Heavy Knight is
// renamed to Iron Guard (stats/model/slot/class unchanged). Raider Tribe
// (Temple) is untouched throughout. Exercises the real engine (no forked
// logic) — createGameState, createUnit, getUnitClass/getUnitTypeMultiplier,
// getEffectiveDefense/getEffectiveSpeed, runAiTurn.
//
// Run with: npx tsx scripts/verify-farmer-roster.ts
import {
  createGameState, chooseFaction, createUnit, getPlayerCapital, getEffectiveDefense,
  getEffectiveSpeed, isOnAgrarHomeGround, HOME_GROUND_DEFENSE_BONUS, getUnitClass,
  getUnitTypeMultiplier, getUnlockedUnits, getUnitCost, unitDisplayName, endTurn, getRoadAt,
  buildRoad, getValidRoadHexes, canBuildRoad,
} from '../src/game';
import { AGRAR_UNITS, TEMPLE_UNITS, ROAD_MOVEMENT_BONUS } from '../src/factions';
import { runAiTurn } from '../src/ai';
import { hexNeighbors, hexKey } from '../src/hex';
import type { GameState } from '../src/types';

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

// Same re-centering pattern used throughout the rest of the suite.
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

// ── 1. The Knight is gone; the Warden takes its slot ───────────────────────
console.log('\n=== Farmer Knight is gone — no unit anywhere in the Agrar roster is named "Knight" ===');
{
  check('no AGRAR_UNITS entry displays as "Knight"', !AGRAR_UNITS.some(u => u.displayName === 'Knight'));
  check('no AGRAR_UNITS entry has id agrar_knight', !AGRAR_UNITS.some(u => u.id === 'agrar_knight'));
  check('unitDisplayName never returns "Knight" for Agrar\'s horserider slot',
    unitDisplayName('horserider', 'agrar') !== 'Knight');
}

console.log('\n=== Farmer has NO unit in the shared horserider slot any more (old Warden deleted) ===');
{
  check('no AGRAR_UNITS entry sits in the horserider slot', !AGRAR_UNITS.some(u => u.slot === 'horserider'));
  check('no AGRAR_UNITS entry has id agrar_warden', !AGRAR_UNITS.some(u => u.id === 'agrar_warden'));
  check('horserider is NOT in Agrar\'s early-unlocked set', !getUnlockedUnits(setup().playerTech[0]!, 'agrar').has('horserider'));
}

console.log('\n=== The Warden is the heavy (heavyknight-slot) unit — former Iron Guard stats, Warden name ===');
{
  const warden = AGRAR_UNITS.find(u => u.slot === 'heavyknight')!;
  check('displayName is "Warden"', warden.displayName === 'Warden');
  check('no AGRAR_UNITS entry still displays as "Iron Guard" or "Heavy Knight"', !AGRAR_UNITS.some(u => u.displayName === 'Iron Guard' || u.displayName === 'Heavy Knight'));
  check('exactly one Agrar unit is named Warden', AGRAR_UNITS.filter(u => u.displayName === 'Warden').length === 1);
  check('cost=7', warden.cost === 7, `got ${warden.cost}`);
  check('hp=29', warden.hp === 29, `got ${warden.hp}`);
  check('attack=16', warden.attack === 16, `got ${warden.attack}`);
  check('defense=6', warden.defense === 6, `got ${warden.defense}`);
  check('speed=2', warden.speed === 2, `got ${warden.speed}`);
  check('range=1', warden.range === 1, `got ${warden.range}`);
  check('commandCost=3', warden.commandCost === 3, `got ${warden.commandCost}`);
  check('class is heavy (unchanged from the Iron Guard)', warden.unitClass === 'heavy', `got ${warden.unitClass}`);
  check('uses the unmounted Warden model asset', warden.assetReference === 'warden_standing');
  check('not early-unlocked — still behind its unlock tech', !warden.earlyUnlock);
}

// ── 2. Raider Tribe (Temple) is completely unaffected ──────────────────────
console.log('\n=== Raider Tribe roster is unchanged ===');
{
  const raider = TEMPLE_UNITS.find(u => u.slot === 'horserider')!;
  const champion = TEMPLE_UNITS.find(u => u.slot === 'heavyknight')!;
  check('Raider still displays as "Raider"', raider.displayName === 'Raider');
  check('Raider is still classed cavalry', raider.unitClass === 'cavalry', `got ${raider.unitClass}`);
  check('Raider stats unchanged (cost/hp/atk/def/speed/range/command)',
    raider.cost === 3 && raider.hp === 14 && raider.attack === 13 && raider.defense === 4
    && raider.speed === 3 && raider.range === 1 && raider.commandCost === 2,
    JSON.stringify(raider));
  check('Champion still displays as "Champion"', champion.displayName === 'Champion');
  check('Champion stats unchanged', champion.cost === 6 && champion.hp === 18 && champion.attack === 17
    && champion.defense === 5 && champion.speed === 3 && champion.commandCost === 2, JSON.stringify(champion));
}

console.log('\n=== Raider cavalry still works correctly (class resolution + counter matrix) ===');
{
  check('getUnitClass(horserider, temple) is cavalry', getUnitClass('horserider', 'temple') === 'cavalry');
  check('getUnitClass(heavyknight, agrar) is heavy (the Warden)', getUnitClass('heavyknight', 'agrar') === 'heavy');
  // Pike hard-counters cavalry (1.35x) — must still apply to Temple's Raider...
  check('pike still gets its 1.35x counter bonus attacking a Raider',
    getUnitTypeMultiplier('spearsman', 'horserider', 'temple', 'temple') === 1.35,
    `got ${getUnitTypeMultiplier('spearsman', 'horserider', 'temple', 'temple')}`);
  // ...and pike's heavy counter applies to the Warden (heavy-classed).
  check('pike gets its 1.35x counter bonus attacking a Warden (heavy)',
    getUnitTypeMultiplier('spearsman', 'heavyknight', 'agrar', 'agrar') === 1.35,
    `got ${getUnitTypeMultiplier('spearsman', 'heavyknight', 'agrar', 'agrar')}`);
  // Cavalry's own attacker bonus (vs archer/siege/support) must still work for
  // the Raider attacking an archer...
  check('a Raider still gets its 1.25x cavalry bonus attacking an archer',
    getUnitTypeMultiplier('horserider', 'archer', 'temple', 'temple') === 1.25,
    `got ${getUnitTypeMultiplier('horserider', 'archer', 'temple', 'temple')}`);
  // ...but the Warden must NOT get a cavalry bonus, since it isn't cavalry.
  check('a Warden does NOT get a cavalry bonus attacking an archer',
    getUnitTypeMultiplier('heavyknight', 'archer', 'agrar', 'agrar') !== 1.25,
    `got ${getUnitTypeMultiplier('heavyknight', 'archer', 'agrar', 'agrar')}`);
}

// ── 3. Warden gets Home Ground like any other Farmer unit ──────────────────
console.log('\n=== Warden gets Home Ground +1 DEF near the Capital, same as any Farmer unit ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const warden = createUnit('heavyknight', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(warden);
  check('isOnAgrarHomeGround is true for a Warden next to its own Capital', isOnAgrarHomeGround(state, warden));
  check('effective DEF is base + HOME_GROUND_DEFENSE_BONUS, no more',
    getEffectiveDefense(state, warden) === warden.stats.defense + HOME_GROUND_DEFENSE_BONUS,
    `got ${getEffectiveDefense(state, warden)}, base=${warden.stats.defense}`);
}

// ── 4. Warden benefits from Farmer Roads exactly like any other unit ───────
console.log('\n=== Warden gets the normal Farmer Road movement bonus (no Warden-specific Road rule) ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  const roadHex = getValidRoadHexes(state, builder).find(h => canBuildRoad(state, builder, h))!;
  check('setup: found a legal Road hex', !!roadHex);
  buildRoad(state, builder.id, roadHex);
  check('setup: the Road tile actually exists now', !!getRoadAt(state, roadHex));

  const wardenOffRoad = createUnit('heavyknight', 0, hexNeighbors(cap.pos).find(h => hexKey(h) !== hexKey(roadHex))!, state.playerTech[0], 'agrar');
  const wardenOnRoad = createUnit('heavyknight', 0, { ...roadHex }, state.playerTech[0], 'agrar');
  state.units.push(wardenOffRoad, wardenOnRoad);
  check('off-Road Warden has plain base speed', getEffectiveSpeed(state, wardenOffRoad) === wardenOffRoad.stats.speed);
  check('on-Road Warden gets +ROAD_MOVEMENT_BONUS speed, same rule as every other Farmer unit',
    getEffectiveSpeed(state, wardenOnRoad) === wardenOnRoad.stats.speed + ROAD_MOVEMENT_BONUS,
    `got ${getEffectiveSpeed(state, wardenOnRoad)}, base=${wardenOnRoad.stats.speed}`);
}

// ── 5. The Warden unlocks through its tech and resolves to Warden stats ────
console.log('\n=== Warden unlock: behind agrar_heavy_knight_tech, cost resolves to 7 ===');
{
  const state = setup('agrar', 'temple');
  check('heavyknight is NOT in Agrar\'s early-unlocked set', !getUnlockedUnits(state.playerTech[0]!, 'agrar').has('heavyknight'));
  state.playerTech[0]!.researched.add('agrar_heavy_knight_tech');
  check('heavyknight IS unlocked once its tech is researched', getUnlockedUnits(state.playerTech[0]!, 'agrar').has('heavyknight'));
  check('its recruit cost resolves to the Warden\'s (7)', getUnitCost('heavyknight', 'agrar') === 7, `got ${getUnitCost('heavyknight', 'agrar')}`);
  check('unitDisplayName(heavyknight, agrar) is "Warden"', unitDisplayName('heavyknight', 'agrar') === 'Warden');
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
