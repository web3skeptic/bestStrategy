// Voxel teleport portal: a chunky stone archway with a glowing portal surface
// inside, on a base slab. The portal surface + base are tinted to the team that
// built it; the arch stonework stays grey. Built in world units (sits on the
// tile at y = 0), so it can stand on any terrain.
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

export function buildPortal(teamColor: number): THREE.Group {
  const g = new THREE.Group();

  const stone = mat(0xada9a0, 0.85);    // arch stone, mid
  const stoneLt = mat(0xc8c4ba, 0.8);   // arch stone, lit
  const stoneDk = mat(0x807d74, 0.9);   // arch stone, shadow
  const baseMat = mat(teamColor, 0.6);  // team-colored base
  // Self-lit portal surface (emissive so it glows without adding a scene light).
  const portalMat = new THREE.MeshStandardMaterial({
    color: teamColor, emissive: teamColor, emissiveIntensity: 1.4, roughness: 0.4, metalness: 0,
  });

  // ── base slab (team color) ──
  g.add(block(1.25, 0.16, 1.05, baseMat, 0, 0.08, 0));
  g.add(block(1.05, 0.05, 0.86, mat(teamColor, 0.45), 0, 0.18, 0)); // lighter top lip

  const R = 0.44;       // arch radius (centreline of the stones)
  const springY = 0.52; // height where the arch springs from the pillars
  const bt = 0.27;      // stone block thickness

  // ── pillars (each side: base → springline) ──
  for (const sx of [-1, 1]) {
    g.add(block(bt, 0.24, bt, stone, sx * R, 0.30, 0));
    g.add(block(bt + 0.02, 0.26, bt + 0.02, stoneLt, sx * R, 0.52, 0));
  }

  // ── arch voussoirs along a semicircle centred at (0, springY) ──
  const N = 7;
  for (let i = 0; i <= N; i++) {
    const a = (Math.PI * i) / N;          // 0 (left) → π (right), π/2 = top
    const x = -Math.cos(a) * R;
    const y = springY + Math.sin(a) * R;
    const m = i % 2 === 0 ? stone : (i % 3 === 0 ? stoneDk : stoneLt);
    const s = i === 0 || i === N ? bt + 0.03 : bt;
    const bk = block(s, s, bt + 0.02, m, x, y, 0);
    bk.rotation.z = a - Math.PI / 2;       // tilt each stone to follow the arch
    g.add(bk);
  }

  // ── glowing portal surface (upright oval) filling the opening ──
  const portal = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 16), portalMat);
  portal.scale.set(1.02, 1.25, 0.16);      // flatten to an upright disc
  portal.position.set(0, 0.5, 0);
  g.add(portal);

  return g;
}
