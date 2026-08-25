// Voxel Farm — a small agricultural plot, visually distinct from the shared
// Temple/Capital ziggurat model (voxelTemple.ts) it used to placeholder-reuse.
// Built from simple primitives: a soil plinth, rows of crops, a small hut
// with a team-tinted roof, and a low perimeter fence — low-profile so it
// never hides units standing behind it. Takes a coarse `damageStage`
// (0 = healthy, 1 = damaged, 2 = heavily damaged) so a Farm under fire
// visibly degrades before it's destroyed outright (structure combat pass).
import * as THREE from 'three';

const SOIL = 0x8a6b45;
const SOIL_DK = 0x5f4a30;
const CROP_GREEN = 0x5fae3a;
const CROP_WILTED = 0xb8a030;
const CROP_DEAD = 0x6b5a30;
const HUT_WALL = 0xcabf9e;
const HUT_ROOF = 0x8a4a2e;
const HUT_ROOF_DAMAGED = 0x4a2e1e;
const FENCE = 0x6b4a2e;
const SMOKE = 0x555555;

// Enlarges the plot to a sensible footprint within the hex tile — smaller
// than a Temple/Capital (a Farm is deliberately modest next to them).
const FARM_SCALE = 1.15;

function mat(color: number, rough = 0.9): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
}

function block(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number, rotY = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  if (rotY) m.rotation.y = rotY;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cone(r: number, h: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 6), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function pyramidRoof(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const geo = new THREE.ConeGeometry(Math.max(w, d) * 0.72, h, 4);
  geo.rotateY(Math.PI / 4);
  geo.scale(1, 1, d / w);
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// One small crop cluster (a few short cones on a stubby stem) — a single
// "instance" repeated in a grid to read as planted rows from any camera angle.
function cropCluster(material: THREE.Material, x: number, z: number, healthy: boolean): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const h = healthy ? 0.16 : 0.10;
  g.add(cone(0.05, h, material, 0, h / 2 + 0.02, 0));
  if (healthy) {
    g.add(cone(0.04, 0.12, material, 0.06, 0.08, 0.04));
    g.add(cone(0.04, 0.12, material, -0.05, 0.08, -0.05));
  }
  if (!healthy) g.rotation.z = 0.35; // bent/wilted lean
  return g;
}

export function buildFarm(teamColor: number, damageStage: 0 | 1 | 2 = 0): THREE.Group {
  const g = new THREE.Group();
  const soilMat = mat(damageStage >= 2 ? SOIL_DK : SOIL);
  const cropColor = damageStage >= 2 ? CROP_DEAD : damageStage >= 1 ? CROP_WILTED : CROP_GREEN;
  const cropMat = mat(cropColor, 0.85);
  const teamMat = new THREE.MeshStandardMaterial({ color: teamColor, roughness: 0.6, metalness: 0.1 });

  // Soil plot — a low, wide plinth filling most of the tile.
  g.add(block(1.5, 0.08, 1.5, soilMat, 0, 0.04, 0));

  // Crop rows — a grid, skipping cells as damage increases (a raided/burned
  // field, not a uniform darken) so the degradation reads at a glance.
  const rows = 3, cols = 4;
  let cell = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cell++;
      // Deterministic "randomness" (no Math.random — meshes must be stable
      // across rebuilds with the same damageStage) via a simple hash.
      const skip = damageStage === 1 && cell % 3 === 0;
      const skipMore = damageStage === 2 && cell % 2 === 0;
      if (skip || skipMore) continue;
      const x = (c - (cols - 1) / 2) * 0.30;
      const z = (r - (rows - 1) / 2) * 0.34 - 0.15;
      g.add(cropCluster(cropMat, x, z, damageStage === 0));
    }
  }

  // Small hut in the back corner — the farm's "structure" component that
  // visibly takes damage (roof darkens/tilts, then loses its roof outright).
  const hutX = 0.48, hutZ = 0.48;
  const wallMat = mat(HUT_WALL, 0.85);
  g.add(block(0.34, 0.22, 0.34, wallMat, hutX, 0.15, hutZ));
  if (damageStage < 2) {
    const roofMat = mat(damageStage === 1 ? HUT_ROOF_DAMAGED : HUT_ROOF, 0.7);
    const roof = pyramidRoof(0.4, 0.18, 0.4, roofMat, hutX, 0.35, hutZ);
    if (damageStage === 1) roof.rotation.z = 0.12; // slightly knocked askew
    g.add(roof);
  } else {
    // Roof is gone outright — charred stub + a little smoke puff.
    const smokeMat = new THREE.MeshStandardMaterial({ color: SMOKE, roughness: 1, transparent: true, opacity: 0.55 });
    const smoke = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), smokeMat);
    smoke.position.set(hutX, 0.34, hutZ);
    g.add(smoke);
  }
  // Team-colored door trim — faction ownership reads even at a glance.
  g.add(block(0.08, 0.14, 0.03, teamMat, hutX, 0.11, hutZ + 0.185));

  // Low perimeter fence — thin posts around the plot edge, missing a few
  // once heavily damaged (a raided field, fence knocked down).
  const fenceMat = mat(FENCE, 0.9);
  const fencePositions: [number, number][] = [
    [-0.72, -0.6], [-0.36, -0.68], [0, -0.72], [0.36, -0.68], [0.72, -0.6],
    [-0.72, 0.6], [-0.36, 0.68], [0.72, 0.6],
  ];
  fencePositions.forEach(([x, z], idx) => {
    if (damageStage >= 2 && idx % 3 === 0) return; // knocked-down gap
    g.add(block(0.04, 0.16, 0.04, fenceMat, x, 0.08, z));
  });

  g.scale.setScalar(FARM_SCALE);
  return g;
}
