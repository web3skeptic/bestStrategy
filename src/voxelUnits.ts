// Shared unit-model builder: returns the visual 3D model for a unit type, team
// tinted, scaled to tile size and standing on y = 0. No HP bar and no support
// aura rings (those are added by the board renderer). Used by the 3D board
// renderer, the asset demo, and the unit-card thumbnail renderer so all three
// always show the same models.
import * as THREE from 'three';
import { UnitType, FactionId } from './types';
import { buildGuy, HairBuilder } from './voxelWarrior';
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
function guy(color: number, weapon: THREE.Object3D, scale: number, x: number, y: number, z: number, scaleVec?: [number, number, number], hairStyle?: HairBuilder): THREE.Group {
  const g = buildGuy(color, hairStyle);
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

// `faction` disambiguates slots two factions flavor very differently in 3D:
// the shared 'horserider' slot is Temple's mounted Raider, but Farmer's own
// flavor (the Warden) is deliberately unmounted heavy infantry — see
// factions.ts's AGRAR_UNITS comment on the Warden entry. Every other slot
// currently shares one model between factions, so `faction` is optional and
// only this one case branches on it.
// `hairStyle` (optional) overrides the humanoid hair — used by /hair-proposals.
export function buildUnitModel(type: UnitType, color: number, faction?: FactionId | null, hairStyle?: HairBuilder): THREE.Group {
  const wrap = new THREE.Group();
  switch (type) {
    case 'catapult': wrap.add(buildCannon(color)); break; // cannon, muzzle faces +Z
    case 'warrior': wrap.add(guy(color, buildSword(), 0.62, 2.2, 2.0, 0.4, undefined, hairStyle)); break;
    case 'archer': wrap.add(guy(color, buildBow(), 0.4, 2.2, 3.4, 0.3, undefined, hairStyle)); break;
    case 'spearsman': wrap.add(guy(color, buildSpear(), 0.52, 2.2, 4.6, 0.3, undefined, hairStyle)); break;
    case 'healer': wrap.add(guy(color, buildHealerStaff(), 0.58, 2.2, 2.2, 0.3, undefined, hairStyle)); break;
    case 'damageBooster': wrap.add(guy(color, buildDemonStaff(), 0, 2.3, 2.4, 0.3, [0.92, 0.72, 0.92], hairStyle)); break;
    case 'rangeBooster': wrap.add(guy(color, buildRuneStaff(), 0, 2.3, 2.4, 0.3, [0.92, 0.72, 0.92], hairStyle)); break;
    case 'horserider':
      if (faction === 'agrar') wrap.add(mounted(buildWarden(color))); // unmounted — see header note
      else wrap.add(mounted(buildHorseRider(color)));
      break;
    case 'heavyknight': wrap.add(mounted(buildHeavyKnight(color))); break;
    default: { const g = buildGuy(color, hairStyle); g.scale.setScalar(0.2); g.position.y = 0.08; wrap.add(g); }
  }
  return wrap;
}
