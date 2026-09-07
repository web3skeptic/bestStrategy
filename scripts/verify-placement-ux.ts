// Farm/Road placement UX pass verification: the canonical getFarmPlacementResult
// / getRoadPlacementResult (game.ts) are the SAME rules the highlighting, the
// per-hex "why is this illegal" UI messages, and actual construction all read
// from — so there must never be a case where a hex the UI highlights as legal
// gets rejected by canStartFarm/canBuildRoad, or vice versa. Exercises the
// real engine (no forked logic) — createGameState, createUnit, startFarm,
// buildRoadPath.
//
// Run with: npx tsx scripts/verify-placement-ux.ts
import {
  createGameState, chooseFaction, createUnit, getPlayerCapital,
  getFarmPlacementResult, getValidFarmHexes, canStartFarm, getAllValidFarmSpots, startFarm,
  getRoadPlacementResult, getValidRoadHexes, canBuildRoad, isLegalRoadTile,
} from '../src/game';
import { FARM_MIN_SPACING, ROAD_SEGMENTS_PER_ACTIVATION, ROAD_COST_PER_HEX, AGRAR_FARM_COST } from '../src/factions';
import { hexDistance, hexNeighbors, hexKey } from '../src/hex';
import type { GameState, HexCoord } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function setup(): GameState {
  const state = createGameState();
  chooseFaction(state, 0, 'agrar');
  chooseFaction(state, 1, 'temple');
  for (const p of state.players) p.aura = 200;
  // Turn order is randomized on reveal — force player 0 (Agrar) to be the
  // active player throughout, since canStartFarm/canBuildRoad (and the
  // canonical getFarmPlacementResult/getRoadPlacementResult) gate on it
  // actually being that unit's player's turn. getValidFarmHexes/
  // getValidRoadHexes deliberately do NOT gate on turn order (the AI uses
  // them to plan regardless of whose turn it currently is), so without this
  // the two would spuriously "disagree" for a reason that has nothing to do
  // with placement legality itself.
  state.currentPlayerIndex = 0;
  return state;
}

// Same re-centering pattern used throughout the rest of the suite.
function clearArea(state: GameState, playerId: number, radius = 6): void {
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

// ── FARM ─────────────────────────────────────────────────────────────────

console.log('\n=== Farm: every highlighted (getValidFarmHexes) cell is actually legal ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  const highlighted = getValidFarmHexes(state, builder);
  check('at least one legal Farm hex near a fresh Capital', highlighted.length > 0);
  check('every highlighted hex passes canStartFarm', highlighted.every(h => canStartFarm(state, builder, h)));
  check('every highlighted hex has an empty reasons list', highlighted.every(h => getFarmPlacementResult(state, builder, h).reasons.length === 0));
}

console.log('\n=== Farm: every legal candidate hex (any Builder neighbour) IS highlighted ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  const highlighted = new Set(getValidFarmHexes(state, builder).map(h => hexKey(h)));
  const legalNeighbours = hexNeighbors(builder.pos).filter(h => canStartFarm(state, builder, h));
  check('every canStartFarm-legal neighbour appears in getValidFarmHexes',
    legalNeighbours.every(h => highlighted.has(hexKey(h))), `legal=${legalNeighbours.length} highlighted=${highlighted.size}`);
}

console.log('\n=== Farm: invalid cells return a meaningful, specific reason ===');
{
  const state = setup();
  clearArea(state, 0, 8);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);

  // Builder adjacency
  const far = { q: cap.pos.q + 6, r: cap.pos.r };
  const farResult = getFarmPlacementResult(state, builder, far);
  check('not adjacent to Builder is reported', !farResult.legal && farResult.reasons.some(r => r.includes('adjacent to the Builder')), JSON.stringify(farResult));

  // Territory
  const outsideTerritory = { q: cap.pos.q + 5, r: cap.pos.r - 1 };
  if (hexDistance({ q: 0, r: 0 }, outsideTerritory) <= state.mapRadius) {
    const territoryResult = getFarmPlacementResult(state, builder, outsideTerritory);
    check('outside-territory reason is present when the hex really is outside',
      territoryResult.reasons.some(r => r.includes('territory')) || territoryResult.reasons.some(r => r.includes('adjacent to the Builder')),
      JSON.stringify(territoryResult));
  }

  // Mountain
  const mountainHex = hexNeighbors(builder.pos)[0]!;
  state.walls.add(hexKey(mountainHex));
  const wallResult = getFarmPlacementResult(state, builder, mountainHex);
  check('mountain-blocked reason is present', !wallResult.legal && wallResult.reasons.some(r => r.includes('ountain')), JSON.stringify(wallResult));
  state.walls.delete(hexKey(mountainHex));

  // Occupied
  const occupiedHex = hexNeighbors(builder.pos)[1]!;
  const blocker = createUnit('warrior', 0, occupiedHex, state.playerTech[0], 'agrar');
  state.units.push(blocker);
  const occResult = getFarmPlacementResult(state, builder, occupiedHex);
  check('occupied-tile reason is present', !occResult.legal && occResult.reasons.some(r => r.includes('occupied')), JSON.stringify(occResult));

  // Insufficient Energy
  state.players[0]!.aura = AGRAR_FARM_COST - 1;
  const legalHex = getValidFarmHexes(state, builder).find(h => !hexEqual(h, occupiedHex));
  if (legalHex) {
    const energyResult = getFarmPlacementResult(state, builder, legalHex);
    check('not-enough-Energy reason is present', !energyResult.legal && energyResult.reasons.some(r => r.includes('Energy')), JSON.stringify(energyResult));
  }
  state.players[0]!.aura = 200;

  // Farm limit reached
  for (let i = 0; i < 10; i++) state.farms.push({ id: `f${i}`, pos: { q: 1000 + i, r: 1000 }, ownerId: 0, state: 'farm', founding: null, hp: 18, maxHp: 18, defense: 5 });
  const capResult = getFarmPlacementResult(state, builder, getValidFarmHexes(state, builder)[0] ?? hexNeighbors(builder.pos)[2]!);
  check('Farm-limit-reached reason is present once at the cap', !capResult.legal && capResult.reasons.some(r => r.includes('limit reached')), JSON.stringify(capResult));
  state.farms = state.farms.filter(f => !f.id.startsWith('f'));
}

function hexEqual(a: HexCoord, b: HexCoord): boolean { return a.q === b.q && a.r === b.r; }

console.log('\n=== Farm: spacing rule (FARM_MIN_SPACING) is represented correctly ===');
{
  const state = setup();
  clearArea(state, 0, 8);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  const candidate = hexNeighbors(builder.pos).find(h => !hexEqual(h, cap.pos))!;

  // An existing Farm exactly FARM_MIN_SPACING away — still legal.
  const farAtSpacing = hexNeighbors(candidate).find(h => hexDistance(h, candidate) === FARM_MIN_SPACING) ?? { q: candidate.q + FARM_MIN_SPACING, r: candidate.r };
  state.farms.push({ id: 'spacingFar', pos: farAtSpacing, ownerId: 0, state: 'farm', founding: null, hp: 18, maxHp: 18, defense: 5 });
  const okResult = getFarmPlacementResult(state, builder, candidate);
  check(`a Farm exactly ${FARM_MIN_SPACING} hexes away does NOT block placement`, !okResult.reasons.some(r => r.includes('too close')), JSON.stringify(okResult));
  state.farms = state.farms.filter(f => f.id !== 'spacingFar');

  // An existing Farm closer than FARM_MIN_SPACING — blocked, with the spacing reason.
  const tooClose = hexNeighbors(candidate)[0]!;
  state.farms.push({ id: 'spacingClose', pos: tooClose, ownerId: 0, state: 'farm', founding: null, hp: 18, maxHp: 18, defense: 5 });
  const blockedResult = getFarmPlacementResult(state, builder, candidate);
  check('a Farm closer than the spacing minimum blocks placement with the spacing reason',
    !blockedResult.legal && blockedResult.reasons.some(r => r.includes('too close to another Farm')), JSON.stringify(blockedResult));
  state.farms = state.farms.filter(f => f.id !== 'spacingClose');
}

console.log('\n=== Farm: territory rule (getAllValidFarmSpots) matches getFarmPlacementResult ===');
{
  const state = setup();
  clearArea(state, 0, 8);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  const territorySpots = new Set(getAllValidFarmSpots(state, 0).map(h => hexKey(h)));
  // Any hex adjacent to the Builder AND legal must also be a valid territory spot.
  const adjacentLegal = getValidFarmHexes(state, builder);
  check('every adjacency-legal Farm hex is also a valid territory-wide spot',
    adjacentLegal.every(h => territorySpots.has(hexKey(h))));
}

// ── ROAD ─────────────────────────────────────────────────────────────────

console.log('\n=== Road: every highlighted first-tile candidate is actually legal ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  const candidates = getValidRoadHexes(state, builder);
  check('at least one legal first-Road hex near a fresh Capital', candidates.length > 0);
  check('every candidate passes canBuildRoad', candidates.every(h => canBuildRoad(state, builder, h)));
  check('every candidate has an empty reasons list from getRoadPlacementResult',
    candidates.every(h => getRoadPlacementResult(state, builder, h, []).reasons.length === 0));
}

console.log('\n=== Road: after Road 1, only legal continuations highlight ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  const first = getValidRoadHexes(state, builder)[0]!;
  // A legal continuation: a neighbour of `first` that's still on-map/legal terrain.
  const continuation = hexNeighbors(first).find(h => isLegalRoadTile(state, h) && hexDistance({ q: 0, r: 0 }, h) <= state.mapRadius);
  check('setup: found a plausible continuation candidate', !!continuation);
  if (continuation) {
    const contResult = getRoadPlacementResult(state, builder, continuation, [first]);
    check('a hex adjacent to Road 1 (not the Builder) is offered as a legal continuation', contResult.legal, JSON.stringify(contResult));
  }
  // A hex that is legal terrain but NOT adjacent to Road 1 must be rejected as a continuation.
  const nonAdjacent = hexNeighbors(builder.pos).find(h => !hexEqual(h, first) && isLegalRoadTile(state, h));
  if (nonAdjacent && hexDistance(nonAdjacent, first) !== 1) {
    const badCont = getRoadPlacementResult(state, builder, nonAdjacent, [first]);
    check('a legal-terrain hex NOT adjacent to Road 1 is rejected as a continuation, with a reason',
      !badCont.legal && badCont.reasons.some(r => r.includes('continue directly')), JSON.stringify(badCont));
  }
}

console.log('\n=== Road: max 2 Road tiles per activation ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  check('ROAD_SEGMENTS_PER_ACTIVATION is 2', ROAD_SEGMENTS_PER_ACTIVATION === 2, `got ${ROAD_SEGMENTS_PER_ACTIVATION}`);
  const first = getValidRoadHexes(state, builder)[0]!;
  const second = hexNeighbors(first).find(h => isLegalRoadTile(state, h) && hexDistance({ q: 0, r: 0 }, h) <= state.mapRadius);
  if (second) {
    const thirdCandidate = hexNeighbors(second).find(h => isLegalRoadTile(state, h) && hexDistance({ q: 0, r: 0 }, h) <= state.mapRadius && !hexEqual(h, first));
    if (thirdCandidate) {
      const thirdResult = getRoadPlacementResult(state, builder, thirdCandidate, [first, second]);
      check('a 3rd Road tile is always illegal (max reached)',
        !thirdResult.legal && thirdResult.reasons.some(r => r.includes('maximum')), JSON.stringify(thirdResult));
    }
  }
}

console.log('\n=== Road: correct Energy cost is reflected in placement legality ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  const first = getValidRoadHexes(state, builder)[0]!;
  const second = hexNeighbors(first).find(h => isLegalRoadTile(state, h) && hexDistance({ q: 0, r: 0 }, h) <= state.mapRadius);
  check('setup: found a 2nd contiguous Road hex', !!second);
  if (second) {
    // Exactly enough for 1 Road, not 2.
    state.players[0]!.aura = ROAD_COST_PER_HEX;
    const firstResult = getRoadPlacementResult(state, builder, first, []);
    check('Road 1 is affordable with exactly 1 Road worth of Energy', firstResult.legal, JSON.stringify(firstResult));
    const secondResult = getRoadPlacementResult(state, builder, second, [first]);
    check('Road 2 is correctly reported as unaffordable with only 1 Road worth of Energy left',
      !secondResult.legal && secondResult.reasons.some(r => r.includes('Energy')), JSON.stringify(secondResult));
    state.players[0]!.aura = 200;
  }
}

console.log('\n=== Road: invalid cells return a meaningful, specific reason ===');
{
  const state = setup();
  clearArea(state, 0, 8);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);

  const mountainHex = hexNeighbors(builder.pos)[0]!;
  state.walls.add(hexKey(mountainHex));
  const wallResult = getRoadPlacementResult(state, builder, mountainHex, []);
  check('mountain-blocked reason is present for Roads', !wallResult.legal && wallResult.reasons.some(r => r.includes('ountain')), JSON.stringify(wallResult));
  state.walls.delete(hexKey(mountainHex));

  // An ENEMY unit occupying the tile still blocks Road construction there.
  const occupiedHex = hexNeighbors(builder.pos)[1]!;
  const enemyBlocker = createUnit('warrior', 1, occupiedHex, state.playerTech[1], 'temple');
  state.units.push(enemyBlocker);
  const occResult = getRoadPlacementResult(state, builder, occupiedHex, []);
  check('an enemy unit occupying the tile blocks Road construction, with a reason',
    !occResult.legal && occResult.reasons.some(r => r.includes('enemy')), JSON.stringify(occResult));
  state.units = state.units.filter(u => u.id !== enemyBlocker.id);

  // The BUILDING PLAYER'S OWN unit occupying the tile does NOT block —
  // paving a Road under/through your own stationed unit is fine.
  const ownBlocker = createUnit('warrior', 0, occupiedHex, state.playerTech[0], 'agrar');
  state.units.push(ownBlocker);
  const ownOccResult = getRoadPlacementResult(state, builder, occupiedHex, []);
  check('the building player\'s OWN unit occupying the tile does NOT block Road construction',
    !ownOccResult.reasons.some(r => r.includes('occupied') || r.includes('enemy')), JSON.stringify(ownOccResult));
  state.units = state.units.filter(u => u.id !== ownBlocker.id);

  // Not connected to Capital/Farm/Road: a hex 2 away from the Builder can
  // never even reach the adjacency test, so use a Builder placed off to the
  // side whose neighbours are legal terrain but disconnected from any anchor.
  const farBuilder = createUnit('founder', 0, { q: cap.pos.q + 5, r: cap.pos.r }, state.playerTech[0], 'agrar');
  state.units.push(farBuilder);
  const disconnectedHex = hexNeighbors(farBuilder.pos)[0]!;
  const discResult = getRoadPlacementResult(state, farBuilder, disconnectedHex, []);
  check('not-connected-to-network reason is present when nothing anchors the first tile',
    !discResult.legal && discResult.reasons.some(r => r.includes('not connected')), JSON.stringify(discResult));
}

console.log('\n=== UI and engine legality cannot disagree (canBuildRoad === getRoadPlacementResult.legal) ===');
{
  const state = setup();
  clearArea(state, 0, 4);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  let allAgree = true;
  for (let dq = -4; dq <= 4; dq++) {
    for (let dr = -4; dr <= 4; dr++) {
      const hex = { q: cap.pos.q + dq, r: cap.pos.r + dr };
      if (canBuildRoad(state, builder, hex) !== getRoadPlacementResult(state, builder, hex, []).legal) allAgree = false;
    }
  }
  check('canBuildRoad and getRoadPlacementResult.legal agree on every nearby hex', allAgree);
}

console.log('\n=== A real build only ever succeeds through startFarm/buildRoadPath after getFarmPlacementResult/getRoadPlacementResult says legal ===');
{
  const state = setup();
  clearArea(state, 0);
  const cap = getPlayerCapital(state, 0)!;
  const builder = createUnit('founder', 0, hexNeighbors(cap.pos)[0]!, state.playerTech[0], 'agrar');
  state.units.push(builder);
  const legalFarmHex = getValidFarmHexes(state, builder)[0]!;
  check('setup: legality result says legal before the real build', getFarmPlacementResult(state, builder, legalFarmHex).legal);
  const started = startFarm(state, builder.id, legalFarmHex);
  check('startFarm actually succeeds on a hex the canonical result says is legal', started);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
