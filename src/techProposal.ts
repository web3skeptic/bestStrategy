// /tech-proposal — side-by-side visual proposal for the research panel.
// Left: a faithful replica of today's renderTechTree (same CSS, same data,
// same status rules). Right: the proposed lane × tier graph. Both read one
// shared mock player state so the comparison is fair. Not wired into the game.
import { TECH_NODES, TechNode, TechId, FactionId } from './types';
import { getUnitThumbnail } from './unitThumbnails';

const COLOR = '#3a7bd5';
const TURN = 7;
type Mock = { faction: FactionId; researched: Set<TechId>; researching: { techId: TechId; completesRound: number } | null; aura: number };
let faction: FactionId = 'temple';
let busy = false;

function mock(): Mock {
  const researched = new Set<TechId>(['command_1', faction === 'temple' ? 'temple_warrior_rite' : 'agrar_heavy_armor']);
  const siege: TechId = faction === 'temple' ? 'temple_mobile_siege_tech' : 'agrar_siegecraft';
  return { faction, researched, researching: busy ? { techId: siege, completesRound: TURN + 1 } : null, aura: 20 };
}

// ── shared status rules (mirror of main.ts appendSection / game.ts canResearch) ──
type Status = 'researching' | 'researched' | 'slot' | 'locked' | 'branch' | 'command2' | 'poor' | 'available';
function statusOf(n: TechNode, m: Mock, lane: TechNode[]): Status {
  if (m.researching?.techId === n.id) return 'researching';
  if (m.researched.has(n.id)) return 'researched';
  if (m.researching) return 'slot';
  const prereqsMet = n.prereqs.every(p => m.researched.has(p));
  const branchBlocked = !!n.branch && lane.some(o => o.id !== n.id && m.researched.has(o.id));
  const c2 = n.id === 'command_2' && prereqsMet && [...m.researched].filter(id => id !== 'command_1' && id !== 'command_2').length < 2;
  if (branchBlocked) return 'branch';
  if (c2) return 'command2';
  if (!prereqsMet) return 'locked';
  if (m.aura < n.cost) return 'poor';
  return 'available';
}
function art(n: TechNode): string | null {
  if (n.unitUnlock) return getUnitThumbnail(n.unitUnlock, COLOR, n.faction);
  if (n.id === 'agrar_siegecraft_splash' || n.id === 'temple_mobile_siege_splash') return getUnitThumbnail('catapult', COLOR, n.faction);
  return null;
}
function lanes(m: Mock): { title: string; branch?: string; nodes: TechNode[] }[] {
  const own = (n: TechNode) => !n.faction || n.faction === m.faction;
  const pick = (...ids: string[]) => TECH_NODES.filter(n => own(n) && ids.includes(n.id));
  return [
    { title: 'Siege', nodes: pick('agrar_siegecraft', 'agrar_siegecraft_splash', 'temple_mobile_siege_tech', 'temple_mobile_siege_splash') },
    { title: 'Heavy Unit', nodes: pick('agrar_heavy_armor', 'agrar_heavy_knight_tech', 'temple_warrior_rite', 'temple_champion_rite') },
    { title: 'Command', nodes: pick('command_1', 'command_2') },
    { title: 'Branch: Stat Bonus — Pick ONE', branch: 'stat_bonus', nodes: TECH_NODES.filter(n => n.branch === 'stat_bonus') },
    { title: 'Branch: Support Unit — Pick ONE', branch: 'support', nodes: TECH_NODES.filter(n => n.branch === 'support') },
  ];
}
const nameOf = (id: TechId) => TECH_NODES.find(n => n.id === id)?.name ?? id;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// ── CURRENT replica ──────────────────────────────────────────────────────────
function renderCurrent(root: HTMLElement, m: Mock): void {
  const rem = m.researching ? Math.max(1, m.researching.completesRound - TURN) : 0;
  let body = '';
  if (m.researching) body += `<div class="tech-branch-label">⏳ Researching ${nameOf(m.researching.techId)} — ${rem} round${rem === 1 ? '' : 's'} remaining</div>`;
  for (const lane of lanes(m)) {
    body += `<div class="tech-section"><div class="tech-section-title">${lane.title}</div>`;
    if (lane.branch && lane.nodes.some(n => m.researched.has(n.id))) body += `<div class="tech-branch-label">✓ Choice made — branch locked</div>`;
    body += `<div class="tech-nodes">`;
    for (const n of lane.nodes) {
      const st = statusOf(n, m, lane.nodes);
      const cls = st === 'researching' ? 'tech-node--researching' : st === 'researched' ? 'tech-node--researched' : st === 'poor' ? 'tech-node--poor' : st === 'available' ? '' : 'tech-node--locked';
      const txt = st === 'researching' ? `⏳ ${rem} round${rem === 1 ? '' : 's'} left` : st === 'researched' ? '✓ Researched' : st === 'slot' ? 'Research slot occupied'
        : st === 'branch' ? '✗ Branch taken' : st === 'command2' ? '✗ Needs 2 other completed techs' : st === 'locked' ? '✗ Requires prerequisite' : st === 'poor' ? `Need ${n.cost} ⚡` : 'Available';
      const sc = st === 'researching' ? 'status-researching' : st === 'researched' ? 'status-researched' : st === 'poor' ? 'status-poor' : st === 'available' ? 'status-available' : 'status-locked';
      const a = art(n);
      const pre = n.prereqs.length ? `<div class="tech-node-prereq">Requires: ${n.prereqs.map(nameOf).join(', ')}</div>` : '';
      body += `<div class="tech-node ${cls}">${a ? `<img class="tech-node-art" src="${a}" alt="">` : ''}<div class="tech-node-name">${n.name}</div>
        <div class="tech-node-cost">Cost: ${n.cost} ⚡ · ${n.researchTime} round${n.researchTime === 1 ? '' : 's'}</div>${pre}
        <div class="tech-node-desc">${esc(n.description)}</div><div class="tech-node-status ${sc}">${txt}</div></div>`;
    }
    body += `</div></div>`;
  }
  root.innerHTML = `<div class="tech-overlay"><div class="tech-panel"><div class="tech-header"><div class="tech-title">Research</div><div class="tech-aura">⚡ ${m.aura} aura</div><button class="tech-close">✕</button></div>${body}</div></div>`;
}

// ── PROPOSED graph ───────────────────────────────────────────────────────────
const GLYPH: Partial<Record<TechId, string>> = { command_1: '⚑', command_2: '⚑', agrar_heavy_armor: '🛡', temple_warrior_rite: '🔥', agrar_siegecraft_splash: '💥', temple_mobile_siege_splash: '💥', longrange_hp: '🏹', horse_sight: '👁' };
let selected: TechId | null = null;

function renderProposed(root: HTMLElement, m: Mock): void {
  const rem = m.researching ? Math.max(1, m.researching.completesRound - TURN) : 0;
  const tierOf = (n: TechNode) => n.prereqs.length; // 0 foundation · 1 advanced · 2 elite
  const all = lanes(m);
  const statusMap = new Map<TechId, Status>();
  for (const l of all) for (const n of l.nodes) statusMap.set(n.id, statusOf(n, m, l.nodes));
  if (!selected || !statusMap.has(selected)) selected = [...statusMap.entries()].find(([, s]) => s === 'available')?.[0] ?? all[0]!.nodes[0]!.id;

  let slot: string;
  if (m.researching) {
    const n = TECH_NODES.find(x => x.id === m.researching!.techId)!;
    const p = Math.round(((n.researchTime - rem) / n.researchTime) * 100);
    slot = `<div class="tt-slot">Research slot: <b>${n.name}</b> · ${rem} round${rem === 1 ? '' : 's'} left <div class="bar"><i style="width:${Math.max(8, p)}%"></i></div></div>`;
  } else slot = `<div class="tt-slot idle">Research slot: <b style="color:#7fd6ff">idle</b> — pick a glowing node <div class="bar"><i style="width:100%"></i></div></div>`;

  let grid = `<div class="tt-tiers"><div></div><div class="tt-tier">Foundation</div><div class="tt-tier">Advanced</div><div class="tt-tier">Elite</div></div>`;
  for (const l of all) {
    const short = l.branch ? (l.branch === 'stat_bonus' ? 'Stat bonus' : 'Support') : l.title;
    grid += `<div class="tt-lane"><div class="tt-lane-label">${short}${l.branch ? '<small>pick one</small>' : ''}</div>`;
    for (let t = 0; t < 3; t++) {
      const cell = l.nodes.filter(n => tierOf(n) === t);
      const isPick = !!l.branch && t === 0;
      const made = isPick && l.nodes.some(n => m.researched.has(n.id));
      grid += `<div class="tt-cell${isPick ? ' pick' : ''}${made ? ' locked-branch' : ''}">`;
      for (const n of cell) {
        const st = statusMap.get(n.id)!;
        const cls = st === 'researching' ? 'researching' : st === 'researched' ? 'researched' : st === 'available' ? 'available' : st === 'poor' ? 'poor' : 'locked';
        const a = art(n);
        const badge = st === 'researched' ? '✓' : st === 'researching' ? rem : (cls === 'locked' ? '🔒' : '');
        const prog = st === 'researching' ? `style="--p:${Math.round(((n.researchTime - rem) / n.researchTime) * 100)}%"` : '';
        grid += `<div class="tt-node ${cls}${selected === n.id ? ' sel' : ''}" data-id="${n.id}">
          <div class="tt-med">${a ? `<img src="${a}" alt="">` : `<span>${GLYPH[n.id] ?? '✦'}</span>`}<div class="tt-ring" ${prog}></div>${badge !== '' ? `<div class="tt-badge">${badge}</div>` : ''}</div>
          <div class="tt-txt"><div class="tt-name">${n.name}</div><div class="tt-meta"><span class="tt-cost">${n.cost} ⚡</span><span class="tt-time">${n.researchTime} rd</span></div></div></div>`;
      }
      grid += `</div>`;
    }
    grid += `</div>`;
  }

  const sel = TECH_NODES.find(n => n.id === selected)!;
  const sst = statusMap.get(sel.id)!;
  const a = art(sel);
  const reqs = sel.prereqs.map(p => `${m.researched.has(p) ? '<b>✓</b>' : '<s>✗</s>'} ${nameOf(p)}`);
  if (sel.id === 'command_2') reqs.push(`${[...m.researched].filter(id => id !== 'command_1' && id !== 'command_2').length >= 2 ? '<b>✓</b>' : '<s>✗</s>'} any 2 other techs`);
  const btnTxt = sst === 'available' ? `Research · ${sel.cost} ⚡` : sst === 'researched' ? 'Researched' : sst === 'researching' ? `${rem} round${rem === 1 ? '' : 's'} left` : sst === 'slot' ? 'Slot busy' : sst === 'poor' ? `Need ${sel.cost} ⚡` : sst === 'branch' ? 'Branch taken' : 'Locked';
  const detail = `<div class="tt-detail"><div class="tt-med">${a ? `<img src="${a}" alt="">` : `<span>${GLYPH[sel.id] ?? '✦'}</span>`}</div>
    <div><h4>${sel.name} <span style="font-weight:600;color:#8b94a4;font-size:11px">· ${sel.cost} ⚡ · ${sel.researchTime} round${sel.researchTime === 1 ? '' : 's'}</span></h4><p>${esc(sel.description)}</p>
    ${reqs.length ? `<div class="req">Requires: ${reqs.join(' &nbsp;·&nbsp; ')}</div>` : ''}</div>
    <button class="tt-btn" ${sst === 'available' ? '' : 'disabled'}>${btnTxt}</button></div>`;

  root.innerHTML = `<div class="tt"><div class="tt-head"><div class="tt-title">Research</div><div class="tt-aura">⚡ ${m.aura} aura</div></div>${slot}
    <div class="tt-graph"><svg class="tt-svg"></svg>${grid}</div>${detail}</div>`;

  root.querySelectorAll<HTMLElement>('.tt-node').forEach(el => {
    el.addEventListener('click', () => { selected = el.dataset.id as TechId; renderProposed(root, m); });
  });
  requestAnimationFrame(() => drawLinks(root, statusMap));
}

// Prerequisite connectors: right edge of the prereq → left edge of the node.
function drawLinks(root: HTMLElement, statusMap: Map<TechId, Status>): void {
  const graph = root.querySelector<HTMLElement>('.tt-graph')!;
  const svg = graph.querySelector<SVGSVGElement>('.tt-svg')!;
  const gb = graph.getBoundingClientRect();
  const rect = (id: string) => graph.querySelector<HTMLElement>(`[data-id="${id}"]`)?.getBoundingClientRect();
  let d = '';
  for (const [id] of statusMap) {
    const n = TECH_NODES.find(x => x.id === id)!;
    const to = rect(id); if (!to) continue;
    for (const p of n.prereqs) {
      const from = rect(p); if (!from) continue;
      const x1 = from.right - gb.left, y1 = from.top + from.height / 2 - gb.top;
      const x2 = to.left - gb.left, y2 = to.top + to.height / 2 - gb.top;
      const mx = (x1 + x2) / 2;
      const done = statusMap.get(p) === 'researched';
      const col = done ? '#33e0a0' : '#3a4560';
      d += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="${col}" stroke-width="2" ${done ? '' : 'stroke-dasharray="5 4"'} opacity=".9"/>`;
      d += `<circle cx="${x2}" cy="${y2}" r="3" fill="${col}"/>`;
    }
  }
  svg.innerHTML = d;
}

// ── page wiring ──────────────────────────────────────────────────────────────
const cur = document.getElementById('cur')!, prop = document.getElementById('prop')!;
function renderAll(): void { const m = mock(); renderCurrent(cur, m); renderProposed(prop, m); }
document.querySelectorAll<HTMLButtonElement>('[data-f]').forEach(b => b.addEventListener('click', () => {
  faction = b.dataset.f as FactionId; selected = null;
  document.querySelectorAll('[data-f]').forEach(x => x.classList.toggle('on', x === b)); renderAll();
}));
document.querySelectorAll<HTMLButtonElement>('[data-s]').forEach(b => b.addEventListener('click', () => {
  busy = b.dataset.s === 'busy'; selected = null;
  document.querySelectorAll('[data-s]').forEach(x => x.classList.toggle('on', x === b)); renderAll();
}));
window.addEventListener('resize', () => renderProposed(prop, mock()));
renderAll();
