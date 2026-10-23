// Fog-of-war rules: what a unit's move and attack highlights may reveal.
//
//  • An enemy unit the mover's player can't see (out of vision, or in a forest
//    with no adjacent friendly) must not block movement — otherwise the hole it
//    leaves in the green move area gives its position away.
//  • Moving onto that hex is refused ("blocked") without spending the move.
//  • A visible enemy still blocks, exactly as before.
//  • Enemy structures can be targeted only while visible (or adjacent),
//    the same as units.
//
// Run with: npx tsx scripts/verify-fog.ts
import { hexKey, hexDistance } from '../src/hex';
import {
  createGameState, chooseFaction, selectUnit, moveUnit, createUnit, getPlayerVisible,
} from '../src/game';
import type { GameState, HexCoord, Unit } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const has = (list: HexCoord[], h: HexCoord) => list.some(x => x.q === h.q && x.r === h.r);

// A fresh game with the centre of the map cleared: no terrain, sites or
// capitals within radius 5 of (0,0), so each scenario controls exactly what
// stands where. Player 0 is the viewer, player 1 the enemy.
function setup(): GameState {
  const state = createGameState();
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
  const far = state.mapRadius * 6;
  let offset = 0;
  const centre = { q: 0, r: 0 };
  for (const c of state.capitals) if (hexDistance(c.pos, centre) <= 5) c.pos = { q: far, r: far + offset++ };
  for (const s of state.strategicSites) if (hexDistance(s.pos, centre) <= 5) s.pos = { q: far, r: far + offset++ };
  for (const f of state.fertileSites) if (hexDistance(f.pos, centre) <= 5) f.pos = { q: far, r: far + offset++ };
  for (let dq = -5; dq <= 5; dq++) {
    for (let dr = Math.max(-5, -dq - 5); dr <= Math.min(5, -dq + 5); dr++) {
      const key = hexKey({ q: dq, r: dr });
      state.hills.delete(key); state.walls.delete(key); state.forests.delete(key);
    }
  }
  state.units = [];
  state.currentPlayerIndex = 0;
  return state;
}

function place(state: GameState, type: 'warrior' | 'archer', playerId: number, pos: HexCoord, stats: Partial<Unit['stats']> = {}): Unit {
  const player = state.players[playerId]!;
  const unit = createUnit(type, playerId, pos, state.playerTech[playerId], player.faction);
  unit.stats = { ...unit.stats, ...stats };
  state.units.push(unit);
  return unit;
}

console.log('\n=== A hidden enemy does not shape the move highlight ===');
{
  const state = setup();
  const mine = place(state, 'warrior', 0, { q: 0, r: 0 }, { speed: 3, vision: 2 });
  // Enemy in a forest two hexes away: inside vision range, but a forest hides
  // a unit unless a friendly stands next to it.
  const hiddenPos = { q: 2, r: 0 };
  state.forests.add(hexKey(hiddenPos));
  place(state, 'warrior', 1, hiddenPos);
  check('setup: the forest hex is in vision', getPlayerVisible(state, 0).has(hexKey(hiddenPos)));

  selectUnit(state, mine.id);
  check('the hidden enemy\'s hex is highlighted as a move target', has(state.moveHexes, hiddenPos));
  check('the hex beyond the hidden enemy is reachable too', has(state.moveHexes, { q: 3, r: 0 }));

  const result = moveUnit(state, hiddenPos);
  check('moving onto the hidden enemy is refused', !result.moved);
  check('…and reported as blocked', result.blocked === true);
  check('the unit stays put', mine.pos.q === 0 && mine.pos.r === 0);
  check('the move is not spent', !mine.hasMoved);
}

console.log('\n=== A visible enemy still blocks ===');
{
  const state = setup();
  const mine = place(state, 'warrior', 0, { q: 0, r: 0 }, { speed: 3, vision: 2 });
  const visiblePos = { q: 0, r: 2 };
  place(state, 'warrior', 1, visiblePos);
  selectUnit(state, mine.id);
  check('the visible enemy\'s hex is not a move target', !has(state.moveHexes, visiblePos));
}

console.log('\n=== Enemy structures must be seen to be targeted ===');
{
  const state = setup();
  const archer = place(state, 'archer', 0, { q: 0, r: 0 }, { range: 4, vision: 2 });
  const seenFarm = { q: 0, r: -2 };
  const fogFarm = { q: 4, r: 0 };
  state.farms.push(
    { id: 'farm_seen', pos: seenFarm, ownerId: 1, state: 'farm', hp: 18, maxHp: 18, defense: 5, founding: null } as GameState['farms'][number],
    { id: 'farm_fog', pos: fogFarm, ownerId: 1, state: 'farm', hp: 18, maxHp: 18, defense: 5, founding: null } as GameState['farms'][number],
  );
  check('setup: one farm in vision, one in the fog', getPlayerVisible(state, 0).has(hexKey(seenFarm)) && !getPlayerVisible(state, 0).has(hexKey(fogFarm)));
  selectUnit(state, archer.id);
  check('the visible farm in range is a target', has(state.structureAttackHexes, seenFarm));
  check('the farm in the fog is not a target, though in range', !has(state.structureAttackHexes, fogFarm));
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
