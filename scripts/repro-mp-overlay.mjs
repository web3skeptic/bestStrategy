import { chromium } from 'playwright-core';
import fs from 'node:fs'; import path from 'node:path';
const URL='https://interslavic.space/game/';
function findChromium(){const b=path.join(process.env.HOME,'.cache/ms-playwright');for(const d of fs.readdirSync(b)){if(d.startsWith('chromium-')){const p=path.join(b,d,'chrome-linux','chrome');if(fs.existsSync(p))return p;}}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'];
const click=(p,i)=>p.evaluate(x=>document.getElementById(x)?.click(),i);
const meta={}; // name -> {slot, lastCPI}
async function mk(b,name){
  const c=await b.newContext({viewport:{width:900,height:700},serviceWorkers:'block'});
  const p=await c.newPage();
  meta[name]={slot:null,lastCPI:null};
  p.on('console',m=>{const t=m.text(); if(t.includes('[MP] game_start')){const mm=t.match(/slot=(\d+).*currentPlayerIndex=(\d+)/); if(mm){meta[name].slot=+mm[1]; meta[name].lastCPI=+mm[2]; console.log(`  [${name} console] ${t}`);}}});
  p.on('websocket',ws=>{ ws.on('framereceived',f=>{ try{const j=JSON.parse(f.payload); if(j.type==='state_update'||j.type==='game_start'){ const cpi=j.state?.currentPlayerIndex; if(cpi!==undefined){meta[name].lastCPI=cpi;} console.log(`  [${name} WS<-] ${j.type} cpi=${cpi} last="${(j.lastAction||'').slice(0,40)}"`);} else if(j.type==='action_error'){console.log(`  [${name} WS<- action_error] ${j.message}`);} }catch{} }); });
  await p.goto(URL,{waitUntil:'networkidle',timeout:60000}); await sleep(1000); return p;
}
async function login(p,n){await click(p,'menuOnline');await sleep(300);await p.evaluate(x=>{document.getElementById('lobbyUsernameInput').value=x;},n);await click(p,'lobbyLoginBtn');await sleep(900);}
async function overlay(p){ return p.evaluate(()=>{ const o=document.getElementById('opponentTurnOverlay'); const et=document.getElementById('endTurnBtn'); return { overlayHidden:o?.classList.contains('hidden'), overlayText:document.getElementById('opponentTurnName')?.textContent||'', endTurnVisible: et? getComputedStyle(et).display!=='none' : false }; }); }

const b=await chromium.launch({executablePath:findChromium(),headless:true,args});
const A=await mk(b,'A'), B=await mk(b,'B');
await login(A,'OvA'); await login(B,'OvB');
await click(A,'lobbyCreateRoomBtn'); await sleep(700);
const rid=await A.evaluate(()=>document.getElementById('lobbyRoomCode')?.textContent?.trim());
console.log('room', rid);
await B.evaluate(c=>{document.getElementById('lobbyJoinCodeInput').value=c;},rid);
await click(B,'lobbyJoinCodeBtn'); await sleep(2500);
console.log('slots: A=',meta.A.slot,'B=',meta.B.slot,'cpi A/B=',meta.A.lastCPI,'/',meta.B.lastCPI);
console.log('  A overlay', await overlay(A));
console.log('  B overlay', await overlay(B));

const pageBySlot={[meta.A.slot]:A,[meta.B.slot]:B};
const nameBySlot={[meta.A.slot]:'A',[meta.B.slot]:'B'};
for(let round=0; round<3; round++){
  const cpi=meta.A.lastCPI; // shared server truth
  const actor=pageBySlot[cpi]; const actorName=nameBySlot[cpi];
  console.log(`\n== round ${round}: current slot=${cpi} (ctx ${actorName}) ends turn ==`);
  await actor.evaluate(()=>document.getElementById('endTurnBtn')?.click());
  await sleep(1500);
  console.log('  after end: cpi A=',meta.A.lastCPI,'B=',meta.B.lastCPI);
  console.log('  A overlay', await overlay(A));
  console.log('  B overlay', await overlay(B));
}
await b.close();
console.log('\nREPRO DONE');
