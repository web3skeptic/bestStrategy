import { chromium } from 'playwright-core';
import fs from 'node:fs'; import path from 'node:path';
const URL='https://interslavic.space/game/';
function findChromium(){const b=path.join(process.env.HOME,'.cache/ms-playwright');for(const d of fs.readdirSync(b)){if(d.startsWith('chromium-')){const p=path.join(b,d,'chrome-linux','chrome');if(fs.existsSync(p))return p;}}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'];
const click=(p,i)=>p.evaluate(x=>document.getElementById(x)?.click(),i);
const meta={};
async function tap(p,x,y){ await p.mouse.move(x,y); await p.mouse.down(); await p.mouse.up(); await sleep(250); }
async function mk(b,name){
  const c=await b.newContext({viewport:{width:1000,height:760},serviceWorkers:'block'});
  const p=await c.newPage(); meta[name]={slot:null,cpi:null};
  p.on('console',m=>{const t=m.text(); if(t.includes('[MP] game_start')){const mm=t.match(/slot=(\d+).*currentPlayerIndex=(\d+)/); if(mm){meta[name].slot=+mm[1];meta[name].cpi=+mm[2];}}});
  p.on('websocket',ws=>{ws.on('framereceived',f=>{try{const j=JSON.parse(f.payload); if((j.type==='state_update'||j.type==='game_start')&&j.state?.currentPlayerIndex!==undefined)meta[name].cpi=j.state.currentPlayerIndex; if(j.type==='action_error')console.log(`  [${name} action_error] ${j.message}`);}catch{}});});
  await p.goto(URL,{waitUntil:'networkidle',timeout:60000}); await sleep(1000); return p;
}
async function login(p,n){await click(p,'menuOnline');await sleep(300);await p.evaluate(x=>{document.getElementById('lobbyUsernameInput').value=x;},n);await click(p,'lobbyLoginBtn');await sleep(900);}
const sel=p=>p.evaluate(()=>window.__sel());
const own=p=>p.evaluate(()=>window.__own());
const ov=p=>p.evaluate(()=>document.getElementById('opponentTurnOverlay')?.classList.contains('hidden'));

const b=await chromium.launch({executablePath:findChromium(),headless:true,args});
const A=await mk(b,'A'),B=await mk(b,'B');
await login(A,'MvA');await login(B,'MvB');
await click(A,'lobbyCreateRoomBtn');await sleep(700);
const rid=await A.evaluate(()=>document.getElementById('lobbyRoomCode')?.textContent?.trim());
await B.evaluate(c=>{document.getElementById('lobbyJoinCodeInput').value=c;},rid);
await click(B,'lobbyJoinCodeBtn');await sleep(3000);
const pageBySlot={[meta.A.slot]:A,[meta.B.slot]:B}, nameBySlot={[meta.A.slot]:'A',[meta.B.slot]:'B'};
const cpi=meta.A.cpi; const actor=pageBySlot[cpi], other=pageBySlot[cpi^1];
console.log(`current slot ${cpi} = ctx ${nameBySlot[cpi]}. actor overlayHidden=${await ov(actor)} other overlayHidden=${await ov(other)}`);

// ACTOR selects its first unit and moves it
const o=await own(actor);
console.log(`actor owns ${o.units.length} units, ${o.temples.length} temples`);
const u=o.units[0];
console.log('tap unit at', Math.round(u.x), Math.round(u.y));
await tap(actor, u.x, u.y);
await sleep(400);
const s1=await sel(actor);
console.log('after unit tap, actor selection:', JSON.stringify(s1));
// read move hexes from state via WS? Instead, tap a spot near the unit (one hex up)
// try tapping a few offsets to find a legal move
let moved=false;
for(const [dx,dy] of [[0,-55],[48,-28],[48,28],[-48,-28]]){
  await tap(actor, u.x+dx, u.y+dy); await sleep(500);
  const o2=await own(actor); const u2=o2.units.find(x=>x.id===u.id);
  if(u2 && (Math.abs(u2.x-u.x)>6||Math.abs(u2.y-u.y)>6)){ moved=true; console.log(`unit MOVED to`,Math.round(u2.x),Math.round(u2.y)); break; }
  // reselect for next attempt
  await tap(actor, u.x, u.y); await sleep(300);
}
console.log('MOVE SUCCESS =', moved);
console.log(`after move: actor overlayHidden=${await ov(actor)} other overlayHidden=${await ov(other)}`);
// actor ends turn
await actor.evaluate(()=>document.getElementById('endTurnBtn')?.click()); await sleep(1500);
console.log(`after end turn: cpi=${meta.A.cpi} actor(${nameBySlot[cpi]})overlayHidden=${await ov(actor)} other overlayHidden=${await ov(other)}`);
await b.close();
console.log('DONE');
