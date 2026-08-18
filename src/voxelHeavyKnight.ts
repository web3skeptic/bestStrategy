// Voxel barded warhorse + armored knight for the heavyknight unit. This is the
// "heavy" sibling of the horserider: it reuses the same horse proportions and
// the same "Voxel Guy" rider (buildGuy from voxelWarrior, torso tinted to the
// owning player's team color), but clads both in steel plate + barding and adds
// a crimson-plumed helm so it reads as the Heavy Chivalry unit. Returned in
// model units (legs stand on y = 0, ~8 units tall); the renderer scales it down
// to fit a hex tile.
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

// Barded warhorse: same proportions as buildHorse() (body 4.2×2.4×2.4, four legs
// at x=±1.4 / z=±0.75, nose toward -X, tail toward +X, standing on y = 0), but
// plated in steel + leather barding instead of bare hide.
function buildArmoredHorse(): THREE.Group {
  const H = new THREE.Group();

  const steel = mat(0x8e8e96, 0.55);  // bright plate
  const steelD = mat(0x5f5f68, 0.6);  // dark plate (tail, recesses)
  const leather = mat(0x6b4a2c, 0.8); // saddle / barding straps
  const leatherD = mat(0x4d3420, 0.85); // darker leather
  const eyeB = mat(0x161616, 0.6);    // eyes + nostrils
  const eyeW = mat(0xeae6e0, 0.6);    // eye highlight

  // body (steel-plated, lowered to sit on the shorter legs)
  H.add(block(4.2, 2.4, 2.4, steel, 0, 2.7, 0));

  // side barding: leather caparison skirts hanging over the flanks
  H.add(block(3.6, 1.2, 0.22, leather, 0, 2.0, 1.26));
  H.add(block(3.6, 1.2, 0.22, leather, 0, 2.0, -1.26));
  // a darker hem along the bottom of each skirt
  H.add(block(3.6, 0.30, 0.24, leatherD, 0, 1.45, 1.26));
  H.add(block(3.6, 0.30, 0.24, leatherD, 0, 1.45, -1.26));

  // legs (armored, shorter / stockier)
  const ly = 0.85, lh = 1.7;
  H.add(block(0.95, lh, 0.95, steel, -1.4, ly, 0.75));
  H.add(block(0.95, lh, 0.95, steel, -1.4, ly, -0.75));
  H.add(block(0.95, lh, 0.95, steel, 1.4, ly, 0.75));
  H.add(block(0.95, lh, 0.95, steel, 1.4, ly, -0.75));

  // tail (dark plate, to match the barding)
  H.add(block(0.7, 2.3, 0.9, steelD, 2.35, 2.55, 0));

  // saddle (steel-trimmed leather)
  H.add(block(2.2, 0.30, 2.2, leather, -0.20, 4.050, 0));  // pad
  H.add(block(1.6, 0.35, 1.7, leatherD, -0.20, 4.375, 0)); // seat
  H.add(block(0.5, 0.45, 1.7, steelD, -1.15, 4.575, 0));   // front pommel (steel)

  // head + neck, leaned forward as one group — chamfron (face plate) over it
  const head = new THREE.Group();
  head.add(block(1.5, 2.2, 1.6, steel, 0.0, 0.6, 0));   // neck (plated)
  head.add(block(1.8, 1.8, 1.7, steel, -0.5, 2.3, 0));  // head box
  head.add(block(1.0, 1.0, 1.3, steel, -1.5, 1.7, 0));  // muzzle (chamfron)
  // raised crest ridge running down the chamfron
  head.add(block(0.40, 1.9, 0.30, steelD, -0.5, 2.45, 0));
  head.add(block(0.5, 0.7, 0.5, steel, -0.2, 3.45, 0.5));  // ear guard
  head.add(block(0.5, 0.7, 0.5, steel, -0.2, 3.45, -0.5)); // ear guard
  head.add(block(0.35, 0.40, 0.12, eyeB, -0.95, 2.55, 0.86));  // eye
  head.add(block(0.35, 0.40, 0.12, eyeB, -0.95, 2.55, -0.86)); // eye
  head.add(block(0.12, 0.14, 0.13, eyeW, -1.12, 2.68, 0.87));  // glint
  head.add(block(0.12, 0.14, 0.13, eyeW, -1.12, 2.68, -0.87)); // glint
  head.add(block(0.13, 0.28, 0.18, eyeB, -2.02, 1.60, 0.30));  // nostril
  head.add(block(0.13, 0.28, 0.18, eyeB, -2.02, 1.60, -0.30)); // nostril
  // noseband strap across the muzzle
  head.add(block(0.20, 1.0, 1.35, leatherD, -1.85, 1.7, 0));
  head.rotation.z = 0.38;
  head.position.set(-1.4, 3.6, 0);
  H.add(head);

  return H;
}

// Armored rider: the angry Voxel Guy (team-tinted torso via bodyColor) re-clad in
// knight's plate — pauldrons, a great helm with visor slit, and a crimson plume.
// The base guy is built and seated exactly like the horserider's rider; the armor
// is added on top in guy-model space so it scales/rotates with him.
function buildArmoredRider(bodyColor?: number): THREE.Group {
  const rider = buildGuy(bodyColor); // torso tinted to the owning player's team color

  const plate = mat(0x989aa4, 0.55);  // bright plate
  const plateD = mat(0x62626c, 0.6);  // dark plate (visor band, trim)
  const crimson = mat(0xb23a3a, 0.7); // livery plume / crest
  const visor = mat(0x14141a, 0.5);   // visor slit

  // pauldrons capping each shoulder (guy torso is 3.0 wide, top near y≈3.2)
  rider.add(block(1.0, 0.85, 1.7, plate, -1.55, 3.05, 0));
  rider.add(block(1.0, 0.85, 1.7, plate, 1.55, 3.05, 0));
  // breastplate slab over the front of the torso
  rider.add(block(2.4, 2.0, 0.35, plate, 0, 1.9, 1.0));
  rider.add(block(0.35, 2.0, 0.30, plateD, 0, 1.9, 1.18)); // central ridge

  // great helm: a plate box enclosing the head (guy head sits at y≈4.1), with a
  // dark visor slit and a brow band, then a crimson plume on top.
  const helm = new THREE.Group();
  helm.add(block(1.9, 1.7, 1.95, plate, 0, 0, 0));         // helm shell
  helm.add(block(2.0, 0.30, 2.0, plateD, 0, 0.55, 0));     // brow band
  helm.add(block(1.4, 0.22, 0.20, visor, 0, 0.05, 1.0));   // visor slit (front +Z)
  // crimson plume / crest sweeping back over the crown
  helm.add(block(0.45, 0.55, 0.9, crimson, 0, 1.05, -0.1));
  helm.add(block(0.45, 0.45, 0.7, crimson, 0, 1.45, -0.5));
  helm.add(block(0.45, 0.35, 0.5, crimson, 0, 1.75, -0.85));
  helm.position.set(0, 4.15, 0);
  rider.add(helm);

  return rider;
}

// Barded warhorse with the armored knight seated on the saddle. bodyColor tints
// the rider's torso to the owning player's team color.
export function buildHeavyKnight(bodyColor?: number): THREE.Group {
  const group = new THREE.Group();
  group.add(buildArmoredHorse());

  const rider = buildArmoredRider(bodyColor);
  rider.scale.set(0.92, 0.6, 0.78); // bigger rider
  rider.rotation.y = -Math.PI / 2;  // face the same way as the horse
  rider.position.set(-0.15, 4.6, 0); // seated on the (lowered) saddle

  // Sword held point-up in the rider's hand — the SAME buildSword() the warrior
  // uses, scaled down and rotated, not re-implemented here. Added to the rider so
  // it inherits his seat transform.
  const sword = buildSword();
  sword.scale.setScalar(0.72); // bigger sword
  sword.position.set(2.0, 1.6, 0.4);
  sword.rotation.z = -0.12;
  rider.add(sword);

  group.add(rider);

  return group;
}
