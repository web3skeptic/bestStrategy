// /capital-proposals — live 3D preview of faction-specific Capital city
// proposals (src/proposals/capitals.ts): the current shared ziggurat next to
// three Nomad versions and three Farmer versions, each on a small hex patch
// with one of that tribe's units beside it for scale. Decision page only —
// nothing here is wired into the board renderer.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { makePalette, TILE_H, Palette } from './three/palette';
import * as B from './three/builders.gen';
import { buildUnitModel } from './voxelUnits';
import { buildTemple } from './voxelTemple';
import {
  buildNomadCapitalA, buildNomadCapitalB, buildNomadCapitalC,
  buildFarmerCapitalA, buildFarmerCapitalB, buildFarmerCapitalC,
} from './proposals/capitals';

const P: Palette = makePalette();
const TEAM_COLORS: [string, number][] = [['blue', 0x3a7bd5], ['red', 0xd23b3b], ['green', 0x3aa86a], ['gold', 0xe0a020]];
let teamIdx = 0;

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
controls.minDistance = 3; controls.maxDistance = 120; controls.maxPolarAngle = Math.PI * 0.49;

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
  ctx.fillStyle = kind === 'header' ? '#ffd27a' : kind === 'side' ? '#e08080' : '#eef0f6';
  ctx.fillText(text, 512, 64);
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  const w = kind === 'header' ? 10 : kind === 'side' ? 6.4 : 5.2;
  sp.scale.set(w, w / 8, 1);
  return sp;
}
const staticGroup = new THREE.Group(); scene.add(staticGroup);
const modelGroup = new THREE.Group(); scene.add(modelGroup);
function label(text: string, x: number, y: number, z: number, kind: 'item' | 'header' | 'side' = 'item'): void {
  const sp = makeLabel(text, kind); sp.position.set(x, y, z); staticGroup.add(sp);
}
function shadows(o: THREE.Object3D): void { o.traverse(c => { (c as THREE.Mesh).castShadow = true; }); }

// A 7-tile hex patch (centre + ring) so each city is judged on real ground.
const HEX_NEIGHBOURS: [number, number][] = [[1.5, 0.866], [1.5, -0.866], [0, 1.732], [0, -1.732], [-1.5, 0.866], [-1.5, -0.866]];
function patch(x: number, z: number, forest = false): void {
  const c = B.build_tilePlain(THREE, P); c.position.set(x, 0, z); staticGroup.add(c);
  HEX_NEIGHBOURS.forEach(([dx, dz], i) => {
    const t = forest && i === 3 ? B.build_tileForest(THREE, P) : B.build_tilePlain(THREE, P);
    t.position.set(x + dx, 0, z + dz); staticGroup.add(t);
  });
}

// Layout: Nomads row at the back, Farmers row in front; 4 stations per row.
const ZN = -6.5, ZF = 6.5;
const XS = [-11.25, -3.75, 3.75, 11.25];
const NOMAD_NAMES = ['Current (shared ziggurat)', 'A · Great Yurt Camp', "B · Khan's Pavilion", 'C · Horde Hold'];
const FARMER_NAMES = ['Current (shared ziggurat)', 'A · Granary Town', 'B · Windmill Keep', 'C · Walled Farmstead'];

label('Nomads', 0, 5.2, ZN - 4.4, 'header');
label('Farmers', 0, 5.2, ZF - 4.4, 'header');
XS.forEach((x, i) => {
  patch(x, ZN, i === 3); patch(x, ZF, i === 1);
  label(NOMAD_NAMES[i]!, x, 3.1, ZN + 1.9);
  label(FARMER_NAMES[i]!, x, 3.1, ZF + 1.9);
});

function buildAll(): void {
  while (modelGroup.children.length) {
    const c = modelGroup.children.pop()!;
    c.traverse(o => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); const mm = m.material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mm)) mm.forEach(q => q.dispose()); else mm?.dispose(); });
  }
  const color = TEAM_COLORS[teamIdx]![1];
  const nomad: THREE.Object3D[] = [buildTemple(color, 10), buildNomadCapitalA(color), buildNomadCapitalB(color), buildNomadCapitalC(color)];
  const farmer: THREE.Object3D[] = [buildTemple(color, 10), buildFarmerCapitalA(color), buildFarmerCapitalB(color), buildFarmerCapitalC(color)];
  XS.forEach((x, i) => {
    const n = nomad[i]!; n.position.set(x, 0, ZN); shadows(n); modelGroup.add(n);
    const f = farmer[i]!; f.position.set(x, 0, ZF); shadows(f); modelGroup.add(f);
    // one unit of each tribe on the front-right neighbour tile, for scale
    const nu = buildUnitModel('horserider', color, 'temple'); nu.position.set(x + 1.5, 0, ZN + 0.866); nu.rotation.y = Math.PI * 0.85; shadows(nu); modelGroup.add(nu);
    const fu = buildUnitModel('warrior', color, 'agrar'); fu.position.set(x + 1.5, 0, ZF + 0.866); fu.rotation.y = Math.PI * 0.85; shadows(fu); modelGroup.add(fu);
  });
}
buildAll();

// ── camera presets ──
function flyTo(x: number, z: number, dist: number): void {
  controls.target.set(x, 0.6, z);
  camera.position.set(x + dist * 0.15, dist * 0.8, z + dist);
}
flyTo(3.5, 0, 30);
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b => {
  b.addEventListener('click', () => {
    const v = b.dataset.view!;
    if (v === 'all') flyTo(3.5, 0, 30);
    else if (v === 'nomads') flyTo(3.5, ZN - 1, 25);
    else if (v === 'farmers') flyTo(3.5, ZF - 1, 25);
    else { const row = v[0] === 'n' ? ZN : ZF; const idx = Number(v[1]) + 1; flyTo(XS[idx]!, row, 6.5); }
  });
});
const colorBtn = document.getElementById('colorBtn') as HTMLButtonElement;
colorBtn.addEventListener('click', () => {
  teamIdx = (teamIdx + 1) % TEAM_COLORS.length;
  colorBtn.textContent = `Team colour: ${TEAM_COLORS[teamIdx]![0]}`;
  buildAll();
});

function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();
(function animate(): void { controls.update(); renderer.render(scene, camera); requestAnimationFrame(animate); })();
