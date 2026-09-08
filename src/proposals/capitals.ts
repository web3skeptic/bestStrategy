// CAPITAL PROPOSALS — faction-specific Capital cities. Today both factions
// share one ziggurat (buildTemple tier 10), so a Nomad capital and a Farmer
// capital look identical. These are prototype kits, previewed at
// /capital-proposals — nothing here is wired into the board renderer yet.
//
//   Nomads (temple faction — raiders, horse people, felt and hide):
//     A · Great Yurt Camp   — a grand central yurt ringed by smaller ones,
//                             stake palisade, horse-skull totems, campfire
//     B · Khan's Pavilion   — one tall striped war tent, pennants on the mast,
//                             hitched horses, spear rack, war drums
//     C · Horde Hold        — a raised earth mound with a palisade terrace,
//                             a watchtower and the chieftain's yurt on top
//   Farmers (agrar faction — harvest, stone, timber, fields):
//     A · Granary Town      — a timber-framed hall, granary silo, windmill,
//                             wheat rows and haystacks inside a low stone wall
//     B · Windmill Keep     — a big stone windmill as the centrepiece, barn,
//                             silos, orchard and a hay cart
//     C · Walled Farmstead  — a two-storey farmhouse and barn behind a stone
//                             wall with a gatehouse, animal pen and oak tree
//
// Every builder takes the owner's team colour and returns a group whose base
// sits on y = 0 inside the hex tile (radius 1) — same contract as buildTemple.
import * as THREE from 'three';

// ── shared palette ──
const STONE = 0xc8c4ba, STONE_MID = 0xada9a0, STONE_DK = 0x807d74;
const WOOD = 0x6b4a2e, WOOD_DK = 0x4a3220, WOOD_LT = 0x9a7a52;
const FELT = 0xd8cfb8, FELT_DK = 0xb9ad92, HIDE = 0x8a6540;
const STEPPE = 0xb8a070, STEPPE_DK = 0x9a8558, EARTH = 0x7a5a3a, EARTH_DK = 0x5c4128;
const GRASS = 0x6f8f45, GRASS_DK = 0x557233, WHEAT = 0xd6b24a, HAY = 0xcfae4e;
const PLASTER = 0xe2d8bd, BRICK = 0x9b4a34, GOLD = 0xe0b020, BONE = 0xece6d2;
const LEAF = 0x3f7a32, LEAF_LT = 0x5d9a44, FIRE = 0xff8a2a, SMOKE = 0x8c8c8c;

// Uniform enlargement so a Capital fills its hex the way buildTemple's
// TEMPLE_SCALE does (outer footprints above are sized for this).
const CAPITAL_SCALE = 1.25;

type Rot = { x?: number; y?: number; z?: number };

function mat(color: number, rough = 0.88): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
}
function glow(color: number, k = 1.3): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: k, roughness: 0.4, metalness: 0 });
}
function add(g: THREE.Object3D, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rot?: Rot): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(x, y, z);
  if (rot) mesh.rotation.set(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0);
  mesh.castShadow = true; mesh.receiveShadow = true;
  g.add(mesh);
  return mesh;
}
function box(g: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, rot?: Rot): THREE.Mesh {
  return add(g, new THREE.BoxGeometry(w, h, d), m, x, y, z, rot);
}
function cyl(g: THREE.Object3D, rt: number, rb: number, h: number, seg: number, m: THREE.Material, x: number, y: number, z: number, rot?: Rot): THREE.Mesh {
  return add(g, new THREE.CylinderGeometry(rt, rb, h, seg), m, x, y, z, rot);
}
function cone(g: THREE.Object3D, r: number, h: number, seg: number, m: THREE.Material, x: number, y: number, z: number, rot?: Rot): THREE.Mesh {
  return add(g, new THREE.ConeGeometry(r, h, seg), m, x, y, z, rot);
}
function sphere(g: THREE.Object3D, r: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  return add(g, new THREE.SphereGeometry(r, 10, 7), m, x, y, z);
}
// Flat-top hex plate matching the ground tiles (30° twist).
function hexPlate(g: THREE.Object3D, r: number, h: number, m: THREE.Material, y: number): THREE.Mesh {
  return cyl(g, r, r * 1.03, h, 6, m, 0, y + h / 2, 0, { y: Math.PI / 6 });
}
// Gabled roof: two slanted slabs meeting at a ridge along the x axis.
function gable(g: THREE.Object3D, w: number, d: number, h: number, m: THREE.Material, x: number, y: number, z: number, ry = 0): THREE.Group {
  const r = new THREE.Group();
  const slope = Math.atan2(h, d / 2);
  const len = Math.sqrt(h * h + (d / 2) * (d / 2)) + 0.04;
  box(r, w + 0.08, 0.05, len, m, 0, h / 2, d / 4, { x: slope });
  box(r, w + 0.08, 0.05, len, m, 0, h / 2, -d / 4, { x: -slope });
  box(r, w + 0.1, 0.05, 0.06, m, 0, h, 0);
  r.position.set(x, y, z); r.rotation.y = ry;
  g.add(r);
  return r;
}
function flag(g: THREE.Object3D, x: number, z: number, y: number, poleH: number, teamColor: number, w = 0.26, h = 0.15): void {
  cyl(g, 0.014, 0.018, poleH, 6, mat(WOOD_DK), x, y + poleH / 2, z);
  box(g, 0.02, h, w, mat(teamColor, 0.7), x, y + poleH - h / 2 - 0.02, z + w / 2);
  sphere(g, 0.03, mat(GOLD, 0.35), x, y + poleH + 0.02, z);
}
function stake(g: THREE.Object3D, x: number, z: number, h: number, tiltOut: number, m: THREE.Material): void {
  const a = Math.atan2(z, x);
  const grp = new THREE.Group();
  cyl(grp, 0.03, 0.04, h, 6, m, 0, h / 2, 0);
  cone(grp, 0.035, 0.08, 6, m, 0, h + 0.04, 0);
  grp.position.set(x, 0, z);
  grp.rotation.set(Math.sin(a) * tiltOut, 0, -Math.cos(a) * tiltOut);
  g.add(grp);
}
function yurt(g: THREE.Object3D, x: number, z: number, r: number, wallH: number, roofH: number, teamColor: number, face: number, grand = false): void {
  const y = new THREE.Group();
  cyl(y, r, r * 1.02, wallH, 12, mat(FELT), 0, wallH / 2, 0);
  // lattice band + team band
  cyl(y, r * 1.03, r * 1.03, 0.04, 12, mat(WOOD_LT), 0, wallH * 0.55, 0);
  cyl(y, r * 1.02, r * 1.02, wallH * 0.22, 12, mat(teamColor, 0.75), 0, wallH * 0.86, 0);
  cone(y, r * 1.12, roofH, 12, mat(grand ? teamColor : FELT_DK, 0.8), 0, wallH + roofH / 2, 0);
  if (grand) {
    // crown ring + smoke hole cap
    cyl(y, r * 0.22, r * 0.22, 0.06, 10, mat(WOOD), 0, wallH + roofH + 0.02, 0);
    sphere(y, 0.05, mat(GOLD, 0.35), 0, wallH + roofH + 0.09, 0);
    // roof ribs
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      const rib = box(y, 0.02, 0.02, roofH * 1.05, mat(WOOD_DK), Math.cos(a) * r * 0.56, wallH + roofH * 0.5, Math.sin(a) * r * 0.56);
      rib.rotation.y = -a; rib.rotation.x = -Math.atan2(roofH, r * 1.12);
      rib.rotation.order = 'YXZ';
    }
  }
  // door
  box(y, r * 0.5, wallH * 0.8, 0.04, mat(WOOD_DK), 0, wallH * 0.4, r, { y: 0 });
  y.rotation.y = face;
  y.position.set(x, 0, z);
  g.add(y);
}
function horse(g: THREE.Object3D, x: number, z: number, ry: number, color: number): void {
  const h = new THREE.Group();
  const m = mat(color);
  box(h, 0.34, 0.16, 0.14, m, 0, 0.22, 0);
  box(h, 0.12, 0.12, 0.1, m, 0.2, 0.34, 0);
  box(h, 0.14, 0.08, 0.08, m, 0.3, 0.36, 0);
  for (const [dx, dz] of [[-0.12, -0.04], [-0.12, 0.04], [0.12, -0.04], [0.12, 0.04]]) cyl(h, 0.02, 0.025, 0.16, 5, m, dx, 0.08, dz);
  box(h, 0.14, 0.05, 0.02, mat(WOOD_DK), 0.02, 0.33, 0); // mane
  box(h, 0.02, 0.1, 0.03, mat(WOOD_DK), -0.18, 0.2, 0);  // tail
  h.position.set(x, 0, z); h.rotation.y = ry;
  g.add(h);
}
function skullTotem(g: THREE.Object3D, x: number, z: number, h: number, teamColor: number): void {
  cyl(g, 0.025, 0.03, h, 6, mat(WOOD_DK), x, h / 2, z);
  sphere(g, 0.07, mat(BONE, 0.6), x, h + 0.04, z);
  box(g, 0.06, 0.06, 0.1, mat(BONE, 0.6), x, h + 0.0, z + 0.06);
  box(g, 0.02, 0.18, 0.05, mat(teamColor, 0.7), x + 0.04, h - 0.1, z);
  box(g, 0.02, 0.14, 0.05, mat(teamColor, 0.7), x - 0.04, h - 0.12, z);
}
function campfire(g: THREE.Object3D, x: number, z: number): void {
  for (let i = 0; i < 7; i++) {
    const a = i * Math.PI * 2 / 7;
    sphere(g, 0.035, mat(STONE_DK), x + Math.cos(a) * 0.13, 0.03, z + Math.sin(a) * 0.13);
  }
  box(g, 0.18, 0.03, 0.03, mat(WOOD_DK), x, 0.03, z, { y: 0.5 });
  box(g, 0.18, 0.03, 0.03, mat(WOOD_DK), x, 0.03, z, { y: -0.7 });
  cone(g, 0.06, 0.16, 6, glow(FIRE, 1.6), x, 0.12, z);
  cone(g, 0.035, 0.1, 6, glow(0xffd070, 1.8), x, 0.17, z);
}
function tree(g: THREE.Object3D, x: number, z: number, s: number, round = true): void {
  cyl(g, 0.03 * s, 0.045 * s, 0.22 * s, 6, mat(WOOD), x, 0.11 * s, z);
  if (round) {
    sphere(g, 0.17 * s, mat(LEAF), x, 0.34 * s, z);
    sphere(g, 0.12 * s, mat(LEAF_LT), x + 0.07 * s, 0.42 * s, z - 0.04 * s);
  } else {
    cone(g, 0.15 * s, 0.34 * s, 7, mat(LEAF), x, 0.36 * s, z);
  }
}
function haystack(g: THREE.Object3D, x: number, z: number, s = 1): void {
  cone(g, 0.12 * s, 0.2 * s, 8, mat(HAY, 0.95), x, 0.1 * s, z);
  cyl(g, 0.012, 0.012, 0.28 * s, 4, mat(WOOD_DK), x, 0.14 * s, z);
}
function wheatRows(g: THREE.Object3D, x: number, z: number, w: number, d: number, rows: number, ry = 0): void {
  const grp = new THREE.Group();
  box(grp, w, 0.03, d, mat(EARTH), 0, 0.015, 0);
  for (let i = 0; i < rows; i++) {
    const zz = -d / 2 + d * (i + 0.5) / rows;
    box(grp, w * 0.92, 0.1, d / rows * 0.5, mat(WHEAT, 0.95), 0, 0.08, zz);
  }
  grp.position.set(x, 0, z); grp.rotation.y = ry;
  g.add(grp);
}
// Low wall along the six hex edges (radius r), leaving a gap on `gapSide`.
function hexWall(g: THREE.Object3D, r: number, h: number, t: number, m: THREE.Material, gapSide: number, capM?: THREE.Material): void {
  const edge = r; // flat-top hex: edge length = radius
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3 + Math.PI / 6; // corners at 30°, 90°...
    const a2 = a + Math.PI / 3;
    const mx = (Math.cos(a) + Math.cos(a2)) / 2 * r, mz = (Math.sin(a) + Math.sin(a2)) / 2 * r;
    const ang = Math.atan2(Math.sin(a2) - Math.sin(a), Math.cos(a2) - Math.cos(a));
    if (i === gapSide) {
      // two short stubs around a gate opening
      for (const s of [-1, 1]) {
        const fx = mx + Math.cos(ang) * s * edge * 0.34, fz = mz + Math.sin(ang) * s * edge * 0.34;
        box(g, edge * 0.32, h, t, m, fx, h / 2, fz, { y: -ang });
      }
      continue;
    }
    box(g, edge, h, t, m, mx, h / 2, mz, { y: -ang });
    if (capM) box(g, edge, 0.03, t * 1.3, capM, mx, h + 0.015, mz, { y: -ang });
  }
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3 + Math.PI / 6;
    cyl(g, t * 0.9, t * 1.0, h + 0.06, 6, m, Math.cos(a) * r, (h + 0.06) / 2, Math.sin(a) * r);
  }
}

// ═══════════════════════════ NOMADS ═══════════════════════════

export function buildNomadCapitalA(teamColor: number): THREE.Group {
  const g = new THREE.Group();
  hexPlate(g, 0.8, 0.06, mat(STEPPE), 0);
  hexPlate(g, 0.5, 0.03, mat(STEPPE_DK), 0.06);
  // stake palisade with a front gap
  for (let i = 0; i < 18; i++) {
    const a = i * Math.PI * 2 / 18;
    if (Math.abs(a - Math.PI / 2) < 0.28) continue; // gate (front = +z)
    stake(g, Math.cos(a) * 0.74, Math.sin(a) * 0.74, 0.26 + (i % 2) * 0.07, 0.12, mat(i % 3 === 0 ? WOOD_DK : WOOD));
  }
  // grand yurt + three smaller
  yurt(g, 0, -0.08, 0.36, 0.34, 0.36, teamColor, 0, true);
  yurt(g, -0.56, 0.28, 0.17, 0.2, 0.19, teamColor, 0.9);
  yurt(g, 0.58, 0.3, 0.17, 0.2, 0.19, teamColor, -0.9);
  yurt(g, 0.44, -0.5, 0.15, 0.18, 0.17, teamColor, -2.4);
  // totems flanking the gate, campfire in the yard
  skullTotem(g, -0.3, 0.72, 0.62, teamColor);
  skullTotem(g, 0.3, 0.72, 0.62, teamColor);
  campfire(g, 0.02, 0.5);
  // hides drying on a rack
  cyl(g, 0.015, 0.015, 0.4, 5, mat(WOOD_DK), -0.55, 0.2, -0.45);
  cyl(g, 0.015, 0.015, 0.4, 5, mat(WOOD_DK), -0.25, 0.2, -0.55);
  box(g, 0.32, 0.02, 0.02, mat(WOOD_DK), -0.4, 0.4, -0.5, { y: 0.32 });
  box(g, 0.1, 0.22, 0.015, mat(HIDE, 0.95), -0.47, 0.29, -0.48, { y: 0.32 });
  box(g, 0.1, 0.2, 0.015, mat(0xa07a50, 0.95), -0.33, 0.3, -0.52, { y: 0.32 });
  // tall standard behind the grand yurt
  flag(g, 0, -0.62, 0, 1.55, teamColor, 0.34, 0.2);
  box(g, 0.28, 0.02, 0.02, mat(WOOD_DK), 0, 1.36, -0.62);
  for (const s of [-1, 1]) box(g, 0.015, 0.16, 0.03, mat(teamColor, 0.7), s * 0.13, 1.27, -0.62);
  g.scale.setScalar(CAPITAL_SCALE);
  return g;
}

export function buildNomadCapitalB(teamColor: number): THREE.Group {
  const g = new THREE.Group();
  hexPlate(g, 0.8, 0.06, mat(STEPPE), 0);
  // rope fence on posts
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI * 2 / 12;
    if (Math.abs(a - Math.PI / 2) < 0.3) continue;
    cyl(g, 0.02, 0.025, 0.2, 5, mat(WOOD_DK), Math.cos(a) * 0.76, 0.16, Math.sin(a) * 0.76);
    const a2 = a + Math.PI * 2 / 12;
    if (Math.abs(a2 - Math.PI / 2) < 0.3) continue;
    const mx = (Math.cos(a) + Math.cos(a2)) / 2 * 0.76, mz = (Math.sin(a) + Math.sin(a2)) / 2 * 0.76;
    box(g, 0.4, 0.015, 0.015, mat(0xd9c9a0), mx, 0.3, mz, { y: -Math.atan2(Math.sin(a2) - Math.sin(a), Math.cos(a2) - Math.cos(a)) });
  }
  // rug up to the entrance
  box(g, 0.3, 0.02, 0.55, mat(teamColor, 0.9), 0, 0.07, 0.55);
  box(g, 0.34, 0.015, 0.59, mat(GOLD, 0.9), 0, 0.065, 0.55);
  // the pavilion: cloth drum + tall striped cone + mast with pennants
  cyl(g, 0.5, 0.52, 0.3, 12, mat(FELT), 0, 0.21, -0.05);
  cyl(g, 0.51, 0.51, 0.06, 12, mat(teamColor, 0.75), 0, 0.33, -0.05);
  cone(g, 0.62, 0.95, 12, mat(teamColor, 0.8), 0, 0.36 + 0.475, -0.05);
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3 + Math.PI / 6;
    const strip = box(g, 0.09, 0.02, 1.0, mat(FELT_DK, 0.9), Math.cos(a) * 0.3, 0.36 + 0.47, -0.05 + Math.sin(a) * 0.3);
    strip.rotation.order = 'YXZ'; strip.rotation.y = -a + Math.PI / 2; strip.rotation.x = -Math.atan2(0.95, 0.62);
  }
  box(g, 0.24, 0.26, 0.04, mat(WOOD_DK), 0, 0.19, 0.46); // entrance
  cyl(g, 0.02, 0.025, 0.7, 6, mat(WOOD_DK), 0, 0.36 + 0.95 + 0.3, -0.05);
  for (let i = 0; i < 3; i++) {
    const yy = 1.9 - i * 0.16, s = i % 2 === 0 ? 1 : -1;
    box(g, 0.02, 0.09, 0.22, mat(i === 1 ? GOLD : teamColor, 0.7), 0, yy, -0.05 + s * 0.11);
  }
  sphere(g, 0.04, mat(GOLD, 0.35), 0, 1.99, -0.05);
  // guy ropes
  for (const a of [0.5, 2.1, 3.7, 5.3]) {
    const gx = Math.cos(a) * 0.72, gz = -0.05 + Math.sin(a) * 0.72;
    const rope = box(g, 0.012, 0.012, 0.95, mat(0xd9c9a0), (gx) * 0.62, 0.6, -0.05 + (gz + 0.05) * 0.62);
    rope.lookAt(gx, 0.05, gz); rope.rotateX(0);
    cyl(g, 0.015, 0.02, 0.08, 4, mat(WOOD_DK), gx, 0.04, gz);
  }
  // hitched horses + post
  cyl(g, 0.02, 0.025, 0.3, 5, mat(WOOD_DK), -0.62, 0.15, 0.3);
  box(g, 0.02, 0.02, 0.5, mat(WOOD_DK), -0.62, 0.28, 0.3);
  horse(g, -0.5, 0.52, 0.5, 0x5a3a24);
  horse(g, -0.7, 0.05, -0.6, 0x3a2a20);
  // spear rack + war drums + totem
  for (let i = 0; i < 5; i++) {
    const x = 0.46 + i * 0.07;
    cyl(g, 0.01, 0.012, 0.55, 4, mat(WOOD_LT), x, 0.28, 0.5, { z: 0.12 });
    cone(g, 0.02, 0.07, 4, mat(STONE_DK, 0.4), x - 0.03, 0.57, 0.5);
  }
  box(g, 0.36, 0.02, 0.02, mat(WOOD_DK), 0.6, 0.34, 0.5);
  for (const [dx, dz] of [[0.6, -0.4], [0.72, -0.24]]) {
    cyl(g, 0.09, 0.09, 0.14, 10, mat(BRICK, 0.9), dx, 0.07, dz);
    cyl(g, 0.085, 0.085, 0.015, 10, mat(BONE, 0.7), dx, 0.147, dz);
  }
  skullTotem(g, -0.35, -0.68, 0.7, teamColor);
  g.scale.setScalar(CAPITAL_SCALE);
  return g;
}

export function buildNomadCapitalC(teamColor: number): THREE.Group {
  const g = new THREE.Group();
  hexPlate(g, 0.8, 0.06, mat(STEPPE), 0);
  hexPlate(g, 0.74, 0.12, mat(EARTH), 0.06);
  hexPlate(g, 0.58, 0.16, mat(EARTH_DK), 0.18);
  hexPlate(g, 0.56, 0.02, mat(STEPPE_DK), 0.34);
  // palisade on the lower terrace + walkway
  for (let i = 0; i < 22; i++) {
    const a = i * Math.PI * 2 / 22;
    if (Math.abs(a - Math.PI / 2) < 0.22) continue;
    stake(g, Math.cos(a) * 0.68, Math.sin(a) * 0.68, 0.36 + (i % 3 === 0 ? 0.08 : 0), 0.06, mat(i % 2 ? WOOD : WOOD_DK));
  }
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3 + Math.PI / 6, a2 = a + Math.PI / 3;
    if (i === 1) continue;
    const mx = (Math.cos(a) + Math.cos(a2)) / 2 * 0.61, mz = (Math.sin(a) + Math.sin(a2)) / 2 * 0.61;
    box(g, 0.6, 0.03, 0.1, mat(WOOD_LT), mx, 0.3, mz, { y: -Math.atan2(Math.sin(a2) - Math.sin(a), Math.cos(a2) - Math.cos(a)) });
  }
  // hides hanging on the palisade
  for (const a of [2.4, 3.3, 4.4]) box(g, 0.14, 0.2, 0.02, mat(HIDE, 0.95), Math.cos(a) * 0.64, 0.5, Math.sin(a) * 0.64, { y: -a + Math.PI / 2 });
  // ramp up the front
  box(g, 0.3, 0.04, 0.5, mat(WOOD_LT), 0, 0.2, 0.62, { x: -0.55 });
  // watchtower on the terrace (back-right)
  {
    const tx = 0.42, tz = -0.42;
    for (const [dx, dz] of [[-0.09, -0.09], [0.09, -0.09], [-0.09, 0.09], [0.09, 0.09]]) cyl(g, 0.02, 0.025, 0.75, 5, mat(WOOD_DK), tx + dx, 0.34 + 0.375, tz + dz);
    box(g, 0.28, 0.04, 0.28, mat(WOOD_LT), tx, 1.11, tz);
    for (const s of [-1, 1]) { box(g, 0.28, 0.08, 0.02, mat(WOOD), tx, 1.17, tz + s * 0.13); box(g, 0.02, 0.08, 0.28, mat(WOOD), tx + s * 0.13, 1.17, tz); }
    for (const [dx, dz] of [[-0.11, -0.11], [0.11, -0.11], [-0.11, 0.11], [0.11, 0.11]]) cyl(g, 0.012, 0.012, 0.3, 4, mat(WOOD_DK), tx + dx, 1.28, tz + dz);
    cone(g, 0.22, 0.2, 4, mat(teamColor, 0.8), tx, 1.53, tz, { y: Math.PI / 4 });
    flag(g, tx, tz, 1.6, 0.34, teamColor, 0.18, 0.1);
  }
  // chieftain's yurt, skull totems and a brazier on the hilltop terrace
  {
    const top = new THREE.Group();
    yurt(top, -0.1, 0.02, 0.32, 0.3, 0.32, teamColor, 0.1, true);
    skullTotem(top, 0.44, 0.3, 0.5, teamColor);
    skullTotem(top, -0.52, -0.2, 0.42, teamColor);
    cyl(top, 0.08, 0.06, 0.08, 8, mat(STONE_DK), 0.3, 0.04, 0.42);
    cone(top, 0.05, 0.14, 6, glow(FIRE, 1.6), 0.3, 0.14, 0.42);
    top.position.y = 0.36;
    g.add(top);
  }
  g.scale.setScalar(CAPITAL_SCALE);
  return g;
}

// ═══════════════════════════ FARMERS ═══════════════════════════

export function buildFarmerCapitalA(teamColor: number): THREE.Group {
  const g = new THREE.Group();
  hexPlate(g, 0.8, 0.06, mat(GRASS), 0);
  box(g, 0.22, 0.015, 0.7, mat(EARTH), 0, 0.065, 0.55); // dirt path to the gate
  hexWall(g, 0.78, 0.16, 0.07, mat(STONE_MID), 1, mat(STONE));
  // timber-framed great hall with team-tiled gable roof
  {
    const hx = -0.12, hz = -0.12;
    box(g, 0.74, 0.42, 0.46, mat(PLASTER), hx, 0.06 + 0.21, hz);
    for (const dx of [-0.36, -0.12, 0.12, 0.36]) box(g, 0.03, 0.42, 0.48, mat(WOOD_DK), hx + dx, 0.27, hz);
    box(g, 0.76, 0.03, 0.48, mat(WOOD_DK), hx, 0.27, hz);
    gable(g, 0.74, 0.5, 0.3, mat(teamColor, 0.8), hx, 0.48, hz);
    box(g, 0.08, 0.2, 0.08, mat(STONE_DK), hx + 0.24, 0.72, hz - 0.08); // chimney
    for (const dz of [-0.14, 0.14]) box(g, 0.02, 0.1, 0.09, glow(0xffd88a, 0.9), hx + 0.38, 0.3, hz + dz);
    box(g, 0.12, 0.2, 0.02, mat(WOOD_DK), hx, 0.16, hz + 0.24);
    flag(g, hx, hz, 0.78, 0.5, teamColor, 0.22, 0.13);
  }
  // granary silo
  cyl(g, 0.15, 0.16, 0.55, 10, mat(STONE), 0.55, 0.06 + 0.275, -0.32);
  cone(g, 0.19, 0.22, 10, mat(teamColor, 0.8), 0.55, 0.06 + 0.55 + 0.11, -0.32);
  box(g, 0.1, 0.12, 0.02, mat(WOOD_DK), 0.55, 0.2, -0.16);
  // windmill
  {
    const wx = -0.6, wz = 0.18;
    cyl(g, 0.11, 0.15, 0.6, 8, mat(STONE_MID), wx, 0.06 + 0.3, wz);
    cone(g, 0.15, 0.14, 8, mat(WOOD), wx, 0.06 + 0.6 + 0.07, wz);
    cyl(g, 0.02, 0.02, 0.12, 6, mat(WOOD_DK), wx, 0.6, wz + 0.12, { x: Math.PI / 2 });
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + 0.4;
      box(g, 0.07, 0.36, 0.015, mat(FELT), wx + Math.cos(a) * 0.18, 0.6 + Math.sin(a) * 0.18, wz + 0.18, { z: a - Math.PI / 2 });
    }
  }
  // fields, haystacks, well
  wheatRows(g, 0.42, 0.45, 0.4, 0.34, 3, 0.3);
  wheatRows(g, -0.38, 0.55, 0.32, 0.28, 3, -0.4);
  haystack(g, 0.62, 0.12, 0.9); haystack(g, 0.72, 0.28, 0.75);
  cyl(g, 0.07, 0.07, 0.1, 8, mat(STONE_DK), 0.22, 0.11, 0.12);
  cone(g, 0.1, 0.08, 4, mat(WOOD), 0.22, 0.3, 0.12, { y: Math.PI / 4 });
  cyl(g, 0.01, 0.01, 0.16, 4, mat(WOOD_DK), 0.22, 0.2, 0.12);
  tree(g, -0.68, -0.55, 0.9); tree(g, 0.02, -0.66, 0.7);
  g.scale.setScalar(CAPITAL_SCALE);
  return g;
}

export function buildFarmerCapitalB(teamColor: number): THREE.Group {
  const g = new THREE.Group();
  hexPlate(g, 0.8, 0.06, mat(GRASS), 0);
  hexWall(g, 0.78, 0.12, 0.06, mat(STONE_DK), 1);
  // the great windmill
  {
    const wx = 0.05, wz = -0.15;
    cyl(g, 0.34, 0.38, 0.5, 8, mat(STONE_MID), wx, 0.06 + 0.25, wz);
    cyl(g, 0.24, 0.3, 0.75, 8, mat(STONE), wx, 0.06 + 0.5 + 0.375, wz);
    for (let i = 0; i < 3; i++) box(g, 0.08, 0.1, 0.02, glow(0xffd88a, 0.9), wx + Math.cos(i * 2.1) * 0.29, 0.6 + i * 0.22, wz + Math.sin(i * 2.1) * 0.29, { y: -(i * 2.1) + Math.PI / 2 });
    add(g, new THREE.SphereGeometry(0.29, 10, 7, 0, Math.PI * 2, 0, Math.PI / 2), mat(teamColor, 0.8), wx, 0.06 + 1.25, wz);
    box(g, 0.2, 0.26, 0.06, mat(WOOD_DK), wx, 0.2, wz + 0.37);
    // sails
    const hub = new THREE.Group();
    cyl(hub, 0.03, 0.03, 0.2, 8, mat(WOOD_DK), 0, 0, 0, { x: Math.PI / 2 });
    for (let i = 0; i < 4; i++) {
      const blade = new THREE.Group();
      box(blade, 0.03, 0.72, 0.02, mat(WOOD), 0, 0.36, 0);
      box(blade, 0.16, 0.6, 0.012, mat(FELT), 0.09, 0.42, 0);
      for (let k = 0; k < 3; k++) box(blade, 0.16, 0.012, 0.02, mat(WOOD_DK), 0.09, 0.22 + k * 0.18, 0);
      blade.rotation.z = i * Math.PI / 2 + 0.35;
      hub.add(blade);
    }
    hub.position.set(wx, 0.06 + 1.18, wz + 0.4);
    hub.rotation.x = 0.12;
    g.add(hub);
  }
  // barn with gable, two silos, orchard, cart
  box(g, 0.44, 0.28, 0.3, mat(BRICK), -0.5, 0.06 + 0.14, 0.32, { y: 0.35 });
  gable(g, 0.44, 0.34, 0.2, mat(WOOD_DK), -0.5, 0.34, 0.32, 0.35);
  box(g, 0.12, 0.16, 0.02, mat(WOOD_LT), -0.36, 0.16, 0.46, { y: 0.35 });
  for (const [sx, sz] of [[0.6, 0.02], [0.72, -0.24]]) {
    cyl(g, 0.1, 0.11, 0.42, 10, mat(STONE), sx, 0.06 + 0.21, sz);
    cone(g, 0.13, 0.14, 10, mat(teamColor, 0.8), sx, 0.06 + 0.42 + 0.07, sz);
  }
  tree(g, -0.62, -0.5, 1.0); tree(g, -0.32, -0.66, 0.85); tree(g, -0.05, -0.75, 0.75);
  wheatRows(g, 0.22, 0.55, 0.5, 0.3, 3, 0.15);
  {
    const c = new THREE.Group();
    box(c, 0.26, 0.1, 0.16, mat(WOOD), 0, 0.14, 0);
    cone(c, 0.09, 0.12, 8, mat(HAY, 0.95), 0, 0.24, 0);
    for (const s of [-1, 1]) cyl(c, 0.06, 0.06, 0.02, 10, mat(WOOD_DK), 0.06, 0.06, s * 0.09, { x: Math.PI / 2 });
    box(c, 0.2, 0.02, 0.02, mat(WOOD_DK), -0.2, 0.12, 0, { y: 0 });
    c.position.set(-0.28, 0, 0.62); c.rotation.y = 0.9; g.add(c);
  }
  haystack(g, 0.62, 0.42, 0.8);
  flag(g, 0.05, -0.15, 0.06 + 1.5, 0.36, teamColor, 0.2, 0.12);
  g.scale.setScalar(CAPITAL_SCALE);
  return g;
}

export function buildFarmerCapitalC(teamColor: number): THREE.Group {
  const g = new THREE.Group();
  hexPlate(g, 0.8, 0.06, mat(GRASS), 0);
  hexPlate(g, 0.76, 0.02, mat(GRASS_DK), 0.06);
  hexWall(g, 0.78, 0.28, 0.08, mat(STONE_MID), 1, mat(STONE));
  // gatehouse over the front gap
  {
    const gz = 0.68;
    for (const s of [-1, 1]) box(g, 0.1, 0.42, 0.12, mat(STONE), s * 0.2, 0.06 + 0.21, gz);
    box(g, 0.5, 0.08, 0.14, mat(STONE_DK), 0, 0.06 + 0.42, gz);
    gable(g, 0.5, 0.2, 0.14, mat(teamColor, 0.8), 0, 0.06 + 0.46, gz);
    box(g, 0.28, 0.24, 0.03, mat(WOOD_DK), 0, 0.18, gz + 0.02);
    box(g, 0.28, 0.015, 0.4, mat(EARTH), 0, 0.075, gz - 0.25);
  }
  // two-storey farmhouse with chimney + smoke
  {
    const hx = -0.18, hz = -0.14;
    box(g, 0.5, 0.26, 0.4, mat(STONE_MID), hx, 0.06 + 0.13, hz);
    box(g, 0.52, 0.24, 0.42, mat(PLASTER), hx, 0.06 + 0.26 + 0.12, hz);
    for (const dx of [-0.22, 0, 0.22]) box(g, 0.025, 0.24, 0.44, mat(WOOD_DK), hx + dx, 0.44, hz);
    gable(g, 0.5, 0.46, 0.26, mat(teamColor, 0.8), hx, 0.56, hz);
    box(g, 0.07, 0.24, 0.07, mat(STONE_DK), hx + 0.16, 0.76, hz - 0.1);
    sphere(g, 0.04, mat(SMOKE, 1), hx + 0.16, 0.94, hz - 0.1);
    sphere(g, 0.05, mat(SMOKE, 1), hx + 0.2, 1.02, hz - 0.13);
    sphere(g, 0.06, mat(SMOKE, 1), hx + 0.26, 1.11, hz - 0.16);
    for (const dx of [-0.16, 0.16]) box(g, 0.1, 0.09, 0.02, glow(0xffd88a, 0.9), hx + dx, 0.45, hz + 0.215);
    box(g, 0.1, 0.16, 0.02, mat(WOOD_DK), hx, 0.14, hz + 0.21);
  }
  // barn
  box(g, 0.34, 0.24, 0.28, mat(BRICK), 0.42, 0.06 + 0.12, -0.34, { y: -0.5 });
  gable(g, 0.34, 0.32, 0.18, mat(WOOD_DK), 0.42, 0.3, -0.34, -0.5);
  // animal pen with fence + livestock
  {
    const px = 0.38, pz = 0.3;
    for (let i = 0; i < 4; i++) {
      const ang = i * Math.PI / 2;
      const mx = px + Math.cos(ang) * 0.2, mz = pz + Math.sin(ang) * 0.2;
      cyl(g, 0.012, 0.012, 0.12, 4, mat(WOOD_DK), px + Math.cos(ang + Math.PI / 4) * 0.28, 0.12, pz + Math.sin(ang + Math.PI / 4) * 0.28);
      box(g, 0.4, 0.015, 0.015, mat(WOOD), mx, 0.15, mz, { y: -ang + Math.PI / 2 });
      box(g, 0.4, 0.015, 0.015, mat(WOOD), mx, 0.1, mz, { y: -ang + Math.PI / 2 });
    }
    for (const [dx, dz, ry] of [[-0.08, -0.05, 0.4], [0.07, 0.06, -1.2]]) {
      box(g, 0.14, 0.09, 0.08, mat(0xf2efe6, 0.95), px + dx, 0.11, pz + dz, { y: ry });
      box(g, 0.05, 0.05, 0.05, mat(0x2a2a2a), px + dx + Math.cos(ry) * 0.08, 0.13, pz + dz - Math.sin(ry) * 0.08);
    }
  }
  // vegetable rows, oak, hay, scarecrow
  wheatRows(g, -0.5, 0.42, 0.3, 0.3, 4, 0.2);
  tree(g, -0.62, -0.45, 1.15);
  haystack(g, 0.7, 0.05, 0.7);
  cyl(g, 0.01, 0.01, 0.3, 4, mat(WOOD_DK), -0.62, 0.22, 0.42);
  box(g, 0.16, 0.012, 0.012, mat(WOOD_DK), -0.62, 0.3, 0.42);
  box(g, 0.08, 0.1, 0.05, mat(FELT), -0.62, 0.28, 0.42);
  cone(g, 0.045, 0.05, 6, mat(HAY), -0.62, 0.375, 0.42);
  flag(g, -0.18, -0.14, 0.82, 0.42, teamColor, 0.2, 0.12);
  g.scale.setScalar(CAPITAL_SCALE);
  return g;
}
