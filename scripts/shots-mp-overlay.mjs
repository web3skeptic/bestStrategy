import { chromium } from 'playwright-core';
import fs from 'node:fs'; import path from 'node:path';
const URL='https://interslavic.space/game/';
const OUT='/Users/mark/Work/Personal/myAI/docs/best-strategy-nplayers-after';
function findChromium(){const b=path.join(process.env.HOME,'.cache/ms-playwright');for(const d of fs.readdirSync(b)){if(d.startsWith('chromium-')){const p=path.join(b,d,'chrome-linux','chrome');if(fs.existsSync(p))return p;}}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'];
const click=(p,i)=>p.evaluate(x=>document.getElementById(x)?.click(),i);
const meta={};
async function mk(b,name){const c=await b.newContext({viewport:{width:1000,height:760},serviceWorkers:'block'});const p=await c.newPage();meta[name]={slot:null,cpi:null};
  p.on('console',m=>{const t=m.text();if(t.includes('[MP] game_start')){const mm=t.match(/slot=(\d+).*currentPlayerIndex=(\d+)/);if(mm){meta[name].slot=+mm[1];meta[name].cpi=+mm[2];}}});
  p.on('websocket',ws=>{ws.on('framereceived',f=>{try{const j=JSON.parse(f.payload);if((j.type==='state_update'||j.type==='game_start')&&j.state?.currentPlayerIndex!==undefined)meta[name].cpi=j.state.currentPlayerIndex;}catch{}});});
  await p.goto(URL,{waitUntil:'networkidle',timeout:60000});await sleep(1000);return p;}
async function login(p,n){await click(p,'menuOnline');await sleep(300);await p.evaluate(x=>{document.getElementById('lobbyUsernameInput').value=x;},n);await click(p,'lobbyLoginBtn');await sleep(900);}
const ovHidden=p=>p.evaluate(()=>document.getElementById('opponentTurnOverlay')?.classList.contains('hidden'));

const b=await chromium.launch({executablePath:findChromium(),headless:true,args});
let A,B,ok=false;
for(let attempt=0; attempt<6 && !ok; attempt++){
  A=await mk(b,`A${attempt}`); B=await mk(b,`B${attempt}`);
  await login(A,`ShotA${attempt}`);await login(B,`ShotB${attempt}`);
  await click(A,'lobbyCreateRoomBtn');await sleep(700);
  const rid=await A.evaluate(()=>document.getElementById('lobbyRoomCode')?.textContent?.trim());
  await B.evaluate(c=>{document.getElementById('lobbyJoinCodeInput').value=c;},rid);await click(B,'lobbyJoinCodeBtn');await sleep(3000);
  const sa=meta[`A${attempt}`].slot, cpi=meta[`A${attempt}`].cpi;
  console.log(`attempt ${attempt}: A slot=${sa} first=${cpi}`);
  if(sa===0 && cpi===0){ ok=true; break; }
  await A.context().close(); await B.context().close();
}
if(!ok){ console.log('could not get slot0-first; using last'); }
const an=Object.keys(meta).filter(k=>k.startsWith('A')).pop(), bn=Object.keys(meta).filter(k=>k.startsWith('B')).pop();
console.log('P1(A) slot', meta[an].slot, 'P2(B) slot', meta[bn].slot, 'current', meta[an].cpi);
console.log('P1 overlayHidden(active)=', await ovHidden(A), '| P2 overlayHidden(waiting)=', await ovHidden(B));
await A.screenshot({path:path.join(OUT,'mp-p1-active.png')}); console.log('  📸 mp-p1-active (P1, its turn, no overlay)');
await B.screenshot({path:path.join(OUT,'mp-p2-waiting.png')}); console.log('  📸 mp-p2-waiting (P2, overlay shown)');
// P1 ends turn → P2 becomes active, overlay clears
await A.evaluate(()=>document.getElementById('endTurnBtn')?.click()); await sleep(1500);
console.log('after P1 ends: current', meta[an].cpi, '| P2 overlayHidden(active)=', await ovHidden(B));
await B.screenshot({path:path.join(OUT,'mp-p2-active.png')}); console.log('  📸 mp-p2-active (P2, overlay CLEARED, can act)');
await b.close(); console.log('SCREENSHOTS DONE');
