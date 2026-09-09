// FERTILE SITE PROPOSALS — the Agrar-vs-Agrar contested objective currently
// looks like a slightly bigger Farm. These are landmark alternatives that
// still read as "something the Farmer tribe would fight over", each with a
// neutral (grey trim) and a claimed (owner-tinted) look. Same contract as
// buildFertileSite(ownerColor | null): sits on y = 0 inside the hex tile.
// Previewed at /fertile-proposals.
import * as THREE from 'three';

const NEUTRAL = 0x8a8a8a;
const SOIL = 0x8a6b45, EARTH_DK = 0x5c4128, GRASS_DK = 0x557233, STONE = 0xc8c4ba, STONE_MID = 0xada9a0, STONE_DK = 0x807d74;
const WOOD = 0x8a6a42, WOOD_DK = 0x5a4028, BARK = 0x5e3f24, LEAF = 0x3f7a32, LEAF_LT = 0x6bb14a, LEAF_GOLD = 0xd6b24a;
const WATER = 0x3f8fbf, WATER_LT = 0x7fd0e8, STRAW = 0xe8c96a, FRUIT = 0xd9412f, FLOWER = [0xf2c94c, 0xe97cb0, 0xf5f0e0, 0xb58cff];

function mat(color: number, rough = 0.9): THREE.MeshStandardMaterial { return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 }); }
function glow(color: number, k = 0.8): THREE.MeshStandardMaterial { return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: k, roughness: 0.5, metalness: 0 }); }
function add(g: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rot?: { x?: number; y?: number; z?: number }): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z);
  if (rot) mesh.rotation.set(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0);
  mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh;
}
const box = (g: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, rot?: { x?: number; y?: number; z?: number }) => add(g, new THREE.BoxGeometry(w, h, d), m, x, y, z, rot);
const cyl = (g: THREE.Object3D, rt: number, rb: number, h: number, seg: number, m: THREE.Material, x: number, y: number, z: number, rot?: { x?: number; y?: number; z?: number }) => add(g, new THREE.CylinderGeometry(rt, rb, h, seg), m, x, y, z, rot);
const cone = (g: THREE.Object3D, r: number, h: number, seg: number, m: THREE.Material, x: number, y: number, z: number, rot?: { x?: number; y?: number; z?: number }) => add(g, new THREE.ConeGeometry(r, h, seg), m, x, y, z, rot);
const sph = (g: THREE.Object3D, r: number, m: THREE.Material, x: number, y: number, z: number) => add(g, new THREE.SphereGeometry(r, 9, 7), m, x, y, z);
function plate(g: THREE.Object3D, r: number, h: number, m: THREE.Material, y = 0): THREE.Mesh { return cyl(g, r, r * 1.03, h, 6, m, 0, y + h / 2, 0, { y: Math.PI / 6 }); }
function flowers(g: THREE.Object3D, n: number, rMin: number, rMax: number, seed = 3): void {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  for (let i = 0; i < n; i++) { const a = rnd() * Math.PI * 2, r = rMin + rnd() * (rMax - rMin); cyl(g, 0.012, 0.012, 0.08, 4, mat(LEAF), Math.cos(a) * r, 0.1, Math.sin(a) * r); sph(g, 0.035, mat(FLOWER[i % 4]!, 0.8), Math.cos(a) * r, 0.15, Math.sin(a) * r); }
}
function ribbon(g: THREE.Object3D, x: number, y: number, z: number, len: number, m: THREE.Material, ry = 0): void { box(g, 0.05, len, 0.015, m, x, y - len / 2, z, { y: ry, z: 0.15 }); }
function post(g: THREE.Object3D, x: number, z: number, h: number, m: THREE.Material): void { cyl(g, 0.03, 0.035, h, 6, mat(WOOD_DK), x, h / 2, z); box(g, 0.02, 0.2, 0.3, m, x, h - 0.12, z + 0.15); }
function trimMat(owner: number | null): THREE.MeshStandardMaterial { return new THREE.MeshStandardMaterial({ color: owner ?? NEUTRAL, roughness: 0.6, metalness: 0.1 }); }
function ring(g: THREE.Object3D, r: number, n: number, h: number, m: THREE.Material, w = 0.14): void { for (let i = 0; i < n; i++) { const a = i * Math.PI * 2 / n; box(g, w, h, w * 0.7, m, Math.cos(a) * r, h / 2, Math.sin(a) * r, { y: -a }); } }

export interface FertileOption { id: string; name: string; blurb: string; build: (owner: number | null) => THREE.Group; }

// A · Sacred Oak — an ancient oak on a grass mound, owner ribbons on the boughs.
const sacredOak = (owner: number | null): THREE.Group => {
  const g = new THREE.Group(); const t = trimMat(owner);
  plate(g, 0.9, 0.06, mat(GRASS_DK)); plate(g, 0.55, 0.12, mat(SOIL), 0.06);
  cyl(g, 0.16, 0.24, 0.8, 8, mat(BARK), 0, 0.58, 0);
  for (const [dx, dz, ry] of [[0.28, 0.1, 0.4], [-0.25, -0.15, -0.5], [0.05, -0.3, 0.9]]) cyl(g, 0.05, 0.08, 0.6, 6, mat(BARK), dx as number * 0.7, 0.95, dz as number * 0.7, { z: (dx as number) * -1.2, x: (dz as number) * 1.2, y: ry as number });
  sph(g, 0.55, mat(LEAF), 0, 1.35, 0); sph(g, 0.38, mat(LEAF_LT), 0.35, 1.5, 0.15); sph(g, 0.34, mat(LEAF_LT), -0.32, 1.45, -0.2); sph(g, 0.3, mat(LEAF), 0.05, 1.7, -0.3);
  for (const [x, z] of [[0.45, 0.35], [-0.5, 0.2], [0.1, -0.55], [-0.2, 0.5]]) ribbon(g, x as number, 1.15, z as number, 0.45, t, (x as number) * 2);
  ring(g, 0.62, 8, 0.12, mat(STONE_MID), 0.12);
  cyl(g, 0.1, 0.12, 0.14, 6, mat(STONE), 0.42, 0.25, -0.1); sph(g, 0.05, mat(FRUIT, 0.7), 0.42, 0.36, -0.1); // offering stone
  flowers(g, 10, 0.66, 0.84, 5);
  return g;
};

// B · Spring Well — a stone well house over a pond with reeds; the water glows for the owner.
const springWell = (owner: number | null): THREE.Group => {
  const g = new THREE.Group(); const t = trimMat(owner);
  plate(g, 0.9, 0.06, mat(GRASS_DK));
  cyl(g, 0.5, 0.52, 0.05, 12, glow(owner ? WATER_LT : WATER, owner ? 0.6 : 0.15), 0.15, 0.085, 0.2);
  cyl(g, 0.56, 0.58, 0.04, 12, mat(STONE_MID), 0.15, 0.075, 0.2);
  cyl(g, 0.24, 0.26, 0.28, 10, mat(STONE), -0.3, 0.2, -0.3); cyl(g, 0.26, 0.26, 0.05, 10, mat(STONE_DK), -0.3, 0.36, -0.3);
  for (const s of [-1, 1]) cyl(g, 0.025, 0.025, 0.55, 5, mat(WOOD_DK), -0.3 + s * 0.24, 0.6, -0.3);
  box(g, 0.6, 0.04, 0.5, mat(WOOD), -0.3, 0.88, -0.3); cone(g, 0.42, 0.22, 4, t, -0.3, 1.0, -0.3, { y: Math.PI / 4 });
  cyl(g, 0.02, 0.02, 0.5, 5, mat(WOOD_DK), -0.3, 0.6, -0.3, { z: Math.PI / 2 }); cyl(g, 0.05, 0.05, 0.08, 8, mat(WOOD), -0.3, 0.45, -0.3);
  for (let i = 0; i < 9; i++) { const a = i * 0.7; cyl(g, 0.012, 0.012, 0.3 + (i % 3) * 0.08, 4, mat(LEAF_LT), 0.15 + Math.cos(a) * 0.5, 0.22, 0.2 + Math.sin(a) * 0.5); }
  post(g, 0.7, -0.4, 0.7, t);
  return g;
};

// C · Harvest Stones — a standing-stone ring with an altar and a wheat wreath.
const harvestStones = (owner: number | null): THREE.Group => {
  const g = new THREE.Group(); const t = trimMat(owner);
  plate(g, 0.9, 0.06, mat(GRASS_DK)); plate(g, 0.6, 0.05, mat(STONE_DK), 0.06);
  for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + 0.3; const h = 0.55 + (i % 2) * 0.2; box(g, 0.22, h, 0.14, mat(i % 3 ? STONE_MID : STONE), Math.cos(a) * 0.62, h / 2 + 0.06, Math.sin(a) * 0.62, { y: -a, z: (i % 2 ? 0.06 : -0.04) }); box(g, 0.24, 0.1, 0.16, t, Math.cos(a) * 0.62, h + 0.06, Math.sin(a) * 0.62, { y: -a }); }
  box(g, 0.44, 0.22, 0.3, mat(STONE), 0, 0.22, 0); box(g, 0.5, 0.05, 0.36, mat(STONE_DK), 0, 0.355, 0);
  for (let i = 0; i < 10; i++) { const a = i * Math.PI * 2 / 10; box(g, 0.06, 0.05, 0.12, mat(LEAF_GOLD, 0.85), Math.cos(a) * 0.16, 0.42, Math.sin(a) * 0.16, { y: -a }); }
  sph(g, 0.06, glow(owner ?? 0xffffff, owner ? 1.2 : 0.2), 0, 0.5, 0);
  flowers(g, 8, 0.72, 0.85, 7);
  return g;
};

// D · Apiary Meadow — straw hives on stands in a wildflower meadow, owner bands.
const apiary = (owner: number | null): THREE.Group => {
  const g = new THREE.Group(); const t = trimMat(owner);
  plate(g, 0.9, 0.06, mat(GRASS_DK));
  const hives: [number, number][] = [[-0.35, -0.25], [0.15, -0.4], [0.45, 0.15], [-0.15, 0.35]];
  hives.forEach(([x, z], i) => {
    box(g, 0.34, 0.06, 0.34, mat(WOOD), x, 0.09 + 0.03, z); for (const [dx, dz] of [[-0.12, -0.12], [0.12, -0.12], [-0.12, 0.12], [0.12, 0.12]]) cyl(g, 0.02, 0.02, 0.1, 4, mat(WOOD_DK), x + dx, 0.07, z + dz);
    for (let k = 0; k < 4; k++) cyl(g, 0.15 - k * 0.025, 0.16 - k * 0.025, 0.09, 10, mat(STRAW, 0.95), x, 0.17 + k * 0.085, z);
    cyl(g, 0.155, 0.155, 0.035, 10, t, x, 0.21, z);
    box(g, 0.06, 0.04, 0.02, mat(WOOD_DK), x, 0.16, z + 0.16);
    for (let b = 0; b < 3; b++) sph(g, 0.014, mat(0xf2c94c, 0.6), x + Math.cos(i + b * 2) * 0.24, 0.42 + b * 0.05, z + Math.sin(i + b * 2) * 0.24);
  });
  post(g, 0.7, -0.45, 0.62, t);
  flowers(g, 22, 0.25, 0.86, 11);
  return g;
};

// E · Watermill — a mill house on a stream with a turning wheel, owner roof.
const watermill = (owner: number | null): THREE.Group => {
  const g = new THREE.Group(); const t = trimMat(owner);
  plate(g, 0.9, 0.06, mat(GRASS_DK));
  box(g, 1.9, 0.03, 0.42, glow(WATER, 0.1), 0, 0.075, 0.42, { y: 0.35 }); box(g, 1.9, 0.02, 0.5, mat(EARTH_DK), 0, 0.065, 0.42, { y: 0.35 });
  box(g, 0.6, 0.42, 0.5, mat(STONE_MID), -0.15, 0.06 + 0.21, -0.1); box(g, 0.62, 0.3, 0.52, mat(0xe2d8bd, 0.9), -0.15, 0.06 + 0.42 + 0.15, -0.1);
  for (const dx of [-0.28, 0, 0.28]) box(g, 0.03, 0.3, 0.54, mat(WOOD_DK), -0.15 + dx, 0.63, -0.1);
  const roof = new THREE.Group(); box(roof, 0.7, 0.05, 0.36, t, 0, 0.14, 0.14, { x: 0.6 }); box(roof, 0.7, 0.05, 0.36, t, 0, 0.14, -0.14, { x: -0.6 }); box(roof, 0.72, 0.05, 0.06, t, 0, 0.27, 0); roof.position.set(-0.15, 0.78, -0.1); g.add(roof);
  cyl(g, 0.3, 0.3, 0.08, 12, mat(WOOD), 0.35, 0.3, 0.2, { x: Math.PI / 2 }); for (let i = 0; i < 8; i++) box(g, 0.1, 0.62, 0.06, mat(WOOD_DK), 0.35, 0.3, 0.2, { z: i * Math.PI / 8 });
  box(g, 0.08, 0.08, 0.3, mat(WOOD_DK), 0.35, 0.3, 0.05);
  box(g, 0.1, 0.16, 0.02, mat(WOOD_DK), -0.15, 0.2, 0.16);
  for (const [x, z] of [[-0.6, 0.55], [0.75, -0.4]]) { cyl(g, 0.03, 0.04, 0.2, 6, mat(BARK), x as number, 0.16, z as number); sph(g, 0.15, mat(LEAF), x as number, 0.36, z as number); }
  return g;
};

// F · Market Crossroads — a signpost where roads meet, stalls with owner awnings, a cart and barrels.
const market = (owner: number | null): THREE.Group => {
  const g = new THREE.Group(); const t = trimMat(owner);
  plate(g, 0.9, 0.06, mat(GRASS_DK));
  box(g, 1.7, 0.02, 0.3, mat(SOIL), 0, 0.07, 0); box(g, 0.3, 0.02, 1.7, mat(SOIL), 0, 0.07, 0);
  cyl(g, 0.03, 0.035, 0.9, 6, mat(WOOD_DK), 0.02, 0.45, 0.02); for (const [ry, y] of [[0.5, 0.75], [-1.2, 0.62], [2.4, 0.5]]) box(g, 0.34, 0.08, 0.03, mat(WOOD), 0.02, y as number, 0.02, { y: ry as number });
  for (const [x, z, ry] of [[-0.5, -0.45, 0.3], [0.5, -0.45, -0.3]]) {
    const st = new THREE.Group();
    box(st, 0.5, 0.2, 0.3, mat(WOOD), 0, 0.16, 0); for (const s of [-1, 1]) cyl(st, 0.015, 0.015, 0.5, 4, mat(WOOD_DK), s * 0.22, 0.3, -0.12);
    box(st, 0.56, 0.03, 0.4, t, 0, 0.56, 0, { x: 0.25 }); for (let k = 0; k < 4; k++) sph(st, 0.04, mat(k % 2 ? FRUIT : LEAF_GOLD, 0.8), -0.15 + k * 0.1, 0.3, 0.05);
    st.position.set(x as number, 0.06, z as number); st.rotation.y = ry as number; g.add(st);
  }
  const c = new THREE.Group(); box(c, 0.3, 0.12, 0.18, mat(WOOD), 0, 0.16, 0); for (const s of [-1, 1]) cyl(c, 0.07, 0.07, 0.02, 10, mat(WOOD_DK), 0.05, 0.07, s * 0.1, { x: Math.PI / 2 }); box(c, 0.2, 0.02, 0.02, mat(WOOD_DK), -0.22, 0.14, 0); for (let k = 0; k < 3; k++) cone(c, 0.05, 0.08, 6, mat(STRAW), -0.06 + k * 0.07, 0.26, 0); c.position.set(0.45, 0.06, 0.45); c.rotation.y = 0.8; g.add(c);
  for (const [x, z] of [[-0.55, 0.4], [-0.42, 0.55]]) cyl(g, 0.07, 0.07, 0.14, 8, mat(WOOD_DK), x as number, 0.13, z as number);
  return g;
};

// G · Orchard Grove — fruit trees in rows, a ladder and baskets, owner flag.
const orchard = (owner: number | null): THREE.Group => {
  const g = new THREE.Group(); const t = trimMat(owner);
  plate(g, 0.9, 0.06, mat(GRASS_DK));
  const spots: [number, number][] = [[-0.45, -0.35], [0.1, -0.45], [0.5, -0.1], [-0.5, 0.25], [0.05, 0.15], [0.4, 0.45], [-0.2, 0.55]];
  spots.forEach(([x, z], i) => {
    cyl(g, 0.035, 0.05, 0.28, 6, mat(BARK), x, 0.2, z); sph(g, 0.2, mat(i % 2 ? LEAF : LEAF_LT), x, 0.44, z);
    for (let k = 0; k < 4; k++) sph(g, 0.03, mat(FRUIT, 0.7), x + Math.cos(k * 1.7 + i) * 0.16, 0.42 + Math.sin(k * 2.1) * 0.1, z + Math.sin(k * 1.7 + i) * 0.16);
  });
  for (const s of [-1, 1]) box(g, 0.02, 0.5, 0.02, mat(WOOD_DK), 0.12 + s * 0.05, 0.3, 0.32, { x: -0.5 }); for (let k = 0; k < 4; k++) box(g, 0.14, 0.015, 0.02, mat(WOOD), 0.12, 0.12 + k * 0.1, 0.4 - k * 0.055);
  for (const [x, z] of [[0.55, 0.25], [0.65, 0.05]]) { cyl(g, 0.06, 0.05, 0.08, 8, mat(WOOD), x as number, 0.1, z as number); sph(g, 0.035, mat(FRUIT, 0.7), x as number, 0.15, z as number); }
  post(g, -0.72, -0.1, 0.75, t);
  return g;
};

// H · Salt Spring — turquoise mineral pool with pale terraces and steam, owner marker stones.
const saltSpring = (owner: number | null): THREE.Group => {
  const g = new THREE.Group(); const t = trimMat(owner);
  plate(g, 0.9, 0.06, mat(GRASS_DK));
  cyl(g, 0.66, 0.7, 0.06, 12, mat(0xe8e2d2, 0.8), 0, 0.09, 0); cyl(g, 0.52, 0.56, 0.06, 12, mat(0xd6cdb6, 0.8), 0, 0.15, 0);
  cyl(g, 0.4, 0.4, 0.04, 12, glow(0x5fd8d0, owner ? 0.9 : 0.35), 0, 0.2, 0);
  for (let i = 0; i < 4; i++) sph(g, 0.05 + i * 0.015, new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 - i * 0.06, roughness: 1 }), Math.cos(i * 2) * 0.15, 0.32 + i * 0.13, Math.sin(i * 2) * 0.15);
  for (let i = 0; i < 5; i++) { const a = i * 1.26 + 0.4; box(g, 0.14, 0.22 + (i % 2) * 0.1, 0.12, mat(STONE_MID), Math.cos(a) * 0.78, 0.17, Math.sin(a) * 0.78, { y: -a }); box(g, 0.15, 0.05, 0.13, t, Math.cos(a) * 0.78, 0.31 + (i % 2) * 0.1, Math.sin(a) * 0.78, { y: -a }); }
  for (let i = 0; i < 5; i++) cyl(g, 0.012, 0.012, 0.25, 4, mat(LEAF_LT), 0.6 + (i % 2) * 0.1, 0.18, -0.45 + i * 0.1);
  return g;
};

export const FERTILE_OPTIONS: FertileOption[] = [
  { id: 'oak', name: 'A · Sacred Oak', blurb: 'An ancient oak on a mound inside a stone ring; the owner ties ribbons in its boughs.', build: sacredOak },
  { id: 'well', name: 'B · Spring Well', blurb: 'A stone well house beside a spring pond with reeds; the water glows in the owner\'s hands.', build: springWell },
  { id: 'stones', name: 'C · Harvest Stones', blurb: 'A standing-stone ring with an altar and a wheat wreath; capstones take the owner colour.', build: harvestStones },
  { id: 'apiary', name: 'D · Apiary Meadow', blurb: 'Straw beehives on stands in a wildflower meadow, hive bands in the owner colour.', build: apiary },
  { id: 'mill', name: 'E · Watermill', blurb: 'A mill house on a stream with a big wheel; the roof takes the owner colour.', build: watermill },
  { id: 'market', name: 'F · Market Crossroads', blurb: 'Where the roads meet: a signpost, two stalls with owner awnings, a hay cart and barrels.', build: market },
  { id: 'orchard', name: 'G · Orchard Grove', blurb: 'Rows of fruit trees, a ladder and baskets, an owner flag at the edge.', build: orchard },
  { id: 'salt', name: 'H · Salt Spring', blurb: 'A turquoise mineral pool with pale terraces and steam; owner marker stones around it.', build: saltSpring },
];
