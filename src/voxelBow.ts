// Voxel bow model (primitives). Built in model units: the stave runs along Y
// (tips at y = ±8), the grip/riser bulges toward +X, and the bowstring runs
// straight nock-to-nock along Y at x = 0. Used as the archer's side weapon.
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

export function buildBow(): THREE.Group {
  const g = new THREE.Group();

  const woodMain = mat(0x9c6a39, 0.78);  // limbs (warm stave wood)
  const woodDark = mat(0x6b4420, 0.84);  // riser / handle core
  const leatherA = mat(0x95612e, 0.85);  // grip wrap, lighter band (matches the sword)
  const leatherB = mat(0x6f4520, 0.88);  // grip wrap, darker band  (matches the sword)
  const horn     = mat(0xe9e0cd, 0.50);  // horn tip nocks
  const flax     = mat(0xe7dcc0, 0.60);  // waxed bowstring

  const HY = 8.0;                                       // half-length (tip height)
  const BX = 2.6;                                       // belly bulge at the grip
  const xAt = (y: number): number => BX * Math.cos((Math.PI / 2) * (y / HY));  // limb centreline

  // ---- limb stave: chunky wood segments stepping along the arc ----
  const N = 22;
  for (let i = 0; i < N; i++) {
    const y0 = -HY + (2 * HY) * (i / N);
    const y1 = -HY + (2 * HY) * ((i + 1) / N);
    const x0 = xAt(y0), x1 = xAt(y1);
    const len = Math.hypot(x1 - x0, y1 - y0) + 0.06;    // tiny overlap hides seams
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const k   = Math.abs((y0 + y1) / 2) / HY;           // 0 at grip -> 1 at tip
    const wPerp = 0.86 - 0.42 * k;                      // in-plane width tapers
    const depth = 0.82 - 0.36 * k;                      // thickness (z) tapers
    const seg = new THREE.Mesh(new THREE.BoxGeometry(len, wPerp, depth), woodMain);
    seg.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
    seg.rotation.z = ang;
    seg.castShadow = true; seg.receiveShadow = true;
    g.add(seg);
  }

  // ---- horn nocks capping both tips ----
  [HY, -HY].forEach((ty) => {
    g.add(block(0.50, 0.58, 0.62, horn, xAt(ty), ty, 0));
  });

  // ---- riser / handle core, standing proud of the belly ----
  g.add(block(1.02, 3.0, 1.06, woodDark, BX + 0.14, 0, 0));

  // ---- leather-wrapped grip: alternating bands (same idea as the sword) ----
  const gy0 = -1.25, gH = 2.5, gn = 6, gbh = gH / gn;
  for (let i = 0; i < gn; i++) {
    const yc   = gy0 + gbh * (i + 0.5);
    const even = (i % 2 === 0);
    g.add(block(even ? 1.14 : 1.02, gbh + 0.02, even ? 1.18 : 1.06,
                even ? leatherA : leatherB, BX + 0.14, yc, 0));
  }

  // ---- cord bindings where the limbs join the riser ----
  [1.55, -1.55].forEach((yb) => {
    g.add(block(0.92, 0.34, 0.96, leatherB, xAt(yb) + 0.06, yb, 0));
  });

  // ---- bowstring: straight nock-to-nock, with a thicker centre serving ----
  g.add(block(0.10, 2 * HY, 0.10, flax, 0, 0, 0));
  g.add(block(0.16, 1.10, 0.16, flax, 0, 0, 0));

  return g;
}
