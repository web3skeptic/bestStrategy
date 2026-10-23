// /nomad-proposals — current vs proposed model for every Nomad unit
// (src/proposals/nomadUnits.ts). Decision page only.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { makePalette, TILE_H, Palette } from './three/palette';
import * as B from './three/builders.gen';
import { buildUnitModel } from './voxelUnits';
import { NOMAD_UNITS } from './proposals/nomadUnits';

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
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 2; controls.maxDistance = 120; controls.maxPolarAngle = Math.PI * 0.49;
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4456, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(-14, 24, 12); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.near = 1; sun.shadow.camera.far = 120;
const d = 34; sun.shadow.camera.left = -d; sun.shadow.camera.right = d; sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d; sun.shadow.bias = -0.0004;
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.3); fill.position.set(10, 8, 12); scene.add(fill);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 70), new THREE.MeshStandardMaterial({ color: 0x1b1d27, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -TILE_H; ground.receiveShadow = true; scene.add(ground);

function makeLabel(text: string, kind: 'item' | 'header' | 'cur' | 'prop' = 'item'): THREE.Sprite {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.font = `bold ${kind === 'header' ? 64 : 44}px -apple-system, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.strokeText(text, 512, 64);
  ctx.fillStyle = kind === 'header' ? '#ffd27a' : kind === 'cur' ? '#e08080' : kind === 'prop' ? '#80d8a0' : '#eef0f6'; ctx.fillText(text, 512, 64);
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  const w = kind === 'header' ? 6 : 4.4; sp.scale.set(w, w / 8, 1); return sp;
}
const staticGroup = new THREE.Group(); scene.add(staticGroup);
const modelGroup = new THREE.Group(); scene.add(modelGroup);
const spinners: THREE.Object3D[] = [];

const XS = NOMAD_UNITS.map((_, i) => (i - (NOMAD_UNITS.length - 1) / 2) * 3.6);
const ZC = -2.4, ZP = 2.4;
XS.forEach((x, i) => {
  for (const z of [ZC, ZP]) { const t = B.build_tilePlain(THREE, P); t.position.set(x, 0, z); staticGroup.add(t); }
  const u = NOMAD_UNITS[i]!;
  const lc = makeLabel(u.current, 'cur'); lc.position.set(x, 2.4, ZC - 1.3); staticGroup.add(lc);
  const lp = makeLabel(u.proposed, 'prop'); lp.position.set(x, 2.4, ZP + 1.5); staticGroup.add(lp);
});
{ const l = makeLabel('CURRENT', 'cur'); l.position.set(XS[0]! - 3.6, 1.2, ZC); staticGroup.add(l); }
{ const l = makeLabel('PROPOSED', 'prop'); l.position.set(XS[0]! - 3.6, 1.2, ZP); staticGroup.add(l); }

function shadows(o: THREE.Object3D): void { o.traverse(c => { (c as THREE.Mesh).castShadow = true; }); }
function buildAll(): void {
  spinners.length = 0;
  while (modelGroup.children.length) {
    const c = modelGroup.children.pop()!;
    c.traverse(o => { const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mm)) mm.forEach(q => q.dispose()); else if (mm && !(mm as THREE.MeshStandardMaterial).map) mm.dispose(); });
  }
  const color = TEAM_COLORS[teamIdx]![1];
  NOMAD_UNITS.forEach((u, i) => {
    const x = XS[i]!;
    const cur = buildUnitModel(u.type, color, 'temple'); cur.position.set(x, 0, ZC); cur.rotation.y = 0.5; shadows(cur); modelGroup.add(cur); spinners.push(cur);
    const m = u.build(color); m.scale.setScalar(0.2); m.position.set(x, 0, ZP); m.rotation.y = 0.6; shadows(m); modelGroup.add(m); spinners.push(m);
  });
}
buildAll();

const btns = document.getElementById('styleBtns')!;
const blurb = document.getElementById('blurb')!;
NOMAD_UNITS.forEach((u, i) => {
  const b = document.createElement('button'); b.textContent = u.current;
  b.addEventListener('click', () => { flyTo(XS[i]!, 0.4, 8.5); blurb.textContent = `${u.current} → ${u.proposed} — ${u.blurb}`; });
  btns.appendChild(b);
});
function flyTo(x: number, z: number, dist: number): void { controls.target.set(x, 0.8, z); camera.position.set(x + dist * 0.35, dist * 0.65, z + dist); }
btns.querySelector('[data-style="all"]')!.addEventListener('click', () => { flyTo(0, 0, 26); blurb.textContent = ''; });
flyTo(0, 0, 26);
const colorBtn = document.getElementById('colorBtn') as HTMLButtonElement;
colorBtn.addEventListener('click', () => { teamIdx = (teamIdx + 1) % TEAM_COLORS.length; colorBtn.textContent = `Team colour: ${TEAM_COLORS[teamIdx]![0]}`; buildAll(); });
const spinBtn = document.getElementById('spinBtn') as HTMLButtonElement;
spinBtn.addEventListener('click', () => { spinning = !spinning; spinBtn.textContent = `Spin: ${spinning ? 'on' : 'off'}`; });
function resize(): void { const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }
window.addEventListener('resize', resize); resize();
let last = performance.now();
(function animate(now: number): void { const dt = (now - last) / 1000; last = now; if (spinning) spinners.forEach(s => { s.rotation.y += dt * 0.5; }); controls.update(); renderer.render(scene, camera); requestAnimationFrame(animate); })(last);
