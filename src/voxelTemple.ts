// Voxel temple — a battered-wall stepped pyramid (ziggurat) that grows with its
// upgrade level. The visual language is consistent across all 10 levels:
//
//   • a hexagonal base plate that fills the tile,
//   • truncated-pyramid tiers with sloped (battered) walls + vertical grooves,
//   • a recessed altar basin on the top tier,
//   • warm/team-tinted glowing niches set into the base walls.
//
// Each level either grows (an extra tier) or gains decorations around it
// (more niches, entry stairs, corner obelisks, banners, edge trim, glowing
// runes, a gold capstone, floating runes/jewels). Built in world units sitting
// on the tile at y = 0, then uniformly scaled up to fill the tile. The glowing
// niches/runes are team-tinted so ownership always reads (neutral = grey glow).
import * as THREE from 'three';

// ── stone / accent palette ────────────────────────────────────────────────────
const STONE_LT = 0xc8c4ba;
const STONE_MID = 0xada9a0;
const STONE_DK = 0x807d74;
const GOLD = 0xe0b020;
const GLOW = 0x00e6ff;

const MAX_LEVEL = 10;

// Uniform enlargement so the temple fills the hex tile (base plate ends up
// ~0.92 radius vs the tile's 1.0). Base stays on y = 0.
const TEMPLE_SCALE = 1.4;

// ── low-level primitive helpers ───────────────────────────────────────────────
function mat(color: number, rough: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
}

function emissiveMat(color: number, intensity: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: intensity, roughness: 0.4, metalness: 0,
  });
}

type Rot = { x?: number; y?: number; z?: number };

function block(
  w: number, h: number, d: number,
  material: THREE.Material,
  x: number, y: number, z: number,
  rot?: Rot,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  if (rot) m.rotation.set(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cyl(
  rTop: number, rBot: number, h: number, seg: number,
  material: THREE.Material,
  x: number, y: number, z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function sphere(r: number, material: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

// Flat-top hexagonal prism (matching the tile prisms in palette.ts).
function hexPrism(r: number, h: number, material: THREE.Material, y: number): THREE.Mesh {
  const m = cyl(r, r, h, 6, material, 0, y, 0);
  m.rotation.y = Math.PI / 6;
  return m;
}

// ── shared materials for one build ────────────────────────────────────────────
interface Mats {
  stoneLt: THREE.MeshStandardMaterial;
  stoneMid: THREE.MeshStandardMaterial;
  stoneDk: THREE.MeshStandardMaterial;
  gold: THREE.MeshStandardMaterial;
  team: THREE.MeshStandardMaterial; // solid team colour (banners)
  teamGlow: THREE.MeshStandardMaterial; // emissive, tinted to the team
  glow: THREE.MeshStandardMaterial; // cyan magic core
}

function makeMats(teamColor: number): Mats {
  return {
    stoneLt: mat(STONE_LT, 0.8),
    stoneMid: mat(STONE_MID, 0.85),
    stoneDk: mat(STONE_DK, 0.9),
    gold: mat(GOLD, 0.35),
    team: mat(teamColor, 0.7),
    teamGlow: emissiveMat(teamColor, 1.3),
    glow: emissiveMat(GLOW, 1.3),
  };
}

// ── ziggurat geometry ─────────────────────────────────────────────────────────
interface TierInfo { rBot: number; rTop: number; h: number; baseY: number; topY: number; }

// Bottom→top circumradius / height of each successive tier (a battered ziggurat).
const TIER_RBOT = [0.56, 0.40, 0.28, 0.18];
const TIER_RTOP = [0.46, 0.32, 0.22, 0.13];
const TIER_H = [0.32, 0.30, 0.26, 0.22];

// A battered (sloped-wall) square tier: a 4-sided frustum rotated so a flat face
// points to +z (the camera-facing front).
function tier(g: THREE.Group, rBot: number, rTop: number, h: number, baseY: number, material: THREE.Material): void {
  const m = cyl(rTop, rBot, h, 4, material, 0, baseY + h / 2, 0);
  m.rotation.y = Math.PI / 4;
  g.add(m);
}

// Tile-filling hexagonal base plate shared by every level.
function addPlinth(g: THREE.Group, M: Mats): void {
  g.add(hexPrism(0.66, 0.10, M.stoneMid, 0.05));
  g.add(hexPrism(0.58, 0.05, M.stoneLt, 0.115)); // lighter top lip
}

// Recessed altar basin on the top tier: a raised light rim around a sunken dark
// floor — reads as a carved pocket from the top-down camera.
function recessedTop(g: THREE.Group, M: Mats, rTop: number, topY: number): void {
  const s = rTop * Math.SQRT2; // top square side
  g.add(block(s * 0.62, 0.04, s * 0.62, M.stoneDk, 0, topY - 0.01, 0)); // sunken floor
  const rimH = 0.05, t = 0.07;
  g.add(block(s, rimH, t, M.stoneLt, 0, topY + rimH / 2, (s - t) / 2));
  g.add(block(s, rimH, t, M.stoneLt, 0, topY + rimH / 2, -(s - t) / 2));
  g.add(block(t, rimH, s - 2 * t, M.stoneLt, (s - t) / 2, topY + rimH / 2, 0));
  g.add(block(t, rimH, s - 2 * t, M.stoneLt, -(s - t) / 2, topY + rimH / 2, 0));
}

// Place a thin panel flush against a battered tier face (tilted to lie on the
// slope). face: 'F'ront/+z, 'B'ack/-z, 'R'ight/+x, 'L'eft/-x. off = lateral
// offset along the face.
function facePanel(
  g: THREE.Group, face: string, t: TierInfo,
  y: number, off: number, w: number, hgt: number, material: THREE.Material, proud = 0.03,
): void {
  const frac = (y - t.baseY) / t.h;
  const dist = (t.rBot + (t.rTop - t.rBot) * frac) / Math.SQRT2 + proud;
  const ang = Math.atan(((t.rBot - t.rTop) / Math.SQRT2) / t.h);
  if (face === 'F') g.add(block(w, hgt, 0.05, material, off, y, dist, { x: -ang }));
  else if (face === 'B') g.add(block(w, hgt, 0.05, material, off, y, -dist, { x: ang }));
  else if (face === 'R') g.add(block(0.05, hgt, w, material, dist, y, off, { z: ang }));
  else g.add(block(0.05, hgt, w, material, -dist, y, off, { z: -ang }));
}

// Vertical groove lines splitting the base-tier walls into carved panels.
function addGrooves(g: THREE.Group, M: Mats, t: TierInfo): void {
  const y = t.baseY + t.h * 0.52;
  const hgt = t.h * 0.78;
  facePanel(g, 'F', t, y, 0.16, 0.035, hgt, M.stoneDk);
  facePanel(g, 'F', t, y, -0.16, 0.035, hgt, M.stoneDk);
  facePanel(g, 'R', t, y, 0, 0.035, hgt, M.stoneDk);
  facePanel(g, 'L', t, y, 0, 0.035, hgt, M.stoneDk);
}

// Glowing (team-tinted) niche openings set into the base-tier walls.
function addNiches(g: THREE.Group, M: Mats, t: TierInfo, faces: string[]): void {
  const y = t.baseY + t.h * 0.42;
  for (const f of faces) facePanel(g, f, t, y, 0, 0.18, 0.20, M.teamGlow, 0.04);
}

// Glowing carved rune strips down a tier's walls (higher levels).
function addRuneStrips(g: THREE.Group, M: Mats, t: TierInfo): void {
  const y = t.baseY + t.h * 0.5;
  const hgt = t.h * 0.8;
  for (const f of ['F', 'R', 'L']) facePanel(g, f, t, y, 0, 0.05, hgt, M.teamGlow, 0.045);
}

// A short front entry stair climbing toward the temple.
function addStairs(g: THREE.Group, M: Mats, baseY: number, frontZ: number): void {
  for (let i = 0; i < 3; i++) {
    g.add(block(0.28, 0.07, 0.08, M.stoneMid, 0, baseY + 0.035 + i * 0.07, frontZ - i * 0.07));
  }
}

// Four small battered corner obelisks hugging the base.
function addCornerPosts(g: THREE.Group, M: Mats, d: number, baseY: number, h: number): void {
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = cyl(0.05, 0.075, h, 4, M.stoneLt, sx * d, baseY + h / 2, sz * d);
    post.rotation.y = Math.PI / 4;
    g.add(post);
    g.add(block(0.13, 0.05, 0.13, M.stoneDk, sx * d, baseY + h + 0.025, sz * d, { y: Math.PI / 4 }));
  }
}

// Two team banners (cloth + gold finial bead) hung on the front of a tier.
function addBanners(g: THREE.Group, M: Mats, t: TierInfo): void {
  const z = t.rTop / Math.SQRT2 + 0.04;
  for (const x of [-0.2, 0.2]) {
    g.add(block(0.10, 0.30, 0.015, M.team, x, t.topY - 0.17, z));
    g.add(sphere(0.03, M.gold, x, t.topY - 0.01, z));
  }
}

// A stone bowl + emissive (team-tinted) flame.
function addBrazier(g: THREE.Group, M: Mats, x: number, baseY: number, z: number): void {
  g.add(cyl(0.07, 0.05, 0.06, 8, M.stoneMid, x, baseY + 0.03, z));
  g.add(cyl(0, 0.06, 0.16, 8, M.teamGlow, x, baseY + 0.14, z));
}

// A front entrance gateway: two pillars + a lintel with a glowing team keystone.
function addGateway(g: THREE.Group, M: Mats, z: number): void {
  const baseY = 0.10, h = 0.34;
  for (const x of [-0.22, 0.22]) {
    const p = cyl(0.06, 0.08, h, 4, M.stoneLt, x, baseY + h / 2, z);
    p.rotation.y = Math.PI / 4;
    g.add(p);
  }
  g.add(block(0.62, 0.09, 0.12, M.stoneMid, 0, baseY + h + 0.045, z)); // lintel
  g.add(block(0.12, 0.12, 0.05, M.teamGlow, 0, baseY + h + 0.045, z + 0.07)); // keystone
}

// Four small pyramidal pinnacles on a tier's top corners.
function addCornerFinials(g: THREE.Group, t: TierInfo, material: THREE.Material): void {
  const c = t.rTop / Math.SQRT2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const p = cyl(0, 0.06, 0.14, 4, material, sx * c, t.topY + 0.07, sz * c);
    p.rotation.y = Math.PI / 4;
    g.add(p);
  }
}

// Gold (or stone) trim outlining each tier's exposed top edge.
function addTierTrim(g: THREE.Group, tiers: TierInfo[], material: THREE.Material): void {
  for (const t of tiers) {
    const s = t.rTop * Math.SQRT2;
    g.add(block(s, 0.035, 0.05, material, 0, t.topY, s / 2));
    g.add(block(s, 0.035, 0.05, material, 0, t.topY, -s / 2));
    g.add(block(0.05, 0.035, s, material, s / 2, t.topY, 0));
    g.add(block(0.05, 0.035, s, material, -s / 2, t.topY, 0));
  }
}

// Gold capstone pyramid + glowing apex on the top tier (L10).
function addCapstone(g: THREE.Group, M: Mats, topY: number): void {
  const pyr = cyl(0, 0.15, 0.20, 4, M.gold, 0, topY + 0.10, 0);
  pyr.rotation.y = Math.PI / 4;
  g.add(pyr);
  g.add(sphere(0.07, M.glow, 0, topY + 0.26, 0));
}

// Small emissive floating rune diamond.
function addFloatingRune(g: THREE.Group, M: Mats, x: number, y: number, z: number, tilt: number): void {
  g.add(block(0.10, 0.16, 0.02, M.teamGlow, x, y, z, { z: tilt }));
}

// Builds an N-tier battered ziggurat on the hex base, with grooves on the base
// tier and a recessed altar on top. Returns the tier metadata for decorations.
function buildZiggurat(g: THREE.Group, M: Mats, count: number, grooves: boolean): TierInfo[] {
  addPlinth(g, M);
  const shade = [M.stoneMid, M.stoneLt, M.stoneMid, M.stoneLt];
  const tiers: TierInfo[] = [];
  let baseY = 0.13;
  for (let i = 0; i < count; i++) {
    tier(g, TIER_RBOT[i], TIER_RTOP[i], TIER_H[i], baseY, shade[i]);
    const topY = baseY + TIER_H[i];
    tiers.push({ rBot: TIER_RBOT[i], rTop: TIER_RTOP[i], h: TIER_H[i], baseY, topY });
    baseY = topY;
  }
  const top = tiers[tiers.length - 1];
  recessedTop(g, M, top.rTop, top.topY);
  if (grooves) addGrooves(g, M, tiers[0]);
  return tiers;
}

// front-face z of a tier's bottom edge (for placing stairs/banners in front).
function frontFootZ(t: TierInfo): number {
  return t.rBot / Math.SQRT2;
}

/**
 * Build a temple sized for its upgrade level (1..10). The model sits on the tile
 * at y = 0; the caller positions the returned group on the board.
 */
export function buildTemple(teamColor: number, level: number): THREE.Group {
  const g = new THREE.Group();
  const lv = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level || 1)));
  const M = makeMats(teamColor);

  // Tier count grows 1 → 4 across the levels; decorations fill the in-betweens.
  const TIERS = [1, 1, 2, 2, 3, 3, 3, 4, 4, 4];
  const tiers = buildZiggurat(g, M, TIERS[lv - 1], /* grooves */ lv >= 2);
  const base = tiers[0];

  // Glowing niches — one face at L1, three from L2, all four once it's tall (L8+).
  if (lv === 1) addNiches(g, M, base, ['F']);
  else if (lv < 8) addNiches(g, M, base, ['F', 'L', 'R']);
  else addNiches(g, M, base, ['F', 'L', 'R', 'B']);

  // L4: an entrance — front gateway + climbing stairs.
  if (lv >= 4) {
    addStairs(g, M, 0.10, frontFootZ(base) + 0.10);
    addGateway(g, M, frontFootZ(base) + 0.13);
  }

  // L6: corner obelisks ring the temple (the prominent L5→L6 change).
  if (lv >= 6) addCornerPosts(g, M, 0.42, 0.10, 0.34);

  // L7: team banners + flaming braziers flanking the front.
  if (lv >= 7) {
    addBanners(g, M, base);
    addBrazier(g, M, -0.34, 0.10, frontFootZ(base) + 0.06);
    addBrazier(g, M, 0.34, 0.10, frontFootZ(base) + 0.06);
  }

  // L8: edge trim on every tier (stone), turning gold at L9.
  if (lv >= 8) addTierTrim(g, tiers, lv >= 9 ? M.gold : M.stoneLt);

  // L9: glowing runes on the 2nd tier + gold pinnacles on the base shoulders.
  if (lv >= 9) {
    if (tiers[1]) addRuneStrips(g, M, tiers[1]);
    addCornerFinials(g, base, M.gold);
  }

  // Apex: gold capstone + floating runes & jewels at L10.
  if (lv === 10) {
    const top = tiers[tiers.length - 1];
    addCapstone(g, M, top.topY);
    addFloatingRune(g, M, -0.46, 0.95, -0.46, 0.30);
    addFloatingRune(g, M, 0.46, 0.95, -0.46, -0.30);
    addFloatingRune(g, M, -0.46, 0.95, 0.46, -0.30);
    addFloatingRune(g, M, 0.46, 0.95, 0.46, 0.30);
    g.add(sphere(0.05, M.gold, -0.18, top.topY + 0.46, 0));
    g.add(sphere(0.05, M.glow, 0, top.topY + 0.52, 0));
    g.add(sphere(0.05, M.gold, 0.18, top.topY + 0.46, 0));
  }

  g.scale.setScalar(TEMPLE_SCALE); // enlarge to fill the tile (base stays on y = 0)
  return g;
}
