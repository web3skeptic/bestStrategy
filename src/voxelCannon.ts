// Voxel cannon (the "catapult" unit's model). A faceted low-poly barrel — bulbous
// breech, narrowing chase, flared muzzle bell — sitting on a wooden sled with four
// chunky black wheels, plus a little touch-hole vent on top of the breech. The
// barrel is tinted to the team colour for ownership.
//
// Orientation: the muzzle (front) points toward +Z, so the renderer can rotate
// the unit to face its firing direction. Built on the tile at y = 0.
import * as THREE from 'three';

function mat(color: number, rough: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
}

function block(
  w: number, h: number, d: number,
  material: THREE.Material,
  x: number, y: number, z: number,
  rot?: { x?: number; y?: number; z?: number },
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  if (rot) m.rotation.set(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// A wheel: short octagonal cylinder, axle running along X (round face sideways).
function wheel(material: THREE.Material, hubMat: THREE.Material, x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.12, 8), material);
  tire.rotation.z = Math.PI / 2; // axis → X
  tire.castShadow = true; tire.receiveShadow = true;
  g.add(tire);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.14, 6), hubMat);
  hub.rotation.z = Math.PI / 2;
  hub.castShadow = true;
  g.add(hub);
  g.position.set(x, y, z);
  return g;
}

// A barrel segment: an 8-sided frustum whose length runs along Z. rFront is the
// +Z (muzzle-side) radius, rBack the -Z radius.
function tube(rFront: number, rBack: number, len: number, zc: number, y: number, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rFront, rBack, len, 8), material);
  m.rotation.x = Math.PI / 2; // cylinder height (+Y → +Z) runs along Z
  m.position.set(0, y, zc);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function buildCannon(teamColor: number): THREE.Group {
  const g = new THREE.Group();

  const woodLt = mat(0xd8be97, 0.85);  // pale sled timber
  const woodMid = mat(0xbfa07a, 0.85);
  const tire = mat(0x191a1f, 0.7);     // black wheels
  const dark = mat(0x0c0d10, 0.6);     // bore / shadow
  const vent = mat(0xe9e6dc, 0.7);     // pale touch-hole stick
  const barrel = mat(teamColor, 0.5);  // team-tinted gun metal
  const barrelDk = mat(teamColor, 0.7);

  const BY = 0.42; // barrel centre height

  // ── wooden sled (two rails + cross-beams) ──
  g.add(block(0.16, 0.12, 0.92, woodLt, -0.2, 0.30, 0));
  g.add(block(0.16, 0.12, 0.92, woodLt, 0.2, 0.30, 0));
  g.add(block(0.56, 0.11, 0.18, woodMid, 0, 0.30, -0.28));
  g.add(block(0.56, 0.11, 0.18, woodMid, 0, 0.30, 0.20));
  // small cradle blocks the barrel rests in
  g.add(block(0.30, 0.14, 0.16, woodMid, 0, 0.40, -0.12));
  g.add(block(0.30, 0.12, 0.16, woodMid, 0, 0.38, 0.18));

  // ── wheels (4 corners) ──
  g.add(wheel(tire, barrelDk, -0.30, 0.16, -0.26));
  g.add(wheel(tire, barrelDk, 0.30, 0.16, -0.26));
  g.add(wheel(tire, barrelDk, -0.30, 0.16, 0.26));
  g.add(wheel(tire, barrelDk, 0.30, 0.16, 0.26));

  // ── barrel (front = +Z) ──
  // bulbous breech ball at the back
  const breech = new THREE.Mesh(new THREE.SphereGeometry(0.21, 10, 8), barrel);
  breech.position.set(0, BY, -0.36);
  breech.castShadow = true;
  g.add(breech);
  g.add(tube(0.235, 0.255, 0.10, -0.30, BY, barrelDk)); // breech reinforce band
  // chase: wide at breech, tapering forward to a neck
  g.add(tube(0.165, 0.235, 0.46, -0.02, BY, barrel));
  g.add(tube(0.15, 0.165, 0.06, 0.24, BY, barrelDk));  // astragal ring
  // flared muzzle bell
  g.add(tube(0.27, 0.16, 0.18, 0.36, BY, barrel));
  g.add(tube(0.285, 0.265, 0.05, 0.47, BY, barrelDk)); // muzzle lip
  g.add(tube(0.18, 0.18, 0.10, 0.45, BY, dark));        // bore (dark hole)

  // ── touch-hole vent on top of the breech ──
  g.add(block(0.05, 0.18, 0.05, vent, 0, BY + 0.24, -0.30, { x: -0.3 }));

  g.scale.setScalar(1.2); // enlarge to read as a hefty siege weapon (base stays on y = 0)
  return g;
}
