// PROPOSAL 1 — faction body kits. Today every humanoid unit is the same
// "Voxel Guy" with a swapped weapon and a team-tinted torso, so a Temple
// Warrior and an Agrar Warrior are pixel-identical. These two kits give each
// faction its own silhouette and move the team colour onto a smaller accent
// (sash / apron) so cloth and skin can carry faction identity instead.
// Same unit-space as buildGuy (≈6.5 tall, scaled ×0.2 on the tile) so the
// existing weapons attach at the same offsets.
import * as THREE from 'three';
import { faceTexture } from '../voxelWarrior';

function mat(color: number, rough = 0.9): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
}
function block(w: number, h: number, d: number, m: THREE.Material | THREE.Material[], x: number, y: number, z: number, rot?: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
  return mesh;
}
function cyl(rt: number, rb: number, h: number, seg: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.position.set(x, y, z);
  return mesh;
}
function head(skin: THREE.Material, y: number): THREE.Mesh {
  const faceMat = new THREE.MeshStandardMaterial({ map: faceTexture(), roughness: 0.95, metalness: 0 });
  const h = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.9, 2.1), [skin, skin, skin, skin, faceMat, skin]);
  h.position.set(0, y, 0);
  return h;
}

// ── Temple ("nomad") kit: hooded desert robe, slim, team sash + cape ─────────
export function buildNomad(teamColor: number): THREE.Group {
  const g = new THREE.Group();
  const skin = mat(0xc9a273, 0.95);
  const cloth = mat(0x7a6448, 0.95);   // dun robe
  const clothDk = mat(0x5a4834, 0.95); // hood lining / hem
  const team = mat(teamColor, 0.75);
  const rope = mat(0xd9c38a, 0.9);

  // tapered robe (hexagonal so it reads as cloth, not a box)
  const robe = cyl(1.25, 1.85, 3.5, 6, cloth, 0, 1.75, 0);
  robe.rotation.y = Math.PI / 6;
  g.add(robe);
  g.add(cyl(1.9, 1.95, 0.35, 6, clothDk, 0, 0.18, 0)); // hem
  // rope belt + team sash across the chest
  g.add(cyl(1.5, 1.5, 0.22, 6, rope, 0, 1.55, 0));
  g.add(block(0.55, 3.2, 0.5, team, 0.35, 2.05, 1.05, [0, 0, 0.55]));
  // sandals
  g.add(block(0.7, 0.3, 1.0, clothDk, -0.6, 0.0, 0.55));
  g.add(block(0.7, 0.3, 1.0, clothDk, 0.6, 0.0, 0.55));

  g.add(head(skin, 4.1));
  // hood: a pointed cap + wrap around the back/sides, face left open
  g.add(cyl(0.25, 1.55, 1.3, 6, cloth, 0, 5.55, -0.15));
  g.add(block(2.6, 2.2, 0.5, cloth, 0, 4.2, -1.2));
  g.add(block(0.4, 2.2, 2.2, cloth, -1.3, 4.2, -0.15));
  g.add(block(0.4, 2.2, 2.2, cloth, 1.3, 4.2, -0.15));
  g.add(block(2.6, 0.4, 2.4, cloth, 0, 5.05, -0.1)); // brow band
  // short team cape hanging from the shoulders
  g.add(block(2.2, 2.4, 0.25, team, 0, 2.6, -1.35));
  return g;
}

// ── Agrar ("farmer") kit: broad build, straw hat, overalls, team apron ────────
export function buildFarmer(teamColor: number): THREE.Group {
  const g = new THREE.Group();
  const skin = mat(0xd9b97f, 0.95);
  const denim = mat(0x3d5a86, 0.95);
  const shirt = mat(0xb9b2a0, 0.95);
  const straw = mat(0xd8b95a, 0.9);
  const strawDk = mat(0xb4933f, 0.9);
  const boot = mat(0x4a2f1a, 0.9);
  const team = mat(teamColor, 0.75);

  // wide torso: shirt with overalls bib in front
  g.add(block(3.4, 3.1, 2.4, shirt, 0, 1.65, 0));
  g.add(block(3.5, 1.5, 2.5, denim, 0, 0.85, 0));            // trousers
  g.add(block(1.9, 2.0, 0.3, denim, 0, 2.2, 1.28));           // bib
  g.add(block(0.35, 1.4, 0.3, denim, -0.75, 3.05, 1.2));      // straps
  g.add(block(0.35, 1.4, 0.3, denim, 0.75, 3.05, 1.2));
  g.add(block(1.5, 1.1, 0.34, team, 0, 1.15, 1.3));           // team apron panel
  // rolled sleeves / arms
  g.add(block(0.7, 1.9, 0.9, skin, -2.0, 1.6, 0.2));
  g.add(block(0.7, 1.9, 0.9, skin, 2.0, 1.6, 0.2));
  g.add(block(0.8, 0.6, 1.0, shirt, -2.0, 2.65, 0.2));
  g.add(block(0.8, 0.6, 1.0, shirt, 2.0, 2.65, 0.2));
  // boots
  g.add(block(0.95, 0.55, 1.15, boot, -0.75, -0.15, 0.5));
  g.add(block(0.95, 0.55, 1.15, boot, 0.75, -0.15, 0.5));

  g.add(head(skin, 4.05));
  g.add(block(1.6, 0.5, 0.35, mat(0x6a4526, 0.95), 0, 3.35, 1.05)); // beard/stubble
  // straw hat: wide brim + domed crown + team band
  g.add(cyl(2.0, 2.05, 0.22, 8, straw, 0, 5.05, 0));
  g.add(cyl(0.9, 1.25, 0.95, 8, straw, 0, 5.6, 0));
  g.add(cyl(1.27, 1.27, 0.25, 8, team, 0, 5.25, 0));
  g.add(cyl(0.6, 0.9, 0.3, 8, strawDk, 0, 6.15, 0));
  return g;
}

// Attach a weapon the same way voxelUnits.guy() does, then tile-scale.
export function kitWithWeapon(body: THREE.Group, weapon: THREE.Object3D, scale: number, x: number, y: number, z: number): THREE.Group {
  weapon.scale.setScalar(scale);
  weapon.position.set(x, y, z);
  weapon.rotation.z = -0.12;
  body.add(weapon);
  body.scale.setScalar(0.2);
  body.position.y = 0.08;
  body.traverse(o => { (o as THREE.Mesh).castShadow = true; });
  return body;
}
