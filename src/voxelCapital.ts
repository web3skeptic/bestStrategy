// Voxel Capital — one look per tribe. Picked from the /capital-proposals
// decision page: Nomads (temple faction) get the Great Yurt Camp, Farmers
// (agrar faction) get the Windmill Keep. Until a player's faction is
// revealed the Capital keeps the shared ziggurat (buildTemple tier 10) so
// nothing about a still-secret pick leaks through the model.
import * as THREE from 'three';
import { buildTemple } from './voxelTemple';
import { buildNomadCapitalA, buildFarmerCapitalB } from './proposals/capitals';
import type { FactionId } from './types';

export function buildCapital(teamColor: number, faction: FactionId | null | undefined): THREE.Group {
  if (faction === 'temple') return buildNomadCapitalA(teamColor);
  if (faction === 'agrar') return buildFarmerCapitalB(teamColor);
  return buildTemple(teamColor, 10);
}
