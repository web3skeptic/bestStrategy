// Farmer Tribe roster change verification: the Knight is gone, replaced by
// the Warden (same shared 'horserider' slot, but slow/durable and classed
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

console.log('\n=== Warden exists with exactly the specified stats ===');
{
  const warden = AGRAR_UNITS.find(u => u.slot === 'horserider')!;
  check('displayName is "Warden"', warden.displayName === 'Warden');
  check('cost=5', warden.cost === 5, `got ${warden.cost}`);
  check('hp=25', warden.hp === 25, `got ${warden.hp}`);
  check('attack=13', warden.attack === 13, `got ${warden.attack}`);
  check('defense=6', warden.defense === 6, `got ${warden.defense}`);
  check('speed=1', warden.speed === 1, `got ${warden.speed}`);
  check('range=1', warden.range === 1, `got ${warden.range}`);
  check('vision=2', warden.vision === 2, `got ${warden.vision}`);
  check('commandCost=3', warden.commandCost === 3, `got ${warden.commandCost}`);
  check('class is warrior', warden.unitClass === 'warrior', `got ${warden.unitClass}`);
  check('no special ability flags — plain isSupport=false, isSiege=false', !warden.isSupport && !warden.isSiege);
  check('early-unlocked, same as the Knight it replaces (no dedicated unlock tech)', warden.earlyUnlock);
}

console.log('\n=== Iron Guard: rename only — displayName changed, stats/slot/class unchanged ===');
{
  const ironGuard = AGRAR_UNITS.find(u => u.slot === 'heavyknight')!;
  check('displayName is "Iron Guard"', ironGuard.displayName === 'Iron Guard');
  check('no AGRAR_UNITS entry still displays as "Heavy Knight"', !AGRAR_UNITS.some(u => u.displayName === 'Heavy Knight'));
  check('cost=7', ironGuard.cost === 7, `got ${ironGuard.cost}`);
  check('hp=29', ironGuard.hp === 29, `got ${ironGuard.hp}`);
  check('attack=16', ironGuard.attack === 16, `got ${ironGuard.attack}`);
  check('defense=6', ironGuard.defense === 6, `got ${ironGuard.defense}`);
  check('speed=2', ironGuard.speed === 2, `got ${ironGuard.speed}`);
  check('range=1', ironGuard.range === 1, `got ${ironGuard.range}`);
  check('commandCost=3', ironGuard.commandCost === 3, `got ${ironGuard.commandCost}`);
  check('class is still heavy (unchanged)', ironGuard.unitClass === 'heavy');
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
  check('getUnitClass(horserider, agrar) is warrior (the Warden, NOT cavalry)', getUnitClass('horserider', 'agrar') === 'warrior');
  // Pike hard-counters cavalry (1.35x) — must still apply to Temple's Raider...
  check('pike still gets its 1.35x counter bonus attacking a Raider',
    getUnitTypeMultiplier('spearsman', 'horserider', 'temple', 'temple') === 1.35,
    `got ${getUnitTypeMultiplier('spearsman', 'horserider', 'temple', 'temple')}`);
  // ...but must NOT apply to the Warden, since it's warrior-classed, not cavalry.
  check('pike does NOT get a cavalry counter bonus attacking a Warden',
    getUnitTypeMultiplier('spearsman', 'horserider', 'agrar', 'agrar') === 1,
    `got ${getUnitTypeMultiplier('spearsman', 'horserider', 'agrar', 'agrar')}`);
  // Cavalry's own attacker bonus (vs archer/siege/support) must still work for
  // the Raider attacking an archer...
  check('a Raider still gets its 1.25x cavalry bonus attacking an archer',
    getUnitTypeMultiplier('horserider', 'archer', 'temple', 'temple') === 1.25,
    `got ${getUnitTypeMultiplier('horserider', 'archer', 'temple', 'temple')}`);
  // ...but the Warden must NOT get that same bonus, since it isn't cavalry.
  check('a Warden does NOT get a cavalry bonus attacking an archer',
    getUnitTypeMultiplier('horserider', 'archer', 'agrar', 'agrar') === 1,
    `got ${getUnitTypeMultiplier('horserider', 'archer', 'agrar', 'agrar')}`);
}

// ── 3. Warden gets Home Ground like any other Farmer unit ──────────────────
console.log('\n=== Warden gets Home Ground +1 DEF near the Capital, same as any Farmer unit ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const warden = createUnit('horserider', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
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

  const wardenOffRoad = createUnit('horserider', 0, hexNeighbors(cap.pos).find(h => hexKey(h) !== hexKey(roadHex))!, state.playerTech[0], 'agrar');
  const wardenOnRoad = createUnit('horserider', 0, { ...roadHex }, state.playerTech[0], 'agrar');
  state.units.push(wardenOffRoad, wardenOnRoad);
  check('off-Road Warden has plain base speed', getEffectiveSpeed(state, wardenOffRoad) === wardenOffRoad.stats.speed);
  check('on-Road Warden gets +ROAD_MOVEMENT_BONUS speed, same rule as every other Farmer unit',
    getEffectiveSpeed(state, wardenOnRoad) === wardenOnRoad.stats.speed + ROAD_MOVEMENT_BONUS,
    `got ${getEffectiveSpeed(state, wardenOnRoad)}, base=${wardenOnRoad.stats.speed}`);
}

// ── 5. AI can recruit the Warden ────────────────────────────────────────────
console.log('\n=== AI can recruit the Warden (not looking for the removed Knight) ===');
{
  const state = setup('agrar', 'temple');
  clearArea(state, 0, 3);
  for (const p of state.players) p.aura = 300;
  check('horserider is in Agrar\'s early-unlocked set (same as the Knight it replaces)',
    getUnlockedUnits(state.playerTech[0]!, 'agrar').has('horserider'));
  check('its recruit cost resolves to the Warden\'s (5), not some stale Knight value',
    getUnitCost('horserider', 'agrar') === 5, `got ${getUnitCost('horserider', 'agrar')}`);

  let recruited = false;
  for (let round = 0; round < 20 && !recruited; round++) {
    state.currentPlayerIndex = 0; // force player 0's (Agrar's) turn regardless of whose turn it actually is
    runAiTurn(state, 'hard', 0);
    recruited = state.units.some(u => u.playerId === 0 && u.type === 'horserider')
      || state.trainingQueue.some(o => o.playerId === 0 && o.unitType === 'horserider');
    if (!recruited) advanceOneRound(state);
  }
  check('the Hard AI recruited (or queued) a Warden within 20 rounds', recruited);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
