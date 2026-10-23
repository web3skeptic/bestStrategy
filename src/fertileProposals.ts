// /fertile-proposals — every Fertile Site option from src/proposals/
// fertileSites.ts, shown neutral and claimed by two owners, next to an
// ordinary Farm so the difference is judged against what it must NOT look
// like. Decision page only.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { makePalette, TILE_H, Palette } from './three/palette';
import * as B from './three/builders.gen';
import { buildFarm, buildFertileSite } from './voxelFarm';
import { FERTILE_OPTIONS } from './proposals/fertileSites';

const P: Palette = makePalette();
const BLUE = 0x3a7bd5, RED = 0xd23b3b;
let spinning = true;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputEncoding = THREE.sRGBEncoding;
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x12131a);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 2; controls.maxDistance = 120; controls.maxPolarAngle = Math.PI * 0.49;
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4456, 0.65));
const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(-14, 24, 12); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.near = 1; sun.shadow.camera.far = 120;
const d = 40; sun.shadow.camera.left = -d; sun.shadow.camera.right = d; sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d; sun.shadow.bias = -0.0004;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.3); fill.position.set(10, 8, 12); scene.add(fill);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 80), new THREE.MeshStandardMaterial({ color: 0x1b1d27, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -TILE_H; ground.receiveShadow = true; scene.add(ground);

function makeLabel(text: string, big = false): THREE.Sprite {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.font = `bold ${big ? 60 : 44}px -apple-system, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.strokeText(text, 512, 64);
  ctx.fillStyle = big ? '#ffd27a' : '#eef0f6'; ctx.fillText(text, 512, 64);
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  const w = big ? 6 : 4.6; sp.scale.set(w, w / 8, 1); return sp;
}
const spinners: THREE.Object3D[] = [];
function shadows(o: THREE.Object3D): void { o.traverse(c => { (c as THREE.Mesh).castShadow = true; }); }
function put(m: THREE.Object3D, x: number, z: number, scale = 1.3): void {
  const t = B.build_tilePlain(THREE, P); t.position.set(x, 0, z); scene.add(t);
  m.scale.setScalar(scale); m.position.set(x, 0, z); shadows(m); scene.add(m); spinners.push(m);
}
interface Col { name: string; blurb: string; build: (o: number | null) => THREE.Object3D; scale: number; }
const COLS: Col[] = [
  { name: 'Current', blurb: 'Today\'s Fertile Site: a bigger golden farm plot with a small windmill.', build: o => buildFertileSite(o), scale: 1 },
  ...FERTILE_OPTIONS.map(o => ({ name: o.name, blurb: o.blurb, build: o.build, scale: 1.3 })),
];
const XS = COLS.map((_, i) => (i - (COLS.length - 1) / 2) * 3.4);
const ZN = -3.4, ZB = 0, ZR = 3.4;
XS.forEach((x, i) => {
  const col = COLS[i]!;
  put(col.build(null), x, ZN, col.scale); put(col.build(BLUE), x, ZB, col.scale); put(col.build(RED), x, ZR, col.scale);
  const l = makeLabel(col.name, i === 0); l.position.set(x, 2.6, ZN - 1.4); scene.add(l);
});
// an ordinary Farm for comparison at the far left of each row
{ const x = XS[0]! - 3.4; put(buildFarm(BLUE, 0), x, ZB, 1); put(buildFarm(RED, 0), x, ZR, 1); const l = makeLabel('ordinary Farm'); l.position.set(x, 1.6, ZN); scene.add(l); }
{ const l = makeLabel('neutral'); l.position.set(XS[0]! - 6.6, 1.0, ZN); scene.add(l); }
{ const l = makeLabel('claimed · blue'); l.position.set(XS[0]! - 6.6, 1.0, ZB); scene.add(l); }
{ const l = makeLabel('claimed · red'); l.position.set(XS[0]! - 6.6, 1.0, ZR); scene.add(l); }

const btns = document.getElementById('styleBtns')!;
const blurb = document.getElementById('blurb')!;
COLS.forEach((col, i) => {
  const b = document.createElement('button'); b.textContent = i === 0 ? 'Current' : col.name.split(' · ')[0]!; b.title = col.name;
  b.addEventListener('click', () => { flyTo(XS[i]!, 0, 8); blurb.textContent = `${col.name} — ${col.blurb}`; });
  btns.appendChild(b);
});
function flyTo(x: number, z: number, dist: number): void { controls.target.set(x, 0.5, z); camera.position.set(x + dist * 0.3, dist * 0.8, z + dist); }
btns.querySelector('[data-style="all"]')!.addEventListener('click', () => { flyTo(0, 0, 30); blurb.textContent = ''; });
flyTo(0, 0, 30);
const spinBtn = document.getElementById('spinBtn') as HTMLButtonElement;
spinBtn.addEventListener('click', () => { spinning = !spinning; spinBtn.textContent = `Spin: ${spinning ? 'on' : 'off'}`; });
function resize(): void { const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }
window.addEventListener('resize', resize); resize();
let last = performance.now();
(function animate(now: number): void { const dt = (now - last) / 1000; last = now; if (spinning) spinners.forEach(s => { s.rotation.y += dt * 0.35; }); controls.update(); renderer.render(scene, camera); requestAnimationFrame(animate); })(last);
