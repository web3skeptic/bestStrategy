// /menu-proposals-2 — three Polytopia-style main-menu mockups over ONE shared
// live world: a wide hex world built with the game's own tile/structure/unit
// builders, seen from a high angle and drifting slowly. Decision page only.
import * as THREE from 'three';
import { makePalette, TILE_H, hexToWorld, Palette } from './three/palette';
import * as B from './three/builders.gen';
import { buildCapital } from './voxelCapital';
import { buildTemple } from './voxelTemple';
import { buildFarm } from './voxelFarm';
import { buildUnitModel } from './voxelUnits';
import { HexCoord, UnitType, FactionId } from './types';

const CAPTIONS: Record<string, string> = {
  A: '<b>A · World.</b> Closest to Polytopia: the live world fills the screen, the logo sits on top, and four equal flat buttons stack at the bottom — <b>New Game · Multiplayer · Continue · Replays</b>. Nothing shouts “vs AI”. <b>New Game</b> opens one sheet: pick your tribe, then the opponent (a friend on this device, or an AI level) and map size, then Start. <b>Multiplayer</b> holds same-device, create room, join code.',
  B: '<b>B · Tribes.</b> Tribe-first: a carousel in the middle of the world (Farmers ⟷ Nomads) with the opponent as small pills and one big <b>PLAY</b>. Multiplayer, Continue and Replays are quiet text links. The first thing you choose is who you are, not what the computer is.',
  C: '<b>C · Shelf.</b> Logo top-left over the world, a Continue chip under it, and a shelf of four picture cards along the bottom: New game · Same device · Online · Replays. Every mode is the same size; the tribe and opponent come on the next screen.',
};
const cap = document.getElementById('cap')!;
cap.addEventListener('click', () => cap.classList.toggle('min'));
if (window.innerWidth < 760) cap.classList.add('min');
function show(p: string): void {
  for (const k of ['A', 'B', 'C']) document.getElementById('p' + k)!.classList.toggle('hidden', k !== p);
  document.querySelectorAll<HTMLButtonElement>('#sw button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  cap.innerHTML = CAPTIONS[p]!;
}
document.querySelectorAll<HTMLButtonElement>('#sw button').forEach(b => b.addEventListener('click', () => show(b.dataset.p!)));
show('A');

// ── A sub-screens ──
const aMain = document.getElementById('aMain')!, aNew = document.getElementById('aNew')!, aMp = document.getElementById('aMp')!;
document.querySelectorAll<HTMLElement>('[data-a]').forEach(el => el.addEventListener('click', () => {
  const a = el.dataset.a;
  aMain.classList.toggle('hidden', a !== 'back');
  aNew.classList.toggle('hidden', a !== 'new');
  aMp.classList.toggle('hidden', a !== 'mp');
}));
document.querySelectorAll<HTMLElement>('.tribes .tribe').forEach(t => t.addEventListener('click', () => {
  t.parentElement!.querySelectorAll('.tribe').forEach(x => x.classList.remove('on')); t.classList.add('on');
}));
document.querySelectorAll<HTMLElement>('.pills').forEach(g => g.querySelectorAll<HTMLElement>('.pill').forEach(p => p.addEventListener('click', () => {
  g.querySelectorAll('.pill').forEach(x => x.classList.remove('on')); p.classList.add('on');
})));
// ── B carousel ──
const TRIBES = [['Farmers', 'Fields, roads and stone walls'], ['Nomads', 'Horses, raids and felt tents']];
let bi = 0;
function bSet(i: number): void {
  bi = (i + TRIBES.length) % TRIBES.length;
  document.getElementById('bName')!.textContent = TRIBES[bi]![0]!;
  document.getElementById('bBlurb')!.textContent = TRIBES[bi]![1]!;
  document.querySelectorAll<HTMLElement>('#bCard .dots i').forEach((d, k) => d.classList.toggle('on', k === bi));
  hero.forEach((h, k) => { h.visible = k === bi; });
}
document.getElementById('bPrev')!.addEventListener('click', () => bSet(bi - 1));
document.getElementById('bNext')!.addEventListener('click', () => bSet(bi + 1));

// ── shared live world ──
const P: Palette = makePalette();
const canvas = document.getElementById('world') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd3e8);
scene.fog = new THREE.Fog(0x9fd3e8, 26, 60);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
scene.add(new THREE.HemisphereLight(0xdff3ff, 0x4a6a3a, 0.75));
const sun = new THREE.DirectionalLight(0xfff1d6, 1.15); sun.position.set(-12, 20, 8); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.near = 1; sun.shadow.camera.far = 80;
const sd = 26; sun.shadow.camera.left = -sd; sun.shadow.camera.right = sd; sun.shadow.camera.top = sd; sun.shadow.camera.bottom = -sd; sun.shadow.bias = -0.0005;
scene.add(sun);

function rng(seed: number): () => number { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const rnd = rng(11);
const world = new THREE.Group(); scene.add(world);
const R = 11;
const feats = new Map<string, string>([
  ['-5,2', 'capF'], ['6,-3', 'capN'], ['0,0', 'temple'], ['-3,6', 'temple'], ['4,3', 'temple'],
  ['-6,3', 'farm'], ['-4,3', 'farm'], ['-6,4', 'farm'], ['-3,1', 'farm'],
  ['1,-6', 'wall'], ['2,-7', 'wall'], ['2,-6', 'wall'], ['-8,5', 'wall'], ['-7,5', 'wall'], ['7,1', 'wall'], ['8,0', 'wall'],
]);
const OCEAN = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardMaterial({ color: 0x3f8fbf, roughness: 0.6 }));
OCEAN.rotation.x = -Math.PI / 2; OCEAN.position.y = -TILE_H - 0.02; OCEAN.receiveShadow = true; scene.add(OCEAN);
for (let q = -R; q <= R; q++) for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
  const d = Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r));
  if (d > 9 + Math.floor(rnd() * 2.2)) continue; // ragged coastline
  const k = feats.get(`${q},${r}`);
  const kind = k === 'wall' ? 'wall' : k ? 'plain' : rnd() < 0.14 ? 'forest' : rnd() < 0.09 ? 'hill' : 'plain';
  const tile = kind === 'wall' ? B.build_tileWall(THREE, P) : kind === 'forest' ? B.build_tileForest(THREE, P) : kind === 'hill' ? B.build_tileHill(THREE, P) : B.build_tilePlain(THREE, P);
  const w = hexToWorld({ q, r } as HexCoord);
  tile.position.set(w.x, 0, w.z);
  tile.traverse(o => { (o as THREE.Mesh).receiveShadow = true; (o as THREE.Mesh).castShadow = kind !== 'plain'; });
  world.add(tile);
  const extra = k === 'capF' ? buildCapital(0xffb054, 'agrar') : k === 'capN' ? buildCapital(0x8f7bff, 'temple') : k === 'temple' ? buildTemple(q === 0 ? 0x9098a0 : 0x8f7bff, q === 0 ? 1 : 5) : k === 'farm' ? buildFarm(0xffb054, 0) : null;
  if (extra) { extra.position.set(w.x, 0, w.z); extra.traverse(o => { (o as THREE.Mesh).castShadow = true; }); world.add(extra); }
}
const cast: [UnitType, number, FactionId, HexCoord][] = [
  ['warrior', 0xffb054, 'agrar', { q: -4, r: 1 }], ['archer', 0xffb054, 'agrar', { q: -5, r: 4 }], ['heavyknight', 0xffb054, 'agrar', { q: -2, r: 2 }], ['founder', 0xffb054, 'agrar', { q: -5, r: 3 }],
  ['horserider', 0x8f7bff, 'temple', { q: 5, r: -2 }], ['archer', 0x8f7bff, 'temple', { q: 6, r: -4 }], ['warrior', 0x8f7bff, 'temple', { q: 3, r: -1 }], ['catapult', 0x8f7bff, 'temple', { q: 5, r: -4 }],
  ['warrior', 0x8f7bff, 'temple', { q: 1, r: 1 }], ['spearsman', 0xffb054, 'agrar', { q: -1, r: 1 }],
];
for (const [type, color, fac, at] of cast) {
  const u = buildUnitModel(type, color, fac);
  const w = hexToWorld(at); u.position.set(w.x, 0, w.z); u.rotation.y = rnd() * Math.PI * 2;
  u.traverse(o => { (o as THREE.Mesh).castShadow = true; });
  world.add(u);
}
// B's carousel hero: a big unit of the selected tribe standing centre-stage
const hero: THREE.Object3D[] = [buildUnitModel('warrior', 0xffb054, 'agrar'), buildUnitModel('horserider', 0x8f7bff, 'temple')];
hero.forEach((h, i) => { h.scale.setScalar(1.9); h.position.set(0, 0.6, 5); h.rotation.y = 0.3 + (i === 1 ? Math.PI / 2 : 0); h.visible = i === 0; h.traverse(o => { (o as THREE.Mesh).castShadow = true; }); scene.add(h); });

function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = w < h ? 58 : 40; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();
const start = performance.now();
(function frame(): void {
  requestAnimationFrame(frame);
  const t = (performance.now() - start) / 1000;
  const cur = document.querySelector('#sw button.on') as HTMLButtonElement | null;
  const p = cur?.dataset.p ?? 'A';
  hero.forEach((h, i) => { h.visible = p === 'B' && i === bi; h.rotation.y += 0; });
  const yaw = t * 0.045;
  const dist = p === 'B' ? 20 : 24, elev = p === 'B' ? 0.7 : 0.78;
  const cx = Math.sin(yaw) * 3, cz = Math.cos(yaw) * 3;
  camera.position.set(cx + Math.sin(yaw) * Math.cos(elev) * dist, Math.sin(elev) * dist, cz + Math.cos(yaw) * Math.cos(elev) * dist);
  camera.lookAt(cx, p === 'B' ? -1.5 : -2.5, cz);
  if (p === 'B') { const h = hero[bi]!; h.position.set(camera.position.x * 0.22 + cx * 0.78, 0.3, camera.position.z * 0.22 + cz * 0.78); h.lookAt(camera.position.x, 0.3, camera.position.z); h.rotateY(hero.indexOf(h) === 1 ? Math.PI / 2 : 0); }
  renderer.render(scene, camera);
})();
