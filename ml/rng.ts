// Seedable RNG so headless episodes are deterministic given a seed. The whole
// game (map/temple gen, combat multiplier, AI tie-breaks) reads Math.random, so
// we swap Math.random for a seeded mulberry32 for the duration of training/eval.
//
// The global stream's state is a single uint32 (`_a`), exposed via
// getRngState/setRngState so a turn can be replayed under the EXACT combat rolls
// it originally used (ml/bcRecord.ts fidelity test). Sequence is bit-identical to
// the previous closure-based implementation for any given seed.
let _a = 0x2545f491 >>> 0;

function nextRand(): number {
  _a |= 0; _a = (_a + 0x6D2B79F5) | 0;
  let t = Math.imul(_a ^ (_a >>> 15), 1 | _a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Install our seeded RNG as the global Math.random. Idempotent.
export function installSeededRandom(): void {
  Math.random = nextRand;
}

export function setSeed(seed: number): void {
  _a = seed >>> 0;
}

// Snapshot / restore the global stream position (a single uint32). Used to replay
// a recorded turn under the same combat rolls it originally produced.
export function getRngState(): number { return _a >>> 0; }
export function setRngState(a: number): void { _a = a >>> 0; }

// A small independent stream for things that should NOT perturb the game RNG
// (e.g. exploration sampling in training). Seeded separately.
export function makeStream(seed: number): () => number {
  return mulberry32(seed >>> 0);
}
