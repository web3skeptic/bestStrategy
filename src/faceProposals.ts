// /face-proposals — every face option from src/proposals/faces.ts on the
// shared rig: bare head, Farmer Warrior and Nomad Warrior per column, with the
// tribes' picked hair/hat so the face is judged in context. Decision page only.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { makePalette, TILE_H, Palette } from './three/palette';
import * as B from './three/builders.gen';
import { buildGuy, angryFace, FaceStyle } from './voxelWarrior';
import { buildUnitModel } from './voxelUnits';
import { wideBrimHat } from './proposals/strawHats';
import { FACES } from './proposals/faces';

const P: Palette = makePalette();
const TEAM_COLORS: [string, number][] = [['blue', 0x3a7bd5], ['red', 0xd23b3b], ['green', 0x3aa86a], ['gold', 0xe0a020]];
let teamIdx = 0, spinning = true;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x12131a);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 1.5; controls.maxDistance = 120; controls.maxPolarAngle = Math.PI * 0.49;
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4456, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(-14, 24, 12); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.near = 1; sun.shadow.camera.far = 120;
const d = 34; sun.shadow.camera.left = -d; sun.shadow.camera.right = d; sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d; sun.shadow.bias = -0.0004;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(6, 6, 14); scene.add(fill);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 70), new THREE.MeshStandardMaterial({ color: 0x1b1d27, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -TILE_H; ground.receiveShadow = true; scene.add(ground);

function makeLabel(text: string, big = false): THREE.Sprite {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.font = `bold ${big ? 64 : 44}px -apple-system, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.strokeText(text, 512, 64);
  ctx.fillStyle = big ? '#ffd27a' : '#eef0f6'; ctx.fillText(text, 512, 64);
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  const w = big ? 6 : 4.4; sp.scale.set(w, w / 8, 1); return sp;
}
const staticGroup = new THREE.Group(); scene.add(staticGroup);
const modelGroup = new THREE.Group(); scene.add(modelGroup);
const spinners: THREE.Object3D[] = [];

interface Col { name: string; face: FaceStyle; blurb: string; }
const COLS: Col[] = [
  { name: 'Current', face: angryFace, blurb: 'Today\'s angry face on everyone.' },
  ...FACES.map(f => ({ name: f.name, face: f.draw, blurb: f.blurb })),
];
const XS = COLS.map((_, i) => (i - (COLS.length - 1) / 2) * 3.2);
const ZH = -3.2, ZW = 0, ZA = 3.2;
XS.forEach((x, i) => {
  for (const z of [ZH, ZW, ZA]) { const t = B.build_tilePlain(THREE, P); t.position.set(x, 0, z); staticGroup.add(t); }
  const l = makeLabel(COLS[i]!.name, i === 0); l.position.set(x, 2.8, ZH - 1.2); staticGroup.add(l);
});
{ const l = makeLabel('bare head'); l.position.set(XS[0]! - 3.2, 1.2, ZH); staticGroup.add(l); }
{ const l = makeLabel('Farmer Warrior'); l.position.set(XS[0]! - 3.4, 1.2, ZW); staticGroup.add(l); }
{ const l = makeLabel('Nomad Warrior'); l.position.set(XS[0]! - 3.4, 1.2, ZA); staticGroup.add(l); }

function shadows(o: THREE.Object3D): void { o.traverse(c => { (c as THREE.Mesh).castShadow = true; }); }
function buildAll(): void {
  spinners.length = 0;
  while (modelGroup.children.length) {
    const c = modelGroup.children.pop()!;
    c.traverse(o => { const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mm)) mm.forEach(q => q.dispose()); else if (mm && !(mm as THREE.MeshStandardMaterial).map) mm.dispose(); });
  }
  const color = TEAM_COLORS[teamIdx]![1];
  COLS.forEach((col, i) => {
    const x = XS[i]!;
    const head = buildGuy(color, wideBrimHat, undefined, col.face); head.scale.setScalar(0.2); head.position.set(x, 0.08, ZH); shadows(head); modelGroup.add(head); spinners.push(head);
    const w = buildUnitModel('warrior', color, 'agrar', undefined, undefined, col.face); w.position.set(x, 0, ZW); shadows(w); modelGroup.add(w); spinners.push(w);
    const a = buildUnitModel('warrior', color, 'temple', undefined, undefined, col.face); a.position.set(x, 0, ZA); shadows(a); modelGroup.add(a); spinners.push(a);
  });
}
buildAll();

const btns = document.getElementById('styleBtns')!;
const blurb = document.getElementById('blurb')!;
COLS.forEach((col, i) => {
  const b = document.createElement('button'); b.textContent = i === 0 ? 'Current' : col.name.split(' · ')[0]!; b.title = col.name;
  b.addEventListener('click', () => { flyTo(XS[i]!, 0.6, 7.2); blurb.textContent = `${col.name} — ${col.blurb}`; });
  btns.appendChild(b);
});
function flyTo(x: number, z: number, dist: number): void { controls.target.set(x, 0.8, z); camera.position.set(x + dist * 0.05, dist * 0.55, z + dist); }
btns.querySelector('[data-style="all"]')!.addEventListener('click', () => { flyTo(0, 0, 24); blurb.textContent = ''; });
flyTo(0, 0, 24);
const colorBtn = document.getElementById('colorBtn') as HTMLButtonElement;
colorBtn.addEventListener('click', () => { teamIdx = (teamIdx + 1) % TEAM_COLORS.length; colorBtn.textContent = `Team colour: ${TEAM_COLORS[teamIdx]![0]}`; buildAll(); });
const spinBtn = document.getElementById('spinBtn') as HTMLButtonElement;
spinBtn.addEventListener('click', () => { spinning = !spinning; spinBtn.textContent = `Spin: ${spinning ? 'on' : 'off'}`; if (!spinning) spinners.forEach(s => { s.rotation.y = 0; }); });
function resize(): void { const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }
window.addEventListener('resize', resize); resize();
let last = performance.now();
(function animate(now: number): void { const dt = (now - last) / 1000; last = now; if (spinning) spinners.forEach(s => { s.rotation.y += dt * 0.6; }); controls.update(); renderer.render(scene, camera); requestAnimationFrame(animate); })(last);
