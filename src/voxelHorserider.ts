// Voxel horse + rider model for the horserider unit. The horse is built from
// primitives here; the rider reuses the same "Voxel Guy" as the warrior
// (buildGuy from voxelWarrior). Returned in model units (legs stand on y = 0);
// the renderer scales it down to fit a hex tile.
import * as THREE from 'three';
import { buildGuy } from './voxelWarrior';
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

// Horse: nose toward -X, tail toward +X, standing on y = 0.
function buildHorse(): THREE.Group {
  const H = new THREE.Group();

  const hide = mat(0x7d4e2f, 0.92); // body brown
  const dark = mat(0x5e3a22, 0.92); // tail (darker brown)
  const sad = mat(0xc45cbb, 0.7);   // saddle pink / magenta
  const eyeB = mat(0x161616, 0.6);  // eyes + nostrils
  const eyeW = mat(0xeae6e0, 0.6);  // eye highlight

  // body (lowered to sit on the shorter legs)
  H.add(block(4.2, 2.4, 2.4, hide, 0, 2.7, 0));

  // legs (shorter / stockier — were lh 2.7)
  const ly = 0.85, lh = 1.7;
  H.add(block(0.95, lh, 0.95, hide, -1.4, ly, 0.75));
  H.add(block(0.95, lh, 0.95, hide, -1.4, ly, -0.75));
  H.add(block(0.95, lh, 0.95, hide, 1.4, ly, 0.75));
  H.add(block(0.95, lh, 0.95, hide, 1.4, ly, -0.75));

  // tail
  H.add(block(0.7, 2.3, 0.9, dark, 2.35, 2.55, 0));

  // saddle
  H.add(block(2.2, 0.30, 2.2, sad, -0.20, 4.050, 0)); // pad
  H.add(block(1.6, 0.35, 1.7, sad, -0.20, 4.375, 0)); // seat
  H.add(block(0.5, 0.45, 1.7, sad, -1.15, 4.575, 0)); // front pommel

  // head + neck, leaned forward as one group
  const head = new THREE.Group();
  head.add(block(1.5, 2.2, 1.6, hide, 0.0, 0.6, 0));   // neck
  head.add(block(1.8, 1.8, 1.7, hide, -0.5, 2.3, 0));  // head box
  head.add(block(1.0, 1.0, 1.3, hide, -1.5, 1.7, 0));  // muzzle
  head.add(block(0.5, 0.7, 0.5, hide, -0.2, 3.45, 0.5));  // ear
  head.add(block(0.5, 0.7, 0.5, hide, -0.2, 3.45, -0.5)); // ear
  head.add(block(0.35, 0.40, 0.12, eyeB, -0.95, 2.55, 0.86));  // eye
  head.add(block(0.35, 0.40, 0.12, eyeB, -0.95, 2.55, -0.86)); // eye
  head.add(block(0.12, 0.14, 0.13, eyeW, -1.12, 2.68, 0.87));  // glint
  head.add(block(0.12, 0.14, 0.13, eyeW, -1.12, 2.68, -0.87)); // glint
  head.add(block(0.13, 0.28, 0.18, eyeB, -2.02, 1.60, 0.30));  // nostril
  head.add(block(0.13, 0.28, 0.18, eyeB, -2.02, 1.60, -0.30)); // nostril
  head.rotation.z = 0.38;
  head.position.set(-1.4, 3.6, 0);
  H.add(head);

  return H;
}

// Horse with the angry guy seated on the saddle. bodyColor tints the rider's
// torso to the owning player's team color.
export function buildHorseRider(bodyColor?: number): THREE.Group {
  const group = new THREE.Group();
  group.add(buildHorse());

  const rider = buildGuy(bodyColor);
  rider.scale.set(0.92, 0.6, 0.78); // bigger rider
  rider.rotation.y = -Math.PI / 2;  // face the same way as the horse
  rider.position.set(-0.15, 4.6, 0); // seated on the (lowered) saddle

  // Sword held by the horseman (same buildSword as the warrior), in the rider's
  // model space so it sits with him.
  const sword = buildSword();
  sword.scale.setScalar(0.72); // bigger sword
  sword.position.set(2.0, 1.6, 0.4);
  sword.rotation.z = -0.12;
  rider.add(sword);

  group.add(rider);

  return group;
}
