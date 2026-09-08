// Map-fairness follow-up — terrain seed placement used to be uniform over
// the FULL hex list, which is itself radius-biased (a ring at radius r has
// 6r tiles vs. 1 at the very centre), so seeds overwhelmingly favored the
// outer rings and left the map's centre looking emptier than the edges by
// construction. generateTerrain now picks a radius uniformly first, then a
// random hex AT that radius, so terrain seeds spread evenly across the whole
// disk (including the centre) while cluster size stays capped exactly as
// before. Exercises the real engine end-to-end (no forked logic) —
// createGameState, which calls generateTerrain internally.
//
// Run with: npx tsx scripts/verify-terrain.ts
import { createGameState } from '../src/game';
import { hexDistance } from '../src/hex';
import type { GameState } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function keyToHex(key: string): { q: number; r: number } {
  const [q, r] = key.split(',').map(Number);
  return { q: q!, r: r! };
}

// Every connected component of a terrain set must be <= maxSize (the
// contiguous-cluster cap is unchanged by this pass).
function maxComponentSize(cells: Set<string>): number {
  const visited = new Set<string>();
  let worst = 0;
  for (const startKey of cells) {
    if (visited.has(startKey)) continue;
    let size = 0;
    const queue = [startKey];
    visited.add(startKey);
    while (queue.length > 0) {
      const key = queue.shift()!;
      size++;
      const { q, r } = keyToHex(key);
      for (const [dq, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]]) {
        const nk = `${q + dq!},${r + dr!}`;
        if (cells.has(nk) && !visited.has(nk)) { visited.add(nk); queue.push(nk); }
      }
    }
    worst = Math.max(worst, size);
  }
  return worst;
}

const SAMPLES = 40;
const states: GameState[] = [];
for (let i = 0; i < SAMPLES; i++) states.push(createGameState());

console.log(`\n=== Contiguous-cluster cap is still exactly 3, across ${SAMPLES} generated maps ===`);
{
  let worstWalls = 0, worstHills = 0, worstForests = 0;
  for (const state of states) {
    worstWalls = Math.max(worstWalls, maxComponentSize(state.walls));
    worstHills = Math.max(worstHills, maxComponentSize(state.hills));
    worstForests = Math.max(worstForests, maxComponentSize(state.forests));
  }
  check('no wall cluster ever exceeds 3 contiguous tiles', worstWalls <= 3, `worst=${worstWalls}`);
  check('no hill cluster ever exceeds 3 contiguous tiles', worstHills <= 3, `worst=${worstHills}`);
  check('no forest cluster ever exceeds 3 contiguous tiles', worstForests <= 3, `worst=${worstForests}`);
}

console.log(`\n=== The map centre gets terrain at roughly the same DENSITY as the rest of the map ===`);
{
  // A hex ring at radius r has 6r tiles vs. 1 at the very centre, so even
  // "even" terrain coverage naturally means fewer ABSOLUTE tiles near the
  // centre — density (tiles per hex) is the metric that actually detects the
  // old radius bias. Compares the innermost third of the radius against the
  // whole map: before this fix that ratio measured ~0.39 (the centre was
  // less than half as dense as the map overall); this fix brings it to ~0.9.
  const mapRadius = states[0]!.mapRadius;
  const innerRadius = Math.max(1, Math.floor(mapRadius / 3));
  const innerHexCount = 1 + 3 * innerRadius * (innerRadius + 1);
  const allHexCount = 1 + 3 * mapRadius * (mapRadius + 1);
  let innerTiles = 0, allTiles = 0;
  for (const state of states) {
    const allTerrain = new Set([...state.walls, ...state.hills, ...state.forests]);
    for (const key of allTerrain) {
      allTiles++;
      if (hexDistance({ q: 0, r: 0 }, keyToHex(key)) <= innerRadius) innerTiles++;
    }
  }
  const innerDensity = innerTiles / (innerHexCount * SAMPLES);
  const overallDensity = allTiles / (allHexCount * SAMPLES);
  const ratio = innerDensity / overallDensity;
  check(`centre terrain density is close to the map-wide average (ratio >= 0.7, was ~0.39 before this fix)`,
    ratio >= 0.7, `ratio=${ratio.toFixed(3)} (inner=${innerDensity.toFixed(3)}/hex, overall=${overallDensity.toFixed(3)}/hex)`);
}

console.log(`\n=== Terrain never invades a Capital's hard exclusion zone (unaffected by this pass) ===`);
{
  let violation: string | null = null;
  outer: for (const state of states) {
    for (const capital of state.capitals) {
      for (const wallKey of state.walls) {
        if (hexDistance(capital.pos, keyToHex(wallKey)) <= 2) {
          violation = `capital=${JSON.stringify(capital.pos)} wall=${wallKey}`;
          break outer;
        }
      }
    }
  }
  check(`no wall ever lands within radius 2 of any Capital, across ${SAMPLES} maps`, violation === null, violation ?? undefined);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
