// Phase 5 verification: full Agrar/Temple faction rosters (design brief
// §37-39). Exercises the real engine mutators end-to-end (no forked logic) —
// createGameState, chooseFaction, researchTech, spawnUnit.
//
// Run with: npx tsx scripts/verify-faction-rosters.ts
import {
  createGameState, endTurn, chooseFaction, spawnUnit, canAfford,
  getUnlockedUnits, getUnitCost, unitDisplayName, researchTech, getPlayerCapital,
} from '../src/game';
import { AGRAR_UNITS, TEMPLE_UNITS, FACTION_UNITS } from '../src/factions';
import type { GameState, FactionId, UnitType } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A fresh 2-player game, fast-forwarded past the Founding Round and faction
// reveal (Agrar=P0, Temple=P1), with generous aura for testing.
function setup(): GameState {
  const state = createGameState();
  endTurn(state);
  endTurn(state);
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
  for (const p of state.players) p.aura = 100;
  return state;
}

function capitalId(state: GameState, playerId: number): string {
  return getPlayerCapital(state, playerId)!.id;
}

// ── Early-unlock sets (§39) ──
console.log('\n=== Early unlock (§39) ===');
{
  const state = setup();
  const agrarUnlocked = getUnlockedUnits(state.playerTech[0]!, 'agrar');
  const templeUnlocked = getUnlockedUnits(state.playerTech[1]!, 'temple');
  for (const t of ['warrior', 'archer', 'spearsman', 'horserider'] as UnitType[]) {
    check(`Agrar unlocks ${t} immediately`, agrarUnlocked.has(t));
    check(`Temple unlocks ${t} immediately`, templeUnlocked.has(t));
  }
  for (const t of ['catapult', 'heavyknight', 'healer', 'damageBooster', 'rangeBooster'] as UnitType[]) {
    check(`Agrar does NOT unlock ${t} without tech`, !agrarUnlocked.has(t));
    check(`Temple does NOT unlock ${t} without tech`, !templeUnlocked.has(t));
  }
}
{
  // Pre-reveal fallback (no faction known yet) uses the generic default set.
  const state = createGameState();
  const unlocked = getUnlockedUnits(state.playerTech[0]!, null);
  check('no-faction fallback unlocks warrior/archer/horserider', unlocked.has('warrior') && unlocked.has('archer') && unlocked.has('horserider'));
  check('no-faction fallback does NOT unlock spearsman', !unlocked.has('spearsman'));
}

// ── Faction-flavored stats/costs (§37-38) ──
console.log('\n=== Faction-flavored recruiting (§37-38) ===');
for (const [faction, roster] of Object.entries(FACTION_UNITS) as [FactionId, typeof AGRAR_UNITS][]) {
  const playerId = faction === 'agrar' ? 0 : 1;
  for (const def of roster) {
    if (def.slot === 'founder') continue; // never recruitable — display-name-only
    const state = setup();
    const cap = capitalId(state, playerId);
    state.currentPlayerIndex = playerId;
    check(`${faction} ${def.displayName}: getUnitCost matches roster`, getUnitCost(def.slot, faction) === def.cost, `got ${getUnitCost(def.slot, faction)}`);
    check(`${faction} ${def.displayName}: unitDisplayName matches roster`, unitDisplayName(def.slot, faction) === def.displayName);

    if (!def.earlyUnlock) {
      check(`${faction} ${def.displayName}: locked before tech`, !canAfford(state, def.slot));
      continue;
    }
    check(`${faction} ${def.displayName}: affordable + unlocked at reveal`, canAfford(state, def.slot));
    const beforeAura = state.players[playerId]!.aura;
    const spawned = spawnUnit(state, cap, def.slot);
    check(`${faction} ${def.displayName}: spawnUnit succeeds`, spawned);
    check(`${faction} ${def.displayName}: charges the faction-flavored cost`, state.players[playerId]!.aura === beforeAura - def.cost, `aura ${beforeAura}->${state.players[playerId]!.aura}`);
    const unit = state.units.find(u => u.playerId === playerId && u.type === def.slot && u.hp > 0);
    check(`${faction} ${def.displayName}: spawned unit exists`, !!unit);
    if (unit) {
      check(`${faction} ${def.displayName}: maxHp matches roster`, unit.stats.maxHp === def.hp, `got ${unit.stats.maxHp}`);
      check(`${faction} ${def.displayName}: attack matches roster`, unit.stats.attack === def.attack, `got ${unit.stats.attack}`);
      check(`${faction} ${def.displayName}: defense matches roster`, unit.stats.defense === def.defense, `got ${unit.stats.defense}`);
      check(`${faction} ${def.displayName}: speed matches roster`, unit.stats.speed === def.speed, `got ${unit.stats.speed}`);
      check(`${faction} ${def.displayName}: range matches roster`, unit.stats.range === def.range, `got ${unit.stats.range}`);
      check(`${faction} ${def.displayName}: vision matches roster`, unit.stats.vision === def.vision, `got ${unit.stats.vision}`);
      check(`${faction} ${def.displayName}: hp starts at full`, unit.hp === def.hp);
    }
  }
}

// ── Same slot, different faction flavor ──
console.log('\n=== Same slot, distinct faction flavor ===');
{
  const agrarDef = AGRAR_UNITS.find(u => u.slot === 'spearsman')!;
  const templeDef = TEMPLE_UNITS.find(u => u.slot === 'spearsman')!;
  check('Agrar and Temple use distinct names for the spearsman slot', agrarDef.displayName !== templeDef.displayName, `${agrarDef.displayName} vs ${templeDef.displayName}`);
  check('Pikeman (Agrar) name is correct', agrarDef.displayName === 'Pikeman');
  check('Spearsman (Temple) name is correct', templeDef.displayName === 'Spearsman');
}
{
  const agrarKnight = AGRAR_UNITS.find(u => u.slot === 'horserider')!;
  const templeRaider = TEMPLE_UNITS.find(u => u.slot === 'horserider')!;
  check('Agrar Knight costs more than Temple Raider (tanky vs cheap-mobility asymmetry)', agrarKnight.cost > templeRaider.cost, `agrar=${agrarKnight.cost} temple=${templeRaider.cost}`);
  check('Temple Raider is faster than Agrar Knight', templeRaider.speed > agrarKnight.speed, `agrar=${agrarKnight.speed} temple=${templeRaider.speed}`);
}
{
  const agrarHK = AGRAR_UNITS.find(u => u.slot === 'heavyknight')!;
  const templeChamp = TEMPLE_UNITS.find(u => u.slot === 'heavyknight')!;
  check('Heavy Knight and Champion cost the same (symmetric slot)', agrarHK.cost === templeChamp.cost, `agrar=${agrarHK.cost} temple=${templeChamp.cost}`);
}

// ── Founder stays unflavored (§6) ──
console.log('\n=== Founder stays faction-neutral (§6) ===');
{
  const state = setup();
  const agrarBuilder = state.units.find(u => u.playerId === 0 && u.type === 'founder')!;
  const templeAcolyte = state.units.find(u => u.playerId === 1 && u.type === 'founder')!;
  check('Builder and Acolyte have identical stats', agrarBuilder.stats.maxHp === templeAcolyte.stats.maxHp
    && agrarBuilder.stats.attack === templeAcolyte.stats.attack
    && agrarBuilder.stats.defense === templeAcolyte.stats.defense
    && agrarBuilder.stats.speed === templeAcolyte.stats.speed);
  check('founder is never in the unlocked recruit set', !getUnlockedUnits(state.playerTech[0]!, 'agrar').has('founder') && !getUnlockedUnits(state.playerTech[1]!, 'temple').has('founder'));
}

// ── Tech unlock gates faction recruiting (§39 + tech tree) ──
console.log('\n=== Tech gates faction recruiting ===');
{
  const state = setup();
  state.currentPlayerIndex = 0;
  check('Agrar cannot recruit Heavy Knight before tech', !canAfford(state, 'heavyknight'));
  const researched = researchTech(state, 'unlock_heavyknight');
  check('research unlock_heavyknight succeeds', researched);
  check('Agrar can now recruit Heavy Knight', canAfford(state, 'heavyknight'));
  const cap = capitalId(state, 0);
  const before = state.players[0]!.aura;
  const spawned = spawnUnit(state, cap, 'heavyknight');
  check('spawnUnit succeeds post-tech', spawned);
  const unit = state.units.find(u => u.playerId === 0 && u.type === 'heavyknight' && u.hp > 0);
  const agrarDef = AGRAR_UNITS.find(u => u.slot === 'heavyknight')!;
  check('recruited Heavy Knight uses Agrar stats, not universal', !!unit && unit.stats.attack === agrarDef.attack, `got ${unit?.stats.attack}`);
  check('charged the Agrar-flavored cost', state.players[0]!.aura === before - agrarDef.cost);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
