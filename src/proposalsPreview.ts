// /proposals — live 3D preview of three model-rework proposals, each shown as
// a "current" row (the exact builders the game uses today) next to a
// "proposed" row (prototype kits under src/proposals/). Nothing here is wired
// into the board renderer; it's a decision page.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { makePalette, TILE_H, Palette } from './three/palette';
import * as B from './three/builders.gen';
import { buildUnitModel } from './voxelUnits';
import { buildTemple } from './voxelTemple';
import { buildSword } from './voxelSword';
import { buildSpear } from './voxelSpear';
import { buildBow } from './voxelBow';
import { buildHealerStaff } from './voxelStaff';
import { buildNomad, buildFarmer, kitWithWeapon } from './proposals/factionKits';
import { buildPlainV2, buildForestV2, buildHillV2, buildWallV2 } from './proposals/tilesV2';
import { buildRuinsV2, buildTempleIV2, buildTempleIIV2, buildCapitalV2 } from './proposals/structuresV2';

const P: Palette = makePalette();
const BLUE = 0x3a7bd5, RED = 0xd23b3b, NEUTRAL = 0x9098a0;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x12131a);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.minDistance = 4; controls.maxDistance = 120; controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4456, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(-14, 24, 12); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 120;
const d = 34; sun.shadow.camera.left = -d; sun.shadow.camera.right = d; sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
sun.shadow.bias = -0.0004;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.25); fill.position.set(12, 9, -10); scene.add(fill);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 70), new THREE.MeshStandardMaterial({ color: 0x1b1d27, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -TILE_H; ground.receiveShadow = true; scene.add(ground);

// ── labels ──
function makeLabel(text: string, kind: 'item' | 'header' | 'side'): THREE.Sprite {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 128;
  const ctx = c.getContext('2d')!;
  const fs = kind === 'header' ? 72 : kind === 'side' ? 56 : 44;
  ctx.font = `bold ${fs}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.strokeText(text, 512, 64);
  ctx.fillStyle = kind === 'header' ? '#ffd27a' : kind === 'side' ? (text.startsWith('PROPOSED') ? '#80d8a0' : '#e08080') : '#eef0f6';
  ctx.fillText(text, 512, 64);
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  const w = kind === 'header' ? 9.6 : kind === 'side' ? 6.4 : 4.8;
  sp.scale.set(w, w / 8, 1);
  return sp;
}
function label(text: string, x: number, y: number, z: number, kind: 'item' | 'header' | 'side' = 'item'): void {
  const sp = makeLabel(text, kind); sp.position.set(x, y, z); scene.add(sp);
}
function shadows(o: THREE.Object3D): void { o.traverse(c => { (c as THREE.Mesh).castShadow = true; }); }
function seat(x: number, z: number, tile?: THREE.Object3D): void {
  const t = tile ?? B.build_tilePlain(THREE, P); t.position.set(x, 0, z); scene.add(t);
}
function put(model: THREE.Object3D, name: string, x: number, z: number, labelY = 1.9, withSeat = true): void {
  if (withSeat) seat(x, z);
  model.position.set(x, 0, z); shadows(model); scene.add(model);
  label(name, x, labelY, z);
}

// Row layout: current items on the left of x = 0, proposed on the right.
const GAP = 2.7;
const LEFT0 = -13.5, RIGHT0 = 1.5;
function rowHeader(title: string, z: number): void {
  label(title, 2, 3.6, z - 3.4, 'header');
  label('CURRENT', LEFT0 + 4, 2.4, z - 2.2, 'side');
  label('PROPOSED', RIGHT0 + 6.5, 2.4, z - 2.2, 'side');
}

// ── Proposal 1: faction body kits ─────────────────────────────────────────────
const Z1 = -12;
rowHeader('1 · Faction body kits', Z1);
{
  const cur: [string, THREE.Object3D][] = [
    ['Temple Warrior', buildUnitModel('warrior', BLUE, 'temple')],
    ['Agrar Warrior', buildUnitModel('warrior', BLUE, 'agrar')],
    ['Temple Healer', buildUnitModel('healer', BLUE, 'temple')],
    ['Agrar Healer', buildUnitModel('healer', BLUE, 'agrar')],
    ['Enemy Warrior', buildUnitModel('warrior', RED, 'temple')],
  ];
  cur.forEach(([n, m], i) => put(m, n, LEFT0 + i * GAP, Z1));
  const prop: [string, THREE.Object3D][] = [
    ['Nomad Warrior', kitWithWeapon(buildNomad(BLUE), buildSword(), 0.62, 2.2, 2.0, 0.4)],
    ['Nomad Archer', kitWithWeapon(buildNomad(BLUE), buildBow(), 0.4, 2.2, 3.4, 0.3)],
    ['Nomad Healer', kitWithWeapon(buildNomad(BLUE), buildHealerStaff(), 0.58, 2.2, 2.2, 0.3)],
    ['Farmer Warrior', kitWithWeapon(buildFarmer(BLUE), buildSword(), 0.62, 2.2, 2.0, 0.4)],
    ['Farmer Spearsman', kitWithWeapon(buildFarmer(BLUE), buildSpear(), 0.52, 2.2, 4.6, 0.3)],
    ['Enemy Nomad', kitWithWeapon(buildNomad(RED), buildSword(), 0.62, 2.2, 2.0, 0.4)],
  ];
  prop.forEach(([n, m], i) => put(m, n, RIGHT0 + i * GAP, Z1));
}

// ── Proposal 2: tile set v2 ───────────────────────────────────────────────────
const Z2 = 0;
rowHeader('2 · Tile set v2', Z2);
{
  const cur: [string, THREE.Object3D][] = [
    ['Plain', B.build_tilePlain(THREE, P)], ['Forest', B.build_tileForest(THREE, P)],
    ['Hill', B.build_tileHill(THREE, P)], ['Mountain', B.build_tileWall(THREE, P)],
  ];
  cur.forEach(([n, m], i) => put(m, n, LEFT0 + i * GAP, Z2, 1.7, false));
  const prop: [string, THREE.Object3D][] = [
    ['Plain', buildPlainV2(P)], ['Forest', buildForestV2(P)], ['Hill', buildHillV2(P)], ['Mountain', buildWallV2(P)],
  ];
  prop.forEach(([n, m], i) => put(m, n, RIGHT0 + i * GAP, Z2, 1.7, false));
  // a small tessellated patch so the bevel/tone variation can be judged as a map
  const patch: [number, number][] = [[0, 0], [1, 0], [-1, 0], [0.5, 1], [-0.5, 1], [0.5, -1], [-0.5, -1]];
  const px = RIGHT0 + 5 * GAP + 0.6, pz = Z2;
  patch.forEach(([dx, dz], i) => {
    const t = i === 3 ? buildForestV2(P) : i === 5 ? buildHillV2(P) : buildPlainV2(P);
    t.position.set(px + dx * 1.5, 0, pz + dz * Math.sqrt(3) * 0.5 * 1.0);
    scene.add(t);
  });
  label('as a map', px, 1.7, pz);
}

// ── Proposal 3: structure set v2 ──────────────────────────────────────────────
const Z3 = 12;
rowHeader('3 · Structure set v2', Z3);
{
  const cur: [string, THREE.Object3D][] = [
    ['Neutral / Ruins (tier 1)', buildTemple(NEUTRAL, 1)],
    ['Founding (tier 2)', buildTemple(BLUE, 2)],
    ['Temple I & II (tier 5)', buildTemple(BLUE, 5)],
    ['Capital (tier 10)', buildTemple(BLUE, 10)],
  ];
  cur.forEach(([n, m], i) => put(m, n, LEFT0 + i * GAP, Z3, 2.6));
  const prop: [string, THREE.Object3D][] = [
    ['Ruins', buildRuinsV2()],
    ['Temple I', buildTempleIV2(BLUE)],
    ['Temple II', buildTempleIIV2(BLUE)],
    ['Capital', buildCapitalV2(BLUE)],
    ['Enemy Temple II', buildTempleIIV2(RED)],
  ];
  prop.forEach(([n, m], i) => put(m, n, RIGHT0 + i * GAP, Z3, 2.6));
}

// ── camera presets ────────────────────────────────────────────────────────────
function flyTo(z: number, dist: number): void {
  controls.target.set(3, 0.5, z);
  camera.position.set(3, dist * 0.85, z + dist);
}
flyTo(0, 40);
document.querySelectorAll<HTMLButtonElement>('[data-row]').forEach(b => {
  b.addEventListener('click', () => {
    const r = b.dataset.row!;
    if (r === 'all') flyTo(0, 40); else flyTo([Z1, Z2, Z3][Number(r) - 1]! + 1, 24);
  });
});

function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();
(function animate(): void { controls.update(); renderer.render(scene, camera); requestAnimationFrame(animate); })();
