import { HexCoord } from './types';

// Cube coordinates for hex math
interface CubeCoord {
  q: number;
  r: number;
  s: number;
}

function axialToCube(h: HexCoord): CubeCoord {
  return { q: h.q, r: h.r, s: -h.q - h.r };
}

export function hexDistance(a: HexCoord, b: HexCoord): number {
  const ac = axialToCube(a);
  const bc = axialToCube(b);
  return Math.max(Math.abs(ac.q - bc.q), Math.abs(ac.r - bc.r), Math.abs(ac.s - bc.s));
}

export function hexEqual(a: HexCoord, b: HexCoord): boolean {
  return a.q === b.q && a.r === b.r;
}

// All 6 axial direction offsets
export const DIRECTIONS: HexCoord[] = [
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
];

// 3 opposing axis pairs (indices into DIRECTIONS: 0↔3, 1↔4, 2↔5)
export const OPPOSING_PAIRS: [number, number][] = [[0, 3], [1, 4], [2, 5]];

export function hexNeighbors(h: HexCoord): HexCoord[] {
  return DIRECTIONS.map(d => ({ q: h.q + d.q, r: h.r + d.r }));
}

// Generate all hex coords within radius of center (0,0)
export function generateHexMap(radius: number): HexCoord[] {
  const hexes: HexCoord[] = [];
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) {
      hexes.push({ q, r });
    }
  }
  return hexes;
}

// Get all reachable hexes within `speed` steps (BFS), excluding occupied hexes
export function getReachableHexes(
  start: HexCoord,
  speed: number,
  mapRadius: number,
  occupied: HexCoord[]
): HexCoord[] {
  const result: HexCoord[] = [];
  const visited = new Set<string>();
  const queue: { hex: HexCoord; dist: number }[] = [{ hex: start, dist: 0 }];
  visited.add(hexKey(start));

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.dist > 0) {
      result.push(current.hex);
    }
    if (current.dist >= speed) continue;

    for (const n of hexNeighbors(current.hex)) {
      const key = hexKey(n);
      if (visited.has(key)) continue;
      if (hexDistance({ q: 0, r: 0 }, n) > mapRadius) continue;
      if (occupied.some(o => hexEqual(o, n))) continue;
      visited.add(key);
      queue.push({ hex: n, dist: current.dist + 1 });
    }
  }
  return result;
}

export function hexKey(h: HexCoord): string {
  return `${h.q},${h.r}`;
}

// Pixel position for flat-top hex
export function hexToPixel(h: HexCoord, size: number, cx: number, cy: number): { x: number; y: number } {
  const x = size * (3 / 2 * h.q);
  const y = size * (Math.sqrt(3) / 2 * h.q + Math.sqrt(3) * h.r);
  return { x: x + cx, y: y + cy };
}

export function pixelToHex(px: number, py: number, size: number, cx: number, cy: number): HexCoord {
  const x = px - cx;
  const y = py - cy;
  const q = (2 / 3 * x) / size;
  const r = (-1 / 3 * x + Math.sqrt(3) / 3 * y) / size;
  return hexRound({ q, r });
}

function hexRound(h: { q: number; r: number }): HexCoord {
  const s = -h.q - h.r;
  let rq = Math.round(h.q);
  let rr = Math.round(h.r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - h.q);
  const dr = Math.abs(rr - h.r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) {
    rq = -rr - rs;
  } else if (dr > ds) {
    rr = -rq - rs;
  }
  return { q: rq, r: rr };
}
