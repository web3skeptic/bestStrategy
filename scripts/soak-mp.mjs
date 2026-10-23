import { chromium } from 'playwright-core';
import fs from 'node:fs'; import path from 'node:path';
const URL='https://interslavic.space/game/';
function findChromium(){const b=path.join(process.env.HOME,'.cache/ms-playwright');for(const d of fs.readdirSync(b)){if(d.startsWith('chromium-')){const p=path.join(b,d,'chrome-linux','chrome');if(fs.existsSync(p))return p;}}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'];
const click=(p,i)=>p.evaluate(x=>document.getElementById(x)?.click(),i);
const meta={};
async function tap(p,x,y){await p.mouse.move(x,y);await p.mouse.down();await p.mouse.up();await sleep(220);}
async function mk(b,name){const c=await b.newContext({viewport:{width:1000,height:760},serviceWorkers:'block'});const p=await c.newPage();meta[name]={slot:null,cpi:null};
  p.on('console',m=>{const t=m.text();if(t.includes('[MP] game_start')){const mm=t.match(/slot=(\d+).*currentPlayerIndex=(\d+)/);if(mm){meta[name].slot=+mm[1];meta[name].cpi=+mm[2];}}});
  p.on('websocket',ws=>{ws.on('framereceived',f=>{try{const j=JSON.parse(f.payload);if((j.type==='state_update'||j.type==='game_start')&&j.state?.currentPlayerIndex!==undefined)meta[name].cpi=j.state.currentPlayerIndex;}catch{}});});
  await p.goto(URL,{waitUntil:'networkidle',timeout:60000});await sleep(1000);return p;}
async function login(p,n){await click(p,'menuOnline');await sleep(300);await p.evaluate(x=>{document.getElementById('lobbyUsernameInput').value=x;},n);await click(p,'lobbyLoginBtn');await sleep(900);}
const ovHidden=p=>p.evaluate(()=>document.getElementById('opponentTurnOverlay')?.classList.contains('hidden'));
const own=p=>p.evaluate(()=>window.__own());

const b=await chromium.launch({executablePath:findChromium(),headless:true,args});
const A=await mk(b,'A'),B=await mk(b,'B');
await login(A,'SoakA');await login(B,'SoakB');
await click(A,'lobbyCreateRoomBtn');await sleep(700);
const rid=await A.evaluate(()=>document.getElementById('lobbyRoomCode')?.textContent?.trim());
await B.evaluate(c=>{document.getElementById('lobbyJoinCodeInput').value=c;},rid);await click(B,'lobbyJoinCodeBtn');await sleep(3000);
const pageBySlot={[meta.A.slot]:A,[meta.B.slot]:B};
let violations=0;
async function checkInvariant(tag){
  const hA=await ovHidden(A), hB=await ovHidden(B);
  const cpi=meta.A.cpi;
  // current player's overlay must be hidden; the other's must be shown
  const aShouldHide = (meta.A.slot===cpi), bShouldHide=(meta.B.slot===cpi);
  const okA = hA===aShouldHide, okB = hB===bShouldHide;
  if(!okA||!okB){ violations++; console.log(`  ✗ VIOLATION @${tag}: cpi=${cpi} A(slot${meta.A.slot})hidden=${hA}(exp${aShouldHide}) B(slot${meta.B.slot})hidden=${hB}(exp${bShouldHide})`); }
  return {cpi,hA,hB};
}
for(let round=0; round<10; round++){
  const cpi=meta.A.cpi; const actor=pageBySlot[cpi];
  await checkInvariant(`r${round}-start`);
  // do a real move sometimes
  if(round%2===0){
    try{ const o=await own(actor); if(o.units.length){ const u=o.units[0]; await tap(actor,u.x,u.y); await sleep(350);
      for(const [dx,dy] of [[0,-55],[48,-28],[-48,28]]){ await tap(actor,u.x+dx,u.y+dy); await sleep(400); const o2=await own(actor); const u2=o2.units.find(z=>z.id===u.id); if(u2&&(Math.abs(u2.x-u.x)>6||Math.abs(u2.y-u.y)>6))break; await tap(actor,u.x,u.y); await sleep(250);} } }catch(e){console.log('  move err',String(e).slice(0,60));}
    await checkInvariant(`r${round}-aftermove`);
  }
  await actor.evaluate(()=>document.getElementById('endTurnBtn')?.click());
  await sleep(1300);
  await checkInvariant(`r${round}-afterend`);
}
console.log(`\nSOAK RESULT: ${violations} invariant violations over 10 rounds`);
await b.close();
