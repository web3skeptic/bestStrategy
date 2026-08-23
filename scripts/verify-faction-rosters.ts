// Phase 5 verification (updated phase 11): full Agrar/Temple faction rosters
// (design brief §37-39), now including the Builder/Acolyte as an ordinary
// recruitable slot and the faction-specific, prerequisite-gated Heavy-unit
// tech line. Exercises the real engine mutators end-to-end (no forked
// logic) — createGameState, chooseFaction, researchTech, spawnUnit,
// resolveTrainingForPlayer (via endTurn).
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

// A fresh 2-player game with factions chosen immediately (phase 11 — no more
// Founding Round to skip past), with generous aura for testing.
function setup(): GameState {
  const state = createGameState();
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
  for (const p of state.players) p.aura = 100;
  return state;
}

function capitalId(state: GameState, playerId: number): string {
  return getPlayerCapital(state, playerId)!.id;
}

// Exactly one full round-trip in a 2-player alternating game.
function advanceOneRound(state: GameState): void {
  endTurn(state);
  endTurn(state);
}

// §5 (phase 11) — spawnUnit only queues a TrainingOrder now; it does NOT
// create a Unit immediately. Recruits, advances one full round for the
// recruiting player (deploying the order), and returns the deployed unit.
function recruitAndDeploy(state: GameState, playerId: number, structureId: string, unitType: UnitType): GameState['units'][number] | null {
  state.currentPlayerIndex = playerId;
  if (!spawnUnit(state, structureId, unitType)) return null;
  advanceOneRound(state);
  return state.units.find(u => u.playerId === playerId && u.type === unitType && u.hp > 0) ?? null;
}

// ── Early-unlock sets (§39) ──
console.log('\n=== Early unlock (§39) ===');
{
  const state = setup();
  const agrarUnlocked = getUnlockedUnits(state.playerTech[0]!, 'agrar');
  const templeUnlocked = getUnlockedUnits(state.playerTech[1]!, 'temple');
  for (const t of ['warrior', 'archer', 'spearsman', 'horserider', 'founder'] as UnitType[]) {
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

// ── Faction-flavored stats/costs (§37-38) — Builder/Acolyte (slot 'founder')
// is now an ordinary early-unlock recruitable slot like any other (§5). ──
console.log('\n=== Faction-flavored recruiting (§37-38) ===');
for (const [faction, roster] of Object.entries(FACTION_UNITS) as [FactionId, typeof AGRAR_UNITS][]) {
  const playerId = faction === 'agrar' ? 0 : 1;
  for (const def of roster) {
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
    check(`${faction} ${def.displayName}: charges the faction-flavored cost immediately`, state.players[playerId]!.aura === beforeAura - def.cost, `aura ${beforeAura}->${state.players[playerId]!.aura}`);
    check(`${faction} ${def.displayName}: does NOT exist on the battlefield immediately (§5, training queue)`, !state.units.some(u => u.playerId === playerId && u.type === def.slot && u.hp > 0));

    advanceOneRound(state);
    const unit = state.units.find(u => u.playerId === playerId && u.type === def.slot && u.hp > 0);
    check(`${faction} ${def.displayName}: deployed at the start of the next round`, !!unit);
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

// ── Builder/Acolyte: independently faction-flavored, both recruitable (§5) ──
console.log('\n=== Builder/Acolyte: faction-flavored stats, both recruitable (§5) ===');
{
  const state = setup();
  const agrarBuilder = recruitAndDeploy(state, 0, capitalId(state, 0), 'founder');
  const templeAcolyte = recruitAndDeploy(state, 1, capitalId(state, 1), 'founder');
  check('Agrar can recruit the Builder', !!agrarBuilder);
  check('Temple can recruit the Acolyte', !!templeAcolyte);
  check('Builder and Acolyte share HP/ATK/DEF (only speed is asymmetric, per the roster)', !!agrarBuilder && !!templeAcolyte
    && agrarBuilder.stats.maxHp === templeAcolyte.stats.maxHp
    && agrarBuilder.stats.attack === templeAcolyte.stats.attack
    && agrarBuilder.stats.defense === templeAcolyte.stats.defense);
  check('the Builder is slower than the Acolyte (bunker correction — the whole Agrar tribe moves less)', !!agrarBuilder && !!templeAcolyte && agrarBuilder.stats.speed < templeAcolyte.stats.speed, `builder=${agrarBuilder?.stats.speed} acolyte=${templeAcolyte?.stats.speed}`);
  check('founder IS in the unlocked recruit set (phase 11 — ordinary recruitable unit)', getUnlockedUnits(state.playerTech[0]!, 'agrar').has('founder') && getUnlockedUnits(state.playerTech[1]!, 'temple').has('founder'));
}

// ── Tech unlock gates faction recruiting — faction-specific Heavy-unit line
// with a real 2-step prerequisite chain (phase 11 §33-34), not a flat unlock ──
console.log('\n=== Tech gates faction recruiting (phase 11 Heavy-unit line) ===');
{
  const state = setup();
  state.currentPlayerIndex = 0;
  check('Agrar cannot recruit Heavy Knight before tech', !canAfford(state, 'heavyknight'));
  check('Agrar cannot research Heavy Knight tech before its prereqs', !researchTech(state, 'agrar_heavy_knight_tech'));
  check('Agrar can research Heavy Armor (no prereq)', researchTech(state, 'agrar_heavy_armor'));
  check('still cannot research Heavy Knight tech — missing Command I', !researchTech(state, 'agrar_heavy_knight_tech'));
  check('Agrar can research Command I', researchTech(state, 'command_1'));
  check('Agrar can now research Heavy Knight tech (both prereqs met)', researchTech(state, 'agrar_heavy_knight_tech'));
  check('Agrar can now recruit Heavy Knight', canAfford(state, 'heavyknight'));

  const cap = capitalId(state, 0);
  const before = state.players[0]!.aura;
  const agrarDef = AGRAR_UNITS.find(u => u.slot === 'heavyknight')!;
  state.currentPlayerIndex = 0;
  spawnUnit(state, cap, 'heavyknight');
  check('charged the Agrar-flavored cost immediately', state.players[0]!.aura === before - agrarDef.cost, `aura ${before}->${state.players[0]!.aura}`);
  advanceOneRound(state);
  const unit = state.units.find(u => u.playerId === 0 && u.type === 'heavyknight' && u.hp > 0);
  check('recruited Heavy Knight uses Agrar stats, not universal', !!unit && unit.stats.attack === agrarDef.attack, `got ${unit?.stats.attack}`);
}
{
  // Faction gating: Temple cannot see/research Agrar's tech nodes and vice versa.
  const state = setup();
  state.currentPlayerIndex = 1; // Temple
  check('Temple cannot research Agrar\'s Heavy Armor tech', !researchTech(state, 'agrar_heavy_armor'));
  check('Temple cannot research Agrar\'s Siegecraft tech', !researchTech(state, 'agrar_siegecraft'));
  state.currentPlayerIndex = 0; // Agrar
  check('Agrar cannot research Temple\'s Warrior Rite tech', !researchTech(state, 'temple_warrior_rite'));
  check('Agrar cannot research Temple\'s Mobile Siege tech', !researchTech(state, 'temple_mobile_siege_tech'));
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
