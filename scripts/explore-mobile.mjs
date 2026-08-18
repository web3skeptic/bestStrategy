// Best Strategy — MOBILE exploration / screenshot driver.
// Mobile variant of scripts/explore.mjs: emulates a phone (390×844, DSR 3,
// isMobile+hasTouch, mobile Safari UA) against the PUBLIC build and captures the
// mobile UI — main menu, lobby, in-game board (top plaque + bottom HUD), the 3D
// HUD slabs close, the carved-stone plaque close, the Research/tech window, the
// Settings stat-spreadsheet, and a unit-selected state — to the mobile screens
// folder. Plays a couple of turns so the board is populated.
//
// Run: node scripts/explore-mobile.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const URL = 'https://interslavic.space/game/';
const OUT = '/Users/mark/Work/Personal/myAI/docs/best-strategy-screens-mobile';
fs.mkdirSync(OUT, { recursive: true });

// iPhone 13-ish viewport.
const VP = { width: 390, height: 844 };
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

function findChromium() {
  const base = path.join(process.env.HOME, '.cache/ms-playwright');
  for (const d of fs.readdirSync(base)) {
    if (d.startsWith('chromium-')) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let shotN = 0;
async function shot(page, name) {
  const file = path.join(OUT, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  console.log('  📸', path.basename(file));
  return file;
}
// Crop helper for close-ups of HUD regions.
async function shotClip(page, name, clip) {
  const file = path.join(OUT, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, clip });
  console.log('  📸', path.basename(file), '(clip)');
  return file;
}

// Tap via touchscreen so the game's pointer handlers treat it as a real tap.
async function tap(page, x, y) {
  await page.touchscreen.tap(x, y);
  await sleep(140);
}

async function uiState(page) {
  return page.evaluate(() => {
    const disp = (id) => {
      const el = document.getElementById(id);
      if (!el) return 'missing';
      return getComputedStyle(el).display;
    };
    const txt = (id) => (document.getElementById(id)?.textContent || '').trim();
    const cards = Array.from(document.querySelectorAll('.unit-card')).map((c) => ({
      name: c.querySelector('.unit-card-name')?.textContent?.trim(),
      disabled: c.classList.contains('disabled'),
    }));
    return {
      menu: disp('menuOverlay'),
      spawn: disp('spawnBarWrap'),
      capture: disp('captureBtn'),
      tech: disp('techOverlay'),
      settings: disp('settingsOverlay'),
      oppTurn: disp('opponentTurnOverlay'),
      turnInfo: txt('turnInfo'),
      unitInfo: txt('unitInfo'),
      aura: txt('auraInfo'),
      pop: txt('popInfo'),
      cards,
    };
  });
}

async function main() {
  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
    ],
  });
  const context = await browser.newContext({
    viewport: VP,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: UA,
  });
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') console.log(`  [console.${t}]`, m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));

  console.log('→ loading (mobile)', URL);
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(1500);

  const W = VP.width, H = VP.height;

  // 1) main menu w/ buttons
  await page.waitForSelector('#menuOverlay', { state: 'visible', timeout: 20000 });
  console.log('STATE @ menu:', JSON.stringify(await uiState(page)));
  await shot(page, 'main-menu');

  // 2) online lobby (login step)
  await page.evaluate(() => document.getElementById('menuOnline')?.click());
  await sleep(700);
  await shot(page, 'online-lobby');
  await page.evaluate(() => document.getElementById('lobbyLoginBack')?.click());
  await sleep(400);

  // 3) start vs Normal AI
  console.log('→ start vs AI (normal)');
  await page.evaluate(() => document.getElementById('menuVsAI')?.click());
  await sleep(2800); // board build + voxel prerender + AI coin-flip

  // verify non-blank board
  const variance = await page.evaluate(() => {
    const cv = document.getElementById('gameCanvas');
    const g = cv?.getContext('webgl2') || cv?.getContext('webgl');
    if (!g) return -1;
    const w = 64, h = 64;
    const px = new Uint8Array(w * h * 4);
    g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
    let min = 255, max = 0;
    for (let i = 0; i < px.length; i += 4) { min = Math.min(min, px[i]); max = Math.max(max, px[i]); }
    return max - min;
  });
  console.log('  board pixel range:', variance, variance > 12 ? 'OK non-blank' : '⚠ possibly blank');

  // 03 — full board (top plaque + bottom HUD in one portrait shot)
  await shot(page, 'board-full');

  // 04 — bottom HUD slabs close-up (bottom-centre ~80px band)
  await shotClip(page, 'bottom-hud-close', { x: 0, y: H - 140, width: W, height: 140 });

  // 05 — top stat plaque close-up
  await shotClip(page, 'top-plaque-close', { x: 0, y: 0, width: W, height: 180 });

  // 06 — tech / research window
  await page.evaluate(() => document.getElementById('techTreeBtn')?.click());
  await sleep(800);
  await shot(page, 'research-window');
  await page.evaluate(() => document.getElementById('techCloseBtn')?.click());
  await sleep(300);

  // 07 — settings stat-spreadsheet
  await page.evaluate(() => document.getElementById('settingsBtn')?.click());
  await sleep(800);
  await shot(page, 'settings-spreadsheet');
  await page.evaluate(() => document.getElementById('settingsCloseBtn')?.click());
  await sleep(300);

  // 08 — unit-selected state: grid-scan taps to select one of our units.
  console.log('→ grid scan for a unit selection');
  let selShot = false;
  outer:
  for (let gy = 250; gy <= 640; gy += 48) {
    for (let gx = 70; gx <= 330; gx += 52) {
      await tap(page, gx, gy);
      const s = await uiState(page);
      if (s.menu !== 'none' || s.oppTurn !== 'none') continue;
      if (s.unitInfo && s.spawn === 'none' && !selShot) {
        console.log('  selected unit @', gx, gy, '|', s.unitInfo);
        await shot(page, 'unit-selected');
        selShot = true;
        break outer;
      }
    }
  }
  if (!selShot) console.log('  ⚠ no unit selected during scan');

  // Play a couple of turns so the board is more populated, then a final board shot.
  console.log('→ ending a couple turns');
  for (let t = 0; t < 2; t++) {
    await page.evaluate(() => document.getElementById('endTurnBtn')?.click());
    await sleep(600);
    for (let w = 0; w < 25; w++) {
      const ss = await uiState(page);
      if (ss.oppTurn === 'none' && ss.turnInfo) break;
      await sleep(400);
    }
    await sleep(500);
  }
  await shot(page, 'board-later');
  // Re-capture plaque + HUD after turns (aura/pop changed).
  await shotClip(page, 'top-plaque-later', { x: 0, y: 0, width: W, height: 180 });

  console.log('FINAL STATE:', JSON.stringify(await uiState(page)));
  await browser.close();
  console.log('done — mobile screenshots:', shotN);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
