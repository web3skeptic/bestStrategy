// Voxel spear model (primitives). Built in model units: the shaft is vertical,
// the leaf-blade spearhead points +Y, and the butt cap hangs toward -Y. Carried
// by the spearsman, who is otherwise the same "Voxel Guy" as the warrior.
import * as THREE from 'three';

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

export function buildSpear(): THREE.Group {
  const g = new THREE.Group();

  const steel = mat(0xd4d7dc, 0.42);  // leaf-blade head
  const midrib = mat(0x9197a0, 0.55); // central groove line
  const pewter = mat(0xb6bac1, 0.50); // ferrule + butt cap
  const wood = mat(0x80512e, 0.80);   // shaft

  // butt cap (the spear's heel)
  g.add(block(0.75, 0.90, 0.75, pewter, 0, -9.85, 0));

  // long wooden shaft
  g.add(block(0.55, 15.30, 0.55, wood, 0, -1.85, 0));

  // ferrule / socket where the head seats onto the shaft
  g.add(block(0.75, 1.00, 0.75, pewter, 0, 5.50, 0));

  // spearhead — stacked layers form a stepped leaf/diamond blade
  const D = 0.50;
  g.add(block(0.80, 0.40, D, steel, 0, 6.000, 0)); // base
  g.add(block(1.30, 0.40, D, steel, 0, 6.400, 0));
  g.add(block(1.70, 0.40, D, steel, 0, 6.800, 0));
  g.add(block(1.95, 0.50, D, steel, 0, 7.250, 0)); // widest
  g.add(block(1.80, 0.50, D, steel, 0, 7.750, 0));
  g.add(block(1.50, 0.50, D, steel, 0, 8.250, 0));
  g.add(block(1.15, 0.50, D, steel, 0, 8.750, 0));
  g.add(block(0.80, 0.50, D, steel, 0, 9.250, 0));
  g.add(block(0.50, 0.35, D, steel, 0, 9.675, 0));
  g.add(block(0.28, 0.25, D, steel, 0, 9.975, 0)); // point

  // central midrib line, front and back (darker, slightly proud)
  g.add(block(0.40, 3.40, 0.05, midrib, 0, 7.90, 0.255));
  g.add(block(0.40, 3.40, 0.05, midrib, 0, 7.90, -0.255));

  return g;
}
