// Every AI level uses the whole game, not a favourite subset: across a set of
// seeded AI-vs-AI games each level recruits every unit type of its faction,
// researches every tech (one option of each exclusive branch, with every
// option possible), builds its economy (Farms/Roads or Temples and
// upgrades) and attacks units and structures.
//
//   npx tsx scripts/verify-ai-capabilities.ts
import { playMatch, type CapabilityLog } from '../ai-evolve/match';
import { AI_DIFFICULTIES } from '../src/ai';
import { branchChoice, DEFAULT_GENOME, SUPPORT_BRANCH, STAT_BRANCH } from '../src/aiGenome';
import { createGameState } from '../src/game';
import { FACTION_UNITS } from '../src/factions';
import { TECH_NODES, type FactionId, type UnitType } from '../src/types';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

const MATCHUPS: [FactionId, FactionId][] = [['agrar', 'temple'], ['temple', 'agrar'], ['agrar', 'agrar'], ['temple', 'temple']];
const SEEDS = [11, 12, 13];

for (const difficulty of AI_DIFFICULTIES) {
  console.log(`\n=== ${difficulty}: capabilities used across ${MATCHUPS.length * SEEDS.length} games ===`);
  const logs: Record<FactionId, CapabilityLog[]> = { agrar: [], temple: [] };
  for (const seed of SEEDS) {
    for (const factions of MATCHUPS) {
      const r = playMatch(seed, [{ difficulty }, { difficulty }], factions, 70);
      logs[factions[0]].push(r.logs[0]);
      logs[factions[1]].push(r.logs[1]);
    }
  }
  for (const faction of ['agrar', 'temple'] as const) {
    const L = logs[faction];
    const recruited = (t: UnitType) => L.some(l => (l.recruits[t] ?? 0) > 0);
    const researched = (id: string) => L.some(l => l.research.includes(id));
    const units = FACTION_UNITS[faction].filter(u => !u.isSupport).map(u => u.slot as UnitType);
    const missingUnits = units.filter(t => !recruited(t));
    check(`${faction}: recruits every combat unit type`, missingUnits.length === 0, missingUnits.join(', '));
    check(`${faction}: recruits support units`, (['healer', 'damageBooster', 'rangeBooster'] as UnitType[]).some(recruited));
    const techs = TECH_NODES.filter(t => (!t.faction || t.faction === faction) && !t.branch);
    const missingTech = techs.filter(t => !researched(t.id)).map(t => t.id);
    check(`${faction}: researches every non-branch tech`, missingTech.length === 0, missingTech.join(', '));
    check(`${faction}: researches a support unlock`, SUPPORT_BRANCH.some(researched));
    check(`${faction}: researches a stat bonus`, STAT_BRANCH.some(researched));
    if (faction === 'agrar') {
      check('agrar: builds Farms', L.some(l => l.farmsStarted > 0));
      check('agrar: builds Roads', L.some(l => l.roadsBuilt > 0));
    } else {
      check('temple: founds Temples', L.some(l => l.templesFounded > 0));
      check('temple: upgrades Temples', L.some(l => l.templeUpgrades > 0));
    }
    check(`${faction}: attacks units`, L.some(l => l.unitHits > 0));
    check(`${faction}: attacks structures`, L.some(l => l.farmHits + l.templeHits + l.capitalHits > 0));
  }
}

console.log('\n=== exclusive branches: every option keeps a real chance each game ===');
{
  const counts = new Map<string, number>();
  for (let i = 0; i < 2000; i++) {
    const state = createGameState();
    for (const branch of ['support', 'stat'] as const) {
      const pick = branchChoice(state, 0, branch, DEFAULT_GENOME.agrar);
      counts.set(pick, (counts.get(pick) ?? 0) + 1);
    }
  }
  for (const id of [...SUPPORT_BRANCH, ...STAT_BRANCH]) {
    const share = (counts.get(id) ?? 0) / 2000;
    check(`${id} picked in at least 10% of games`, share >= 0.1, `${(share * 100).toFixed(0)}%`);
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
