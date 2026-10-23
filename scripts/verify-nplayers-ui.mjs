import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const URL = 'https://interslavic.space/game/';
const OUT = '/Users/mark/Work/Personal/myAI/docs/best-strategy-nplayers-after';
fs.mkdirSync(OUT, { recursive: true });

function findChromium() {
  const base = path.join(process.env.HOME, '.cache/ms-playwright');
  for (const d of fs.readdirSync(base)) {
    if (d.startsWith('chromium-')) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = ['--use-gl=angle','--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--no-sandbox'];

async function newCtxPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0,160)));
  return { ctx, page };
}
async function shot(page, name) { const f = path.join(OUT, `${name}.png`); await page.screenshot({ path: f }); console.log('  📸', name); }
const click = (page, id) => page.evaluate((i)=>document.getElementById(i)?.click(), id);

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args });
  const { page } = await newCtxPage(browser);
  console.log('→ loading', URL);
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(1500);
  await page.waitForSelector('#menuOverlay', { state: 'visible', timeout: 20000 });

  // ── Setup UI: 4 players (1 human + 3 AI) ──
  await click(page, 'menuCustom'); await sleep(400);
  // inc from 2 → 4
  await click(page, 'setupPlayersInc'); await sleep(120);
  await click(page, 'setupPlayersInc'); await sleep(200);
  console.log('setup count =', await page.evaluate(()=>document.getElementById('setupPlayersCount')?.textContent));
  await shot(page, 'setup-player-count');

  // ── Start 4-player game ──
  await click(page, 'setupStartBtn');
  await sleep(3500); // board build + AI coin-flip / first AI turns
  const st = await page.evaluate(()=> (window).__dbg.state());
  console.log('4P STATE: numPlayers=%d radius=%d temples=%d colors=%s', st.numPlayers, st.mapRadius, st.temples.length, st.players.map(p=>p.color).join(','));
  console.log('4P minTempleDist =', await page.evaluate(()=> (window).__dbg.minTempleDist()));
  await shot(page, 'game-4player');
  // HUD close-up (top bar with player list) — crop top region
  await page.screenshot({ path: path.join(OUT,'game-4player-hud.png'), clip: { x:0, y:0, width:1440, height:130 } });
  console.log('  📸 game-4player-hud');

  // ── Teleport highlight excludes walls ── (retry new games until a temple has walls within r2)
  let tp=null;
  for (let attempt=0; attempt<6; attempt++) {
    tp = await page.evaluate(()=> (window).__dbg.forceTeleport());
    console.log('  forceTeleport try', attempt, JSON.stringify(tp));
    if (tp.wallsWithinRadius2 > 0) break;
    // restart a fresh 2p game for another map
    await click(page,'menuBtn'); await sleep(400); await click(page,'menu2P'); await sleep(2500);
  }
  await sleep(400);
  await shot(page, 'teleport-valid-highlight');
  console.log('TELEPORT: highlighted=%d wallsHighlighted=%d wallsWithinR2=%d', tp.highlighted, tp.wallsHighlighted, tp.wallsWithinRadius2);

  // ── Temples randomized: two seeds ──
  await click(page,'menuBtn'); await sleep(400); await click(page,'menu2P'); await sleep(2500);
  const s1 = await page.evaluate(()=> (window).__dbg.state());
  const d1 = await page.evaluate(()=> (window).__dbg.minTempleDist());
  await shot(page, 'temples-randomized-1');
  await click(page,'menuBtn'); await sleep(400); await click(page,'menu2P'); await sleep(2500);
  const s2 = await page.evaluate(()=> (window).__dbg.state());
  const d2 = await page.evaluate(()=> (window).__dbg.minTempleDist());
  await shot(page, 'temples-randomized-2');
  const layout = (s)=> s.temples.map(t=>`${t.q},${t.r}`).join('|');
  console.log('TEMPLES seed1:', layout(s1), 'minDist', d1);
  console.log('TEMPLES seed2:', layout(s2), 'minDist', d2);
  console.log('  seeds differ =', layout(s1)!==layout(s2));

  // ── Online lobby: expected-players selector ──
  await click(page,'menuBtn'); await sleep(400);
  await click(page,'menuOnline'); await sleep(400);
  await page.evaluate(()=>{ const el=document.getElementById('lobbyUsernameInput'); el.value='HostA'; });
  await click(page,'lobbyLoginBtn'); await sleep(1200);
  // bump room size to 3
  await click(page,'lobbyPlayersInc'); await sleep(200);
  console.log('lobby room size =', await page.evaluate(()=>document.getElementById('lobbyPlayersCount')?.textContent));
  await shot(page, 'lobby-expected-players');

  await browser.close();
  console.log('LOCAL VERIFICATION DONE');
}
main().catch(e=>{ console.error(e); process.exit(1); });
