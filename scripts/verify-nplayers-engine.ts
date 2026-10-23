// PHASE 3 NOTE: N-player (3-6) support is dormant/unsupported in the live
// product (online rooms are 1v1 only — see gameManager.ts), but the engine
// itself still runs it for tooling, so this keeps checking placement/rotation
// geometry. The old "resign eliminates one player, game continues until one
// remains" behavior is GONE — resignGame now always ends the match
// immediately (there's no more N-player "last standing" win condition, only
// Capital-HP — see game.ts §5). Assertions below reflect that.
import { createGameState, endTurn, resignGame, MIN_TEMPLE_SEPARATION } from '../src/game';
import { PLAYER_COLORS, mapRadiusForPlayers, neutralSiteCountForPlayers } from '../src/types';
import { hexDistance } from '../src/hex';

function cfgs(n: number) { return Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}`, color: PLAYER_COLORS[i]! })); }
function minStructureDist(s: any): number {
  const all = [...s.capitals, ...s.strategicSites];
  let m = Infinity;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) m = Math.min(m, hexDistance(all[i].pos, all[j].pos));
  return m;
}

let pass = 0, fail = 0;
const ok = (c: boolean, msg: string) => { if (c) { pass++; } else { fail++; console.log('  ✗', msg); } };

for (const n of [2, 3, 4, 5, 6]) {
  const s = createGameState(cfgs(n));
  ok(s.players.length === n, `${n}p players`);
  ok(s.mapRadius === mapRadiusForPlayers(n), `${n}p radius ${s.mapRadius} exp ${mapRadiusForPlayers(n)}`);
  ok(s.capitals.length === n, `${n}p capitals ${s.capitals.length} exp ${n}`);
  ok(s.strategicSites.length === neutralSiteCountForPlayers(n), `${n}p neutral sites ${s.strategicSites.length} exp ${neutralSiteCountForPlayers(n)}`);
  ok(s.units.filter((u: any) => u.hp > 0).length === n * 3, `${n}p units ${s.units.filter((u: any) => u.hp > 0).length} (warrior+archer+founder each)`);
  const md = minStructureDist(s);
  ok(md >= MIN_TEMPLE_SEPARATION, `${n}p minStructureDist ${md} >= ${MIN_TEMPLE_SEPARATION}`);
  const colors = new Set(s.players.map((p: any) => p.color));
  ok(colors.size === n, `${n}p distinct colors ${colors.size}`);
  const border = s.capitals.some((c: any) => hexDistance({ q: 0, r: 0 }, c.pos) === s.mapRadius);
  console.log(`  ${n}p: radius=${s.mapRadius} capitals=${s.capitals.length} sites=${s.strategicSites.length} minDist=${md} anyOnBorder=${border}`);
}

// Turn rotation visits every player (4p) — no more skip-eliminated-player
// logic (§11 — a Capital is permanent, so nobody is ever skipped).
{
  const s = createGameState(cfgs(4));
  const order: number[] = [];
  for (let i = 0; i < 8; i++) { order.push(s.currentPlayerIndex); endTurn(s); }
  const distinct = new Set(order);
  ok(distinct.size === 4, `4p rotation visits all 4 (${[...distinct].join(',')})`);
}

// Resign always ends the match immediately now (no more N-player elimination
// chain) — winner is just "some other player" (arbitrary pick for N>2, which
// is fine since N-player is dormant/untested by design).
{
  const s = createGameState(cfgs(4));
  resignGame(s, 0);
  ok(s.phase === 'gameOver', '4p resign ends the match immediately');
  ok(s.winner !== null && s.winner.id !== 0, `4p winner is someone other than the resigner (got ${s.winner?.id})`);
}

// 2p: resign → opponent wins
{
  const s = createGameState(cfgs(2));
  const other = s.currentPlayerIndex === 0 ? 1 : 0;
  resignGame(s, s.currentPlayerIndex);
  ok(s.phase === 'gameOver' && s.winner?.id === other, `2p resign → opponent ${other} wins (got ${s.winner?.id})`);
}

// Two seeds differ
{
  const a = createGameState(cfgs(4)).capitals.map((c: any) => `${c.pos.q},${c.pos.r}`).join('|');
  const b = createGameState(cfgs(4)).capitals.map((c: any) => `${c.pos.q},${c.pos.r}`).join('|');
  ok(a !== b, 'two seeds produce different Capital layouts');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
