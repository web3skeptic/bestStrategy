// Voxel heavy infantry model for the Farmer Warden — a slow, durable frontline
// unit with NO mount (unlike the horserider/heavyknight models it shares its
// engine slot with — see voxelUnits.ts, which picks this model over
// buildHorseRider purely by faction). Built from the same "Voxel Guy" base
// body as the Warrior (buildGuy, torso tinted to the owning player's team
// color) with the Farmer head/hat/face untouched, bulked up in padded
// leather armour, carrying a broad wooden tower shield and a heavy sword.
// Built in model units (feet at y = 0, ~8 units tall, same reference frame as
// buildGuy/buildHeavyKnight); the renderer scales it down to fit a hex tile.
import * as THREE from 'three';
import { buildGuy, HairBuilder, FaceStyle } from './voxelWarrior';
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

// Broad wooden tower shield, strapped to the left arm (-X side, opposite the
// sword): planks with an iron rim and a team-coloured centre panel.
function buildTowerShield(teamColor: number): THREE.Group {
  const g = new THREE.Group();
  const wood = mat(0x8a6a42, 0.9);
  const woodD = mat(0x5a4028, 0.9);
  const iron = mat(0x6f7079, 0.55);
  const team = mat(teamColor, 0.75);

  g.add(block(0.30, 2.7, 1.9, wood, 0, 0, 0));            // plank face
  for (const z of [-0.5, 0.1, 0.7]) g.add(block(0.32, 2.7, 0.06, woodD, 0, 0, z)); // plank seams
  g.add(block(0.14, 2.8, 0.22, iron, 0.20, 0, 0.9));      // right rim
  g.add(block(0.14, 2.8, 0.22, iron, 0.20, 0, -0.9));     // left rim
  g.add(block(0.14, 0.22, 1.95, iron, 0.20, 1.3, 0));     // top rim
  g.add(block(0.14, 0.22, 1.95, iron, 0.20, -1.3, 0));    // bottom rim
  g.add(block(0.16, 1.1, 0.9, team, 0.18, 0.1, 0));       // team panel
  g.add(block(0.36, 0.36, 0.36, iron, 0.22, 0.1, 0));     // boss
  return g;
}

// Heavy farm guard: the same guy body as the Warrior — with the tribe's own
// head, hat and face left completely uncovered (no helm; an earlier great
// helm slab z-fought with the head and read as a grey robot) — bulked up with
// thick padded-leather armour: broad shoulder pads with team trim, a riveted
// leather cuirass, a waist guard and leather greaves. Heavy sword in the right
// hand, a broad wooden tower shield on the left.
export function buildWarden(bodyColor?: number, hairStyle?: HairBuilder, hairColor?: number, faceStyle?: FaceStyle): THREE.Group {
  const teamColor = bodyColor ?? 0xf1cb16;
  const g = buildGuy(bodyColor, hairStyle, hairColor, faceStyle);

  const leather = mat(0x8a5a3a, 0.9);
  const leatherD = mat(0x5a3a22, 0.9);
  const iron = mat(0x6f7079, 0.55);
  const team = mat(teamColor, 0.75);

  // broad padded shoulder pads with a team-coloured trim strip
  g.add(block(1.2, 1.0, 2.0, leather, -1.7, 3.05, 0));
  g.add(block(1.2, 1.0, 2.0, leather, 1.7, 3.05, 0));
  g.add(block(1.25, 0.22, 2.05, team, -1.7, 3.6, 0));
  g.add(block(1.25, 0.22, 2.05, team, 1.7, 3.6, 0));

  // riveted leather cuirass over the chest + waist guard
  g.add(block(2.6, 2.2, 0.4, leather, 0, 1.9, 1.05));
  g.add(block(0.4, 2.2, 0.32, leatherD, 0, 1.9, 1.24));
  for (const x of [-0.95, 0.95]) for (const y of [1.2, 2.5]) g.add(block(0.18, 0.18, 0.12, iron, x, y, 1.3));
  g.add(block(2.7, 0.5, 2.3, leatherD, 0, 0.4, 0));
  g.add(block(2.75, 0.14, 2.35, iron, 0, 0.62, 0)); // belt buckle line

  // leather greaves over the shins, in front of the guy's own feet blocks
  g.add(block(0.85, 0.9, 1.1, leatherD, -0.66, -0.1, 0.55));
  g.add(block(0.85, 0.9, 1.1, leatherD, 0.66, -0.1, 0.55));

  // heavy sword — the same buildSword() the Warrior uses, scaled up.
  const sword = buildSword();
  sword.scale.setScalar(0.78);
  sword.position.set(2.35, 1.9, 0.4);
  sword.rotation.z = -0.12;
  g.add(sword);

  // broad shield on the opposite arm.
  const shield = buildTowerShield(teamColor);
  shield.position.set(-2.15, 2.0, 0.3);
  g.add(shield);

  return g;
}
