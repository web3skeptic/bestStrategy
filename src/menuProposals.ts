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
  A: '<b>A · War Table.</b> A live low-angle shot of the actual board (real tile, temple, farm and unit builders) drifting behind an old-ledger menu: serif type, roman numerals, a wax-seal hover mark, a red bookmark for “Continue”. Feels like a campaign map on a general’s table, not a settings dialog.',
  B: '<b>B · Diptych.</b> The two factions split the screen on a skewed seam — Temple dusk and moon left, Agrar dawn and sun right — and the title is cut across both. Modes are a honeycomb of hex cells with line-art icons; hovering fills a cell with the colour of the side it sits on. Move the mouse: the halves parallax.',
  C: '<b>C · Broadsheet.</b> Editorial poster: huge tight serif title, numbered chapters instead of buttons, monospace metadata, one vermilion accent. A hexagonal coin flips between the two faction sigils. Quiet, typographic and deliberate.',
};

// ── switcher ────────────────────────────────────────────────────────────────
const cap = document.getElementById('cap')!;
cap.addEventListener('click', () => cap.classList.toggle('min'));
function show(p: string): void {
  for (const k of ['A', 'B', 'C']) document.getElementById('p' + k)!.classList.toggle('hidden', k !== p);
  document.querySelectorAll<HTMLButtonElement>('#sw button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  cap.innerHTML = CAPTIONS[p]!;
  if (p === 'A') resize();
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

// initial screen (after the scene exists — show('A') resizes the renderer)
show(new URLSearchParams(location.search).get('p')?.toUpperCase() || 'A');
