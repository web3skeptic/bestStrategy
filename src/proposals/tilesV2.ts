// PROPOSAL 2 — tile set v2. Today every tile is a flat hex prism with random
// flowers; forests are three identical cones; hills a single mound; mountains
// one big cone. v2 keeps the same footprint/height conventions (top at y = 0,
// prism thickness TILE_H) but gives every tile a bevelled rim, two grass tones,
// mixed tree species, terraced hills and jagged multi-spire mountains so the
// map reads at a glance from the default camera height.
import * as THREE from 'three';
import { Palette, TILE_H, HEX_R } from '../three/palette';

function hexPrism(P: Palette, r: number, h: number, color: number, y: number, rough = 0.95): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 6), P.mat(color, rough));
  m.rotation.y = Math.PI / 6;
  m.position.y = y;
  m.receiveShadow = true;
  m.castShadow = true;
  return m;
}
// Bevelled base: full prism in a darker tone + a slightly smaller, lighter cap.
function base(P: Palette, grassDk: number, grassLt: number): THREE.Group {
  const g = new THREE.Group();
  g.add(hexPrism(P, HEX_R, TILE_H, grassDk, -TILE_H / 2));
  g.add(hexPrism(P, HEX_R * 0.92, 0.06, grassLt, 0.0));
  return g;
}
function spot(min: number, max: number): { x: number; z: number } {
  const a = Math.random() * Math.PI * 2, r = min + Math.random() * (max - min);
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

const GRASS_A: [number, number] = [0x2c4a24, 0x3a6a2c];
const GRASS_B: [number, number] = [0x2f5027, 0x427a33];

export function buildPlainV2(P: Palette): THREE.Group {
  const tone = Math.random() < 0.5 ? GRASS_A : GRASS_B;
  const g = base(P, tone[0], tone[1]);
  // a couple of pebbles + one grass tuft — calmer than today's flower field
  const pebble = new THREE.DodecahedronGeometry(0.05, 0);
  for (let i = 0; i < 2; i++) {
    const s = spot(0.15, 0.6);
    const m = new THREE.Mesh(pebble, P.mat(0x7c7f86, 0.95));
    m.position.set(s.x, 0.05, s.z); m.scale.y = 0.6; m.castShadow = true;
    g.add(m);
  }
  const s = spot(0.15, 0.55);
  const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 4), P.mat(0x4c8a3a, 0.9));
  tuft.position.set(s.x, 0.1, s.z); tuft.castShadow = true;
  g.add(tuft);
  return g;
}

function conifer(P: Palette, s: number): THREE.Group {
  const t = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.22, 5), P.mat(P.colors.wood, 0.95));
  trunk.position.y = 0.11; trunk.castShadow = true; t.add(trunk);
  const c1 = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.34, 6), P.mat(0x1f4a24, 0.85));
  c1.position.y = 0.36; c1.castShadow = true; t.add(c1);
  const c2 = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.3, 6), P.mat(0x2a6030, 0.85));
  c2.position.y = 0.58; c2.castShadow = true; t.add(c2);
  t.scale.setScalar(s);
  return t;
}
function broadleaf(P: Palette, s: number): THREE.Group {
  const t = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.3, 5), P.mat(0x5a3a1c, 0.95));
  trunk.position.y = 0.15; trunk.castShadow = true; t.add(trunk);
  const crown = new THREE.Mesh(new THREE.DodecahedronGeometry(0.24, 0), P.mat(0x3f7a2e, 0.85));
  crown.position.y = 0.46; crown.castShadow = true; t.add(crown);
  t.scale.setScalar(s);
  return t;
}

export function buildForestV2(P: Palette): THREE.Group {
  const g = base(P, 0x24421f, 0x2f5a28);
  const base0 = Math.random() * Math.PI * 2;
  // five trees on a jittered pentagon: 3 conifers + 2 broadleaf, plus bushes
  for (let i = 0; i < 5; i++) {
    const a = base0 + i * (Math.PI * 2 / 5) + (Math.random() - 0.5) * 0.5;
    const r = 0.22 + Math.random() * 0.3;
    const s = 0.75 + Math.random() * 0.45;
    const tree = i % 2 === 0 ? conifer(P, s) : broadleaf(P, s * 0.9);
    tree.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    tree.rotation.y = Math.random() * Math.PI * 2;
    g.add(tree);
  }
  for (let i = 0; i < 3; i++) {
    const s = spot(0.35, 0.7);
    const bush = new THREE.Mesh(new THREE.DodecahedronGeometry(0.09, 0), P.mat(0x2f6a2a, 0.9));
    bush.position.set(s.x, 0.06, s.z); bush.castShadow = true;
    g.add(bush);
  }
  return g;
}

export function buildHillV2(P: Palette): THREE.Group {
  const g = base(P, 0x2c4a24, 0x3a6a2c);
  // two terraces, offset slightly so it isn't a perfect bullseye
  const t1 = hexPrism(P, 0.72, 0.22, 0x33582a, 0.11);
  t1.position.x = 0.05; g.add(t1);
  const t2 = hexPrism(P, 0.42, 0.22, 0x3d6a31, 0.33);
  t2.position.set(0.12, 0.33, -0.06); g.add(t2);
  // rock outcrops on the terraces
  const rock = new THREE.DodecahedronGeometry(0.11, 0);
  const places: [number, number, number][] = [[-0.45, 0.22, 0.25], [0.15, 0.44, 0.1], [0.4, 0.22, -0.35]];
  for (const [x, y, z] of places) {
    const m = new THREE.Mesh(rock, P.mat(0x777a84, 0.95));
    m.position.set(x, y + 0.05, z); m.rotation.set(Math.random(), Math.random(), 0); m.castShadow = true;
    g.add(m);
  }
  return g;
}

export function buildWallV2(P: Palette): THREE.Group {
  const g = base(P, 0x4a4c55, 0x5c5f69);
  // three jagged spires of different heights with snow caps
  const spires: [number, number, number, number][] = [[0, 0, 0.42, 1.35], [-0.42, 0.28, 0.3, 0.85], [0.38, -0.3, 0.26, 0.7]];
  for (const [x, z, r, h] of spires) {
    const s = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5), P.mat(0x6a6c76, 0.95));
    s.position.set(x, h / 2, z); s.rotation.y = Math.random() * Math.PI; s.castShadow = true; s.receiveShadow = true;
    g.add(s);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.42, h * 0.32, 5), P.mat(0xe8ecf2, 0.9));
    cap.position.set(x, h - h * 0.16 - 0.005, z); cap.rotation.y = s.rotation.y; cap.castShadow = true;
    g.add(cap);
  }
  for (let i = 0; i < 4; i++) {
    const s = spot(0.5, 0.78);
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.09, 0), P.mat(0x5a5c66, 0.95));
    m.position.set(s.x, 0.05, s.z); m.castShadow = true;
    g.add(m);
  }
  return g;
}
