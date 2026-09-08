// PROPOSAL 3 — structure set v2. Today ONE ziggurat model (buildTemple) with
// 10 growth levels is stretched over four unrelated game states: tier 1 for a
// neutral/ruined site, tier 2 for founding, tier 5 for a finished Temple, and
// tier 10 for the Capital — so "ruins" look like a small healthy temple and a
// Capital is just a bigger temple. The game only has Temple I, Temple II,
// Ruins and the Capital; v2 gives each its own silhouette:
//   • Ruins       — broken plinth, snapped pillars, rubble, no colour
//   • Temple I    — open shrine: six pillars under a team-coloured roof
//   • Temple II   — the shrine raised on a second storey, gold finial, banners
//   • Capital     — a walled keep with corner towers and a flagged donjon
import * as THREE from 'three';

const STONE = 0xc8c4ba, STONE_MID = 0xada9a0, STONE_DK = 0x807d74, GOLD = 0xe0b020, MOSS = 0x4a6a3a;

function mat(color: number, rough = 0.85): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
}
function glow(color: number, k = 1.2): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: k, roughness: 0.4, metalness: 0 });
}
function add(g: THREE.Group, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, ry = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  mesh.castShadow = true; mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}
function plinth(g: THREE.Group, r: number, h: number, y: number, color = STONE_MID): THREE.Mesh {
  return add(g, new THREE.CylinderGeometry(r, r * 1.04, h, 6), mat(color), 0, y + h / 2, 0, Math.PI / 6);
}
function pillarRing(g: THREE.Group, r: number, h: number, y: number, n = 6, pr = 0.06): void {
  for (let i = 0; i < n; i++) {
    const a = i * Math.PI * 2 / n;
    add(g, new THREE.CylinderGeometry(pr, pr * 1.15, h, 8), mat(STONE), Math.cos(a) * r, y + h / 2, Math.sin(a) * r);
    add(g, new THREE.BoxGeometry(pr * 3, pr * 1.2, pr * 3), mat(STONE_DK), Math.cos(a) * r, y + h + pr * 0.6, Math.sin(a) * r);
  }
}
function roof(g: THREE.Group, r: number, h: number, y: number, teamColor: number): void {
  add(g, new THREE.CylinderGeometry(r * 1.05, r * 1.05, 0.07, 6), mat(STONE_DK), 0, y + 0.035, 0, Math.PI / 6);
  add(g, new THREE.ConeGeometry(r, h, 6), mat(teamColor, 0.7), 0, y + 0.07 + h / 2, 0, Math.PI / 6);
}

export function buildRuinsV2(): THREE.Group {
  const g = new THREE.Group();
  const half = add(g, new THREE.CylinderGeometry(0.72, 0.75, 0.12, 6), mat(STONE_DK), 0, 0.06, 0, Math.PI / 6);
  half.scale.x = 0.9;
  add(g, new THREE.BoxGeometry(0.5, 0.1, 0.3), mat(STONE_MID), 0.35, 0.05, 0.3, 0.4);
  // snapped pillars of uneven height, one toppled
  const heights = [0.55, 0.3, 0.18, 0.42];
  heights.forEach((h, i) => {
    const a = i * Math.PI / 2 + 0.4;
    add(g, new THREE.CylinderGeometry(0.06, 0.07, h, 8), mat(STONE), Math.cos(a) * 0.45, 0.12 + h / 2, Math.sin(a) * 0.45);
  });
  const fallen = add(g, new THREE.CylinderGeometry(0.06, 0.06, 0.5, 8), mat(STONE_MID), -0.1, 0.18, 0.15);
  fallen.rotation.z = Math.PI / 2; fallen.rotation.y = 0.5;
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2, r = 0.2 + Math.random() * 0.5;
    add(g, new THREE.DodecahedronGeometry(0.07, 0), mat(i % 3 === 0 ? MOSS : STONE_DK), Math.cos(a) * r, 0.15, Math.sin(a) * r, Math.random());
  }
  return g;
}

export function buildTempleIV2(teamColor: number): THREE.Group {
  const g = new THREE.Group();
  plinth(g, 0.78, 0.12, 0);
  plinth(g, 0.66, 0.08, 0.12, STONE);
  pillarRing(g, 0.5, 0.55, 0.2);
  add(g, new THREE.CylinderGeometry(0.16, 0.2, 0.22, 6), mat(STONE_DK), 0, 0.31, 0, Math.PI / 6); // altar
  add(g, new THREE.SphereGeometry(0.09, 12, 8), glow(teamColor), 0, 0.52, 0);
  roof(g, 0.72, 0.36, 0.78, teamColor);
  add(g, new THREE.SphereGeometry(0.05, 10, 6), mat(GOLD, 0.35), 0, 1.24, 0);
  return g;
}

export function buildTempleIIV2(teamColor: number): THREE.Group {
  const g = new THREE.Group();
  plinth(g, 0.86, 0.14, 0);
  plinth(g, 0.74, 0.1, 0.14, STONE);
  // ground storey: solid walls with glowing niches
  add(g, new THREE.CylinderGeometry(0.52, 0.56, 0.5, 6), mat(STONE_MID), 0, 0.49, 0, Math.PI / 6);
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3 + Math.PI / 6;
    add(g, new THREE.BoxGeometry(0.12, 0.2, 0.04), glow(teamColor, 1.4), Math.cos(a) * 0.55, 0.5, Math.sin(a) * 0.55, -a + Math.PI / 2);
  }
  plinth(g, 0.62, 0.08, 0.74, STONE);
  pillarRing(g, 0.42, 0.45, 0.82, 6, 0.05);
  add(g, new THREE.SphereGeometry(0.1, 12, 8), glow(teamColor), 0, 1.05, 0);
  roof(g, 0.6, 0.34, 1.3, teamColor);
  add(g, new THREE.CylinderGeometry(0.02, 0.02, 0.18, 6), mat(GOLD, 0.35), 0, 1.78, 0);
  add(g, new THREE.SphereGeometry(0.06, 10, 6), mat(GOLD, 0.35), 0, 1.9, 0);
  // two banners on the plinth corners
  for (const sx of [-1, 1]) {
    add(g, new THREE.CylinderGeometry(0.015, 0.015, 0.7, 6), mat(0x4a3a2a), sx * 0.7, 0.55, 0.35);
    add(g, new THREE.BoxGeometry(0.02, 0.32, 0.18), mat(teamColor, 0.7), sx * 0.7, 0.72, 0.45);
  }
  return g;
}

export function buildCapitalV2(teamColor: number): THREE.Group {
  const g = new THREE.Group();
  plinth(g, 0.9, 0.12, 0, STONE_DK);
  // curtain wall (square keep footprint) with crenellations
  add(g, new THREE.BoxGeometry(1.15, 0.5, 1.15), mat(STONE_MID), 0, 0.37, 0);
  for (let i = 0; i < 4; i++) {
    for (let k = -1; k <= 1; k++) {
      const along = k * 0.36;
      const [x, z] = i === 0 ? [along, 0.58] : i === 1 ? [along, -0.58] : i === 2 ? [0.58, along] : [-0.58, along];
      add(g, new THREE.BoxGeometry(0.16, 0.12, 0.16), mat(STONE), x, 0.68, z);
    }
  }
  // gate
  add(g, new THREE.BoxGeometry(0.28, 0.32, 0.06), mat(0x2a2320), 0, 0.28, 0.6);
  // corner towers with team roofs
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
    add(g, new THREE.CylinderGeometry(0.16, 0.18, 0.9, 8), mat(STONE), sx * 0.55, 0.57, sz * 0.55);
    add(g, new THREE.ConeGeometry(0.2, 0.26, 8), mat(teamColor, 0.7), sx * 0.55, 1.15, sz * 0.55);
  }
  // donjon + flag
  add(g, new THREE.CylinderGeometry(0.26, 0.3, 1.3, 8), mat(STONE), 0, 0.77, 0);
  add(g, new THREE.ConeGeometry(0.32, 0.36, 8), mat(teamColor, 0.7), 0, 1.6, 0);
  add(g, new THREE.CylinderGeometry(0.015, 0.015, 0.4, 6), mat(0x4a3a2a), 0, 1.95, 0);
  add(g, new THREE.BoxGeometry(0.02, 0.14, 0.24), mat(teamColor, 0.7), 0, 2.08, 0.12);
  add(g, new THREE.SphereGeometry(0.05, 10, 6), mat(GOLD, 0.35), 0, 2.17, 0);
  return g;
}
