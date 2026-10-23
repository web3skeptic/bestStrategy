import { chromium } from 'playwright-core';
import fs from 'node:fs'; import path from 'node:path';
const URL='https://interslavic.space/game/';
function findChromium(){const b=path.join(process.env.HOME,'.cache/ms-playwright');for(const d of fs.readdirSync(b)){if(d.startsWith('chromium-')){const p=path.join(b,d,'chrome-linux','chrome');if(fs.existsSync(p))return p;}}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'];
const click=(p,i)=>p.evaluate(x=>document.getElementById(x)?.click(),i);
const meta={};
async function mk(b,name){
  const c=await b.newContext({viewport:{width:900,height:700},serviceWorkers:'block'});
  const p=await c.newPage(); meta[name]={slot:null,cpi:null};
  p.on('console',m=>{const t=m.text(); if(t.includes('[MP] game_start')){const mm=t.match(/slot=(\d+).*currentPlayerIndex=(\d+)/); if(mm){meta[name].slot=+mm[1];meta[name].cpi=+mm[2];}}});
  p.on('websocket',ws=>{ws.on('framereceived',f=>{try{const j=JSON.parse(f.payload); if((j.type==='state_update'||j.type==='game_start')&&j.state?.currentPlayerIndex!==undefined)meta[name].cpi=j.state.currentPlayerIndex;}catch{}});});
  await p.goto(URL,{waitUntil:'networkidle',timeout:60000}); await sleep(1000); return p;
}
async function login(p,n){await click(p,'menuOnline');await sleep(300);await p.evaluate(x=>{document.getElementById('lobbyUsernameInput').value=x;},n);await click(p,'lobbyLoginBtn');await sleep(900);}
const ov=p=>p.evaluate(()=>document.getElementById('opponentTurnOverlay')?.classList.contains('hidden'));
async function report(pages){ const r=[]; for(const [n,p] of Object.entries(pages)) r.push(`${n}(slot${meta[n].slot}):ovHidden=${await ov(p)}`); return r.join('  '); }

const b=await chromium.launch({executablePath:findChromium(),headless:true,args});
const A=await mk(b,'A'),B=await mk(b,'B'),C=await mk(b,'C');
await login(A,'TpA');await login(B,'TpB');await login(C,'TpC');
await click(A,'lobbyPlayersInc');await sleep(150); // 2→3
await click(A,'lobbyCreateRoomBtn');await sleep(700);
const rid=await A.evaluate(()=>document.getElementById('lobbyRoomCode')?.textContent?.trim());
await B.evaluate(c=>{document.getElementById('lobbyJoinCodeInput').value=c;},rid);await click(B,'lobbyJoinCodeBtn');await sleep(800);
await C.evaluate(c=>{document.getElementById('lobbyJoinCodeInput').value=c;},rid);await click(C,'lobbyJoinCodeBtn');await sleep(3000);
const pages={A,B,C};
const pageBySlot={}; for(const n of ['A','B','C']) pageBySlot[meta[n].slot]=pages[n];
console.log('start: cpi=',meta.A.cpi,'|',await report(pages));
// exactly one overlay should be hidden (the current player); other two shown
for(let round=0; round<5; round++){
  const cpi=meta.A.cpi; const actor=pageBySlot[cpi];
  await actor.evaluate(()=>document.getElementById('endTurnBtn')?.click());
  await sleep(1400);
  console.log(`round ${round}: ended slot ${cpi} → cpi=${meta.A.cpi} | ${await report(pages)}`);
}
await b.close(); console.log('3P OVERLAY TEST DONE');
