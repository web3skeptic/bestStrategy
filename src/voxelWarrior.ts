// Renders the "Voxel Guy" 3D model (green hair, yellow body, angry face) once to
// a transparent PNG data URL, so it can be used as the warrior unit sprite in the
// 2D board renderer. We pre-render a single flattering 3/4 angle rather than
// running a live WebGL scene per unit — that keeps the per-frame board cost
// identical to a flat sprite while still giving warriors the voxel look.
//
// Returns null if WebGL is unavailable or the render fails; the caller then falls
// back to the original warrior_standing.png.
import * as THREE from 'three';

export function renderVoxelWarriorSprite(size = 384): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,               // transparent background → sits on the hex tile
      preserveDrawingBuffer: true, // required so toDataURL() can read the pixels
    });
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    renderer.outputEncoding = THREE.sRGBEncoding;

    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);

    // Lights (no shadows needed for a small token — keeps it cheap + transparent).
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb7c1cc, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(-6, 13, 8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(9, 5, 6);
    scene.add(fill);

    scene.add(buildGuy());

    // Frame the character: same 3/4 view as the reference viewer.
    const target = new THREE.Vector3(0, 3.0, 0);
    const theta = 0.5, phi = 1.16, radius = 13;
    const sp = Math.sin(phi);
    camera.position.set(
      target.x + radius * sp * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * sp * Math.cos(theta),
    );
    camera.lookAt(target);
    camera.updateProjectionMatrix();

    renderer.render(scene, camera);
    const url = canvas.toDataURL('image/png');
    renderer.dispose();
    return url;
  } catch (e) {
    console.warn('[voxelWarrior] render failed, falling back to sprite', e);
    return null;
  }
}

/* ======================= model builders (from the reference) ======================= */

function mat(color: number, rough: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
}

function block(
  w: number, h: number, d: number,
  material: THREE.Material | THREE.Material[],
  x: number, y: number, z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  return m;
}

// bodyColor tints the torso to the owning player's team color (red/blue);
// defaults to the original yellow when omitted (e.g. the standalone sprite).
export function buildGuy(bodyColor = 0xf1cb16): THREE.Group {
  const g = new THREE.Group();

  const skin = mat(0xd9b97f, 0.95);
  const hair = mat(0x5e3b1e, 0.85); // brown hair (was green)
  const body = mat(bodyColor, 0.80);
  const feet = mat(0x5d3b1e, 0.90);

  // chunky body
  g.add(block(3.0, 3.2, 2.2, body, 0, 1.6, 0));

  // two little feet at the front-bottom
  g.add(block(0.78, 0.55, 1.0, feet, -0.66, -0.15, 0.55));
  g.add(block(0.78, 0.55, 1.0, feet, 0.66, -0.15, 0.55));

  // head — only the front (+Z) face carries the angry expression
  const faceMat = new THREE.MeshStandardMaterial({ map: makeFace(), roughness: 0.95, metalness: 0 });
  const headMats = [skin, skin, skin, skin, faceMat, skin]; // +x,-x,+y,-y,+z,-z
  const head = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.9, 2.1), headMats);
  head.position.set(0, 4.1, 0);
  g.add(head);

  // green hair, built as a blocky helmet around the head
  g.add(block(2.50, 0.75, 2.45, hair, 0, 5.375, 0));      // crown slab
  g.add(block(1.70, 0.50, 1.70, hair, 0, 6.000, -0.10));  // stepped top
  g.add(block(2.40, 2.00, 0.45, hair, 0, 4.250, -1.20));  // back of hair
  g.add(block(0.35, 1.50, 2.10, hair, -1.20, 4.550, 0));  // left side
  g.add(block(0.35, 1.50, 2.10, hair, 1.20, 4.550, 0));   // right side
  g.add(block(2.20, 0.45, 0.30, hair, 0, 4.850, 1.15));   // front fringe / hairline

  return g;
}

// The angry face texture is pixel-identical and colour-independent for every
// humanoid unit, so it is built once and shared across all of them. The shared
// flag lets the 3D renderer's disposeObject() skip it when freeing per-unit
// resources (see RND-LEAK-1).
let faceTex: THREE.CanvasTexture | null = null;

/** The memoized shared face texture, or null if it hasn't been built yet. */
export function getSharedFaceTexture(): THREE.CanvasTexture | null {
  return faceTex;
}

// Paints the tan face with two angry eyebrows + an open frowning mouth.
// Memoized: all produced textures are identical, so the canvas + CanvasTexture
// are built exactly once and reused for every unit (RND-PERF-4).
function makeFace(): THREE.CanvasTexture {
  return faceTex ??= buildFace();
}

function buildFace(): THREE.CanvasTexture {
  const s = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const x = cv.getContext('2d')!;

  x.fillStyle = '#d9b97f'; // matches the skin material so edges blend
  x.fillRect(0, 0, s, s);

  // eyebrows: thick black bars angled down toward the centre (anger)
  x.fillStyle = '#1d1d1d';
  drawBrow(x, s * 0.355, s * 0.40, 0.42, s * 0.26, s * 0.085);
  drawBrow(x, s * 0.645, s * 0.40, -0.42, s * 0.26, s * 0.085);

  // wide open mouth
  roundRect(x, s * 0.34, s * 0.70, s * 0.32, s * 0.15, s * 0.05);
  x.fill();

  const t = new THREE.CanvasTexture(cv);
  t.anisotropy = 8;
  t.encoding = THREE.sRGBEncoding;
  // Tag as shared so the 3D renderer's disposeObject() never frees it. (Texture
  // carries a runtime `userData` object that the r128 type defs don't declare.)
  (t as unknown as { userData: Record<string, unknown> }).userData = { shared: true };
  return t;

  function drawBrow(ctx: CanvasRenderingContext2D, px: number, py: number, rot: number, w: number, h: number): void {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rot);
    roundRect(ctx, -w / 2, -h / 2, w, h, h / 2);
    ctx.fill();
    ctx.restore();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
