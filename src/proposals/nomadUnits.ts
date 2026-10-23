// NOMAD UNIT PROPOSALS — every Nomad (temple faction) unit rebuilt around the
// tribe's concept: everyone rides, and the siege engine is a horse-drawn cart.
// Previewed at /nomad-proposals next to the current models. Model units:
// horses stand on y = 0, nose toward -X, ~8 units tall; the renderer scales
// by 0.2 (same contract as buildHorseRider).
//
//   Warrior  → Sabre Rider    sabre + small round shield on a bay horse
//   Archer   → Horse Archer   bow drawn, quiver on the back
//   Spearsman→ Lancer         long lance with a team pennant
//   Raider   → Raider         dark fast horse, sabre + torch, saddlebags
//   Mobile Siege → Siege Cart horse-drawn two-wheel cart carrying a ballista
//   Champion → Warlord        felt-barded warhorse, lamellar rider, fur hat, glaive, banner
//   Priest   → Shaman         antler staff, feathers, bone charms
//   Chanter  → War Drummer    big war drum slung at the saddle
//   Oracle   → Falconer       eagle perched on the gloved arm
import * as THREE from 'three';
import { buildGuy, guyBlock, HairBuilder, FaceStyle } from '../voxelWarrior';
import { buildSword } from '../voxelSword';
import { buildSpear } from '../voxelSpear';
import { buildBow } from '../voxelBow';
import { buildHealerStaff } from '../voxelStaff';
import { ponytailHeadband } from './hairStyles';

export const NOMAD_HAIR = 0x1c1a18;
const FELT = 0xd8cfb8, LEATHER = 0x6b4a2c, LEATHER_DK = 0x4d3420, WOOD = 0x8a6a42, WOOD_DK = 0x5a4028;
const STEEL = 0x9a9aa2, STEEL_DK = 0x5f5f68, BONE = 0xece6d2, FUR = 0x6e5a48, FIRE = 0xff8a2a;

function mat(color: number, rough = 0.9): THREE.MeshStandardMaterial { return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 }); }
function glow(color: number, k = 1.4): THREE.MeshStandardMaterial { return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: k, roughness: 0.4, metalness: 0 }); }
function block(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, rot?: { x?: number; y?: number; z?: number }): THREE.Mesh {
  const b = guyBlock(w, h, d, m, x, y, z);
  if (rot) b.rotation.set(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0);
  b.castShadow = true; b.receiveShadow = true; return b;
}
function cyl(r: number, h: number, m: THREE.Material, x: number, y: number, z: number, rot?: { x?: number; y?: number; z?: number }, seg = 10): THREE.Mesh {
  const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), m);
  c.position.set(x, y, z); if (rot) c.rotation.set(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0);
  c.castShadow = true; c.receiveShadow = true; return c;
}

// ── steppe horse: same proportions as buildHorse(), felt saddle in the team
// colour, tassels, optional felt barding ──
export function buildSteppeHorse(teamColor: number, hideColor = 0x7d4e2f, barded = false): THREE.Group {
  const H = new THREE.Group();
  const hide = mat(hideColor, 0.92), dark = mat(0x3a2a20, 0.92), felt = mat(teamColor, 0.8), feltDk = mat(FELT, 0.9);
  const eyeB = mat(0x161616, 0.6), eyeW = mat(0xeae6e0, 0.6);
  H.add(block(4.2, 2.4, 2.4, hide, 0, 2.7, 0));
  const ly = 0.85, lh = 1.7;
  for (const [x, z] of [[-1.4, 0.75], [-1.4, -0.75], [1.4, 0.75], [1.4, -0.75]]) H.add(block(0.95, lh, 0.95, hide, x!, ly, z!));
  H.add(block(0.7, 2.3, 0.9, dark, 2.35, 2.55, 0));
  H.add(block(0.5, 0.5, 2.5, dark, -0.4, 4.1, 0)); // mane ridge
  if (barded) {
    H.add(block(3.8, 1.3, 0.24, felt, 0, 2.0, 1.28)); H.add(block(3.8, 1.3, 0.24, felt, 0, 2.0, -1.28));
    H.add(block(3.8, 0.3, 0.26, feltDk, 0, 1.4, 1.28)); H.add(block(3.8, 0.3, 0.26, feltDk, 0, 1.4, -1.28));
    for (const z of [1.3, -1.3]) for (const x of [-1.2, 0, 1.2]) H.add(block(0.2, 0.5, 0.2, mat(0xe0b020, 0.5), x, 1.0, z));
  }
  // felt saddle + blanket in the team colour, leather straps
  H.add(block(2.6, 0.3, 2.6, felt, -0.2, 4.05, 0));
  H.add(block(1.6, 0.35, 1.7, mat(LEATHER_DK, 0.85), -0.2, 4.375, 0));
  H.add(block(0.5, 0.45, 1.7, mat(LEATHER, 0.85), -1.15, 4.575, 0));
  H.add(block(2.2, 0.15, 0.2, mat(LEATHER_DK, 0.85), -0.2, 2.9, 1.25)); H.add(block(2.2, 0.15, 0.2, mat(LEATHER_DK, 0.85), -0.2, 2.9, -1.25));
  // tassels
  for (const z of [1.35, -1.35]) H.add(block(0.2, 0.7, 0.2, felt, -1.7, 2.3, z));
  const head = new THREE.Group();
  head.add(block(1.5, 2.2, 1.6, hide, 0, 0.6, 0));
  head.add(block(1.8, 1.8, 1.7, hide, -0.5, 2.3, 0));
  head.add(block(1.0, 1.0, 1.3, hide, -1.5, 1.7, 0));
  head.add(block(0.5, 0.7, 0.5, hide, -0.2, 3.45, 0.5)); head.add(block(0.5, 0.7, 0.5, hide, -0.2, 3.45, -0.5));
  head.add(block(0.35, 0.4, 0.12, eyeB, -0.95, 2.55, 0.86)); head.add(block(0.35, 0.4, 0.12, eyeB, -0.95, 2.55, -0.86));
  head.add(block(0.12, 0.14, 0.13, eyeW, -1.12, 2.68, 0.87)); head.add(block(0.12, 0.14, 0.13, eyeW, -1.12, 2.68, -0.87));
  head.add(block(0.13, 0.28, 0.18, eyeB, -2.02, 1.6, 0.3)); head.add(block(0.13, 0.28, 0.18, eyeB, -2.02, 1.6, -0.3));
  head.add(block(0.15, 0.15, 1.9, mat(LEATHER_DK, 0.85), -0.9, 2.0, 0)); // bridle
  head.add(block(0.3, 1.2, 0.3, dark, 0.2, 2.6, 0)); // forelock
  head.rotation.z = 0.38; head.position.set(-1.4, 3.6, 0);
  H.add(head);
  return H;
}

// Nomad rider seated on the saddle, facing -X like the horse. Returns the
// rider group in guy space (scaled 0.92/0.6/0.78) so props added to it sit
// with him: +X is his weapon side, +Z his front.
function rider(teamColor: number, hair: HairBuilder = ponytailHeadband, face?: FaceStyle): THREE.Group {
  const r = buildGuy(teamColor, hair, NOMAD_HAIR, face);
  r.scale.set(0.92, 0.6, 0.78); r.rotation.y = -Math.PI / 2; r.position.set(-0.15, 4.6, 0);
  return r;
}
function mountedBase(teamColor: number, hide?: number, barded = false, face?: FaceStyle): { g: THREE.Group; r: THREE.Group } {
  const g = new THREE.Group();
  g.add(buildSteppeHorse(teamColor, hide, barded));
  const r = rider(teamColor, ponytailHeadband, face);
  g.add(r);
  return { g, r };
}
function sabre(r: THREE.Group): void {
  const s = buildSword(); s.scale.setScalar(0.72); s.position.set(2.0, 1.6, 0.4); s.rotation.z = -0.35; r.add(s);
}
function roundShield(r: THREE.Group, teamColor: number): void {
  const sh = new THREE.Group();
  sh.add(cyl(1.15, 0.2, mat(LEATHER, 0.85), 0, 0, 0, { z: Math.PI / 2 }, 12));
  sh.add(cyl(0.75, 0.24, mat(teamColor, 0.75), 0, 0, 0, { z: Math.PI / 2 }, 12));
  sh.add(cyl(0.25, 0.3, mat(STEEL, 0.5), 0, 0, 0, { z: Math.PI / 2 }, 8));
  sh.position.set(-1.9, 2.2, 0.3); r.add(sh);
}

export function buildSabreRider(teamColor: number, face?: FaceStyle): THREE.Group {
  const { g, r } = mountedBase(teamColor, 0x7d4e2f, false, face);
  sabre(r); roundShield(r, teamColor);
  return g;
}

export function buildHorseArcher(teamColor: number, face?: FaceStyle): THREE.Group {
  const { g, r } = mountedBase(teamColor, 0xa07a50, false, face);
  const b = buildBow(); b.scale.setScalar(0.5); b.position.set(2.1, 2.4, 0.5); b.rotation.z = -0.15; r.add(b);
  r.add(block(0.6, 2.2, 0.6, mat(LEATHER, 0.85), -0.9, 2.4, -1.3, { x: 0.25 })); // quiver
  for (const dx of [-0.15, 0.15]) r.add(block(0.1, 0.9, 0.1, mat(FELT), -0.9 + dx, 3.7, -1.5, { x: 0.25 }));
  return g;
}

export function buildLancer(teamColor: number, face?: FaceStyle): THREE.Group {
  const { g, r } = mountedBase(teamColor, 0x8a5a3a, false, face);
  const sp = buildSpear(); sp.scale.set(0.6, 0.85, 0.6); sp.position.set(2.1, 1.2, 0.5); sp.rotation.z = -0.12; sp.rotation.x = 0.55; r.add(sp);
  r.add(block(0.05, 0.9, 1.4, mat(teamColor, 0.75), 2.1, 6.1, 1.9, { x: 0.55 })); // pennant near the tip
  return g;
}

export function buildRaiderV2(teamColor: number, face?: FaceStyle): THREE.Group {
  const { g, r } = mountedBase(teamColor, 0x3a2a20, false, face);
  sabre(r);
  const torch = new THREE.Group();
  torch.add(block(0.25, 1.9, 0.25, mat(WOOD_DK), 0, 0, 0));
  torch.add(block(0.5, 0.5, 0.5, glow(FIRE, 1.8), 0, 1.15, 0));
  torch.add(block(0.3, 0.4, 0.3, glow(0xffd070, 2.0), 0, 1.5, 0));
  torch.position.set(-1.9, 2.4, 0.5); torch.rotation.z = 0.35; r.add(torch);
  g.add(block(1.2, 1.1, 0.5, mat(LEATHER, 0.85), 1.0, 3.0, 1.35)); g.add(block(1.2, 1.1, 0.5, mat(LEATHER, 0.85), 1.0, 3.0, -1.35)); // saddlebags
  return g;
}

export function buildSiegeCart(teamColor: number, face?: FaceStyle): THREE.Group {
  const g = new THREE.Group();
  const horse = buildSteppeHorse(teamColor, 0x7d4e2f); horse.position.x = -3.2; horse.scale.setScalar(0.92); g.add(horse);
  // shafts from the horse's flanks back to the cart
  for (const z of [1.1, -1.1]) g.add(block(4.2, 0.25, 0.25, mat(WOOD_DK), -0.6, 2.6, z));
  // cart bed + two big wheels
  g.add(block(3.6, 0.5, 2.6, mat(WOOD), 1.6, 2.5, 0));
  g.add(block(3.6, 0.6, 0.2, mat(WOOD_DK), 1.6, 3.05, 1.3)); g.add(block(3.6, 0.6, 0.2, mat(WOOD_DK), 1.6, 3.05, -1.3));
  for (const z of [1.55, -1.55]) {
    g.add(cyl(1.55, 0.3, mat(WOOD_DK), 2.0, 1.55, z, { x: Math.PI / 2 }, 10));
    g.add(cyl(0.45, 0.4, mat(STEEL_DK, 0.6), 2.0, 1.55, z, { x: Math.PI / 2 }, 8));
    for (let i = 0; i < 4; i++) g.add(block(2.6, 0.18, 0.12, mat(WOOD), 2.0, 1.55, z, { z: i * Math.PI / 4 }));
  }
  g.add(block(0.3, 0.3, 3.4, mat(STEEL_DK, 0.6), 2.0, 1.55, 0)); // axle
  // ballista: post, stock, bow arms, bolt (aimed forward, -X)
  g.add(block(0.5, 1.6, 0.5, mat(WOOD_DK), 1.4, 3.5, 0));
  g.add(block(3.2, 0.45, 0.6, mat(WOOD), 0.6, 4.35, 0));
  g.add(block(0.4, 0.4, 4.0, mat(WOOD_DK), -0.8, 4.4, 0));
  for (const z of [2.0, -2.0]) g.add(block(0.3, 0.3, 0.9, mat(BONE, 0.6), -1.0, 4.4, z, { y: z > 0 ? -0.5 : 0.5 }));
  g.add(block(2.8, 0.06, 0.06, mat(0xd9c9a0), 0.2, 4.4, 0)); // string (rough)
  g.add(block(3.0, 0.18, 0.18, mat(WOOD_DK), -0.4, 4.65, 0)); g.add(block(0.5, 0.35, 0.35, mat(STEEL, 0.5), -1.85, 4.65, 0)); // bolt + head
  g.add(block(1.2, 0.5, 0.06, mat(teamColor, 0.75), 2.4, 5.5, 0)); g.add(block(0.08, 2.2, 0.08, mat(WOOD_DK), 3.0, 4.5, 0)); // pennant
  // driver kneeling at the back of the bed
  const d = buildGuy(teamColor, ponytailHeadband, NOMAD_HAIR, face); d.scale.set(0.8, 0.55, 0.7); d.rotation.y = -Math.PI / 2; d.position.set(2.9, 2.75, 0); g.add(d);
  return g;
}

export function buildWarlord(teamColor: number, face?: FaceStyle): THREE.Group {
  const { g, r } = mountedBase(teamColor, 0x4a3628, true, face);
  // lamellar cuirass over the torso + pauldrons
  r.add(block(3.2, 2.2, 2.4, mat(STEEL_DK, 0.6), 0, 2.1, 0));
  for (let i = 0; i < 3; i++) r.add(block(3.25, 0.12, 2.45, mat(STEEL, 0.5), 0, 1.4 + i * 0.6, 0));
  r.add(block(1.2, 0.6, 1.4, mat(FUR, 0.95), -1.6, 3.3, 0)); r.add(block(1.2, 0.6, 1.4, mat(FUR, 0.95), 1.6, 3.3, 0));
  // fur-trimmed hat over the hair
  r.add(block(2.5, 0.5, 2.5, mat(FUR, 0.95), 0, 5.35, 0)); r.add(block(1.7, 0.9, 1.7, mat(teamColor, 0.8), 0, 5.95, 0)); r.add(block(0.4, 0.5, 0.4, mat(0xe0b020, 0.5), 0, 6.6, 0));
  // glaive: long shaft + axe head
  const sp = buildSpear(); sp.scale.set(0.6, 0.9, 0.6); sp.position.set(2.1, 1.0, 0.5); sp.rotation.z = -0.1; r.add(sp);
  r.add(block(0.15, 1.6, 0.9, mat(STEEL, 0.45), 2.1, 6.6, 0.95)); r.add(block(0.15, 0.6, 0.5, mat(STEEL_DK, 0.5), 2.1, 6.4, 1.4));
  // back banner
  r.add(block(0.12, 4.0, 0.12, mat(WOOD_DK), -0.6, 3.6, -1.4)); r.add(block(0.06, 1.6, 1.2, mat(teamColor, 0.75), -0.6, 5.0, -2.0));
  return g;
}

export function buildShaman(teamColor: number, face?: FaceStyle): THREE.Group {
  const { g, r } = mountedBase(teamColor, 0xc9c0b0, false, face);
  const st = buildHealerStaff(); st.scale.setScalar(0.7); st.position.set(2.1, 1.6, 0.4); st.rotation.z = -0.1; r.add(st);
  for (const s of [-1, 1]) r.add(block(0.15, 1.1, 0.15, mat(BONE, 0.6), 2.1 + s * 0.45, 5.9, 0.4, { z: s * 0.6 })); // antlers on the staff
  for (const [dx, dz] of [[-0.9, 0.9], [0.9, 0.9], [0, 1.0]]) r.add(block(0.2, 0.9, 0.08, mat(dz > 0.95 ? 0xe0b020 : FELT, 0.9), dx, 5.6, dz)); // feathers in the headband
  for (let i = 0; i < 3; i++) r.add(block(0.15, 0.5, 0.15, mat(BONE, 0.6), -1.4 + i * 0.6, 0.6, 1.2)); // bone charms on the sash
  r.add(block(3.1, 0.35, 0.15, mat(LEATHER_DK, 0.85), 0, 0.9, 1.15));
  return g;
}

export function buildWarDrummer(teamColor: number, face?: FaceStyle): THREE.Group {
  const { g, r } = mountedBase(teamColor, 0x8a6a4a, false, face);
  // big drum hung on the horse's right flank
  const drum = new THREE.Group();
  drum.add(cyl(1.3, 1.6, mat(0x9b4a34, 0.9), 0, 0, 0, { x: Math.PI / 2 }, 12));
  drum.add(cyl(1.32, 0.25, mat(teamColor, 0.75), 0, 0, 0.55, { x: Math.PI / 2 }, 12));
  drum.add(cyl(1.32, 0.25, mat(teamColor, 0.75), 0, 0, -0.55, { x: Math.PI / 2 }, 12));
  drum.add(cyl(1.2, 0.08, mat(BONE, 0.7), 0, 0, 0.82, { x: Math.PI / 2 }, 12));
  drum.position.set(-0.4, 3.2, 1.9); g.add(drum);
  g.add(block(0.2, 1.2, 0.2, mat(LEATHER_DK), -0.4, 4.2, 1.5)); // strap
  for (const s of [-1, 1]) { r.add(block(0.18, 1.6, 0.18, mat(WOOD), 2.0 + s * 0.6, 2.6, 0.8 + s * 0.3, { z: -0.4 - s * 0.3 })); r.add(block(0.4, 0.4, 0.4, mat(FELT, 0.9), 2.0 + s * 0.85, 3.3, 0.8 + s * 0.3)); }
  return g;
}

export function buildFalconer(teamColor: number, face?: FaceStyle): THREE.Group {
  const { g, r } = mountedBase(teamColor, 0x6a4a34, false, face);
  r.add(block(2.4, 0.9, 0.9, mat(LEATHER, 0.85), 2.6, 3.4, 0.4, { z: 0.35 })); // gloved arm raised out to the side
  const eagle = new THREE.Group();
  eagle.add(block(0.9, 0.9, 1.4, mat(0x4a3a2a, 0.9), 0, 0, 0));
  eagle.add(block(0.7, 0.7, 0.7, mat(BONE, 0.85), 0, 0.6, 0.7)); // white head
  eagle.add(block(0.25, 0.25, 0.4, mat(0xe0a020, 0.5), 0, 0.55, 1.2)); // beak
  eagle.add(block(2.2, 0.15, 0.9, mat(0x4a3a2a, 0.9), -1.4, 0.5, -0.1, { z: 0.35 })); eagle.add(block(2.2, 0.15, 0.9, mat(0x4a3a2a, 0.9), 1.4, 0.5, -0.1, { z: -0.35 })); // wings
  eagle.add(block(0.8, 0.12, 0.7, mat(BONE, 0.85), 0, -0.1, -0.9)); // tail
  eagle.position.set(3.9, 4.6, 0.4); eagle.rotation.y = Math.PI / 2; r.add(eagle);
  r.add(block(0.5, 0.5, 0.5, mat(0xe0b020, 0.5), -1.3, 4.9, 0.9)); // gold sight-charm on the headband
  return g;
}

export interface NomadUnitProposal { type: 'warrior' | 'archer' | 'spearsman' | 'horserider' | 'catapult' | 'heavyknight' | 'healer' | 'damageBooster' | 'rangeBooster'; current: string; proposed: string; blurb: string; build: (teamColor: number) => THREE.Group; }
export const NOMAD_UNITS: NomadUnitProposal[] = [
  { type: 'warrior', current: 'Warrior', proposed: 'Sabre Rider', blurb: 'Sabre and a small round team-coloured shield on a bay horse.', build: buildSabreRider },
  { type: 'archer', current: 'Archer', proposed: 'Horse Archer', blurb: 'Bow in hand, quiver on the back, on a dun horse.', build: buildHorseArcher },
  { type: 'spearsman', current: 'Spearsman', proposed: 'Lancer', blurb: 'A long lance held forward with a team pennant near the tip.', build: buildLancer },
  { type: 'horserider', current: 'Raider', proposed: 'Raider', blurb: 'Dark fast horse, sabre and a burning torch, saddlebags for the loot.', build: buildRaiderV2 },
  { type: 'catapult', current: 'Mobile Siege', proposed: 'Siege Cart', blurb: 'A horse-drawn two-wheel cart carrying a ballista, driver at the back.', build: buildSiegeCart },
  { type: 'heavyknight', current: 'Champion', proposed: "Warlord", blurb: 'Felt-barded warhorse, lamellar cuirass, fur hat, glaive and a back banner.', build: buildWarlord },
  { type: 'healer', current: 'Priest', proposed: 'Shaman', blurb: 'Antler staff, feathers in the headband, bone charms, on a pale horse.', build: buildShaman },
  { type: 'damageBooster', current: 'Chanter', proposed: 'War Drummer', blurb: 'A big war drum slung at the saddle, drumsticks raised.', build: buildWarDrummer },
  { type: 'rangeBooster', current: 'Oracle', proposed: 'Falconer', blurb: 'An eagle perched on the gloved arm — the tribe\'s eyes.', build: buildFalconer },
];
