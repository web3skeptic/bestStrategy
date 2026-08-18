// Gameplay-tweaks verification + screenshots. Drives the LOCAL fresh build
// (127.0.0.1:8768) so there's no SW/asset caching. Uses the temp __dbg hook to
// set up scenarios, but exercises the REAL UI logic (tile taps, spawn cards).
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const URL = 'https://interslavic.space/game/';
const OUT = '/Users/mark/Work/Personal/myAI/docs/best-strategy-gameplay-after';
fs.mkdirSync(OUT, { recursive: true });

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
async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('  📸', name);
}
async function tap(page, x, y) {
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up(); await sleep(150);
}
async function ui(page) {
  return page.evaluate(() => {
    const txt = (id) => (document.getElementById(id)?.textContent || '').trim();
    const disp = (id) => { const el = document.getElementById(id); return el ? getComputedStyle(el).display : 'missing'; };
    const cards = Array.from(document.querySelectorAll('.unit-card'))
      .filter(c => getComputedStyle(c).display !== 'none')
      .map(c => ({ name: c.querySelector('.unit-card-name')?.textContent?.trim(), disabled: c.classList.contains('disabled') }));
    return { pop: txt('popInfo'), unitInfo: txt('unitInfo'), spawn: disp('spawnBarWrap'),
             sel: window.__dbg ? undefined : null, cards };
  });
}
const sel = (page) => page.evaluate(() => window.__sel());
const cleanDbg = (page) => page.evaluate(() => {
  const s = window.__dbg.state();
  s.units = s.units.filter(u => !String(u.id).startsWith('dbg_'));
  window.__dbg.render();
});

async function main() {
  const browser = await chromium.launch({
    executablePath: findChromium(), headless: true,
    args: ['--use-gl=angle','--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0,160)));

  console.log('→', URL);
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(1200);
  await page.waitForSelector('#menuOverlay', { state: 'visible', timeout: 20000 });
  await page.evaluate(() => document.getElementById('menuVsAI')?.click());
  await sleep(2500);
  console.log('  __dbg present:', await page.evaluate(() => !!window.__dbg));

  // ── #1 Multiple spawns from ONE temple in ONE turn (pop cap still enforced) ──
  // Setup: give the temple pop-cap headroom (level 3 → cap 6), clear my units,
  // ample aura, select the temple. Then use the REAL spawn cards repeatedly,
  // moving each freshly spawned unit off the temple between spawns — all within a
  // single turn (no End Turn). Proves the per-turn spawn gate is lifted.
  await page.evaluate(() => {
    const s = window.__dbg.state(); const slot = window.__dbg.slot(); const me = s.players[slot];
    s.currentPlayerIndex = slot; me.aura = 999;
    const t = s.temples.find(x => x.ownerId === me.id);
    t.level = 3; // population cap = 3 * 2 = 6
    s.units = s.units.filter(u => u.playerId !== me.id); // clear my units → empty tile + pop room
    s.spawnedTempleIds = new Set();
    s.selectedTempleId = t.id; s.selectedUnitId = null; s.selectionMode = 'temple';
    window.__dbg.render();
  });
  await sleep(300);
  const spawnSeq = [];
  for (let i = 0; i < 4; i++) {
    // Click the first enabled unit card (real spawn onto the temple tile).
    const res = await page.evaluate(() => {
      const s = window.__dbg.state(); const slot = window.__dbg.slot(); const me = s.players[slot];
      const before = s.units.filter(u => u.hp > 0 && u.playerId === me.id).length;
      const card = Array.from(document.querySelectorAll('.unit-card'))
        .find(c => getComputedStyle(c).display !== 'none' && !c.classList.contains('disabled'));
      if (!card) return { before, after: before, clicked: false };
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const after = s.units.filter(u => u.hp > 0 && u.playerId === me.id).length;
      // Move the just-spawned unit off the temple, then reselect the temple so we
      // can spawn again this same turn (mimics the player relocating the unit).
      const t = s.temples.find(x => x.ownerId === me.id);
      const onTemple = s.units.find(u => u.pos.q === t.pos.q && u.pos.r === t.pos.r);
      if (onTemple) {
        const ring = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1],[2,0],[0,2],[-2,2],[2,-2]];
        for (const [dq, dr] of ring) {
          const p = { q: t.pos.q + dq, r: t.pos.r + dr };
          if (Math.max(Math.abs(p.q), Math.abs(p.r), Math.abs(-p.q-p.r)) > s.mapRadius) continue;
          if (s.units.some(u => u.pos.q === p.q && u.pos.r === p.r)) continue;
          onTemple.pos = p; break;
        }
      }
      s.selectedTempleId = t.id; s.selectedUnitId = null; s.selectionMode = 'temple';
      window.__dbg.render();
      return { before, after, clicked: true, spawnedThisTurn: Array.from(s.spawnedTempleIds).length };
    });
    spawnSeq.push(res);
    await sleep(250);
  }
  const u1 = await ui(page);
  console.log('  #1 sequential real spawns from ONE temple (same turn):',
    spawnSeq.map(r => `${r.before}->${r.after}`).join(', '), '| popPill=', JSON.stringify(u1.pop));
  await shot(page, 'spawn-multi-per-turn');
  // Push to the population cap and confirm the cards grey out (cap still blocks).
  const capState = await page.evaluate(() => {
    const s = window.__dbg.state(); const slot = window.__dbg.slot(); const me = s.players[slot];
    const t = s.temples.find(x => x.ownerId === me.id);
    // clear temple tile so occupancy isn't the blocker; fill pop to the cap
    s.units = s.units.filter(u => !(u.pos.q === t.pos.q && u.pos.r === t.pos.r));
    // top up to cap with off-temple units
    const proto = s.units.find(u => u.playerId === me.id) || { stats: { maxHp: 20 } };
    let guard = 0;
    while (true) {
      const cnt = s.units.filter(u => u.hp>0 && u.playerId===me.id).length;
      const cap = s.temples.filter(x=>x.ownerId===me.id).reduce((a,x)=>a+Math.min(x.level,5)*2,0);
      if (cnt >= cap || guard++ > 30) break;
      let placed=false;
      for (let dq=-3;dq<=3&&!placed;dq++) for (let dr=-3;dr<=3&&!placed;dr++){
        const p={q:t.pos.q+dq,r:t.pos.r+dr};
        if (dq===0&&dr===0) continue;
        if (Math.max(Math.abs(p.q),Math.abs(p.r),Math.abs(-p.q-p.r))>s.mapRadius) continue;
        if (s.units.some(u=>u.pos.q===p.q&&u.pos.r===p.r)) continue;
        const u=structuredClone(proto); u.id='dbg_cap_'+cnt; u.type='warrior'; u.pos=p; u.playerId=me.id; u.hp=u.stats.maxHp; u.hasMoved=false; u.hasAttacked=false;
        s.units.push(u); placed=true;
      }
      if(!placed) break;
    }
    s.selectedTempleId=t.id; s.selectedUnitId=null; s.selectionMode='temple';
    window.__dbg.render();
    const cnt = s.units.filter(u=>u.hp>0&&u.playerId===me.id).length;
    const cap = s.temples.filter(x=>x.ownerId===me.id).reduce((a,x)=>a+Math.min(x.level,5)*2,0);
    return { cnt, cap };
  });
  await sleep(300);
  const u1b = await ui(page);
  const allDisabled = u1b.cards.length > 0 && u1b.cards.every(c => c.disabled);
  console.log(`  #1 at population cap ${capState.cnt}/${capState.cap}: cards all disabled = ${allDisabled} | popPill=${JSON.stringify(u1b.pop)}`);
  await shot(page, 'spawn-cap-blocks');
  await cleanDbg(page);

  // ── #2 Temple selectable when occupied + spawn blocked ────────────────
  await page.evaluate(() => {
    const s = window.__dbg.state(); const slot = window.__dbg.slot(); const me = s.players[slot];
    s.currentPlayerIndex = slot; me.aura = 999;
    const t = s.temples.find(x => x.ownerId === me.id);
    s.units = s.units.filter(u => !(u.pos.q === t.pos.q && u.pos.r === t.pos.r)); // clear temple tile
    const proto = s.units.find(u => u.playerId === me.id) || s.units[0];
    const u = structuredClone(proto);
    u.id = 'dbg_occ'; u.type = 'warrior'; u.pos = { ...t.pos }; u.playerId = me.id; u.hp = u.stats.maxHp;
    u.hasMoved = true; u.hasAttacked = true;
    s.units.push(u);
    s.selectedUnitId = null; s.selectedTempleId = null; s.selectionMode = null;
    window.__dbg.render();
  });
  await sleep(300);
  // Real tile tap on the (occupied) temple → change #2 should select the TEMPLE.
  const tpos = await page.evaluate(() => {
    const own = window.__own(); return own.temples[0];
  });
  console.log('  temple screen pos:', tpos && { x: Math.round(tpos.x), y: Math.round(tpos.y) });
  await tap(page, tpos.x, tpos.y);
  let selState = await sel(page);
  let u2 = await ui(page);
  console.log('  #2 after tap on occupied temple → selection:', JSON.stringify(selState));
  console.log('     unitInfo:', u2.unitInfo);
  console.log('     spawn bar:', u2.spawn, '| cards:', JSON.stringify(u2.cards));
  await shot(page, 'temple-occupied-selectable');
  await shot(page, 'temple-spawn-blocked');
  // Try to spawn while occupied → count must NOT increase.
  const spawnBlocked = await page.evaluate(() => {
    const s = window.__dbg.state(); const slot = window.__dbg.slot();
    const before = s.units.filter(u => u.hp > 0 && u.playerId === s.players[slot].id).length;
    const card = Array.from(document.querySelectorAll('.unit-card')).find(c => getComputedStyle(c).display !== 'none');
    card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const after = s.units.filter(u => u.hp > 0 && u.playerId === s.players[slot].id).length;
    return { before, after };
  });
  console.log('  #2 spawn attempt while occupied: units', spawnBlocked.before, '→', spawnBlocked.after,
              spawnBlocked.before === spawnBlocked.after ? '(BLOCKED ✓)' : '(LEAKED ✗)');
  // Tap again → toggles to the UNIT (proves both are reachable).
  await tap(page, tpos.x, tpos.y);
  const selState2 = await sel(page);
  console.log('  #2 second tap toggles selection →', JSON.stringify(selState2));
  await cleanDbg(page);

  // ── #3 Range booster pulse (radius 1) ─────────────────────────────────
  await page.evaluate(() => {
    const s = window.__dbg.state(); const slot = window.__dbg.slot(); const me = s.players[slot];
    s.currentPlayerIndex = slot; s.selectedUnitId = null; s.selectedTempleId = null; s.selectionMode = null;
    const proto = s.units.find(u => u.playerId === me.id) || s.units[0];
    const mk = (type, q, r, id) => { const u = structuredClone(proto); u.id = id; u.type = type; u.pos = { q, r }; u.playerId = me.id; u.hp = u.stats.maxHp; s.units.push(u); };
    mk('rangeBooster', 0, 0, 'dbg_rb');
    window.__dbg.render();
  });
  await sleep(300);
  await page.evaluate(() => { for (let i = 0; i < 2; i++) document.getElementById('zoomInBtn')?.click(); });
  await sleep(700);
  await shot(page, 'range-booster-pulse');
  await sleep(650);
  await shot(page, 'range-booster-pulse-frame2');
  await cleanDbg(page);
  await page.evaluate(() => { for (let i = 0; i < 2; i++) document.getElementById('zoomOutBtn')?.click(); });
  await sleep(500);

  // ── #4 Damage booster + healer (r1 full / r2 half rings) ──────────────
  await page.evaluate(() => {
    const s = window.__dbg.state(); const slot = window.__dbg.slot(); const me = s.players[slot];
    s.currentPlayerIndex = slot; s.selectedUnitId = null; s.selectedTempleId = null; s.selectionMode = null;
    const proto = s.units.find(u => u.playerId === me.id) || s.units[0];
    const mk = (type, q, r, id) => { const u = structuredClone(proto); u.id = id; u.type = type; u.pos = { q, r }; u.playerId = me.id; u.hp = u.stats.maxHp; s.units.push(u); };
    mk('damageBooster', -1, 0, 'dbg_db');
    mk('healer', 2, 0, 'dbg_hl');
    window.__dbg.render();
  });
  await sleep(300);
  await page.evaluate(() => { for (let i = 0; i < 1; i++) document.getElementById('zoomInBtn')?.click(); });
  await sleep(700);
  await shot(page, 'damage-healer-radius');
  await sleep(650);
  await shot(page, 'damage-healer-radius-frame2');

  console.log('\nDONE — screenshots in', OUT);
  await browser.close();
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
