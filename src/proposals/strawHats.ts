// STRAW HAT PROPOSALS — a One Piece-style straw hat for every Farmer humanoid,
// replacing the hair. Same plug as a hair style (HairBuilder), previewed at
// /hat-proposals. Head top is at y = 5.05, half-width 1.1, face on +Z; every
// hat sits ON the head with the brim above the brow line (~4.3) so the face
// stays fully open.
import * as THREE from 'three';
import { HairBuilder, guyBlock as block } from '../voxelWarrior';

const STRAW = 0xe8c96a, STRAW_DK = 0xc9a64b, BAND_RED = 0xc4302b;
function m(color: number, rough = 0.92): THREE.MeshStandardMaterial { return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 }); }
function cyl(g: THREE.Group, rt: number, rb: number, h: number, seg: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh;
}
// Shared crown: dome-ish stack with two darker straw rings.
function crown(g: THREE.Group, r: number, y: number, h: number, seg: number, band: number): void {
  cyl(g, r * 0.97, r, h, seg, m(STRAW), 0, y + h / 2, 0);
  cyl(g, r * 0.72, r * 0.95, 0.32, seg, m(STRAW), 0, y + h + 0.16, 0);
  cyl(g, r * 1.03, r * 1.05, 0.28, seg, m(band, 0.75), 0, y + 0.22, 0);
  cyl(g, r * 1.0, r * 1.0, 0.06, seg, m(STRAW_DK), 0, y + h * 0.62, 0);
  cyl(g, r * 0.99, r * 0.99, 0.06, seg, m(STRAW_DK), 0, y + h * 0.88, 0);
}
function shortHairUnder(g: THREE.Group, hair: THREE.Material): void {
  block(2.3, 0.35, 2.2, hair, 0, 5.0, 0);
  block(2.3, 0.7, 0.3, hair, 0, 4.85, -1.15);
  block(0.3, 0.6, 1.2, hair, -1.2, 4.9, -0.35);
  block(0.3, 0.6, 1.2, hair, 1.2, 4.9, -0.35);
}

export interface HatStyle { id: string; name: string; blurb: string; build: HairBuilder; }

// A · Luffy classic: round crown, wide flat brim, red band.
const luffy: HairBuilder = (g) => {
  cyl(g, 2.35, 2.35, 0.16, 12, m(STRAW), 0, 5.16, 0);
  cyl(g, 2.35, 2.35, 0.05, 12, m(STRAW_DK), 0, 5.06, 0);
  crown(g, 1.38, 5.24, 0.8, 12, BAND_RED);
};

// B · Team band: same hat, band in the owner's colour.
const teamBand: HairBuilder = (g, _hair, teamColor) => {
  cyl(g, 2.35, 2.35, 0.16, 12, m(STRAW), 0, 5.16, 0);
  cyl(g, 2.35, 2.35, 0.05, 12, m(STRAW_DK), 0, 5.06, 0);
  crown(g, 1.38, 5.24, 0.8, 12, teamColor);
};

// C · Wide drooping brim: bigger brim that turns down at the edge.
export const wideBrimHat: HairBuilder = (g) => {
  cyl(g, 2.1, 2.1, 0.16, 12, m(STRAW), 0, 5.18, 0);
  cyl(g, 2.75, 2.15, 0.34, 12, m(STRAW), 0, 5.02, 0);
  cyl(g, 2.72, 2.72, 0.05, 12, m(STRAW_DK), 0, 4.84, 0);
  crown(g, 1.36, 5.26, 0.7, 12, BAND_RED);
};

// D · Low boater with hair showing: flat, shallow crown, narrower brim.
const boater: HairBuilder = (g, hair) => {
  shortHairUnder(g, hair);
  cyl(g, 2.05, 2.05, 0.14, 12, m(STRAW), 0, 5.22, 0);
  cyl(g, 1.3, 1.34, 0.55, 12, m(STRAW), 0, 5.56, 0);
  cyl(g, 1.34, 1.36, 0.24, 12, m(BAND_RED, 0.75), 0, 5.44, 0);
  cyl(g, 1.3, 1.3, 0.08, 12, m(STRAW_DK), 0, 5.86, 0);
};

// E · Rustic: octagonal blocky weave, frayed brim, wheat stalk in the band.
const rustic: HairBuilder = (g, _hair, teamColor) => {
  cyl(g, 2.3, 2.3, 0.18, 8, m(STRAW), 0, 5.16, 0);
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8;
    const fray = block(0.45, 0.12, 0.3, m(i % 2 ? STRAW_DK : STRAW), Math.cos(a) * 2.4, 5.14, Math.sin(a) * 2.4);
    fray.rotation.y = -a; g.add(fray);
  }
  crown(g, 1.4, 5.25, 0.85, 8, teamColor);
  const stalk = block(0.08, 0.9, 0.08, m(0xd6b24a), 1.25, 5.85, 0.55); stalk.rotation.z = -0.35; g.add(stalk);
  const ear = block(0.16, 0.3, 0.12, m(0xd6b24a), 1.42, 6.25, 0.55); ear.rotation.z = -0.35; g.add(ear);
};

// F · Pushed back: the classic hat tipped back on the head, face wide open.
const tippedBack: HairBuilder = (g, hair) => {
  shortHairUnder(g, hair);
  const hat = new THREE.Group();
  cyl(hat, 2.3, 2.3, 0.16, 12, m(STRAW), 0, 0, 0);
  cyl(hat, 2.3, 2.3, 0.05, 12, m(STRAW_DK), 0, -0.1, 0);
  crown(hat, 1.36, 0.08, 0.78, 12, BAND_RED);
  hat.position.set(0, 5.28, -0.35); hat.rotation.x = -0.32;
  g.add(hat);
};

export const STRAW_HATS: HatStyle[] = [
  { id: 'luffy', name: 'A · Classic', blurb: 'Round crown, wide flat brim, red band — the One Piece silhouette as-is.', build: luffy },
  { id: 'team', name: 'B · Team band', blurb: 'Same hat with the band in the owner\'s colour, so ownership reads on the head too.', build: teamBand },
  { id: 'droop', name: 'C · Wide brim', blurb: 'Bigger brim that turns down at the edge — reads bigger from the top-down camera.', build: wideBrimHat },
  { id: 'boater', name: 'D · Low boater', blurb: 'Flat, shallow crown and narrower brim with short hair showing under it.', build: boater },
  { id: 'rustic', name: 'E · Rustic', blurb: 'Blocky octagonal weave, frayed brim, team band, a wheat stalk tucked in.', build: rustic },
  { id: 'back', name: 'F · Pushed back', blurb: 'The classic hat tipped back on the head with hair showing — face wide open.', build: tippedBack },
];
