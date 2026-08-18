import * as THREE from 'three';
import { HexCoord } from '../types';

// Shared palette passed to every element builder. Materials are cached so the
// whole board reuses a tiny set of MeshStandardMaterials (few draw-call state
// changes, low memory).
export interface Palette {
  HEX_R: number;
  TILE_H: number;
  colors: Record<string, number>;
  mat(hex: number, rough?: number): THREE.MeshStandardMaterial;
}

export const HEX_R = 1;       // hex circumradius (world units)
export const TILE_H = 0.35;   // tile prism thickness

export function makePalette(): Palette {
  const cache = new Map<string, THREE.MeshStandardMaterial>();
  const colors: Record<string, number> = {
    grass: 0x375529, dirt: 0x5a3f24, rock: 0x6f7079, wood: 0x4e3219,
    leaf: 0x205026, stone: 0x6a6a72, water: 0x235c8a, gold: 0xe0b020,
    neutral: 0x9098a0, glow: 0x00e6ff,
  };
  return {
    HEX_R, TILE_H, colors,
    mat(hex: number, rough = 0.9): THREE.MeshStandardMaterial {
      const key = `${hex}:${rough}`;
      let m = cache.get(key);
      if (!m) {
        m = new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0 });
        cache.set(key, m);
      }
      return m;
    },
  };
}

// Flat-top axial hex → world position on the XZ plane (tile top at y = 0).
// Flat-top because the tile prisms (CylinderGeometry, 6 seg) are rotated by
// Math.PI/6, which turns THREE's default pointy-top hexagon into a flat-top one;
// the layout must match that orientation or the tiles won't tessellate.
export function hexToWorld(h: HexCoord): { x: number; z: number } {
  const x = HEX_R * 1.5 * h.q;
  const z = HEX_R * Math.sqrt(3) * (h.r + h.q / 2);
  return { x, z };
}

// Inverse: world (x,z) → fractional axial, for raycast picking.
export function worldToHexFractional(x: number, z: number): { q: number; r: number } {
  const q = ((2 / 3) * x) / HEX_R;
  const r = ((-1 / 3) * x + (Math.sqrt(3) / 3) * z) / HEX_R;
  return { q, r };
}
