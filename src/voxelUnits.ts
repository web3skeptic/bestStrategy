// Shared unit-model builder: returns the visual 3D model for a unit type, team
// tinted, scaled to tile size and standing on y = 0. No HP bar and no support
// aura rings (those are added by the board renderer). Used by the 3D board
// renderer, the asset demo, and the unit-card thumbnail renderer so all three
// always show the same models.
import * as THREE from 'three';
import { UnitType, FactionId } from './types';
import { buildGuy, HairBuilder, FaceStyle } from './voxelWarrior';
import { ponytailHeadband } from './proposals/hairStyles';
import { sunny } from './proposals/faces';
import {
  buildSabreRider, buildHorseArcher, buildLancer, buildRaiderV2, buildSiegeCart,
  buildWarlord, buildShaman, buildWarDrummer, buildFalconer,
} from './proposals/nomadUnits';
import { wideBrimHat } from './proposals/strawHats';
import { buildHorseRider } from './voxelHorserider';
import { buildHeavyKnight } from './voxelHeavyKnight';
import { buildWarden } from './voxelWarden';
import { buildSword } from './voxelSword';
import { buildSpear } from './voxelSpear';
import { buildBow } from './voxelBow';
import { buildDemonStaff, buildRuneStaff, buildHealerStaff } from './voxelStaff';
import { buildCannon } from './voxelCannon';

// A foot soldier ("Voxel Guy"), team-tinted, holding a weapon on its right side,
// scaled down to tile size. scaleVec overrides the uniform weapon scale.
function guy(color: number, weapon: THREE.Object3D, scale: number, x: number, y: number, z: number, scaleVec?: [number, number, number], hairStyle?: HairBuilder, hairColor?: number, faceStyle?: FaceStyle): THREE.Group {
  const g = buildGuy(color, hairStyle, hairColor, faceStyle);
  if (scaleVec) weapon.scale.set(scaleVec[0], scaleVec[1], scaleVec[2]);
  else weapon.scale.setScalar(scale);
  weapon.position.set(x, y, z);
  weapon.rotation.z = -0.12;
  g.add(weapon);
  g.scale.setScalar(0.2);
  g.position.y = 0.08;
  g.traverse(o => { (o as THREE.Mesh).castShadow = true; });
  return g;
}

// Generic "whole custom model, scaled + shadowed" helper — named for its
// original mounted-unit use (horse rider/heavy knight) but reused as-is for
// the unmounted Warden below, since the scale/shadow logic has nothing
// actually rider-specific in it.
function mounted(model: THREE.Group): THREE.Group {
  model.scale.setScalar(0.2); // model is ~8 units tall → ~1.6 on the tile
  model.traverse(o => { (o as THREE.Mesh).castShadow = true; });
  return model;
}

// `faction` picks each tribe's own flavor of a slot: Nomads are all mounted
// (see below), and Farmer's heavy 'heavyknight' unit is the unmounted Warden
// (voxelWarden.ts) — see factions.ts's AGRAR_UNITS comment.
// Per-tribe look (picked on /hair-proposals, /hat-proposals, /face-proposals):
// Nomads wear a black ponytail with a team-coloured headband on every
// humanoid rig, including the mounted Raider, and keep the angry face;
// Farmers wear the wide-brim straw hat with the sunny face.
export const NOMAD_HAIR_COLOR = 0x1c1a18;
interface TribeLook { hairStyle?: HairBuilder; hairColor?: number; faceStyle?: FaceStyle; }
function tribeLook(faction: FactionId | null | undefined): TribeLook {
  if (faction === 'temple') return { hairStyle: ponytailHeadband, hairColor: NOMAD_HAIR_COLOR };
  if (faction === 'agrar') return { hairStyle: wideBrimHat, faceStyle: sunny };
  return {};
}

// `hairStyle`/`hairColor`/`faceStyle` (optional) override the tribe's look —
// used by the proposal pages.
export function buildUnitModel(type: UnitType, color: number, faction?: FactionId | null, hairStyle?: HairBuilder, hairColor?: number, faceStyle?: FaceStyle): THREE.Group {
  const wrap = new THREE.Group();
  const look = tribeLook(faction);
  const hairOverridden = hairStyle !== undefined;
  hairStyle = hairStyle ?? look.hairStyle;
  hairColor = hairColor ?? look.hairColor;
  faceStyle = faceStyle ?? look.faceStyle;

  // Nomads: every unit is mounted (picked on /nomad-proposals) — the kit under
  // src/proposals/nomadUnits.ts, all facing -X like buildHorseRider. Skipped
  // only when a proposal page explicitly overrides the hair, so those pages
  // keep showing the bare rig.
  if (faction === 'temple' && !hairOverridden) {
    const nomad: Partial<Record<UnitType, (c: number, f?: FaceStyle) => THREE.Group>> = {
      warrior: buildSabreRider, archer: buildHorseArcher, spearsman: buildLancer, horserider: buildRaiderV2,
      catapult: buildSiegeCart, heavyknight: buildWarlord, healer: buildShaman, damageBooster: buildWarDrummer, rangeBooster: buildFalconer,
    };
    const b = nomad[type];
    if (b) { wrap.add(mounted(b(color, faceStyle))); return wrap; }
  }
  switch (type) {
    case 'catapult': wrap.add(buildCannon(color)); break; // cannon, muzzle faces +Z
    case 'warrior': wrap.add(guy(color, buildSword(), 0.62, 2.2, 2.0, 0.4, undefined, hairStyle, hairColor, faceStyle)); break;
    case 'archer': wrap.add(guy(color, buildBow(), 0.4, 2.2, 3.4, 0.3, undefined, hairStyle, hairColor, faceStyle)); break;
    case 'spearsman': wrap.add(guy(color, buildSpear(), 0.52, 2.2, 4.6, 0.3, undefined, hairStyle, hairColor, faceStyle)); break;
    case 'healer': wrap.add(guy(color, buildHealerStaff(), 0.58, 2.2, 2.2, 0.3, undefined, hairStyle, hairColor, faceStyle)); break;
    case 'damageBooster': wrap.add(guy(color, buildDemonStaff(), 0, 2.3, 2.4, 0.3, [0.92, 0.72, 0.92], hairStyle, hairColor, faceStyle)); break;
    case 'rangeBooster': wrap.add(guy(color, buildRuneStaff(), 0, 2.3, 2.4, 0.3, [0.92, 0.72, 0.92], hairStyle, hairColor, faceStyle)); break;
    case 'horserider': wrap.add(mounted(buildHorseRider(color, hairStyle, hairColor, faceStyle))); break;
    case 'heavyknight':
      if (faction === 'agrar') wrap.add(mounted(buildWarden(color, hairStyle, hairColor, faceStyle))); // unmounted — see header note
      else wrap.add(mounted(buildHeavyKnight(color, hairStyle, hairColor, faceStyle)));
      break;
    default: { const g = buildGuy(color, hairStyle, hairColor, faceStyle); g.scale.setScalar(0.2); g.position.y = 0.08; wrap.add(g); }
  }
  return wrap;
}
