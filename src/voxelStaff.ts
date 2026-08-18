// Voxel staff models (primitives). Built in model units: the shaft runs along Y,
// the head/ornament sits near the top (+Y), and emissive flame/rune boxes glow.
// The demon staff (fiery, attack aura) is the damageBooster's side prop; the rune
// staff (runed defence staff) is the rangeBooster's side prop.
//
// Note: the original reference flickers the flames/runes per frame by collecting
// them into arrays; here they are built as static glowing meshes (the emissive
// materials still make them clearly glow) — no per-frame animation.
import * as THREE from 'three';

function mat(color: number, rough: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
}

function matGlow(color: number, emissive: number, ei: number, rough: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: ei, roughness: rough, metalness: 0 });
}

function block(
  w: number, h: number, d: number,
  material: THREE.Material,
  x: number, y: number, z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function buildDemonStaff(): THREE.Group {
  const g = new THREE.Group();
  const bone    = mat(0x6e3a25, 0.85);
  const boneDk  = mat(0x4f2a1a, 0.9);
  const skull   = mat(0x812f24, 0.7);
  const skullDk = mat(0x5c2018, 0.8);
  const horn    = mat(0x241914, 0.55);
  const tooth   = mat(0xcbbfa6, 0.6);
  const eyeMat  = matGlow(0xff6a2a, 0xff3300, 2.4, 0.4);

  g.add(block(0.95, 0.5, 0.95, boneDk, 0, -3.85, 0));
  const sY0 = -3.5, sH = 5.95, segs = 8, sh = sH / segs;
  for (let i = 0; i < segs; i++) {
    const yc = sY0 + sh * (i + 0.5);
    const w = 0.50 + i * 0.014;
    g.add(block(w, sh + 0.02, w, (i % 2 === 0) ? bone : boneDk, 0, yc, 0));
  }
  g.add(block(0.92, 0.34, 0.92, horn, 0, 2.55, 0));
  g.add(block(1.50, 1.25, 1.15, skull,   0,  3.70, 0));
  g.add(block(1.56, 0.30, 0.45, skullDk, 0,  4.05, 0.40));
  g.add(block(1.18, 0.55, 1.00, skullDk, 0,  2.95, 0));
  g.add(block(0.46, 0.55, 0.55, skull,   0,  3.30, 0.55));
  g.add(block(0.40, 0.38, 0.30, eyeMat, -0.42, 3.72, 0.62));
  g.add(block(0.40, 0.38, 0.30, eyeMat,  0.42, 3.72, 0.62));
  for (let i = -1; i <= 1; i++) g.add(block(0.16, 0.30, 0.16, tooth, i * 0.34, 2.64, 0.50));
  bigHorn(g,  1,  0.72, 4.25, -0.05, horn);
  bigHorn(g, -1,  0.72, 4.25, -0.05, horn);
  smallHorn(g,  1, 0.30, 4.40, -0.22, horn);
  smallHorn(g, -1, 0.30, 4.40, -0.22, horn);
  const fire: [number, number, number, number, number, number][] = [
    [ 0.00, 4.60,  0.00, 0.70, 0xff2d00, 1.7], [-0.30, 4.82,  0.06, 0.50, 0xff3d00, 1.8],
    [ 0.32, 4.86, -0.06, 0.48, 0xff4500, 1.8], [ 0.00, 5.10,  0.00, 0.60, 0xff5a00, 1.9],
    [-0.16, 5.50,  0.00, 0.50, 0xff7a00, 1.9], [ 0.25, 5.72,  0.00, 0.42, 0xff8c1a, 2.0],
    [ 0.00, 6.02,  0.00, 0.46, 0xffa12a, 2.0], [-0.30, 6.24,  0.00, 0.32, 0xffb23a, 2.1],
    [ 0.18, 6.62,  0.00, 0.34, 0xffc23d, 2.1], [-0.12, 7.02,  0.00, 0.30, 0xffcf52, 2.2],
    [ 0.24, 7.34,  0.00, 0.24, 0xffd863, 2.2], [ 0.00, 7.72,  0.00, 0.28, 0xffe07a, 2.3],
    [-0.18, 8.12,  0.00, 0.20, 0xffe98f, 2.3], [ 0.12, 8.50,  0.00, 0.18, 0xfff1a8, 2.4],
    [ 0.00, 8.86,  0.00, 0.14, 0xfff7c8, 2.6],
  ];
  fire.forEach(f => addFlame(g, f[0], f[1], f[2], f[3], f[4], f[5]));
  return g;

  function bigHorn(group: THREE.Group, side: number, bx: number, by: number, bz: number, m: THREE.Material): void {
    const pts: [number, number, number][] = [[0.00,0.00,0.42],[0.45,0.35,0.40],[0.85,0.70,0.36],[1.10,1.15,0.30],[1.20,1.65,0.24],[1.12,2.10,0.18],[0.95,2.45,0.12]];
    pts.forEach(p => group.add(block(p[2], p[2], p[2], m, bx + side * p[0], by + p[1], bz)));
  }
  function smallHorn(group: THREE.Group, side: number, bx: number, by: number, bz: number, m: THREE.Material): void {
    const pts: [number, number, number][] = [[0.00,0.00,0.30],[0.18,0.42,0.26],[0.30,0.82,0.20],[0.32,1.18,0.13]];
    pts.forEach(p => group.add(block(p[2], p[2], p[2], m, bx + side * p[0], by + p[1], bz)));
  }
  function addFlame(group: THREE.Group, x: number, y: number, z: number, s: number, color: number, ei: number): void {
    const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), matGlow(color, color, ei, 0.5));
    m.position.set(x, y, z); m.castShadow = false; m.receiveShadow = false; group.add(m);
  }
}

export function buildRuneStaff(): THREE.Group {
  const g = new THREE.Group();
  const stone   = mat(0x9aa0a6, 0.8);
  const stoneLt = mat(0xb4b9bf, 0.72);
  const stoneDk = mat(0x6f757b, 0.85);
  const runeHex = 0x4fe3ff;
  g.add(block(0.98, 0.6, 0.98, stoneDk, 0, -3.85, 0));
  g.add(block(0.80, 0.25, 0.80, stone,  0, -3.45, 0));
  const rY0 = -3.3, rH = 6.3, rsegs = 7, rsh = rH / rsegs;
  for (let i = 0; i < rsegs; i++) {
    const yc = rY0 + rsh * (i + 0.5);
    g.add(block(0.62, rsh + 0.02, 0.62, (i % 2 === 0) ? stone : stoneLt, 0, yc, 0));
  }
  g.add(block(0.70, 0.22, 0.70, stoneDk, 0, -1.2, 0));
  g.add(block(0.70, 0.22, 0.70, stoneDk, 0,  1.0, 0));
  const runeYs = [-2.5, -1.7, -0.4, 0.4, 1.7, 2.5];
  runeYs.forEach((ry) => { addRune(g, 0, ry, 0.33, 0.26, 0.26); addRune(g, 0, ry, -0.33, 0.22, 0.22); });
  g.add(block(0.86, 0.40, 0.86, stoneDk, 0, 3.25, 0));
  g.add(block(2.10, 0.46, 0.70, stone,   0, 3.72, 0));
  g.add(block(2.10, 0.20, 0.72, stoneLt, 0, 3.98, 0));
  g.add(block(0.50, 2.20, 0.50, stone,   0, 5.00, 0));
  g.add(block(0.34, 0.50, 0.50, stoneLt, 0, 6.25, 0));
  [-1, 1].forEach(side => {
    g.add(block(0.46, 0.46, 0.50, stone,   side * 0.80, 4.05, 0));
    g.add(block(0.42, 0.50, 0.50, stone,   side * 1.00, 4.50, 0));
    g.add(block(0.40, 1.55, 0.50, stone,   side * 1.06, 5.35, 0));
    g.add(block(0.30, 0.45, 0.50, stoneLt, side * 1.06, 6.18, 0));
  });
  addRune(g, 0, 3.72, 0.40, 0.55, 0.22);
  addRune(g, 0, 5.05, 0.28, 0.24, 0.95);
  return g;

  function addRune(group: THREE.Group, x: number, y: number, z: number, w: number, h: number): void {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.08), matGlow(runeHex, runeHex, 1.8, 0.4));
    m.position.set(x, y, z); m.castShadow = false; group.add(m);
  }
}

// The healer staff (gnarled living branch topped with a glowing green crystal,
// healing aura). The healer's side prop. As with the other staves, the crystals
// are static glowing meshes (no per-frame flicker).
export function buildHealerStaff(): THREE.Group {
  const g = new THREE.Group();
  const wood    = mat(0x7a4a28, 0.84);
  const woodLt  = mat(0x90592f, 0.80);
  const woodDk  = mat(0x5c3820, 0.86);
  const cut     = mat(0xba8a55, 0.70);
  const leafA   = mat(0x5fae3a, 0.68);
  const leafB   = mat(0x3f8f2a, 0.74);
  const vineMat = mat(0x4f9e3a, 0.72);
  const gemCore = matGlow(0xb6ff6e, 0x7dff33, 2.4, 0.32);
  const gemEdge = matGlow(0x86ec3e, 0x63d622, 1.9, 0.42);

  g.add(block(0.56, 0.45, 0.56, cut, 0, -3.88, 0));
  const sY0 = -3.6, sH = 9.4, segs = 12, sh = sH / segs;
  for (let i = 0; i < segs; i++) {
    const yc   = sY0 + sh * (i + 0.5);
    const w    = 0.56 - i * 0.022;
    const lean = 0.05 * Math.sin(i * 0.9);
    const pick = (i % 3 === 0) ? woodDk : (i % 3 === 1) ? wood : woodLt;
    g.add(block(w, sh + 0.04, w, pick, lean, yc, lean * 0.6));
  }
  g.add(block(0.30, 0.30, 0.30, woodLt,  0.30, -0.4,  0.10));
  g.add(block(0.26, 0.26, 0.26, woodDk, -0.28,  2.1, -0.08));
  twig(g,  0.55, -1.6,  0.0,  1, 0);
  twig(g, -0.20,  1.3,  0.4,  0, 1);
  twig(g,  0.18,  3.4, -0.3, -1, 0);
  const vN = 22;
  for (let k = 0; k < vN; k++) {
    const a = k * 0.78;
    const y = -3.0 + (k / vN) * 8.0;
    const r = 0.30;
    g.add(block(0.17, 0.17, 0.17, (k % 2 === 0) ? vineMat : leafB, r * Math.cos(a), y, r * Math.sin(a)));
  }
  leaf(g, -0.55, -2.2,  0.10, -1,  0);
  leaf(g,  0.55, -0.9,  0.00,  1,  0);
  leaf(g, -0.45,  0.6,  0.30, -1,  0);
  leaf(g,  0.20,  1.9, -0.45,  0, -1);
  leaf(g,  0.55,  2.8,  0.10,  1,  0);
  leaf(g, -0.30,  3.7,  0.35, -1,  0);
  leaf(g,  0.10,  4.6,  0.40,  0,  1);
  g.add(block(0.20, 0.85, 0.20, woodLt,  0.34, 6.05, 0));
  g.add(block(0.20, 0.85, 0.20, woodLt, -0.34, 6.05, 0));
  g.add(block(0.20, 0.75, 0.20, woodDk,  0.00, 6.00, 0.32));
  // ── crowning green crystal cluster — enlarged + brighter so the head reads as
  // the staff's prominent feature ──
  addGem(g,  0.00, 6.40, 0, 0.78, 0.62, 0.72, gemEdge);   // wide socket base
  addGem(g,  0.00, 7.10, 0, 1.02, 1.05, 0.90, gemCore);   // big main crystal
  addGem(g,  0.50, 7.20, 0, 0.40, 0.66, 0.46, gemEdge);   // side shard
  addGem(g, -0.50, 7.20, 0, 0.40, 0.66, 0.46, gemEdge);   // side shard
  addGem(g,  0.30, 7.60, 0.10, 0.34, 0.80, 0.34, gemCore);
  addGem(g, -0.30, 7.60, -0.10, 0.34, 0.80, 0.34, gemCore);
  addGem(g,  0.00, 7.95, 0, 0.78, 1.02, 0.68, gemCore);   // tall central spire
  addGem(g,  0.00, 8.70, 0, 0.46, 0.86, 0.46, gemCore);
  addGem(g,  0.00, 9.35, 0, 0.26, 0.62, 0.28, gemEdge);   // pointed tip
  // bright inner core
  addGem(g,  0.00, 7.80, 0, 0.50, 1.9, 0.44, matGlow(0xeaffd0, 0xb6ff6e, 3.2, 0.2));
  // soft green glow halo around the crystal
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(1.15, 14, 12),
    new THREE.MeshStandardMaterial({ color: 0x9dff5a, emissive: 0x6bdd2a, emissiveIntensity: 1.4, transparent: true, opacity: 0.2, roughness: 0.5, metalness: 0, depthWrite: false }),
  );
  halo.position.set(0, 7.7, 0);
  g.add(halo);
  return g;

  function twig(group: THREE.Group, x: number, y: number, z: number, dx: number, dz: number): void {
    const w = 0.16;
    group.add(block(w + (dx ? 0.28 : 0), w, w + (dz ? 0.28 : 0), woodDk, x + dx * 0.22, y, z + dz * 0.22));
    group.add(block(0.12, 0.12, 0.12, cut, x + dx * 0.40, y + 0.04, z + dz * 0.40));
  }
  function leaf(group: THREE.Group, x: number, y: number, z: number, dx: number, dz: number): void {
    const m = (Math.random() < 0.5) ? leafA : leafB;
    group.add(block(0.10, 0.10, 0.10, vineMat, x, y, z));
    group.add(block(0.30 + (dz ? 0 : 0.06), 0.13, 0.22 + (dx ? 0 : 0.06), m, x + dx * 0.24, y + 0.06, z + dz * 0.24));
    group.add(block(0.16, 0.10, 0.13, m, x + dx * 0.42, y + 0.12, z + dz * 0.42));
  }
  function addGem(group: THREE.Group, x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material): void {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y, z);
    m.castShadow = false; m.receiveShadow = false;
    group.add(m);
  }
}
