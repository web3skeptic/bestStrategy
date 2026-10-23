// The main-menu "living board": a hand-laid board rendered with the game's own
// tile/structure/unit builders, drifting through a day–night cycle behind the
// menu. Every menu entry has a scene the camera flies to (see PLACES). Created
// when the menu opens and disposed when a game starts (see main.ts), so it
// never competes with the board renderer for a WebGL context.
import * as THREE from 'three';
import { makePalette, TILE_H, hexToWorld, Palette } from './three/palette';
import * as B from './three/builders.gen';
import { buildTemple } from './voxelTemple';
import { buildUnitModel } from './voxelUnits';
import { buildFarm } from './voxelFarm';
import { buildPortal } from './voxelPortal';
import { HexCoord, UnitType, FactionId } from './types';
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils';
import { IS_TOUCH, renderPixelRatio } from './perfProfile';

// Merge every mesh under `root` that shares a material look into one mesh.
// The board is ~170 voxel tiles plus buildings — hundreds of tiny meshes and
// as many draw calls per frame (twice, with the shadow pass). None of it moves,
// so it can be baked into a handful of meshes. Materials are matched by
// appearance (the builders create a fresh material per part).
function bakeStatic(root: THREE.Object3D): THREE.Group {
  root.updateMatrixWorld(true);
  // Bake into the root's local space, so a baked unit can still move/bob as a whole.
  const toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  const buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; cast: boolean; receive: boolean }>();
  root.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    let g = m.geometry.clone().applyMatrix4(rel.multiplyMatrices(toLocal, m.matrixWorld));
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') g.deleteAttribute(name);
    // Plain coloured parts (no texture, opaque, no vertex colours yet) differ
    // only by colour: write the colour into the geometry so they can all share
    // one vertex-coloured material and merge into a single mesh.
    const plain = !mat.map && !mat.vertexColors && !mat.transparent && !!mat.color;
    if (plain) {
      const n = g.attributes.position!.count, c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = mat.color.r; c[i * 3 + 1] = mat.color.g; c[i * 3 + 2] = mat.color.b; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      if (g.attributes.uv) g.deleteAttribute('uv');
    }
    const attrs = Object.keys(g.attributes).sort().join(',');
    const key = [plain ? 'vc' : mat.color?.getHex(), mat.type, mat.emissive?.getHex(), mat.emissiveIntensity, mat.roughness, mat.metalness,
      mat.map?.uuid ?? '', mat.vertexColors, mat.flatShading, mat.transparent, mat.opacity, mat.side, m.castShadow, m.receiveShadow, attrs].join('|');
    let b = buckets.get(key);
    if (!b) {
      let useMat: THREE.Material = mat;
      if (plain) { const vc = mat.clone(); vc.vertexColors = true; vc.color.setRGB(1, 1, 1); useMat = vc; }
      b = { mat: useMat, geos: [], cast: m.castShadow, receive: m.receiveShadow }; buckets.set(key, b);
    }
    b.geos.push(g);
  });
  const out = new THREE.Group();
  for (const b of buckets.values()) {
    const merged = BufferGeometryUtils.mergeBufferGeometries(b.geos, false);
    for (const g of b.geos) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, b.mat);
    mesh.castShadow = b.cast; mesh.receiveShadow = b.receive;
    out.add(mesh);
  }
  return out;
}

export type MenuPlace = 'home' | 'duel' | 'machine' | 'camps' | 'portals' | 'temple';

export interface MenuScene {
  goTo(place: MenuPlace): void;
  resize(): void;
  dispose(): void;
}

const TEMPLE_COL = 0x8f7bff, AGRAR_COL = 0xffb054, THIRD_COL = 0x5ee08a, FOURTH_COL = 0x4fe3ff;

function rng(seed: number): () => number { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

type Place = { target: [number, number, number]; yaw: number; dist: number; elev: number };

export function createMenuScene(canvas: HTMLCanvasElement, host: HTMLElement): MenuScene {
  const P: Palette = makePalette();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // It's a backdrop under the menu: phones render it at a lower resolution,
  // with cheaper shadows refreshed a few times a second (the sun drifts slowly).
  renderer.setPixelRatio(renderPixelRatio(1.25));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = IS_TOUCH ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.outputEncoding = THREE.sRGBEncoding;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 120);
  const hemi = new THREE.HemisphereLight(0xffe6c0, 0x1c2a1a, 0.6); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffd9a0, 1.2);
  sun.castShadow = true; sun.shadow.mapSize.set(IS_TOUCH ? 1024 : 2048, IS_TOUCH ? 1024 : 2048); sun.shadow.camera.near = 1; sun.shadow.camera.far = 60;
  const sd = 16; sun.shadow.camera.left = -sd; sun.shadow.camera.right = sd; sun.shadow.camera.top = sd; sun.shadow.camera.bottom = -sd; sun.shadow.bias = -0.0005;
  scene.add(sun);
  const fog = new THREE.Fog(0x0a1510, 18, 40); scene.fog = fog;

  // ── the board ──
  const rnd = rng(23);
  const map = new THREE.Group(); scene.add(map);
  const staticBoard = new THREE.Group(); // tiles, temple, farms, portals — baked below
  const R = 7;
  const feats = new Map<string, string>([
    ['0,0', 'temple'], ['-4,1', 'farm'], ['-5,3', 'farm'], ['-3,3', 'farm'], ['-4,2', 'plain'], ['-4,3', 'plain'],
    ['3,-5', 'wall'], ['4,-5', 'wall'], ['4,-6', 'wall'], ['5,-6', 'wall'], ['3,-4', 'hill'], ['5,-5', 'hill'], ['2,-4', 'hill'],
    ['-2,-3', 'hill'], ['4,1', 'hill'], ['0,4', 'forest'], ['1,4', 'forest'], ['-1,5', 'forest'], ['2,3', 'forest'], ['-6,1', 'forest'], ['-6,2', 'forest'], ['6,-2', 'forest'], ['5,-1', 'forest'],
  ]);
  for (let q = -R; q <= R; q++) for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
    const kind = feats.get(`${q},${r}`) ?? (rnd() < 0.1 ? 'forest' : 'plain');
    const tile = kind === 'wall' ? B.build_tileWall(THREE, P) : kind === 'forest' ? B.build_tileForest(THREE, P) : kind === 'hill' ? B.build_tileHill(THREE, P) : B.build_tilePlain(THREE, P);
    const w = hexToWorld({ q, r });
    tile.position.set(w.x, 0, w.z);
    tile.traverse(o => { (o as THREE.Mesh).receiveShadow = true; (o as THREE.Mesh).castShadow = kind !== 'plain'; });
    staticBoard.add(tile);
    const extra = kind === 'temple' ? buildTemple(TEMPLE_COL, 5) : kind === 'farm' ? buildFarm(AGRAR_COL, 0) : null;
    if (extra) { extra.position.set(w.x, 0, w.z); extra.traverse(o => { (o as THREE.Mesh).castShadow = true; }); staticBoard.add(extra); }
  }

  // ── the cast (each menu entry flies to one of these groups) ──
  const DUEL_A: HexCoord = { q: 0, r: 3 }, DUEL_B: HexCoord = { q: 1, r: 3 };
  const CATAPULT: HexCoord = { q: -2, r: 2 };
  const PORTALS: HexCoord[] = [{ q: 3, r: 2 }, { q: 5, r: 1 }];
  const cast: [UnitType, number, FactionId, HexCoord, HexCoord | null][] = [
    ['archer', TEMPLE_COL, 'temple', { q: 1, r: -2 }, null], ['spearsman', TEMPLE_COL, 'temple', { q: 0, r: -1 }, null], ['horserider', TEMPLE_COL, 'temple', { q: 1, r: -1 }, null],
    ['spearsman', AGRAR_COL, 'agrar', { q: -3, r: 5 }, null], ['horserider', AGRAR_COL, 'agrar', { q: -1, r: 3 }, null], ['catapult', AGRAR_COL, 'agrar', CATAPULT, null], ['warrior', AGRAR_COL, 'agrar', { q: -4, r: 4 }, null],
    ['warrior', TEMPLE_COL, 'temple', DUEL_A, DUEL_B], ['warrior', AGRAR_COL, 'agrar', DUEL_B, DUEL_A],       // the duel
    ['warrior', THIRD_COL, 'temple', { q: 6, r: -1 }, null], ['archer', THIRD_COL, 'temple', { q: 5, r: 0 }, null],       // third camp
    ['warrior', FOURTH_COL, 'agrar', { q: -3, r: -4 }, null], ['spearsman', FOURTH_COL, 'agrar', { q: -2, r: -5 }, null], // fourth camp
    ['horserider', TEMPLE_COL, 'temple', { q: 4, r: 2 }, { q: 4, r: 3 }],                                                 // rider by the portals
  ];
  const bobbers: THREE.Object3D[] = [];
  for (const [type, color, fac, at, faceHex] of cast) {
    const u = buildUnitModel(type, color, fac);
    const w = hexToWorld(at);
    u.position.set(w.x, 0, w.z);
    const look = faceHex ? hexToWorld(faceHex) : { x: 0, z: 0 };
    u.rotation.y = Math.atan2(look.x - w.x, look.z - w.z) + (faceHex ? 0 : (rnd() - 0.5) * 0.6);
    u.traverse(o => { (o as THREE.Mesh).castShadow = true; });
    // Each voxel unit is dozens of small meshes; in the menu it only bobs as a
    // whole, so its parts are merged into a few meshes too.
    const baked = bakeStatic(u);
    baked.position.copy(u.position); baked.rotation.copy(u.rotation);
    u.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    map.add(baked); bobbers.push(baked);
  }
  for (const h of PORTALS) {
    const pm = buildPortal(TEMPLE_COL); const w = hexToWorld(h);
    pm.position.set(w.x, 0, w.z); pm.traverse(o => { (o as THREE.Mesh).castShadow = true; }); staticBoard.add(pm);
  }
  // Bake the static board (hundreds of meshes) into a few merged meshes.
  map.add(bakeStatic(staticBoard));
  staticBoard.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
  // fireflies
  const FF = 90;
  const ffBase = new Float32Array(FF * 3), ffSeed = new Float32Array(FF);
  for (let i = 0; i < FF; i++) { const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 11; ffBase[i * 3] = Math.cos(a) * rr; ffBase[i * 3 + 1] = 0.4 + rnd() * 2.2; ffBase[i * 3 + 2] = Math.sin(a) * rr; ffSeed[i] = rnd() * 100; }
  const ffGeo = new THREE.BufferGeometry(); ffGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ffBase), 3));
  const ffMat = new THREE.PointsMaterial({ color: 0xffe08a, size: 0.14, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  scene.add(new THREE.Points(ffGeo, ffMat));
  const table = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 0.4, 64), new THREE.MeshStandardMaterial({ color: 0x1a2a1c, roughness: 1 }));
  table.position.y = -TILE_H - 0.2; table.receiveShadow = true; scene.add(table);

  // ── places ──
  const dA = hexToWorld(DUEL_A), dB = hexToWorld(DUEL_B);
  const cat = hexToWorld(CATAPULT);
  const pA = hexToWorld(PORTALS[0]!), pB = hexToWorld(PORTALS[1]!);
  const PLACES: Record<MenuPlace, Place> = {
    home:    { target: [0, -1.2, 0.6], yaw: 0.35, dist: 24, elev: 0.82 },  // Polytopia-style: high, wide, drifting
    duel:    { target: [(dA.x + dB.x) / 2, 0.5, (dA.z + dB.z) / 2], yaw: Math.atan2(dB.x - dA.x, dB.z - dA.z) + Math.PI / 2 + 0.55, dist: 8.2, elev: 0.45 },
    machine: { target: [cat.x * 0.8, 0.5, cat.z * 0.8], yaw: Math.atan2(cat.x, cat.z), dist: 6.5, elev: 0.5 },
    camps:   { target: [0.5, 0, -0.5], yaw: 0.35, dist: 31, elev: 1.2 },
    portals: { target: [(pA.x + pB.x) / 2, 0.5, (pA.z + pB.z) / 2], yaw: Math.atan2(pB.x - pA.x, pB.z - pA.z) - Math.PI / 2, dist: 7.5, elev: 0.5 },
    temple:  { target: [0, 0.7, 0], yaw: -1.2, dist: 8, elev: 0.62 },
  };
  let from: Place = PLACES.home, to: Place = PLACES.home, t01 = 1, t0 = 0, focused = false;
  function sample(): Place {
    const e = t01 >= 1 ? 1 : (1 - Math.cos(t01 * Math.PI)) / 2;
    const L = (a: number, b: number) => a + (b - a) * e;
    return { target: [L(from.target[0], to.target[0]), L(from.target[1], to.target[1]), L(from.target[2], to.target[2])], yaw: L(from.yaw, to.yaw), dist: L(from.dist, to.dist), elev: L(from.elev, to.elev) };
  }
  function goTo(place: MenuPlace): void {
    from = sample(); to = PLACES[place]; t01 = 0; t0 = performance.now(); focused = place !== 'home';
    host.classList.toggle('focused', focused);
  }

  function resize(): void {
    const w = host.clientWidth || window.innerWidth, h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.fov = w < h ? 58 : 44;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize); resize();

  const day = { sky: new THREE.Color(0x1d3a2a), sun: new THREE.Color(0xffd9a0), hemi: new THREE.Color(0xffe6c0), sunI: 1.25, hemiI: 0.6, ff: 0 };
  const night = { sky: new THREE.Color(0x070d12), sun: new THREE.Color(0x8fa8ff), hemi: new THREE.Color(0x6a7cbf), sunI: 0.35, hemiI: 0.35, ff: 0.9 };
  const tmp = new THREE.Color();
  const start = performance.now();
  let raf = 0, alive = true, frameNo = 0, lastDraw = 0;
  const sky = new THREE.Color(); scene.background = sky;
  // Phones: 30 fps is plenty for a slow ambient backdrop and halves GPU/battery cost.
  const MIN_FRAME_MS = IS_TOUCH ? 1000 / 30 - 2 : 0;
  // Shadow refresh cadence (in drawn frames): the sun moves a few degrees a second.
  const SHADOW_EVERY = IS_TOUCH ? 6 : 2;
  function frame(now: number = performance.now()): void {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < MIN_FRAME_MS) return;
    lastDraw = now;
    frameNo++;
    renderer.shadowMap.needsUpdate = frameNo % SHADOW_EVERY === 1 || t01 < 1;
    const t = (performance.now() - start) / 1000;
    const cyc = (t % 48) / 48, k = (1 - Math.cos(cyc * Math.PI * 2)) / 2;
    tmp.copy(day.sky).lerp(night.sky, k); sky.copy(tmp); fog.color.copy(tmp);
    sun.color.copy(day.sun).lerp(night.sun, k); sun.intensity = day.sunI + (night.sunI - day.sunI) * k;
    hemi.color.copy(day.hemi).lerp(night.hemi, k); hemi.intensity = day.hemiI + (night.hemiI - day.hemiI) * k;
    const sa = cyc * Math.PI * 2; sun.position.set(Math.cos(sa) * 14, 11 + Math.sin(sa) * 6, Math.sin(sa) * 10);
    ffMat.opacity = day.ff + (night.ff - day.ff) * k;
    const pos = ffGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < FF; i++) { const s0 = ffSeed[i]!; pos.setXYZ(i, ffBase[i * 3]! + Math.sin(t * 0.5 + s0) * 0.6, ffBase[i * 3 + 1]! + Math.sin(t * 0.9 + s0 * 1.3) * 0.25, ffBase[i * 3 + 2]! + Math.cos(t * 0.4 + s0) * 0.6); }
    pos.needsUpdate = true;
    bobbers.forEach((u, i) => { u.position.y = Math.max(0, Math.sin(t * 2.2 + i) * 0.03); });
    if (t01 < 1) t01 = Math.min(1, (performance.now() - t0) / 1400);
    const pl = sample();
    const drift = focused ? Math.sin(t * 0.18) * 0.12 : t * 0.04; // home view slowly circles the world
    const yaw = pl.yaw + drift, elev = pl.elev + Math.sin(t * 0.13) * 0.03;
    const portrait = (host.clientWidth || window.innerWidth) < (host.clientHeight || window.innerHeight);
    const tx = pl.target[0], tz = pl.target[2];
    camera.position.set(tx + Math.sin(yaw) * Math.cos(elev) * pl.dist, pl.target[1] + Math.sin(elev) * pl.dist, tz + Math.cos(yaw) * Math.cos(elev) * pl.dist);
    const drop = portrait ? pl.dist * (focused ? 0.17 : 0.1) : 0; // portrait: subject sits between wordmark and sheet
    camera.lookAt(tx, pl.target[1] - drop, tz);
    renderer.render(scene, camera);
  }
  frame(performance.now());
  // Debug-only perf readout (draw calls / triangles of the last frame).
  (window as any).__menuPerf = () => ({ meshes: (() => { let n = 0; scene.traverse(o => { if ((o as THREE.Mesh).isMesh) n++; }); return n; })(), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, pixelRatio: renderer.getPixelRatio(), size: [renderer.domElement.width, renderer.domElement.height] });

  function dispose(): void {
    alive = false; cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    scene.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mt of mats) { const tex = (mt as THREE.MeshStandardMaterial).map; if (tex && !(tex as unknown as { userData?: { shared?: boolean } }).userData?.shared) tex.dispose(); (mt as THREE.Material).dispose(); }
    });
    renderer.dispose();
    renderer.forceContextLoss();
    host.classList.remove('focused');
  }
  return { goTo, resize, dispose };
}
