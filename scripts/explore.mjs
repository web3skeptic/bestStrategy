// Best Strategy — exploration / screenshot driver.
// Headless chromium via playwright-core (installed locally). Drives the PUBLIC
// build at interslavic.space/game/, captures every screen + a few real turns
// vs the Normal AI, writing PNGs to the docs screens folder.
//
// Run: node scripts/explore.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const URL = 'https://interslavic.space/game/';
const OUT = '/Users/mark/Work/Personal/myAI/docs/best-strategy-screens';
fs.mkdirSync(OUT, { recursive: true });

// chromium binary shipped with the playwright install
const EXEC = '/opt/best-strategy/node_modules/playwright-core/.local-browsers';
function findChromium() {
  // prefer full chromium (headless shell may lack swiftshader gl)
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

// Tap = mousedown+up at same point (pointer travel 0 → game treats as a tap).
async function tap(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(120);
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
      teleport: disp('teleportBtn'),
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
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') console.log(`  [console.${t}]`, m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));

  console.log('→ loading', URL);
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(1500);

  // 1) main menu
  await page.waitForSelector('#menuOverlay', { state: 'visible', timeout: 20000 });
  console.log('STATE @ menu:', JSON.stringify(await uiState(page)));
  await shot(page, 'main-menu');

  // 2) online lobby (login step) — from the menu
  await page.evaluate(() => document.getElementById('menuOnline')?.click());
  await sleep(600);
  await shot(page, 'online-lobby-login');
  // back to menu
  await page.evaluate(() => document.getElementById('lobbyLoginBack')?.click());
  await sleep(400);

  // 3) start vs Normal AI
  console.log('→ start vs AI (normal)');
  await page.evaluate(() => document.getElementById('menuVsAI')?.click());
  await sleep(2500); // board build + voxel sprite prerender + AI coin-flip
  let st = await uiState(page);
  console.log('STATE @ game start:', JSON.stringify(st));
  await shot(page, 'board-early-default');

  // verify non-blank board
  const variance = await page.evaluate(() => {
    const cv = document.getElementById('gameCanvas');
    const g = cv.getContext('webgl2') || cv.getContext('webgl');
    if (!g) return -1;
    const w = 64, h = 64;
    const px = new Uint8Array(w * h * 4);
    g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
    let min = 255, max = 0;
    for (let i = 0; i < px.length; i += 4) { min = Math.min(min, px[i]); max = Math.max(max, px[i]); }
    return max - min;
  });
  console.log('  board pixel range (red channel):', variance, variance > 12 ? 'OK non-blank' : '⚠ possibly blank');

  // zoom in a touch for crisper unit/terrain detail, then re-shoot
  await page.evaluate(() => { for (let i = 0; i < 2; i++) document.getElementById('zoomInBtn')?.click(); });
  await sleep(800);
  await shot(page, 'board-early-zoomed');

  // 4) spawn bar (temple auto-selected at start → should already be visible)
  st = await uiState(page);
  if (st.spawn !== 'none') {
    console.log('  spawn bar visible, cards:', JSON.stringify(st.cards));
    await shot(page, 'spawn-bar-recruit');
  } else {
    console.log('  ⚠ spawn bar not visible at start:', st.spawn);
  }

  // 5) tech tree
  await page.evaluate(() => document.getElementById('techTreeBtn')?.click());
  await sleep(700);
  await shot(page, 'tech-tree');
  await page.evaluate(() => document.getElementById('techCloseBtn')?.click());
  await sleep(300);

  // 6) settings
  await page.evaluate(() => document.getElementById('settingsBtn')?.click());
  await sleep(700);
  await shot(page, 'settings');
  await page.evaluate(() => document.getElementById('settingsCloseBtn')?.click());
  await sleep(300);

  // 7) recruit a unit (first affordable card) — spawns onto the temple + selects it
  st = await uiState(page);
  const idx = st.cards.findIndex((c) => !c.disabled);
  if (idx >= 0) {
    console.log('  recruiting card:', st.cards[idx].name);
    await page.evaluate((i) => {
      const cards = document.querySelectorAll('.unit-card');
      cards[i]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, idx);
    await sleep(900);
    st = await uiState(page);
    console.log('  after recruit:', st.unitInfo, '| spawn:', st.spawn);
    await shot(page, 'unit-selected-move-highlights');
  }

  // 8) GRID SCAN — tap across the board to find/select our units & temples,
  // capturing any new selection (green move highlights) + capture states.
  console.log('→ grid scan for selections / moves');
  const W = 1440, H = 900;
  let movedShot = false, attackShot = false, captureSeen = false;
  outer:
  for (let gy = 230; gy <= 700; gy += 60) {
    for (let gx = 360; gx <= 1080; gx += 80) {
      await tap(page, gx, gy);
      const s = await uiState(page);
      if (s.menu !== 'none' || s.oppTurn !== 'none') continue;
      if (s.capture !== 'none' && !captureSeen) {
        captureSeen = true;
        await shot(page, 'capture-available');
        await page.evaluate(() => document.getElementById('captureBtn')?.click());
        await sleep(600);
        await shot(page, 'after-capture');
      }
      // selecting one of our units populates unitInfo & shows green move ring
      if (s.unitInfo && s.spawn === 'none' && !movedShot) {
        await shot(page, `selected-${gx}-${gy}`);
        // try a move: tap the 4 cardinal neighbours ~1 hex away
        const before = s.unitInfo;
        for (const [dx, dy] of [[64, 0], [-64, 0], [0, 56], [0, -56], [48, 40], [-48, 40]]) {
          await tap(page, gx + dx, gy + dy);
          const s2 = await uiState(page);
          if (s2.unitInfo !== before || s2.spawn !== 'none') { /* selection changed; reselect */
            await tap(page, gx, gy);
          }
        }
        await shot(page, 'after-move-attempt');
        movedShot = true;
      }
      if (movedShot && captureSeen) break outer;
    }
  }

  // 9) end a few turns to watch the AI / opponent overlay + later-game board
  console.log('→ ending turns');
  for (let t = 0; t < 4; t++) {
    await page.evaluate(() => document.getElementById('endTurnBtn')?.click());
    await sleep(500);
    const s = await uiState(page);
    if (s.oppTurn !== 'none' && t === 0) await shot(page, 'opponent-turn-overlay');
    // wait out AI turn
    for (let w = 0; w < 30; w++) {
      const ss = await uiState(page);
      if (ss.oppTurn === 'none' && ss.turnInfo) break;
      await sleep(400);
    }
    await sleep(600);
    const s2 = await uiState(page);
    console.log(`  turn ${t}: ${s2.turnInfo} | aura ${s2.aura}`);
    if (/win|defeat|victor|lose|game over/i.test(s2.turnInfo)) {
      await shot(page, 'game-over');
      break;
    }
  }
  await shot(page, 'board-later');

  // final state dump
  console.log('FINAL STATE:', JSON.stringify(await uiState(page)));
  await browser.close();
  console.log('done — screenshots:', shotN);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
