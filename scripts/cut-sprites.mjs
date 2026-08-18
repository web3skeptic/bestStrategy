import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const inputPath = path.join(projectRoot, 'src/assets/tiles.jpg');
const outputDir = path.join(projectRoot, 'src/assets/tiles');

// Image is 1024x559.
// Top row has 4 tiles: Plain, Forest, Hill, Mountain/Wall
// Each tile is roughly 256px wide (1024/4), top row ends around y=280
// We'll crop generous bounding boxes then trim + remove background.

const tiles = [
  { name: 'plain',  left: 10,  top: 0, width: 225, height: 225 },
  { name: 'forest', left: 250, top: 0, width: 240, height: 230 },
  { name: 'hill',   left: 500, top: 10, width: 235, height: 218 },
  { name: 'wall',   left: 755, top: 0, width: 245, height: 230 },
];

// Color distance in RGB space
function colorDist(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1-r2)**2 + (g1-g2)**2 + (b1-b2)**2);
}

async function processTile(tile) {
  console.log(`Processing ${tile.name}...`);

  // Step 1: Crop the tile from the sheet
  const cropped = sharp(inputPath).extract({
    left: tile.left,
    top: tile.top,
    width: tile.width,
    height: tile.height,
  });

  // Get raw pixel data (as RGBA by converting to png first, or as raw RGB)
  const { data, info } = await cropped
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  console.log(`  Cropped: ${width}x${height}, ${channels} channels`);

  // Step 2: Remove white/light background
  // The background is white-ish (#f5f5f5 to #ffffff range)
  // We'll make any pixel close to white transparent
  const tolerance = 45; // color distance threshold
  const bgR = 255, bgG = 255, bgB = 255;

  const output = Buffer.from(data);
  let transparentCount = 0;

  for (let i = 0; i < output.length; i += channels) {
    const r = output[i];
    const g = output[i+1];
    const b = output[i+2];

    const dist = colorDist(r, g, b, bgR, bgG, bgB);

    // Also check for very light grays (the background may not be pure white)
    const isLight = r > 210 && g > 210 && b > 210;

    if (dist < tolerance || isLight) {
      output[i+3] = 0; // make transparent
      transparentCount++;
    }
  }

  console.log(`  Made ${transparentCount} pixels transparent out of ${width*height}`);

  // Step 3: Write the processed image, then trim
  const outputPath = path.join(outputDir, `${tile.name}.png`);

  await sharp(output, { raw: { width, height, channels } })
    .trim()  // auto-trim transparent edges
    .png()
    .toFile(outputPath);

  // Get final dimensions
  const finalMeta = await sharp(outputPath).metadata();
  console.log(`  Saved: ${outputPath} (${finalMeta.width}x${finalMeta.height})`);
}

async function main() {
  console.log('Input image:', inputPath);
  console.log('Output dir:', outputDir);
  console.log('');

  for (const tile of tiles) {
    await processTile(tile);
    console.log('');
  }

  console.log('Done! All sprites saved.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
