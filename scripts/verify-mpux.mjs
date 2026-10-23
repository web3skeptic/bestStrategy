import { chromium } from 'playwright-core';
import fs from 'node:fs'; import path from 'node:path';
const URL = 'http://localhost:5173/';
const SHOT = '/tmp';
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
  await p.goto(URL,{waitUntil:'networkidle',timeout:60000}); await sleep(800); return p;
}
async function login(p,n){await click(p,'menuOnline');await sleep(300);await p.evaluate(x=>{document.getElementById('lobbyUsernameInput').value=x;},n);await click(p,'lobbyLoginBtn');await sleep(900);}
const sel=p=>p.evaluate(()=>window.__sel());
const own=p=>p.evaluate(()=>window.__own());
const curtainHidden=p=>p.evaluate(()=>document.getElementById('opponentTurnOverlay')?.classList.contains('hidden'));
const pillHidden=p=>p.evaluate(()=>document.getElementById('waitingIndicator')?.classList.contains('hidden'));
const aura=p=>p.evaluate(()=>{const el=document.querySelector('#auraInfo .pill-value'); return el?+el.textContent:null;});
const spawnCard=p=>p.evaluate(()=>{const c=[...document.querySelectorAll('.unit-card')].find(c=>!c.classList.contains('disabled')&&c.style.display!=='none'); if(c){c.click();return true;} return false;});
// move the unit at (u.x,u.y) to some adjacent legal hex; returns true if it moved
async function moveUnitOff(p,u){
  await tap(p,u.x,u.y); await sleep(500);
  for(const [dx,dy] of [[0,-55],[48,-28],[48,28],[-48,-28],[0,55],[-48,28],[-48,-28],[95,0],[-95,0]]){
    await tap(p,u.x+dx,u.y+dy); await sleep(800);
    const o2=await own(p); const u2=o2.units.find(x=>x.id===u.id);
    if(u2 && (Math.abs(u2.x-u.x)>6||Math.abs(u2.y-u.y)>6)) return true;
    await tap(p,u.x,u.y); await sleep(400);
  }
  return false;
}
// find whichever of the player's units currently sits on one of its temples
function unitOnTemple(o){
  for(const t of o.temples){ const u=o.units.find(u=>Math.abs(u.x-t.x)<8&&Math.abs(u.y-t.y)<8); if(u) return {unit:u,temple:t}; }
  return null;
}
// Players start AT their population cap (2 units, cap 2), so spawning is blocked
// until the cap rises. Select a temple and upgrade it (3rd HUD slab, bottom-centre)
// to raise the cap, then spawn a unit. Returns whether the spawn succeeded.
const TEMPLE_HUD = {x:620,y:717}; // temple-upgrade slab @ 1000x760 viewport (layoutHud)
async function upgradeAndSpawn(p){
  let o=await own(p); const hit=unitOnTemple(o); const t=hit?hit.temple:o.temples[0];
  await tap(p,t.x,t.y); await sleep(700);           // select temple
  await tap(p,TEMPLE_HUD.x,TEMPLE_HUD.y); await sleep(900); // upgrade → raises pop cap
  await tap(p,t.x,t.y); await sleep(700);           // reselect temple (spawn bar)
  return spawnCard(p);
}

const b=await chromium.launch({executablePath:findChromium(),headless:true,args});

// ══════════════ PART A: vs-AI (tasks 2 + 3) ══════════════
console.log('\n=== PART A: vs-AI ===');
const A=await mk(b,'A');
await click(A,'menuVsAI'); await sleep(1600);
const oA=await own(A);
console.log('start: units',oA.units.length,'temples',oA.temples.length,'aura',await aura(A));
// Task 2: end turn -> AI turn -> opaque curtain HIDDEN, waiting pill VISIBLE, board on screen
await click(A,'endTurnBtn'); await sleep(300);
const curtainDuringAI=await curtainHidden(A), pillDuringAI=await pillHidden(A);
console.log('TASK2 vs-AI during AI turn: opaqueCurtainHidden=',curtainDuringAI,' waitingPillHidden=',pillDuringAI,'=> PASS:',curtainDuringAI===true&&pillDuringAI===false);
await A.screenshot({path:`${SHOT}/vsai-during-ai-turn.png`});
await sleep(2000);
console.log('TASK2 vs-AI after AI done: waitingPillHidden=',await pillHidden(A),'(expect true)');
// build a little aura (upgrade costs 2 + unit costs 1) by ending a couple more turns
let guard=0; while((await aura(A))<4 && guard++<4){ await click(A,'endTurnBtn'); await sleep(2600); }
// Task 3: upgrade temple (frees pop cap), then spawn -> expect auto-select of new unit
console.log('pre-spawn aura',await aura(A));
const spawned=await upgradeAndSpawn(A); await sleep(600);
const sAfterSpawn=await sel(A);
console.log('TASK3 vs-AI: spawned=',spawned,' selection=',JSON.stringify(sAfterSpawn),'=> AUTO-SELECTED:',spawned&&sAfterSpawn.mode==='unit'&&!!sAfterSpawn.unitId);
await A.screenshot({path:`${SHOT}/vsai-after-spawn.png`});
await A.close();

// ══════════════ PART B: online MP (tasks 1,2,3,4) ══════════════
console.log('\n=== PART B: online MP ===');
const P=await mk(b,'P'), Q=await mk(b,'Q');
await login(P,'MPux1'+Date.now()%1000); await login(Q,'MPux2'+Date.now()%1000);
await click(P,'lobbyCreateRoomBtn'); await sleep(700);
const rid=await P.evaluate(()=>document.getElementById('lobbyRoomCode')?.textContent?.trim());
await Q.evaluate(c=>{document.getElementById('lobbyJoinCodeInput').value=c;},rid);
await click(Q,'lobbyJoinCodeBtn'); await sleep(3000);
const pageBySlot={[meta.P.slot]:P,[meta.Q.slot]:Q}, nameBySlot={[meta.P.slot]:'P',[meta.Q.slot]:'Q'};
let cpi=meta.P.cpi; let actor=pageBySlot[cpi], other=pageBySlot[cpi^1];
console.log(`current slot ${cpi}=${nameBySlot[cpi]}`);
// Task 2 online: the NON-acting player sees NO opaque curtain, but the waiting pill
console.log('TASK2 online (non-actor): opaqueCurtainHidden=',await curtainHidden(other),' waitingPillHidden=',await pillHidden(other),'=> PASS:',(await curtainHidden(other))===true&&(await pillHidden(other))===false);
await other.screenshot({path:`${SHOT}/mp-nonactor-waiting.png`});

// Task 1 online: actor moves the unit sitting on its temple -> move applies (animated via reconciliation)
const o=await own(actor); const hit=unitOnTemple(o); const u=hit?hit.unit:o.units[0];
const movedMP=await moveUnitOff(actor,u);
console.log('TASK1 online: own move applied =',movedMP,'(smooth tween driven by state_update reconciliation)');
await actor.screenshot({path:`${SHOT}/mp-after-move.png`});

// Accumulate aura (end turns back and forth) so we can afford temple upgrade + spawn + research
async function endTurnFor(pg){ await pg.evaluate(()=>document.getElementById('endTurnBtn')?.click()); await sleep(1400); }
for(let i=0;i<16;i++){
  cpi=meta.P.cpi; actor=pageBySlot[cpi]; other=pageBySlot[cpi^1];
  if((await aura(actor))>=12) break;
  await endTurnFor(actor);
}
cpi=meta.P.cpi; actor=pageBySlot[cpi]; other=pageBySlot[cpi^1];
console.log('after accumulation: actor',nameBySlot[cpi],'aura',await aura(actor));

// Task 3 online: upgrade temple (frees pop cap) then spawn -> auto-select
const spMP=await upgradeAndSpawn(actor); await sleep(1600);
const sSpawnMP=await sel(actor);
console.log('TASK3 online: spawned=',spMP,' selection=',JSON.stringify(sSpawnMP),'=> AUTO-SELECTED:',spMP&&sSpawnMP.mode==='unit'&&!!sSpawnMP.unitId);

// Task 4 online: optimistic research — aura must drop before the server round-trip
const auraBefore=await aura(actor);
console.log('research setup: current actor',nameBySlot[cpi],'aura',auraBefore);
await actor.evaluate(()=>document.getElementById('techTreeBtn')?.click()); await sleep(500);
const bought=await actor.evaluate(()=>{const c=document.querySelector('.tech-node .status-available'); if(c){c.closest('.tech-node').click(); return true;} return false;});
await sleep(120); // short: optimistic apply must beat server RTT
const auraQuick=await aura(actor);
console.log('TASK4 online research: bought=',bought,' auraBefore=',auraBefore,' auraAfter(120ms)=',auraQuick,'=> OPTIMISTIC IMMEDIATE:',bought&&auraQuick!==null&&auraBefore!==null&&auraQuick<auraBefore);
await actor.screenshot({path:`${SHOT}/mp-research.png`});
await b.close();
console.log('\nDONE');
