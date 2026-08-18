// Best Strategy — "Continue last game" save/resume verification + screenshots.
// Drives real gameplay against the PUBLIC build (nginx strips /game/ so modules
// load; hitting :8768 directly serves index.html for /game/assets). Fresh
// contexts = empty localStorage. Run: node scripts/verify-continue.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs'; import path from 'node:path';

const URL = 'https://interslavic.space/game/';
const OUT = '/Users/mark/Work/Personal/myAI/docs/best-strategy-continue-after';
fs.mkdirSync(OUT, { recursive: true });
const SAVE_KEY = 'bs:savedGame:v1';
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

function findChromium() {
  const base = path.join(process.env.HOME, '.cache/ms-playwright');
  for (const d of fs.readdirSync(base))
    if (d.startsWith('chromium-')) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name, clip) => page.screenshot(clip ? { path: path.join(OUT, name + '.png'), clip } : { path: path.join(OUT, name + '.png') }).then(() => console.log('  📸', name));

const click = (page, id) => page.evaluate((i) => document.getElementById(i)?.click(), id);
const contDisplay = (page) => page.evaluate(() => getComputedStyle(document.getElementById('menuContinue')).display);
const readSave = (page) => page.evaluate((k) => localStorage.getItem(k), SAVE_KEY);

// Core logical fields that MUST round-trip identically (selection/highlight
// fields are excluded — they're cosmetic and reset on resume).
function core(rawSave) {
  if (!rawSave) return null;
  const s = JSON.parse(rawSave).state;
  return JSON.stringify({
    mode: JSON.parse(rawSave).mode,
    turnNumber: s.turnNumber,
    currentPlayerIndex: s.currentPlayerIndex,
    phase: s.phase,
    players: s.players,
    units: s.units,
    temples: s.temples,
    hills: s.hills, walls: s.walls, forests: s.forests,
    teleportBuildings: s.teleportBuildings,
    playerTech: s.playerTech,
  });
}

// Poll the localStorage save until it's the human's turn (AI id is 1) and the
// opponent curtain is gone — so vs-AI snapshots are taken at a resumable point.
async function waitHumanTurn(page, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ok = await page.evaluate((k) => {
      const overlay = getComputedStyle(document.getElementById('opponentTurnOverlay')).display;
      const raw = localStorage.getItem(k);
      if (!raw) return false;
      const s = JSON.parse(raw).state;
      const humanTurn = s.players[s.currentPlayerIndex]?.id !== 1;
      return overlay === 'none' && humanTurn && s.phase !== 'gameOver';
    }, SAVE_KEY);
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

async function startGame(browser, opts) {
  const { mode, mobile, label } = opts;
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: mobile ? 3 : 1, isMobile: mobile, hasTouch: mobile,
    userAgent: mobile ? UA_MOBILE : undefined,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 160)));
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(1200);

  // No-save proof on first load
  await page.waitForSelector('#menuOverlay', { state: 'visible' });
  const noSaveDisp = await contDisplay(page);
  console.log(`[${label}] Continue @first-load:`, noSaveDisp, '(expect none)');
  await shot(page, `menu-no-save${mobile ? '-mobile' : ''}`);

  // Start + make a move (end a turn → mutates turn/resources; AI plays in vsAI)
  await click(page, mode === '2P' ? 'menu2P' : (mode === 'vsHardAI' ? 'menuVsHardAI' : 'menuVsAI'));
  await sleep(3000);
  await click(page, 'endTurnBtn');
  await sleep(800);
  await waitHumanTurn(page);
  const before = await readSave(page);
  console.log(`[${label}] save written after move:`, !!before);

  // Open menu mid-game → Continue should appear
  await click(page, 'menuBtn');
  await sleep(600);
  const contDisp = await contDisplay(page);
  console.log(`[${label}] Continue @menu:`, contDisp, '(expect block)');
  await shot(page, `menu-continue-${mode === '2P' ? '2p' : (mode === 'vsHardAI' ? 'vshardai' : 'vsai')}${mobile ? '-mobile' : ''}`);

  // Resume
  await click(page, 'menuContinue');
  await sleep(2500);
  await waitHumanTurn(page);
  const after = await readSave(page);
  const match = core(before) === core(after);
  console.log(`[${label}] resumed core-state identical:`, match);
  if (!match) { console.log('  BEFORE', core(before)?.slice(0, 300)); console.log('  AFTER ', core(after)?.slice(0, 300)); }
  await shot(page, `resumed-${mode === '2P' ? '2p' : (mode === 'vsHardAI' ? 'vshardai' : 'vsai')}${mobile ? '-mobile' : ''}`);

  return { ctx, page, before, label, contDisp, noSaveDisp, match };
}

async function main() {
  const browser = await chromium.launch({
    executablePath: findChromium(), headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl',
      '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const results = [];

  // Desktop 2P
  const d2p = await startGame(browser, { mode: '2P', mobile: false, label: 'desktop-2P' });
  results.push(d2p);

  // Reload persistence on the SAME context (localStorage survives reload)
  console.log('[desktop-2P] reloading page…');
  await d2p.page.reload({ waitUntil: 'networkidle' });
  await d2p.page.waitForSelector('#menuOverlay', { state: 'visible' });
  await sleep(1000);
  const reloadDisp = await contDisplay(d2p.page);
  console.log('[reload] Continue after reload:', reloadDisp, '(expect block)');
  await shot(d2p.page, 'reload-continue');
  await click(d2p.page, 'menuContinue');
  await sleep(2500);
  await waitHumanTurn(d2p.page);
  const reloadMatch = core(d2p.before) === core(await readSave(d2p.page));
  console.log('[reload] resumed core-state identical to pre-reload:', reloadMatch);
  await shot(d2p.page, 'reload-resumed');
  await d2p.ctx.close();

  // Desktop vs AI
  const dvsai = await startGame(browser, { mode: 'vsAI', mobile: false, label: 'desktop-vsAI' });
  results.push(dvsai);
  await dvsai.ctx.close();

  // Mobile 2P (button styling + loop in mobile viewport)
  const m2p = await startGame(browser, { mode: '2P', mobile: true, label: 'mobile-2P' });
  results.push(m2p);
  await m2p.ctx.close();

  await browser.close();
  console.log('\n=== SUMMARY ===');
  for (const r of results)
    console.log(`${r.label}: noSave=${r.noSaveDisp} contMenu=${r.contDisp} resumedMatch=${r.match}`);
  console.log('reload: contDisp=' + reloadDisp + ' match=' + reloadMatch);
  console.log('→', OUT);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
