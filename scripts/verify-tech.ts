// Tech-tree pacing pass verification (design brief "TECH TREE REBALANCE —
// MAKE RESEARCH A REAL CIVILIZATION INVESTMENT", §16): single research slot,
// timed multi-round completion, Energy deducted at start (not completion),
// Command II's 2-other-techs gate, Heavy Knight/Champion Rite's dual
// (tier-1 tech + Command I) gate, and Splash's Siege-unlock gate.
//
// Run with: npx tsx scripts/verify-tech.ts
import {
  createGameState, endTurn, chooseFaction, canResearch, researchTech,
  getUnlockedUnits, canAfford,
} from '../src/game';
import { TECH_NODES } from '../src/types';
import type { GameState, TechId, TechNode } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function node(id: TechId): TechNode {
  return TECH_NODES.find(n => n.id === id)!;
}

function setup(): GameState {
  const state = createGameState();
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
  for (const p of state.players) p.aura = 200;
  return state;
}

function advanceOneRound(state: GameState): void {
  endTurn(state);
  endTurn(state);
}

// Starts `techId` for `playerId`, then advances exactly its researchTime
// rounds so it resolves. Returns whether it ended up researched.
function researchAndComplete(state: GameState, playerId: number, techId: TechId): boolean {
  state.currentPlayerIndex = playerId;
  if (!researchTech(state, techId)) return false;
  for (let i = 0; i < node(techId).researchTime; i++) advanceOneRound(state);
  return state.playerTech[playerId]!.researched.has(techId);
}

// ── §10: cost/duration table matches exactly ──
console.log('\n=== Tech cost/duration table (§10) ===');
{
  const table: Record<TechId, { cost: number; time: number }> = {
    command_1: { cost: 12, time: 1 },
    unlock_healer: { cost: 14, time: 2 },
    unlock_damagebooster: { cost: 14, time: 2 },
    unlock_rangebooster: { cost: 14, time: 2 },
    longrange_hp: { cost: 14, time: 2 },
    horse_sight: { cost: 14, time: 2 },
    agrar_siegecraft: { cost: 16, time: 2 },
    temple_mobile_siege_tech: { cost: 16, time: 2 },
    agrar_heavy_armor: { cost: 16, time: 2 },
    temple_warrior_rite: { cost: 16, time: 2 },
    agrar_siegecraft_splash: { cost: 18, time: 2 },
    temple_mobile_siege_splash: { cost: 18, time: 2 },
    command_2: { cost: 18, time: 2 },
    agrar_heavy_knight_tech: { cost: 22, time: 3 },
    temple_champion_rite: { cost: 22, time: 3 },
  };
  for (const id of Object.keys(table) as TechId[]) {
    const n = node(id);
    const exp = table[id]!;
    check(`${id} cost is ${exp.cost}`, n.cost === exp.cost, `got ${n.cost}`);
    check(`${id} researchTime is ${exp.time}`, n.researchTime === exp.time, `got ${n.researchTime}`);
  }
}

// ── §2: single research slot ──
console.log('\n=== Single research slot enforced (§2) ===');
{
  const state = setup();
  state.currentPlayerIndex = 0;
  check('command_1 starts fine', researchTech(state, 'command_1'));
  check('a second tech cannot start while one is researching', !canResearch(state, 'unlock_healer'));
  check('researchTech itself rejects a second tech mid-research', !researchTech(state, 'unlock_healer'));
  // Complete command_1, then confirm the slot is free again.
  for (let i = 0; i < node('command_1').researchTime; i++) advanceOneRound(state);
  state.currentPlayerIndex = 0;
  check('slot is free again once command_1 completes', canResearch(state, 'unlock_healer'));
}

// ── §3: Energy deducted at start, not completion ──
console.log('\n=== Energy deducted at research START (§3) ===');
{
  const state = setup();
  state.currentPlayerIndex = 0;
  state.players[0]!.aura = 20;
  researchTech(state, 'command_1');
  check('aura drops by the full cost immediately on start', state.players[0]!.aura === 20 - node('command_1').cost, `got ${state.players[0]!.aura}`);
  const auraAfterStart = state.players[0]!.aura;
  for (let i = 0; i < node('command_1').researchTime; i++) advanceOneRound(state);
  check('aura does not change further on completion (beyond normal income)', state.players[0]!.aura >= auraAfterStart);
}

// ── Effect gated behind completion, not the start action ──
console.log('\n=== Effect unavailable before completion, active after (§4) ===');
{
  const state = setup();
  state.currentPlayerIndex = 0;
  researchTech(state, 'agrar_siegecraft');
  check('Catapult NOT unlocked the instant Siegecraft starts', !getUnlockedUnits(state.playerTech[0]!, 'agrar').has('catapult'));
  check('cannot afford/recruit Catapult mid-research', !canAfford(state, 'catapult'));
  for (let i = 0; i < node('agrar_siegecraft').researchTime - 1; i++) advanceOneRound(state);
  check('still not unlocked with 1 round left', !getUnlockedUnits(state.playerTech[0]!, 'agrar').has('catapult'));
  advanceOneRound(state);
  check('Catapult unlocked once Siegecraft fully completes', getUnlockedUnits(state.playerTech[0]!, 'agrar').has('catapult'));
}

// ── Command II gating ──
console.log('\n=== Command II gating (§21, §30) ===');
{
  const state = setup();
  state.currentPlayerIndex = 0;
  check('Command II blocked without Command I', !canResearch(state, 'command_2'));
  check('research + complete Command I', researchAndComplete(state, 0, 'command_1'));
  state.currentPlayerIndex = 0;
  check('Command II still blocked — 0 other completed techs', !canResearch(state, 'command_2'));
  check('research + complete unlock_healer', researchAndComplete(state, 0, 'unlock_healer'));
  state.currentPlayerIndex = 0;
  check('Command II still blocked — only 1 other completed tech', !canResearch(state, 'command_2'));
  check('research + complete horse_sight', researchAndComplete(state, 0, 'horse_sight'));
  state.currentPlayerIndex = 0;
  check('Command II researchable — Command I + 2 other completed techs', canResearch(state, 'command_2'));
}

// ── Heavy Knight / Champion Rite dual gating ──
console.log('\n=== Heavy Knight dual gate: Heavy Armor + Command I (§30) ===');
{
  const state = setup();
  state.currentPlayerIndex = 0;
  check('Heavy Knight blocked with no prereqs', !canResearch(state, 'agrar_heavy_knight_tech'));
  check('research + complete Heavy Armor', researchAndComplete(state, 0, 'agrar_heavy_armor'));
  state.currentPlayerIndex = 0;
  check('Heavy Knight still blocked without Command I', !canResearch(state, 'agrar_heavy_knight_tech'));
  check('research + complete Command I', researchAndComplete(state, 0, 'command_1'));
  state.currentPlayerIndex = 0;
  check('Heavy Knight now researchable (Heavy Armor + Command I)', canResearch(state, 'agrar_heavy_knight_tech'));
}
console.log('\n=== Heavy Knight blocked without Heavy Armor even with Command I ===');
{
  const state = setup();
  check('research + complete Command I', researchAndComplete(state, 0, 'command_1'));
  state.currentPlayerIndex = 0;
  check('Heavy Knight blocked without Heavy Armor', !canResearch(state, 'agrar_heavy_knight_tech'));
}
console.log('\n=== Champion Rite dual gate: Warrior Rite + Command I (§30) ===');
{
  const state = setup();
  state.currentPlayerIndex = 1;
  check('Champion Rite blocked with no prereqs', !canResearch(state, 'temple_champion_rite'));
  check('research + complete Warrior Rite', researchAndComplete(state, 1, 'temple_warrior_rite'));
  state.currentPlayerIndex = 1;
  check('Champion Rite still blocked without Command I', !canResearch(state, 'temple_champion_rite'));
  check('research + complete Command I', researchAndComplete(state, 1, 'command_1'));
  state.currentPlayerIndex = 1;
  check('Champion Rite now researchable (Warrior Rite + Command I)', canResearch(state, 'temple_champion_rite'));
}
console.log('\n=== Champion Rite blocked without Warrior Rite even with Command I ===');
{
  const state = setup();
  check('research + complete Command I', researchAndComplete(state, 1, 'command_1'));
  state.currentPlayerIndex = 1;
  check('Champion Rite blocked without Warrior Rite', !canResearch(state, 'temple_champion_rite'));
}

// ── Splash upgrade requires the faction's Siege unlock ──
console.log('\n=== Splash upgrade blocked without Siege unlock (§30) ===');
{
  const state = setup();
  state.currentPlayerIndex = 0;
  check('Explosive Shot blocked without Siegecraft', !canResearch(state, 'agrar_siegecraft_splash'));
  check('research + complete Siegecraft', researchAndComplete(state, 0, 'agrar_siegecraft'));
  state.currentPlayerIndex = 0;
  check('Explosive Shot now researchable', canResearch(state, 'agrar_siegecraft_splash'));

  const state2 = setup();
  state2.currentPlayerIndex = 1;
  check('Blast Rite blocked without Mobile Siege', !canResearch(state2, 'temple_mobile_siege_splash'));
  check('research + complete Mobile Siege', researchAndComplete(state2, 1, 'temple_mobile_siege_tech'));
  state2.currentPlayerIndex = 1;
  check('Blast Rite now researchable', canResearch(state2, 'temple_mobile_siege_splash'));
}

console.log(failures === 0 ? `\nPASS: 0 failing check(s)` : `\nFAIL: ${failures} failing check(s)`);
if (failures > 0) process.exit(1);
