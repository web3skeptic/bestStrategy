import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const URL='https://interslavic.space/game/';
const OUT='/Users/mark/Work/Personal/myAI/docs/best-strategy-nplayers-after';
function findChromium(){ const base=path.join(process.env.HOME,'.cache/ms-playwright'); for(const d of fs.readdirSync(base)){ if(d.startsWith('chromium-')){ const p=path.join(base,d,'chrome-linux','chrome'); if(fs.existsSync(p))return p; } } }
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const args=['--use-gl=angle','--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--no-sandbox'];
const click=(page,id)=>page.evaluate(i=>document.getElementById(i)?.click(),id);
async function mkPage(browser){ const ctx=await browser.newContext({viewport:{width:1200,height:800},deviceScaleFactor:1,serviceWorkers:'block'}); const page=await ctx.newPage(); page.on('pageerror',e=>console.log('  [pageerror]',String(e).slice(0,140))); await page.goto(URL,{waitUntil:'networkidle',timeout:60000}); await sleep(1200); return page; }
async function login(page,name){ await click(page,'menuOnline'); await sleep(300); await page.evaluate(n=>{document.getElementById('lobbyUsernameInput').value=n;},name); await click(page,'lobbyLoginBtn'); await sleep(1000); }

async function main(){
  const browser=await chromium.launch({executablePath:findChromium(),headless:true,args});
  const A=await mkPage(browser), B=await mkPage(browser), C=await mkPage(browser);
  await login(A,'HostA'); await login(B,'HostB'); await login(C,'HostC');

  // A creates a 3-player room
  await click(A,'lobbyPlayersInc'); await sleep(150); // 2→3
  await click(A,'lobbyCreateRoomBtn'); await sleep(800);
  const roomId=await A.evaluate(()=>document.getElementById('lobbyRoomCode')?.textContent?.trim());
  const waitA=await A.evaluate(()=>document.getElementById('lobbyWaitingStatus')?.textContent);
  console.log('room created:', roomId, '| host status:', waitA);

  // B joins
  await B.evaluate(c=>{document.getElementById('lobbyJoinCodeInput').value=c;},roomId);
  await click(B,'lobbyJoinCodeBtn'); await sleep(1000);
  console.log('after B join → host status:', await A.evaluate(()=>document.getElementById('lobbyWaitingStatus')?.textContent));

  // C joins → should start the 3-player game
  await C.evaluate(c=>{document.getElementById('lobbyJoinCodeInput').value=c;},roomId);
  await click(C,'lobbyJoinCodeBtn'); await sleep(3500);

  for(const [n,p] of [['A',A],['B',B],['C',C]]){
    const st=await p.evaluate(()=>({ menu: getComputedStyle(document.getElementById('menuOverlay')).display, dbg:(window).__dbg.state() }));
    console.log(`ctx ${n}: menuOverlay=${st.menu} numPlayers=${st.dbg.numPlayers} radius=${st.dbg.mapRadius} temples=${st.dbg.temples.length} current=${st.dbg.currentPlayerIndex} colors=${st.dbg.dbg?'':''}${st.dbg.players.map(x=>x.color).join(',')}`);
  }
  await A.screenshot({ path: path.join(OUT,'lobby-3player-started.png') });
  console.log('  📸 lobby-3player-started');

  // Turn rotation: find current player's context, end turn, confirm advance
  const cur0=await A.evaluate(()=>(window).__dbg.state().currentPlayerIndex);
  const ctxBySlot={0:A,1:B,2:C};
  await ctxBySlot[cur0].evaluate(()=>document.getElementById('endTurnBtn')?.click());
  await sleep(1200);
  const cur1=await A.evaluate(()=>(window).__dbg.state().currentPlayerIndex);
  console.log(`turn rotation: current ${cur0} → ${cur1} (advanced=${cur0!==cur1})`);

  await browser.close();
  console.log('ONLINE VERIFICATION DONE');
}
main().catch(e=>{console.error(e);process.exit(1);});
