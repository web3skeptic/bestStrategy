import { createGameState, endTurn, resignGame, MIN_TEMPLE_SEPARATION } from '../src/game';
import { PLAYER_COLORS, mapRadiusForPlayers, templeCountForPlayers } from '../src/types';
import { hexDistance } from '../src/hex';

function cfgs(n:number){ return Array.from({length:n},(_,i)=>({name:`P${i+1}`,color:PLAYER_COLORS[i]!})); }
function minTempleDist(s:any){ let m=Infinity; const T=s.temples; for(let i=0;i<T.length;i++)for(let j=i+1;j<T.length;j++)m=Math.min(m,hexDistance(T[i].pos,T[j].pos)); return m; }

let pass=0, fail=0;
const ok=(c:boolean,msg:string)=>{ if(c){pass++;} else {fail++; console.log('  ✗',msg);} };

for(const n of [2,3,4,5,6]){
  const s=createGameState(cfgs(n));
  ok(s.players.length===n, `${n}p players`);
  ok(s.mapRadius===mapRadiusForPlayers(n), `${n}p radius ${s.mapRadius} exp ${mapRadiusForPlayers(n)}`);
  ok(s.temples.length===templeCountForPlayers(n), `${n}p temples ${s.temples.length} exp ${templeCountForPlayers(n)}`);
  ok(s.temples.filter((t:any)=>t.ownerId!==null).length===n, `${n}p start temples = ${n}`);
  ok(s.units.filter((u:any)=>u.hp>0).length===n*2, `${n}p units ${s.units.filter((u:any)=>u.hp>0).length}`);
  const md=minTempleDist(s);
  ok(md>=MIN_TEMPLE_SEPARATION, `${n}p minTempleDist ${md} >= ${MIN_TEMPLE_SEPARATION}`);
  const colors=new Set(s.players.map((p:any)=>p.color));
  ok(colors.size===n, `${n}p distinct colors ${colors.size}`);
  const border=s.temples.some((t:any)=>hexDistance({q:0,r:0},t.pos)===s.mapRadius);
  console.log(`  ${n}p: radius=${s.mapRadius} temples=${s.temples.length} minDist=${md} anyOnBorder=${border} startTempleIds=${s.players.map((p:any)=>p.startTempleId).join(',')}`);
}

// Turn rotation skips eliminated players (4p)
{
  const s=createGameState(cfgs(4));
  const order:number[]=[];
  let cur=s.currentPlayerIndex;
  for(let i=0;i<8;i++){ order.push(s.currentPlayerIndex); endTurn(s); }
  const distinct=new Set(order);
  ok(distinct.size===4, `4p rotation visits all 4 (${[...distinct].join(',')})`);
}

// Elimination + win: resign players one-by-one, last standing wins
{
  const s=createGameState(cfgs(4));
  resignGame(s,0);
  ok(s.temples.every((t:any)=>t.ownerId!==0), '4p resigned P0 temples released');
  ok(s.units.filter((u:any)=>u.playerId===0&&u.hp>0).length===0, '4p resigned P0 units dead');
  ok(s.phase==='playing', '4p still playing after 1 resign');
  resignGame(s,1);
  resignGame(s,2);
  ok(s.phase==='gameOver', '4p gameOver after 3 resigns');
  ok(s.winner?.id===3, `4p winner is P3 (got ${s.winner?.id})`);
}

// 2p compat: resign → opponent wins
{
  const s=createGameState(cfgs(2));
  const other = s.currentPlayerIndex===0?1:0;
  resignGame(s, s.currentPlayerIndex);
  ok(s.phase==='gameOver' && s.winner?.id===other, `2p resign → opponent ${other} wins (got ${s.winner?.id})`);
}

// Two seeds differ
{
  const a=createGameState(cfgs(4)).temples.map((t:any)=>`${t.pos.q},${t.pos.r}`).join('|');
  const b=createGameState(cfgs(4)).temples.map((t:any)=>`${t.pos.q},${t.pos.r}`).join('|');
  ok(a!==b, 'two seeds produce different temple layouts');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
