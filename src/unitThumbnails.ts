// Renders unit 3D models to transparent PNG thumbnails (data URLs) for the
// unit-card UI, using a single shared offscreen WebGL renderer. Results are
// cached per (type, team colour), so each model is rendered at most once.
import * as THREE from 'three';
import { UnitType } from './types';
import { buildUnitModel } from './voxelUnits';
import { buildTemple } from './voxelTemple';

let renderer: THREE.WebGLRenderer | null = null;
let thumbSize = 0;
const cache = new Map<string, Partial<Record<UnitType, string>>>();
const upgradeCache = new Map<string, string>(); // keyed `${color}:${level}`

function getRenderer(size: number): THREE.WebGLRenderer {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
  }
  if (thumbSize !== size) { renderer.setSize(size, size, false); thumbSize = size; }
  return renderer;
}

function disposeModel(model: THREE.Object3D): void {
  model.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : (m.material ? [m.material] : []);
    for (const mt of mats) (mt as THREE.Material).dispose();
  });
}

// Render one unit model to a data-URL PNG. `color` is any CSS colour string.
export function getUnitThumbnail(type: UnitType, color: string, size = 256): string {
  let byColor = cache.get(color);
  if (byColor && byColor[type]) return byColor[type]!;
  if (!byColor) { byColor = {}; cache.set(color, byColor); }

  const r = getRenderer(size);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4456, 0.95));
  const key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(3, 6, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd0ff, 0.45);
  rim.position.set(-4, 3, -5);
  scene.add(rim);

  const model = buildUnitModel(type, new THREE.Color(color).getHex());
  scene.add(model);

  // Frame the model: fit a bounding sphere into the view from a 3/4 front angle.
  const box = new THREE.Box3().setFromObject(model);
  const sph = box.getBoundingSphere(new THREE.Sphere());
  const c = sph.center, rad = Math.max(sph.radius, 0.001);
  const fov = 30;
  const cam = new THREE.PerspectiveCamera(fov, 1, 0.01, 100);
  const dist = (rad * 1.18) / Math.sin((fov / 2) * Math.PI / 180);
  cam.position.copy(c).add(new THREE.Vector3(0.45, 0.5, 1).normalize().multiplyScalar(dist));
  cam.lookAt(c);

  r.render(scene, cam);
  const url = r.domElement.toDataURL('image/png');
  byColor[type] = url;
  disposeModel(model);
  return url;
}

// Render the team's temple model (at its current level) with a gold up-arrow
// floating above it — the icon for the "upgrade temple" button. Cached per
// (colour, level).
export function getTempleUpgradeThumbnail(color: string, level: number, size = 256): string {
  const key = `${color}:${level}`;
  const hit = upgradeCache.get(key);
  if (hit) return hit;

  const r = getRenderer(size);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4456, 0.95));
  const k = new THREE.DirectionalLight(0xffffff, 1.05); k.position.set(3, 6, 6); scene.add(k);
  const rim = new THREE.DirectionalLight(0xbcd0ff, 0.45); rim.position.set(-4, 3, -5); scene.add(rim);

  const root = new THREE.Group();
  const temple = buildTemple(new THREE.Color(color).getHex(), Math.max(1, Math.min(10, Math.floor(level || 1))));
  root.add(temple);

  // gold up-arrow above the temple
  const arrowMat = new THREE.MeshStandardMaterial({ color: 0xe7c24a, emissive: 0x6b5212, emissiveIntensity: 0.5, flatShading: true, roughness: 0.5, metalness: 0 });
  const pts: [number, number][] = [[-0.2, -0.55], [0.2, -0.55], [0.2, 0.12], [0.5, 0.12], [0, 0.66], [-0.5, 0.12], [-0.2, 0.12]];
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const ageo = new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 1 });
  ageo.center();
  const arrow = new THREE.Mesh(ageo, arrowMat);
  const tbox = new THREE.Box3().setFromObject(temple);
  arrow.scale.setScalar(1.15);
  arrow.position.set(0, tbox.max.y + 0.55, 0);
  root.add(arrow);
  scene.add(root);

  const box = new THREE.Box3().setFromObject(root);
  const sph = box.getBoundingSphere(new THREE.Sphere());
  const c = sph.center, rad = Math.max(sph.radius, 0.001);
  const fov = 32;
  const cam = new THREE.PerspectiveCamera(fov, 1, 0.01, 100);
  const dist = (rad * 1.12) / Math.sin((fov / 2) * Math.PI / 180);
  cam.position.copy(c).add(new THREE.Vector3(0.4, 0.42, 1).normalize().multiplyScalar(dist));
  cam.lookAt(c);

  r.render(scene, cam);
  const url = r.domElement.toDataURL('image/png');
  upgradeCache.set(key, url);
  disposeModel(root);
  return url;
}
