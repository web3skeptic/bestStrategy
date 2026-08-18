/**
 * build-tile-atlas.mjs
 *
 * Optimises every tile PNG (strips metadata, re-compresses, resizes to TARGET_W)
 * then packs them all into a single sprite atlas + JSON manifest.
 *
 * Output:
 *   src/assets/tiles/atlas.png   – sprite atlas
 *   src/assets/tiles/atlas.json  – frame positions { tiles: { plain: [{x,y,w,h}], … } }
 *
 * Usage:  node scripts/build-tile-atlas.mjs
 */

import sharp from 'sharp';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const tilesDir = path.join(projectRoot, 'src/assets/tiles');

/** Each tile will be resized so its width equals this (height proportional). */
const TARGET_W = 256;

/** Folder name → manifest key */
const FOLDERS = [
  { folder: 'palin',    key: 'plain'    },
  { folder: 'forest',   key: 'forest'   },
  { folder: 'hill',     key: 'hill'     },
  { folder: 'wall',     key: 'wall'     },
  { folder: 'fogofwar', key: 'fogofwar' },
];

/** Read every *.png in a folder, sorted alphabetically. */
async function getPNGs(folder) {
  const dir = path.join(tilesDir, folder);
  const files = await fs.readdir(dir);
  return files
    .filter(f => f.toLowerCase().endsWith('.png'))
    .sort()
    .map(f => ({ name: f, fullPath: path.join(dir, f) }));
}

/**
 * Resize a tile to TARGET_W wide (proportional height), strip all metadata,
 * and return the compressed PNG as a Buffer plus its { width, height }.
 */
async function optimizeTile(inputPath) {
  const meta = await sharp(inputPath).metadata();
  const targetH = Math.round((meta.height / meta.width) * TARGET_W);

  const buf = await sharp(inputPath)
    .resize(TARGET_W, targetH, { fit: 'fill' })
    .ensureAlpha()
    .png({
      compressionLevel: 9,  // maximum zlib compression
      effort: 10,           // maximum encoder effort
      palette: false,        // keep full RGBA (tiles have detailed gradients)
    })
    .toBuffer();

  return { buf, width: TARGET_W, height: targetH };
}

async function main() {
  console.log('Building tile atlas…\n');

  // ── Step 1: optimise all tiles ──────────────────────────────────────────────
  const groups = {}; // key → [{ buf, width, height, name }]
  let origBytes = 0;
  let optBytes  = 0;

  for (const { folder, key } of FOLDERS) {
    const pngs = await getPNGs(folder);
    if (pngs.length === 0) {
      console.warn(`  ⚠ No PNGs found in ${folder}/`);
      groups[key] = [];
      continue;
    }
    groups[key] = [];
    for (const { name, fullPath } of pngs) {
      const stat = await fs.stat(fullPath);
      origBytes += stat.size;
      const result = await optimizeTile(fullPath);
      optBytes += result.buf.length;
      groups[key].push({ ...result, name });
      const pct = Math.round((1 - result.buf.length / stat.size) * 100);
      console.log(`  ${key}/${name}  ${result.width}×${result.height}  ${Math.round(stat.size/1024)}KB → ${Math.round(result.buf.length/1024)}KB  (${pct}% smaller)`);
    }
  }

  console.log(`\n  Total: ${Math.round(origBytes/1024)}KB → ${Math.round(optBytes/1024)}KB  (${Math.round((1-optBytes/origBytes)*100)}% reduction)\n`);

  // ── Step 2: layout – horizontal strip, all tiles in one row ─────────────────
  // Each tile is placed left-to-right. Atlas height = max tile height.
  let atlasW = 0;
  let atlasH = 0;
  const manifest = { tiles: {} };

  // Pre-calculate positions
  for (const { key } of FOLDERS) {
    manifest.tiles[key] = [];
    for (const tile of groups[key]) {
      manifest.tiles[key].push({ x: atlasW, y: 0, w: tile.width, h: tile.height });
      atlasW += tile.width;
      atlasH = Math.max(atlasH, tile.height);
    }
  }

  if (atlasW === 0) {
    console.error('No tiles found – nothing to build.');
    process.exit(1);
  }

  console.log(`Atlas canvas: ${atlasW}×${atlasH}`);

  // ── Step 3: composite into single PNG ──────────────────────────────────────
  const compositeInputs = [];
  for (const { key } of FOLDERS) {
    const frames = manifest.tiles[key];
    const tiles  = groups[key];
    for (let i = 0; i < tiles.length; i++) {
      compositeInputs.push({
        input: tiles[i].buf,
        left: frames[i].x,
        top:  frames[i].y,
      });
    }
  }

  const atlasPath    = path.join(tilesDir, 'atlas.png');
  const manifestPath = path.join(tilesDir, 'atlas.json');

  await sharp({
    create: {
      width:      atlasW,
      height:     atlasH,
      channels:   4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(compositeInputs)
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(atlasPath);

  const atlasSize = (await fs.stat(atlasPath)).size;
  console.log(`Atlas saved: ${atlasPath}  (${Math.round(atlasSize/1024)} KB)\n`);

  // ── Step 4: write manifest ──────────────────────────────────────────────────
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Manifest saved: ${manifestPath}`);
  console.log('\nDone! Run `vite build` (or `vite`) to use the new atlas.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
