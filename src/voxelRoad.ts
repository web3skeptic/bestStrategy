// Voxel Road — a worn dirt path patch marking an actual built Road tile.
// Roads previously had no 3D presence at all, just a faint flat ground tint
// (easy to lose among the placement-mode highlight tints layered on top of
// it) — this gives a built Road the same "there's unmistakably something
// here" real geometry every other structure (Farm/Capital/Temple) already
// has. Deliberately low-profile (like the Farm) so it never hides a unit
// standing on the Road. Built from simple primitives, same hex-prism
// convention as voxelFarm.ts's plot so the footprint matches the tile.
import * as THREE from 'three';

const DIRT = 0x8a6b45;
const DIRT_DARK = 0x6b4a2c;
const STONE = 0x9a9488;

function mat(color: number, rough = 0.92): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
}

function hexPatch(r: number, h: number, material: THREE.Material, y: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 6), material);
  m.rotation.y = Math.PI / 6;
  m.position.y = y;
  m.receiveShadow = true;
  return m;
}

function stone(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number, rotY = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.rotation.y = rotY;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function buildRoad(): THREE.Group {
  const g = new THREE.Group();

  // A worn, slightly-darker-edged dirt patch sitting just above the ground.
  g.add(hexPatch(0.8, 0.05, mat(DIRT_DARK, 0.95), 0.015));
  g.add(hexPatch(0.66, 0.05, mat(DIRT, 0.92), 0.03));

  // A few scattered flat paving stones for texture/read-at-a-glance shape.
  const stoneMat = mat(STONE, 0.6);
  g.add(stone(0.22, 0.07, 0.18, stoneMat, 0.28, 0.075, 0.18, 0.3));
  g.add(stone(0.18, 0.06, 0.20, stoneMat, -0.32, 0.07, -0.12, -0.4));
  g.add(stone(0.16, 0.06, 0.16, stoneMat, 0.05, 0.07, -0.34, 0.7));

  return g;
}
