// Best Strategy — post-change verification + screenshots (local build).
// Drives the LOCAL server (fresh context, no SW cache) in MOBILE and DESKTOP
// viewports, verifies the UI changes, and writes screenshots to the docs folder.
// Run: node scripts/shots-after.mjs
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

// Must be the PUBLIC URL: the app's base is /game/, and only nginx (in front of
// the public host) strips the /game/ prefix so the Express server resolves
// /assets/…. Hitting 127.0.0.1:8768 directly returns index.html for /game/assets
// (catch-all) and the module fails to load. The public URL serves the same dist.
const URL = 'https://interslavic.space/game/';
const OUT = '/Users/mark/Work/Personal/myAI/docs/best-strategy-screens-after';
fs.mkdirSync(OUT, { recursive: true });

const UA_MOBILE =
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

async function shot(page, name, clip) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot(clip ? { path: file, clip } : { path: file });
  console.log('  📸', name + (clip ? ' (clip)' : ''));
}

async function disp(page, id) {
  return page.evaluate((i) => {
    const el = document.getElementById(i);
    return el ? getComputedStyle(el).display : 'missing';
  }, id);
}

async function startVsAI(page) {
  await page.evaluate(() => document.getElementById('menuVsAI')?.click());
  await sleep(3000); // board build + voxel prerender + AI coin-flip
}

async function run(browser, opts) {
  const { label, viewport, mobile } = opts;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: mobile ? 3 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: mobile ? UA_MOBILE : undefined,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 160)));
  console.log(`\n=== ${label} ${viewport.width}x${viewport.height} ===`);
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(1200);

  // Menu
  await page.waitForSelector('#menuOverlay', { state: 'visible', timeout: 20000 });
  await shot(page, `${label}-menu`);

  // Online lobby (Connect button proof)
  await page.evaluate(() => document.getElementById('menuOnline')?.click());
  await sleep(600);
  await shot(page, `${label}-lobby`);
  await page.evaluate(() => document.getElementById('lobbyLoginBack')?.click());
  await sleep(400);

  // In game
  await startVsAI(page);
  await shot(page, `${label}-ingame`);

  // Verification booleans
  const zoom = await page.evaluate(() => {
    const el = document.querySelector('.zoom-controls');
    return el ? getComputedStyle(el).display : 'missing';
  });
  const settings = await disp(page, 'settingsBtn');
  const unitInfo = await page.evaluate(() => !!document.getElementById('unitInfo'));
  const turnTxt = await page.evaluate(() => (document.getElementById('turnInfo')?.textContent || '').trim());
  const clusterKids = await page.evaluate(() =>
    Array.from(document.querySelector('.hud-cluster')?.children || [])
      .filter((c) => getComputedStyle(c).display !== 'none')
      .map((c) => c.id || c.className));
  console.log('  zoom-controls display:', zoom, mobile ? '(expect none)' : '(expect flex)');
  console.log('  settingsBtn display:', settings, '(expect none — non-debug)');
  console.log('  #unitInfo present:', unitInfo, '(expect false)');
  console.log('  turnInfo text:', JSON.stringify(turnTxt), '(expect empty)');
  console.log('  visible cluster children:', JSON.stringify(clusterKids));

  // Close-up of top-left cluster
  await shot(page, `${label}-ingame-topleft`, { x: 0, y: 0, width: Math.min(300, viewport.width), height: 96 });

  if (mobile) {
    // No-zoom proof: bottom-right region where zoom discs used to live.
    await shot(page, `${label}-no-zoom-proof`, {
      x: viewport.width - 120, y: viewport.height - 160, width: 120, height: 160,
    });
  } else {
    // Desktop: zoom buttons close-up (bottom-right).
    await shot(page, `${label}-zoom-close`, {
      x: viewport.width - 90, y: viewport.height - 120, width: 80, height: 110,
    });
  }

  await context.close();
  return { zoom, settings, unitInfo, turnTxt };
}

async function debugCheck(browser) {
  console.log('\n=== DEBUG GATE (?debug=1) ===');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(URL + '?debug=1', { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(1200);
  await page.evaluate(() => document.getElementById('menuVsAI')?.click());
  await sleep(3000);
  const gearDisp = await page.evaluate(() => {
    const el = document.getElementById('settingsBtn');
    return el ? getComputedStyle(el).display : 'missing';
  });
  await page.evaluate(() => document.getElementById('settingsBtn')?.click());
  await sleep(600);
  const settingsOpen = await page.evaluate(() =>
    !document.getElementById('settingsOverlay')?.classList.contains('hidden'));
  console.log('  gear display (debug):', gearDisp, '(expect inline/flex)');
  console.log('  settings overlay opened on gear click:', settingsOpen, '(expect true)');
  await shot(page, 'desktop-debug-settings');
  await context.close();
}

async function main() {
  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl',
      '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  await run(browser, { label: 'mobile', viewport: { width: 390, height: 844 }, mobile: true });
  await run(browser, { label: 'desktop', viewport: { width: 1440, height: 900 }, mobile: false });
  await debugCheck(browser);
  await browser.close();
  console.log('\ndone →', OUT);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
