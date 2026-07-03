// Seedable RNG so headless episodes are deterministic given a seed. The whole
// game (map/temple gen, combat multiplier, AI tie-breaks) reads Math.random, so
// we swap Math.random for a seeded mulberry32 for the duration of training/eval.
let _state = 0x2545f491 >>> 0;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _rand: () => number = mulberry32(_state);

// Install our seeded RNG as the global Math.random. Idempotent.
export function installSeededRandom(): void {
  Math.random = () => _rand();
}

export function setSeed(seed: number): void {
  _state = seed >>> 0;
  _rand = mulberry32(_state);
}

// A small independent stream for things that should NOT perturb the game RNG
// (e.g. exploration sampling in training). Seeded separately.
export function makeStream(seed: number): () => number {
  return mulberry32(seed >>> 0);
}
