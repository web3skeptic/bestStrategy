// HAIR PROPOSALS — alternatives to the current "blocky helmet" hair on every
// humanoid unit, which wraps the whole head and reaches down past the
// eyebrows, hiding most of the face. Previewed at /hair-proposals.
//
// Head box: 2.2 wide x 1.9 tall x 2.1 deep, centred at y = 4.1 (top at 5.05,
// chin at 3.15), face on +Z. The eyebrows sit at y ~ 4.3, so every style here
// keeps the FRONT of the hair above y ~ 4.8 and pulls the sides back off the
// cheeks — the face always stays open.
import * as THREE from 'three';
import { HairBuilder, defaultHair, guyBlock as block } from '../voxelWarrior';

function dark(): THREE.MeshStandardMaterial { return new THREE.MeshStandardMaterial({ color: 0x3a2412, roughness: 0.9, metalness: 0 }); }
function tint(c: number): THREE.MeshStandardMaterial { return new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, metalness: 0 }); }

export interface HairStyle { id: string; name: string; blurb: string; build: HairBuilder; }

// Same silhouette as today, just shallower: sides stop at cheekbone height,
// fringe lifted above the brows, back trimmed.
const bowlLite: HairBuilder = (g, hair) => {
  g.add(block(2.45, 0.6, 2.4, hair, 0, 5.3, 0));
  g.add(block(1.6, 0.4, 1.6, hair, 0, 5.8, -0.1));
  g.add(block(2.4, 1.3, 0.4, hair, 0, 4.6, -1.2));
  g.add(block(0.35, 1.0, 1.9, hair, -1.2, 4.7, -0.1));
  g.add(block(0.35, 1.0, 1.9, hair, 1.2, 4.7, -0.1));
  g.add(block(2.2, 0.3, 0.3, hair, 0, 5.0, 1.15));
};

// Short crop: cap + short sides set back from the face, no fringe.
const shortCrop: HairBuilder = (g, hair) => {
  g.add(block(2.4, 0.55, 2.35, hair, 0, 5.3, 0));
  g.add(block(2.4, 1.1, 0.35, hair, 0, 4.7, -1.2));
  g.add(block(0.3, 0.9, 1.6, hair, -1.2, 4.75, -0.3));
  g.add(block(0.3, 0.9, 1.6, hair, 1.2, 4.75, -0.3));
  g.add(block(2.2, 0.25, 0.25, hair, 0, 5.1, 1.1));
};

// Buzz / skull cap: only the top of the head and a thin strip down the back.
const skullCap: HairBuilder = (g, hair) => {
  g.add(block(2.35, 0.45, 2.25, hair, 0, 5.25, 0));
  g.add(block(2.3, 0.7, 0.3, hair, 0, 4.85, -1.15));
};

// Swept back with a raised quiff at the front — the face is fully open.
const quiff: HairBuilder = (g, hair) => {
  g.add(block(2.4, 0.6, 2.3, hair, 0, 5.3, -0.05));
  g.add(block(2.0, 0.7, 1.0, hair, 0, 5.8, 0.5));
  g.add(block(1.6, 0.35, 0.6, hair, 0, 6.2, 0.35));
  g.add(block(2.3, 1.0, 0.35, hair, 0, 4.75, -1.2));
  g.add(block(0.3, 0.6, 1.2, hair, -1.2, 4.95, -0.4));
  g.add(block(0.3, 0.6, 1.2, hair, 1.2, 4.95, -0.4));
};

// Topknot: skull cap + a knot tied on top with a leather band.
const topknot: HairBuilder = (g, hair) => {
  g.add(block(2.35, 0.45, 2.25, hair, 0, 5.25, 0));
  g.add(block(2.3, 0.7, 0.3, hair, 0, 4.85, -1.15));
  g.add(block(0.85, 0.5, 0.85, hair, 0, 5.72, -0.3));
  g.add(block(0.95, 0.16, 0.95, dark(), 0, 5.96, -0.3));
  g.add(block(0.75, 0.55, 0.75, hair, 0, 6.3, -0.3));
};

// Mohawk: shaved sides, one tall strip front to back.
const mohawk: HairBuilder = (g, hair) => {
  g.add(block(0.6, 1.0, 2.2, hair, 0, 5.55, -0.1));
  g.add(block(0.6, 0.45, 1.0, hair, 0, 6.25, -0.2));
  g.add(block(0.6, 0.35, 0.5, hair, 0, 5.4, 1.1));
  g.add(block(0.6, 0.9, 0.35, hair, 0, 4.8, -1.15));
};

// Ponytail: skull cap, hair gathered at the back with a tie, tail down the back.
export const ponytail: HairBuilder = (g, hair) => {
  g.add(block(2.4, 0.5, 2.35, hair, 0, 5.28, 0));
  g.add(block(2.3, 0.9, 0.35, hair, 0, 4.75, -1.15));
  g.add(block(0.9, 0.5, 0.6, hair, 0, 4.55, -1.35));
  g.add(block(0.95, 0.18, 0.65, dark(), 0, 4.3, -1.35));
  g.add(block(0.6, 1.5, 0.45, hair, 0, 3.45, -1.35));
};

// Braids: skull cap + two braids hanging behind the ears.
const braids: HairBuilder = (g, hair) => {
  g.add(block(2.4, 0.5, 2.35, hair, 0, 5.28, 0));
  g.add(block(2.3, 0.9, 0.35, hair, 0, 4.75, -1.15));
  for (const sx of [-1, 1]) {
    g.add(block(0.4, 1.7, 0.4, hair, sx * 0.95, 3.75, -0.85));
    g.add(block(0.46, 0.18, 0.46, dark(), sx * 0.95, 3.35, -0.85));
    g.add(block(0.46, 0.18, 0.46, dark(), sx * 0.95, 4.2, -0.85));
  }
};

// Headband: no hair mass at all — a team-coloured band across the brow line
// keeps the top of the head from reading bald, and the owner colour shows.
const headband: HairBuilder = (g, hair, teamColor) => {
  g.add(block(2.35, 0.4, 2.25, hair, 0, 5.28, 0));
  g.add(block(2.3, 0.6, 0.3, hair, 0, 4.85, -1.15));
  g.add(block(2.35, 0.32, 2.3, tint(teamColor), 0, 4.98, 0));
  g.add(block(0.5, 0.7, 0.12, tint(teamColor), -0.6, 4.55, -1.2));
  g.add(block(0.5, 0.7, 0.12, tint(teamColor), -0.15, 4.5, -1.2));
};

export const HAIR_STYLES: HairStyle[] = [
  { id: 'current', name: 'Current', blurb: 'Blocky helmet around the whole head, sides down to the cheeks, fringe over the brow line.', build: defaultHair },
  { id: 'bowl', name: 'A · Bowl, lighter', blurb: 'Same shape as today, just shallower: sides stop at cheekbone height, fringe lifted above the brows.', build: bowlLite },
  { id: 'crop', name: 'B · Short crop', blurb: 'Cap plus short sides set back off the face, no fringe.', build: shortCrop },
  { id: 'cap', name: 'C · Skull cap', blurb: 'Only the top of the head and a thin strip down the back — the whole face open.', build: skullCap },
  { id: 'quiff', name: 'D · Swept back', blurb: 'Hair combed back with a raised quiff up front — nothing touches the face.', build: quiff },
  { id: 'topknot', name: 'E · Topknot', blurb: 'Skull cap with a knot tied on top — reads well from the top-down camera.', build: topknot },
  { id: 'mohawk', name: 'F · Mohawk', blurb: 'Shaved sides, one tall strip front to back.', build: mohawk },
  { id: 'ponytail', name: 'G · Ponytail', blurb: 'Cap with the hair tied at the back and a tail down the neck.', build: ponytail },
  { id: 'braids', name: 'H · Braids', blurb: 'Cap with two braids hanging behind the ears, tied with leather.', build: braids },
  { id: 'headband', name: 'I · Headband', blurb: 'Almost no hair; a team-coloured band across the brow shows the owner colour up close.', build: headband },
];
