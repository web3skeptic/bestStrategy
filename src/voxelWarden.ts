// Voxel heavy infantry model for the Farmer Warden — a slow, durable frontline
// unit with NO mount (unlike the horserider/heavyknight models it shares its
// engine slot with — see voxelUnits.ts, which picks this model over
// buildHorseRider purely by faction). Built from the same "Voxel Guy" base
// body as the Warrior (buildGuy, torso tinted to the owning player's team
// color), re-clad in thicker plate than either the Warrior or the mounted
// Heavy Knight/Champion, carrying a broad tower shield and a heavy sword.
// Built in model units (feet at y = 0, ~8 units tall, same reference frame as
// buildGuy/buildHeavyKnight); the renderer scales it down to fit a hex tile.
import * as THREE from 'three';
import { buildGuy, HairBuilder } from './voxelWarrior';
import { buildSword } from './voxelSword';

function mat(color: number, rough: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
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

// Broad tower shield, strapped to the left arm (-X side, opposite the sword).
function buildTowerShield(): THREE.Group {
  const g = new THREE.Group();
  const iron = mat(0x777c85, 0.5);
  const ironD = mat(0x4c4f56, 0.55);
  const rim = mat(0x6b4a2c, 0.8); // leather-bound edge

  g.add(block(0.30, 2.7, 1.9, iron, 0, 0, 0));           // main face
  g.add(block(0.14, 2.7, 0.22, ironD, 0.20, 0, 0.84));   // right edge trim
  g.add(block(0.14, 2.7, 0.22, ironD, 0.20, 0, -0.84));  // left edge trim
  g.add(block(0.14, 0.22, 1.9, ironD, 0.20, 1.24, 0));   // top trim
  g.add(block(0.14, 0.22, 1.9, ironD, 0.20, -1.24, 0));  // bottom trim
  g.add(block(0.36, 0.36, 0.36, rim, 0.18, 0, 0));       // central boss
  return g;
}

// Thick-plated foot soldier: the same guy body as the Warrior, re-clad in
// heavier armor than either the Warrior or the mounted Heavy Knight/Champion
// — broader pauldrons, a deep breastplate, a waist guard, greaves, and a
// plain steel great helm (no plume — this is a defensive frontline unit, not
// cavalry). Holds a heavy sword in the right hand, a broad shield on the left.
export function buildWarden(bodyColor?: number, hairStyle?: HairBuilder, hairColor?: number): THREE.Group {
  const g = buildGuy(bodyColor, hairStyle, hairColor);

  const plate = mat(0x8b8f97, 0.5);
  const plateD = mat(0x5a5d63, 0.55);

  // broad pauldrons — wider and deeper than the Heavy Knight's, for a bulkier
  // silhouette that reads as heavier than any other Farmer infantry.
  g.add(block(1.2, 1.0, 2.0, plate, -1.7, 3.05, 0));
  g.add(block(1.2, 1.0, 2.0, plate, 1.7, 3.05, 0));

  // deep breastplate with a raised central ridge, plus a waist/tasset guard.
  g.add(block(2.6, 2.2, 0.4, plate, 0, 1.9, 1.05));
  g.add(block(0.4, 2.2, 0.32, plateD, 0, 1.9, 1.24));
  g.add(block(2.7, 0.5, 2.3, plateD, 0, 0.4, 0));

  // greaves over the shins, in front of the guy's own feet blocks.
  g.add(block(0.85, 0.9, 1.1, plate, -0.66, -0.1, 0.55));
  g.add(block(0.85, 0.9, 1.1, plate, 0.66, -0.1, 0.55));

  // plain steel great helm — a thicker slab than the Heavy Knight's, no
  // plume/crest (utilitarian, defensive, not a mounted knight).
  const helm = new THREE.Group();
  helm.add(block(2.1, 1.8, 2.1, plate, 0, 0, 0));
  helm.add(block(2.2, 0.32, 2.2, plateD, 0, 0.55, 0));     // brow band
  helm.add(block(1.5, 0.24, 0.2, plateD, 0, 0.05, 1.05));  // visor slit
  helm.position.set(0, 4.15, 0);
  g.add(helm);

  // heavy sword — the same buildSword() the Warrior uses, scaled up.
  const sword = buildSword();
  sword.scale.setScalar(0.78);
  sword.position.set(2.35, 1.9, 0.4);
  sword.rotation.z = -0.12;
  g.add(sword);

  // broad shield on the opposite arm.
  const shield = buildTowerShield();
  shield.position.set(-2.15, 2.0, 0.3);
  g.add(shield);

  return g;
}
