// Parses a side spec used on the command line:
//   hard                        a difficulty with its own genome
//   hard@path/to/genome.json    a difficulty playing a stored genome
//   old-normal / old-expert     the original pre-evolution AI (needs LEGACY_AI_DIR)
import { readFileSync } from 'node:fs';
import type { SideSpec } from './match';
import type { AiDifficulty } from '../src/ai';
import { normalizeGenome } from '../src/aiGenome';

export function parseSide(spec: string): SideSpec {
  if (spec.startsWith('old-')) return { difficulty: 'hard', legacy: spec.slice(4) };
  const [difficulty, file] = spec.split('@') as [AiDifficulty, string | undefined];
  return file ? { difficulty, genome: normalizeGenome(JSON.parse(readFileSync(file, 'utf8'))) } : { difficulty };
}

// Short label for printing (drops the genome file's directory).
export function sideLabel(spec: string): string {
  return spec.replace(/@.*\//, '@');
}
