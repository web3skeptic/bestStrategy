// /menu-proposals — three live main-menu style mockups. A renders a real
// Three.js war-table scene behind the menu (the game's own tile/structure
// builders, slow orbit); B and C are pure CSS with light interaction.
import * as THREE from 'three';
import { makePalette, TILE_H, hexToWorld, Palette } from './three/palette';
import * as B from './three/builders.gen';
import { buildTemple } from './voxelTemple';
import { buildUnitModel } from './voxelUnits';
import { buildFarm } from './voxelFarm';
import { HexCoord } from './types';

const CAPTIONS: Record<string, string> = {
  D: '<b>D · Living Board.</b> Mobile-first: the real board fills the phone, drifting through a day–night cycle with fireflies and long shadows. Chunky Lilita One wordmark with a voxel extrusion, Nunito UI, thumb-zone bottom sheet: Continue card, one big PLAY, three mode tiles. Tap a mode — the camera swoops to its place on the board (armies, farms, the ridge, the temple).',
  A: '<b>A · War Table.</b> A live low-angle shot of the actual board (real tile, temple, farm and unit builders) drifting behind an old-ledger menu: serif type, roman numerals, a wax-seal hover mark, a red bookmark for “Continue”. Feels like a campaign map on a general’s table, not a settings dialog.',
  B: '<b>B · Diptych.</b> The two factions split the screen on a skewed seam — Temple dusk and moon left, Agrar dawn and sun right — and the title is cut across both. Modes are a honeycomb of hex cells with line-art icons; hovering fills a cell with the colour of the side it sits on. Move the mouse: the halves parallax.',
  C: '<b>C · Broadsheet.</b> Editorial poster: huge tight serif title, numbered chapters instead of buttons, monospace metadata, one vermilion accent. A hexagonal coin flips between the two faction sigils. Quiet, typographic and deliberate.',
};

// ── switcher ────────────────────────────────────────────────────────────────
const cap = document.getElementById('cap')!;
cap.addEventListener('click', () => cap.classList.toggle('min'));
if (window.innerWidth < 760) cap.classList.add('min'); // phones: start collapsed, tap to read
function show(p: string): void {
  for (const k of ['A', 'B', 'C', 'D']) document.getElementById('p' + k)!.classList.toggle('hidden', k !== p);
  document.querySelectorAll<HTMLButtonElement>('#sw button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  cap.innerHTML = CAPTIONS[p]!;
  if (p === 'A') resize();
  if (p === 'D') resizeD();
}
document.querySelectorAll<HTMLButtonElement>('#sw button').forEach(b => b.addEventListener('click', () => show(b.dataset.p!)));

// ── A · war table scene ─────────────────────────────────────────────────────
const P: Palette = makePalette();
const canvas = document.getElementById('warTable') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e0c0a);
scene.fog = new THREE.Fog(0x0e0c0a, 14, 30);
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
scene.add(new THREE.HemisphereLight(0xffe6c0, 0x2a1d12, 0.55));
const sun = new THREE.DirectionalLight(0xffd9a0, 1.1);
sun.position.set(-6, 9, 4); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.near = 1; sun.shadow.camera.far = 40;
const d = 12; sun.shadow.camera.left = -d; sun.shadow.camera.right = d; sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
scene.add(sun);
const rim = new THREE.DirectionalLight(0x9fb4ff, 0.35); rim.position.set(6, 4, -6); scene.add(rim);

// deterministic little map: radius-4 board with a temple, a farm, forests, hills, a mountain ridge
function rng(seed: number): () => number { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const rand = rng(7);
const board = new THREE.Group(); scene.add(board);
const R = 4;
const specials = new Map<string, string>([['0,0', 'temple'], ['2,-1', 'farm'], ['-2,1', 'farm'], ['3,-3', 'wall'], ['3,-2', 'wall'], ['2,-3', 'wall'], ['-3,3', 'hill'], ['-3,2', 'hill'], ['1,2', 'forest'], ['0,3', 'forest'], ['-1,3', 'forest'], ['-2,-1', 'forest'], ['-1,-2', 'forest'], ['2,1', 'hill']]);
for (let q = -R; q <= R; q++) for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
  const kind = specials.get(`${q},${r}`) ?? (rand() < 0.12 ? 'forest' : 'plain');
  const tile = kind === 'wall' ? B.build_tileWall(THREE, P) : kind === 'forest' ? B.build_tileForest(THREE, P) : kind === 'hill' ? B.build_tileHill(THREE, P) : B.build_tilePlain(THREE, P);
  const w = hexToWorld({ q, r } as HexCoord);
  tile.position.set(w.x, 0, w.z);
  tile.traverse(o => { (o as THREE.Mesh).receiveShadow = true; });
  board.add(tile);
  let extra: THREE.Object3D | null = null;
  if (kind === 'temple') extra = buildTemple(0x3a7bd5, 5);
  else if (kind === 'farm') extra = buildFarm(0xd23b3b, 0);
  if (extra) { extra.position.set(w.x, 0, w.z); extra.traverse(o => { (o as THREE.Mesh).castShadow = true; }); board.add(extra); }
}
const units: [string, number, number, number][] = [['warrior', 0x3a7bd5, 1, 0], ['archer', 0x3a7bd5, 0, 1], ['horserider', 0x3a7bd5, -1, 0], ['warrior', 0xd23b3b, 2, -2], ['spearsman', 0xd23b3b, 1, -3], ['horserider', 0xd23b3b, -2, 2]];
for (const [type, color, q, r] of units) {
  const u = buildUnitModel(type as never, color, color === 0xd23b3b ? 'agrar' : 'temple');
  const w = hexToWorld({ q, r } as HexCoord);
  u.position.set(w.x, 0, w.z); u.rotation.y = rand() * Math.PI * 2;
  u.traverse(o => { (o as THREE.Mesh).castShadow = true; });
  board.add(u);
}
const table = new THREE.Mesh(new THREE.CylinderGeometry(9.5, 9.5, 0.3, 48), new THREE.MeshStandardMaterial({ color: 0x2a1f16, roughness: 0.95 }));
table.position.y = -TILE_H - 0.15; table.receiveShadow = true; scene.add(table);

function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();
let t0 = performance.now();
(function frame(): void {
  const t = (performance.now() - t0) / 1000;
  const a = 0.55 + t * 0.035;             // slow drift around the table
  const rad = 14.5, y = 7.6;
  camera.position.set(Math.cos(a) * rad + 2.5, y, Math.sin(a) * rad); // offset right so the board sits in the ledger's negative space
  camera.lookAt(2.2, 0.1, 0);
  if (!document.getElementById('pA')!.classList.contains('hidden')) renderer.render(scene, camera);
  requestAnimationFrame(frame);
})();

// ── B · parallax ────────────────────────────────────────────────────────────
const hT = document.getElementById('halfT')!, hA = document.getElementById('halfA')!;
window.addEventListener('pointermove', e => {
  const dx = (e.clientX / window.innerWidth - 0.5) * 2, dy = (e.clientY / window.innerHeight - 0.5) * 2;
  hT.style.transform = `translate(${dx * -10}px, ${dy * -6}px)`;
  hA.style.transform = `translate(${dx * 10}px, ${dy * 6}px)`;
});

// ── D · living board ────────────────────────────────────────────────────────
const canvasD = document.getElementById('living') as HTMLCanvasElement;
const rD = new THREE.WebGLRenderer({ canvas: canvasD, antialias: true });
rD.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
rD.shadowMap.enabled = true; rD.shadowMap.type = THREE.PCFSoftShadowMap;
rD.outputEncoding = THREE.sRGBEncoding;
const sceneD = new THREE.Scene();
const camD = new THREE.PerspectiveCamera(50, 1, 0.1, 120);
const hemiD = new THREE.HemisphereLight(0xffe6c0, 0x1c2a1a, 0.6); sceneD.add(hemiD);
const sunD = new THREE.DirectionalLight(0xffd9a0, 1.2);
sunD.castShadow = true; sunD.shadow.mapSize.set(2048, 2048); sunD.shadow.camera.near = 1; sunD.shadow.camera.far = 60;
const sd = 16; sunD.shadow.camera.left = -sd; sunD.shadow.camera.right = sd; sunD.shadow.camera.top = sd; sunD.shadow.camera.bottom = -sd; sunD.shadow.bias = -0.0005;
sceneD.add(sunD);
const fogD = new THREE.Fog(0x0a1510, 18, 40); sceneD.fog = fogD;

// a bigger, hand-laid map: two armies facing across the centre temple, farms
// bottom-left, a mountain ridge top-right, forests scattered
const rnd = rng(23);
const mapD = new THREE.Group(); sceneD.add(mapD);
const RD = 7;
const featD = new Map<string, string>([
  ['0,0', 'temple'], ['-4,1', 'farm'], ['-5,3', 'farm'], ['-3,3', 'farm'], ['-4,2', 'plain'], ['-4,3', 'plain'],
  ['3,-5', 'wall'], ['4,-5', 'wall'], ['4,-6', 'wall'], ['5,-6', 'wall'], ['3,-4', 'hill'], ['5,-5', 'hill'], ['2,-4', 'hill'],
  ['-2,-3', 'hill'], ['4,1', 'hill'], ['0,4', 'forest'], ['1,4', 'forest'], ['-1,5', 'forest'], ['2,3', 'forest'], ['-6,1', 'forest'], ['-6,2', 'forest'], ['6,-2', 'forest'], ['5,-1', 'forest'],
]);
const bobbers: THREE.Object3D[] = [];
for (let q = -RD; q <= RD; q++) for (let r = Math.max(-RD, -q - RD); r <= Math.min(RD, -q + RD); r++) {
  const kind = featD.get(`${q},${r}`) ?? (rnd() < 0.1 ? 'forest' : 'plain');
  const tile = kind === 'wall' ? B.build_tileWall(THREE, P) : kind === 'forest' ? B.build_tileForest(THREE, P) : kind === 'hill' ? B.build_tileHill(THREE, P) : B.build_tilePlain(THREE, P);
  const w = hexToWorld({ q, r } as HexCoord);
  tile.position.set(w.x, 0, w.z);
  tile.traverse(o => { (o as THREE.Mesh).receiveShadow = true; (o as THREE.Mesh).castShadow = kind !== 'plain'; });
  mapD.add(tile);
  const extra = kind === 'temple' ? buildTemple(0x8f7bff, 5) : kind === 'farm' ? buildFarm(0xffb054, 0) : null;
  if (extra) { extra.position.set(w.x, 0, w.z); extra.traverse(o => { (o as THREE.Mesh).castShadow = true; }); mapD.add(extra); }
}
const unitsD: [string, number, string, number, number][] = [
  ['warrior', 0x8f7bff, 'temple', 1, -1], ['archer', 0x8f7bff, 'temple', 2, -2], ['horserider', 0x8f7bff, 'temple', 1, -2], ['spearsman', 0x8f7bff, 'temple', 0, -1],
  ['warrior', 0xffb054, 'agrar', -1, 2], ['spearsman', 0xffb054, 'agrar', -2, 3], ['horserider', 0xffb054, 'agrar', -1, 1], ['catapult', 0xffb054, 'agrar', -2, 2],
];
for (const [type, color, fac, q, r] of unitsD) {
  const u = buildUnitModel(type as never, color, fac as never);
  const w = hexToWorld({ q, r } as HexCoord);
  u.position.set(w.x, 0, w.z); u.rotation.y = Math.atan2(-w.x, -w.z) + (rnd() - 0.5) * 0.6; // face the temple
  u.traverse(o => { (o as THREE.Mesh).castShadow = true; });
  mapD.add(u); bobbers.push(u);
}
// fireflies — additive points drifting over the board
const FF = 90;
const ffPos = new Float32Array(FF * 3), ffSeed = new Float32Array(FF);
for (let i = 0; i < FF; i++) { const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 11; ffPos[i * 3] = Math.cos(a) * rr; ffPos[i * 3 + 1] = 0.4 + rnd() * 2.2; ffPos[i * 3 + 2] = Math.sin(a) * rr; ffSeed[i] = rnd() * 100; }
const ffGeo = new THREE.BufferGeometry(); ffGeo.setAttribute('position', new THREE.BufferAttribute(ffPos, 3));
const ffMat = new THREE.PointsMaterial({ color: 0xffe08a, size: 0.14, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
const fireflies = new THREE.Points(ffGeo, ffMat); sceneD.add(fireflies);
const tableD = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 0.4, 64), new THREE.MeshStandardMaterial({ color: 0x1a2a1c, roughness: 1 }));
tableD.position.y = -TILE_H - 0.2; tableD.receiveShadow = true; sceneD.add(tableD);

// camera places — one per menu entry; tapping swoops there
type Place = { target: [number, number, number]; yaw: number; dist: number; elev: number };
const PLACES: Record<string, Place> = {
  home:   { target: [0, 0.2, 0.6],  yaw: 0.35, dist: 15, elev: 0.95 },
  armies: { target: [0.4, 0.2, 0.2], yaw: 0.9,  dist: 9.5, elev: 0.7 },
  farms:  { target: [-5.5, 0.1, 3],  yaw: -0.4, dist: 8,  elev: 0.8 },
  ridge:  { target: [5.5, 0.4, -7],  yaw: 2.4,  dist: 9,  elev: 0.6 },
  temple: { target: [0, 0.6, 0],     yaw: -1.2, dist: 6.5, elev: 0.55 },
};
let placeFrom: Place = PLACES.home!, placeTo: Place = PLACES.home!, placeT = 1, placeT0 = 0;
function goTo(name: string): void {
  const cur = samplePlace();
  placeFrom = cur; placeTo = PLACES[name] ?? PLACES.home!; placeT = 0; placeT0 = performance.now();
}
function samplePlace(): Place {
  const e = placeT >= 1 ? 1 : (1 - Math.cos(Math.min(1, placeT) * Math.PI)) / 2;
  const L = (a: number, b: number) => a + (b - a) * e;
  return { target: [L(placeFrom.target[0], placeTo.target[0]), L(placeFrom.target[1], placeTo.target[1]), L(placeFrom.target[2], placeTo.target[2])], yaw: L(placeFrom.yaw, placeTo.yaw), dist: L(placeFrom.dist, placeTo.dist), elev: L(placeFrom.elev, placeTo.elev) };
}
document.querySelectorAll<HTMLElement>('#pD [data-cam]').forEach(el => el.addEventListener('click', () => {
  document.querySelectorAll('#pD .mode').forEach(m => m.classList.toggle('on', m === el));
  goTo(el.dataset.cam!);
}));

function resizeD(): void {
  const w = window.innerWidth, h = window.innerHeight;
  rD.setSize(w, h, false); camD.aspect = w / h;
  camD.fov = w < h ? 58 : 44; // portrait: wider so the whole board fits above the sheet
  camD.updateProjectionMatrix();
}
window.addEventListener('resize', resizeD); resizeD();

const dayA = { sky: new THREE.Color(0x1d3a2a), sun: new THREE.Color(0xffd9a0), hemi: new THREE.Color(0xffe6c0), sunI: 1.25, hemiI: 0.6, ff: 0.0 };
const nightA = { sky: new THREE.Color(0x070d12), sun: new THREE.Color(0x8fa8ff), hemi: new THREE.Color(0x6a7cbf), sunI: 0.35, hemiI: 0.35, ff: 0.9 };
const tmp = new THREE.Color();
const tD0 = performance.now();
(function frameD(): void {
  requestAnimationFrame(frameD);
  if (document.getElementById('pD')!.classList.contains('hidden')) return;
  const t = (performance.now() - tD0) / 1000;
  // day–night: 48 s cycle, sun sweeps across so shadows crawl over the board
  const cyc = (t % 48) / 48, k = (1 - Math.cos(cyc * Math.PI * 2)) / 2; // 0 = day, 1 = night
  tmp.copy(dayA.sky).lerp(nightA.sky, k); sceneD.background = tmp.clone(); fogD.color.copy(tmp);
  sunD.color.copy(dayA.sun).lerp(nightA.sun, k); sunD.intensity = dayA.sunI + (nightA.sunI - dayA.sunI) * k;
  hemiD.color.copy(dayA.hemi).lerp(nightA.hemi, k); hemiD.intensity = dayA.hemiI + (nightA.hemiI - dayA.hemiI) * k;
  const sa = cyc * Math.PI * 2; sunD.position.set(Math.cos(sa) * 14, 6 + Math.sin(sa) * 6 + 5, Math.sin(sa) * 10);
  ffMat.opacity = dayA.ff + (nightA.ff - dayA.ff) * k;
  const pos = ffGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < FF; i++) { const s0 = ffSeed[i]!; pos.setXYZ(i, ffPos[i * 3]! + Math.sin(t * 0.5 + s0) * 0.6, ffPos[i * 3 + 1]! + Math.sin(t * 0.9 + s0 * 1.3) * 0.25, ffPos[i * 3 + 2]! + Math.cos(t * 0.4 + s0) * 0.6); }
  pos.needsUpdate = true;
  bobbers.forEach((u, i) => { u.position.y = Math.max(0, Math.sin(t * 2.2 + i) * 0.03); });
  // camera: eased swoop between places + a gentle idle sway
  if (placeT < 1) placeT = Math.min(1, (performance.now() - placeT0) / 1400);
  const pl = samplePlace();
  const yaw = pl.yaw + Math.sin(t * 0.18) * 0.12, elev = pl.elev + Math.sin(t * 0.13) * 0.03;
  const portrait = window.innerWidth < window.innerHeight;
  const tz = pl.target[2] + (portrait ? 1.6 : 0), tx = pl.target[0] + (portrait ? 0 : -3.5); // keep the board above the sheet / right of the card
  camD.position.set(tx + Math.sin(yaw) * Math.cos(elev) * pl.dist, pl.target[1] + Math.sin(elev) * pl.dist, tz + Math.cos(yaw) * Math.cos(elev) * pl.dist);
  camD.lookAt(tx, pl.target[1], tz);
  rD.render(sceneD, camD);
})();

// initial screen (after the scene exists — show('A') resizes the renderer)
show(new URLSearchParams(location.search).get('p')?.toUpperCase() || 'D');
