import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.GAME_URL || 'https://interslavic.space/game/';

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

async function main() {
  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    args: ['--use-gl=angle','--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => { const t=m.type(); if (t==='error'||t==='warning') { const s=`[console.${t}] ${m.text()}`; errors.push(s); console.log(s); }});
  page.on('pageerror', (e) => { const s=`[pageerror] ${String(e)}`; errors.push(s); console.log(s); });
  page.on('requestfailed', (r) => { const s=`[requestfailed] ${r.url()} :: ${r.failure()?.errorText}`; errors.push(s); console.log(s); });
  page.on('response', (r) => { if (r.status()>=400) { const s=`[http ${r.status()}] ${r.url()}`; errors.push(s); console.log(s); }});

  console.log('→ loading', URL);
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(1500);

  // Inspect the menu overlay & its buttons
  const info = await page.evaluate(() => {
    const overlay = document.getElementById('menuOverlay');
    const btns = Array.from(document.querySelectorAll('#menuOverlay button, .menu-btn, [id^="menu"]')).map((b) => ({
      id: b.id, tag: b.tagName, text: (b.textContent||'').trim().slice(0,30),
      display: getComputedStyle(b).display, disabled: b.disabled,
    }));
    return {
      overlayExists: !!overlay,
      overlayDisplay: overlay ? getComputedStyle(overlay).display : 'n/a',
      buttons: btns,
      bodyReadyFlag: window.__gameBooted ?? null,
    };
  });
  console.log('MENU INFO:', JSON.stringify(info, null, 2));

  await page.screenshot({ path: '/tmp/game-menu-load.png' });

  // Try clicking a couple menu buttons and observe state change
  const tryClick = async (id) => {
    const before = await page.evaluate(() => document.getElementById('menuOverlay') ? getComputedStyle(document.getElementById('menuOverlay')).display : 'n/a');
    const clicked = await page.evaluate((i) => { const el=document.getElementById(i); if(!el) return 'no-el'; el.click(); return 'clicked'; }, id);
    await sleep(800);
    const after = await page.evaluate(() => document.getElementById('menuOverlay') ? getComputedStyle(document.getElementById('menuOverlay')).display : 'n/a');
    console.log(`CLICK ${id}: ${clicked} | menuOverlay ${before} -> ${after}`);
  };
  for (const id of ['menuLocal','menuSingle','menuOnline','menuSettings','menuAI','menuHotseat','menuNormalAI','menuHardAI']) {
    await tryClick(id);
  }

  console.log('\n=== ERROR SUMMARY (' + errors.length + ') ===');
  errors.slice(0,40).forEach(e => console.log(e));
  await browser.close();
}
main().catch((e)=>{ console.error(e); process.exit(1); });
