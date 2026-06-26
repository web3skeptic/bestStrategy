// Voxel sword model (primitives). Built in model units: blade points +Y, the
// crossguard sits at y = 0, the grip/pommel hang toward -Y. Used both as the
// warrior's side weapon and as the sword-slash hit effect.
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

export function buildSword(): THREE.Group {
  const g = new THREE.Group();

  const steel = mat(0xd4d7dc, 0.42);  // bright blade
  const fuller = mat(0x9197a0, 0.55); // recessed darker groove
  const gold = mat(0xd8b35e, 0.55);   // crossguard + pommel (tan-gold)
  const wrapA = mat(0x95612e, 0.85);  // grip wrap, lighter band
  const wrapB = mat(0x6f4520, 0.88);  // grip wrap, darker band

  // pommel
  g.add(block(1.10, 0.70, 1.00, gold, 0, -3.70, 0));

  // wrapped grip: alternating bands give a ridged, leather-wrapped look
  const y0 = -3.35, H = 3.0, n = 6, bh = H / n;
  for (let i = 0; i < n; i++) {
    const yc = y0 + bh * (i + 0.5);
    const even = i % 2 === 0;
    g.add(block(even ? 0.84 : 0.74, bh + 0.02, even ? 0.84 : 0.74, even ? wrapA : wrapB, 0, yc, 0));
  }

  // crossguard
  g.add(block(3.00, 0.70, 0.90, gold, 0, 0, 0));

  // blade body: two bright edge rails flanking a recessed darker fuller
  const by = 3.85, bH = 7.0;
  g.add(block(0.45, bH, 0.50, steel, -0.575, by, 0)); // left edge
  g.add(block(0.45, bH, 0.50, steel, 0.575, by, 0));  // right edge
  g.add(block(0.72, bH, 0.40, fuller, 0, by, 0));     // recessed central groove

  // stepped point
  g.add(block(1.30, 0.50, 0.50, steel, 0, 7.600, 0));
  g.add(block(0.95, 0.40, 0.50, steel, 0, 8.050, 0));
  g.add(block(0.60, 0.35, 0.50, steel, 0, 8.425, 0));
  g.add(block(0.30, 0.30, 0.50, steel, 0, 8.750, 0));

  return g;
}
