// Asset showcase (/demo) — renders one of every tile, unit, and structure the
// game builds, laid out in labelled rows. Reuses the exact builders, materials
// and unit-wiring from the 3D renderer so it always matches the real game.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { makePalette, TILE_H, Palette } from './three/palette';
import * as B from './three/builders.gen';
import { buildGuy } from './voxelWarrior';
import { buildHorseRider } from './voxelHorserider';
import { buildHeavyKnight } from './voxelHeavyKnight';
import { buildSword } from './voxelSword';
import { buildSpear } from './voxelSpear';
import { buildBow } from './voxelBow';
import { buildDemonStaff, buildRuneStaff, buildHealerStaff } from './voxelStaff';
import { buildPortal } from './voxelPortal';
import { buildTemple } from './voxelTemple';
import { buildCannon } from './voxelCannon';
import { UnitType } from './types';

const P: Palette = makePalette();
const TEAM = 0x3a7bd5;        // blue team
const TEAM2 = 0xd23b3b;       // red team (second portal-pair colour demo)

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x12131a);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
camera.position.set(0, 22, 27);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.4, 0);
controls.minDistance = 6;
controls.maxDistance = 120;
controls.maxPolarAngle = Math.PI * 0.49;

// ── lighting (mirrors Renderer3D) ─────────────────────────────────────────────
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4456, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(-14, 24, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 120;
const d = 30;
sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
sun.shadow.bias = -0.0004;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.25);
fill.position.set(12, 9, -10);
scene.add(fill);

// ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 60),
  new THREE.MeshStandardMaterial({ color: 0x1b1d27, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -TILE_H;
ground.receiveShadow = true;
scene.add(ground);

// ── label sprites (canvas texture, always face camera) ────────────────────────
function makeLabel(text: string, kind: 'item' | 'header' = 'item'): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const ctx = c.getContext('2d')!;
  const fs = kind === 'header' ? 78 : 46;
  ctx.font = `bold ${fs}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.strokeText(text, 256, 64);
  ctx.fillStyle = kind === 'header' ? '#ffd27a' : '#eef0f6';
  ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  sp.scale.set(kind === 'header' ? 3.6 : 2.6, kind === 'header' ? 0.9 : 0.65, 1);
  return sp;
}

function label(text: string, x: number, y: number, z: number, kind: 'item' | 'header' = 'item'): void {
  const sp = makeLabel(text, kind);
  sp.position.set(x, y, z);
  scene.add(sp);
}

function setShadows(o: THREE.Object3D): void {
  o.traverse(c => { (c as THREE.Mesh).castShadow = true; });
}

// ── tiles ─────────────────────────────────────────────────────────────────────
function placeTile(kind: string, x: number, z: number): void {
  const tile =
    kind === 'wall' ? B.build_tileWall(THREE, P)
    : kind === 'forest' ? B.build_tileForest(THREE, P)
    : kind === 'hill' ? B.build_tileHill(THREE, P)
    : kind === 'fog' ? B.build_tileFog(THREE, P)
    : B.build_tilePlain(THREE, P);
  tile.position.set(x, 0, z);
  scene.add(tile);
}

// a plain tile to seat units / structures on
function seatTile(x: number, z: number): void {
  const tile = B.build_tilePlain(THREE, P);
  tile.position.set(x, 0, z);
  scene.add(tile);
}

// ── units (mirrors Renderer3D.buildUnitMesh) ──────────────────────────────────
function guyWithWeapon(weapon: THREE.Object3D, s: number, wx: number, wy: number, wz: number): THREE.Group {
  const guy = buildGuy(TEAM);
  weapon.scale.setScalar(s);
  weapon.position.set(wx, wy, wz);
  weapon.rotation.z = -0.12;
  guy.add(weapon);
  guy.scale.setScalar(0.2);
  guy.position.y = 0.08;
  setShadows(guy);
  return guy;
}

function buildUnitModel(type: UnitType): THREE.Object3D {
  const wrap = new THREE.Group();
  switch (type) {
    case 'warrior': wrap.add(guyWithWeapon(buildSword(), 0.62, 2.2, 2.0, 0.4)); break;
    case 'archer': wrap.add(guyWithWeapon(buildBow(), 0.6, 2.2, 2.0, 0.3)); break;
    case 'spearsman': wrap.add(guyWithWeapon(buildSpear(), 0.52, 2.2, 4.6, 0.3)); break;
    case 'healer': wrap.add(guyWithWeapon(buildHealerStaff(), 0.58, 2.2, 2.2, 0.3)); break;
    case 'damageBooster':
    case 'rangeBooster': {
      const guy = buildGuy(TEAM);
      const staff = type === 'damageBooster' ? buildDemonStaff() : buildRuneStaff();
      staff.scale.set(0.92, 0.72, 0.92);
      staff.position.set(2.3, 2.4, 0.3);
      staff.rotation.z = -0.12;
      guy.add(staff);
      guy.scale.setScalar(0.2);
      guy.position.y = 0.08;
      setShadows(guy);
      wrap.add(guy);
      break;
    }
    case 'horserider': { const hr = buildHorseRider(TEAM); hr.scale.setScalar(0.2); setShadows(hr); wrap.add(hr); break; }
    case 'heavyknight': { const hk = buildHeavyKnight(TEAM); hk.scale.setScalar(0.2); setShadows(hk); wrap.add(hk); break; }
    case 'catapult': default: { const m = buildCannon(TEAM); setShadows(m); wrap.add(m); break; }
  }
  return wrap;
}

function placeUnit(type: UnitType, name: string, x: number, z: number): void {
  seatTile(x, z);
  const u = buildUnitModel(type);
  u.position.set(x, 0, z);
  scene.add(u);
  label(name, x, 1.9, z);
}

// ── structures ────────────────────────────────────────────────────────────────
function placeTemple(level: number, x: number, z: number, color = TEAM): void {
  seatTile(x, z);
  const t = buildTemple(color, level);
  t.position.set(x, 0, z);
  scene.add(t);
  label(`Temple L${level}`, x, 2.0 + level * 0.12, z);
}

function placePortal(x: number, z: number, color: number, name: string): void {
  seatTile(x, z);
  const p = buildPortal(color);
  p.position.set(x, 0, z);
  scene.add(p);
  label(name, x, 1.7, z);
}

// ── layout ────────────────────────────────────────────────────────────────────
const COL = [-6, -3, 0, 3, 6];

// Tiles row
const Z_TILES = -9;
label('TILES', -10.5, 2.4, Z_TILES, 'header');
const tiles: [string, string][] = [['plain', 'Plain'], ['forest', 'Forest'], ['hill', 'Hill'], ['wall', 'Wall'], ['fog', 'Fog']];
tiles.forEach(([kind, name], i) => { placeTile(kind, COL[i], Z_TILES); label(name, COL[i], 1.2, Z_TILES); });

// Units rows (9 types → 5 + 4)
label('UNITS', -10.5, 2.4, -4.5, 'header');
const units: [UnitType, string][] = [
  ['warrior', 'Warrior'], ['archer', 'Archer'], ['spearsman', 'Spearsman'],
  ['horserider', 'Horserider'], ['heavyknight', 'Heavy Knight'], ['catapult', 'Cannon'],
  ['healer', 'Healer'], ['damageBooster', 'Damage Booster'], ['rangeBooster', 'Range Booster'],
];
units.forEach(([type, name], i) => {
  const row = i < 5 ? 0 : 1;
  const inRow = i < 5 ? 5 : units.length - 5;
  const col = i < 5 ? i : i - 5;
  const x = (col - (inRow - 1) / 2) * 3;
  placeUnit(type, name, x, -5 + row * 3.2);
});

// Structures: temples L1–10 + a portal pair
label('STRUCTURES', -11.5, 2.6, 4, 'header');
for (let i = 0; i < 5; i++) placeTemple(i + 1, COL[i], 3);
for (let i = 0; i < 5; i++) placeTemple(i + 6, COL[i], 7);
placePortal(9.5, 4.5, TEAM, 'Portal');
placePortal(9.5, 7.5, TEAM2, 'Portal (red)');

// ── render loop ───────────────────────────────────────────────────────────────
function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function animate(): void {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();
