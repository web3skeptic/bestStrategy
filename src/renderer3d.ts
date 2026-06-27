import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { GameState, HexCoord, Unit, Temple, TeleportBuilding, SUPPORT_RANGE } from './types';
import { generateHexMap, hexKey, hexDistance, hexRound } from './hex';
import { getCurrentPlayer, getCurrentPlayerVisible, getPlayerVisible, isForestUnitRevealed } from './game';
import { makePalette, Palette, hexToWorld, worldToHexFractional, HEX_R, TILE_H } from './three/palette';
import * as B from './three/builders.gen';
import { buildPortal } from './voxelPortal';
import { buildTemple } from './voxelTemple';
import { buildUnitModel } from './voxelUnits';
import { getSharedFaceTexture } from './voxelWarrior';

const MOVE_ANIM_MS = 260;
const EXPLOSION_MS = 440;
const UNIT_LAYER = 1; // extra layer lit by unit-only lights so units stay bright
const HILL_ELEV = 0.18;     // units on a hill sit slightly higher
const TEMPLE_ELEV = 0.5;    // units on a temple tile perch on its steps, not inside it
const TURN_SPEED = 12;      // unit facing rotation speed (rad/s)
const FOREST_FADE = 0.45;   // opacity of own units hidden in a forest
// Explored-but-not-currently-visible tiles keep their real terrain, but every
// material on the tile (prism + grass + trees + flowers) is dimmed to this
// fraction of its lit brightness — no extra overlay shape is drawn.
const FOG_MEMORY_SHADE = 0.33;
// Duration of the fade between lit terrain and the dimmed "remembered" look.
const FOG_FADE_MS = 500;

// An in-flight fade of one tile between its lit and dimmed look. While a tile
// fades it wears throwaway per-mesh material clones whose colour is lerped each
// frame; on completion it settles back onto the shared lit / dimmed materials.
type TileFade = {
  fromFactor: number;
  toFactor: number;
  start: number;
  meshes: {
    mesh: THREE.Mesh;
    litMat: THREE.Material | THREE.Material[];
    temps: THREE.Material[];
    bases: { color: THREE.Color | null; emissive: THREE.Color | null }[];
  }[];
};

// Structures (temples/portals) own their materials, so we dim them by scaling the
// material colour/emissive in place (no clones) — one part per material.
type StructPart = { mat: THREE.MeshStandardMaterial; baseColor: THREE.Color | null; baseEmissive: THREE.Color | null };
type StructFade = { parts: StructPart[]; fromFactor: number; toFactor: number; start: number };

// A unit model's facing rotation (about Y) to point toward world direction
// (dx, dz): atan2(dx, dz) for a +Z-forward model, plus a per-model offset. The
// mounted models (horse/knight) face -X by default, so they need +90°.
function forwardOffset(type: string): number {
  return (type === 'horserider' || type === 'heavyknight') ? Math.PI / 2 : 0;
}

type TileKind = 'plain' | 'forest' | 'hill' | 'wall';

// A screen-space button rendered in the Three.js HUD layer: a chiseled low-poly
// rock slab (lit, flat-shaded) with a text label plane on its face.
interface HudButton {
  id: string;
  group: THREE.Group;
  rock: THREE.Mesh;
  rockMat: THREE.MeshStandardMaterial;
  labelCanvas?: HTMLCanvasElement;
  labelTex?: THREE.CanvasTexture;
  iconGroup?: THREE.Group;
  iconMats?: THREE.MeshStandardMaterial[];
  label: string;
  enabled: boolean;
  hovered: boolean;
  w: number;
  h: number;
}

// Stone-slab colours by state.
const ROCK_NORMAL = 0x5e6470;
const ROCK_HOVER = 0x7a8290;
const ROCK_DISABLED = 0x2a2e36;

const ROCK_PEAK_Z = 12; // front-face apex height (also where the label floats above)

// A faceted low-poly "rock" slab: a hewn octagon whose front face fans out from a
// raised, jittered centre to the rim, with chunky side walls. Flat-shaded, each
// triangle reads as a distinct chiselled facet.
function rockSlabGeometry(w: number, h: number): THREE.BufferGeometry {
  const hw = w / 2, hh = h / 2;
  const c = Math.min(hw, hh) * 0.55;
  // hewn octagon rim (deterministic jitter so it reads as cut stone)
  const oct: [number, number][] = [
    [-hw + c * 0.7, -hh + 1], [hw - c, -hh - 1], [hw + 1, -hh + c * 0.8], [hw - 1, hh - c],
    [hw - c * 0.9, hh + 1], [-hw + c, hh - 1], [-hw - 1, hh - c * 0.7], [-hw + 1, -hh + c],
  ];
  const N = oct.length;
  const zf = 4, zb = -8, peak = ROCK_PEAK_Z;
  // slight per-corner front-rim height variation → tilted facets
  const rimZ = oct.map((_, i) => zf + (i % 2 === 0 ? 1.4 : -1.1) + (i % 3 === 0 ? 1.0 : 0));
  const pos: number[] = [];
  const tri = (a: number[], b: number[], d: number[]) => pos.push(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2]);
  const apex = [0, 1.5, peak];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const pi = [oct[i][0], oct[i][1], rimZ[i]];
    const pj = [oct[j][0], oct[j][1], rimZ[j]];
    const bi = [oct[i][0], oct[i][1], zb];
    const bj = [oct[j][0], oct[j][1], zb];
    tri(apex, pi, pj);                 // front facet
    tri(pi, bi, bj); tri(pi, bj, pj);  // side wall
    tri([0, 0, zb], bj, bi);           // back cap
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// A small low-poly 3D icon to sit on a HUD button face (flat-shaded, lit by the
// HUD lights). 'flask' = a research flask with glowing liquid; 'endturn' = a
// chunky forward arrow.
function buildHudIcon(kind: string): { group: THREE.Group; mats: THREE.MeshStandardMaterial[] } {
  const group = new THREE.Group();
  const mats: THREE.MeshStandardMaterial[] = [];
  const M = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.8, metalness: 0, ...opts });
    mats.push(m);
    return m;
  };
  if (kind === 'flask') {
    const glass = M(0xbcd4e2, { roughness: 0.3 });
    const liquid = M(0x33e0a0, { emissive: 0x17c184, emissiveIntensity: 1.2, roughness: 0.4 });
    const cork = M(0xc9b78c);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 8.6, 16, 8), glass);
    group.add(body);
    const liq = new THREE.Mesh(new THREE.CylinderGeometry(5.6, 7.7, 7, 8), liquid);
    liq.position.y = -4.2; group.add(liq);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.4, 8, 8), glass);
    neck.position.y = 12; group.add(neck);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 1.8, 8), cork);
    rim.position.y = 16.4; group.add(rim);
    const b1 = new THREE.Mesh(new THREE.SphereGeometry(1.1, 6, 5), liquid);
    b1.position.set(1.6, -1.5, 2); group.add(b1);
    const b2 = new THREE.Mesh(new THREE.SphereGeometry(0.8, 6, 5), liquid);
    b2.position.set(-2, 0.6, 1.6); group.add(b2);
  } else if (kind === 'temple') { // 'temple' — classical temple with a gold "level up" arrow
    const stone = M(0xd8c9a8, { roughness: 0.85 });
    const gold = M(0xe7c24a, { roughness: 0.45, emissive: 0x6e5310, emissiveIntensity: 0.5 });
    // stepped stone base
    const base = new THREE.Mesh(new THREE.BoxGeometry(22, 3, 9), stone);
    base.position.y = -10; group.add(base);
    const base2 = new THREE.Mesh(new THREE.BoxGeometry(18, 2.4, 8), stone);
    base2.position.y = -7.2; group.add(base2);
    // four columns
    for (const dx of [-6.6, -2.2, 2.2, 6.6]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 9, 6), stone);
      col.position.set(dx, -1, 0); group.add(col);
    }
    // entablature / lintel
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(19, 2.6, 8.2), stone);
    lintel.position.y = 4.2; group.add(lintel);
    // triangular pediment roof (extruded prism)
    const tri = new THREE.Shape();
    tri.moveTo(-11, 0); tri.lineTo(11, 0); tri.lineTo(0, 6.5); tri.closePath();
    const roofGeo = new THREE.ExtrudeGeometry(tri, { depth: 8, bevelEnabled: false });
    roofGeo.center();
    const roof = new THREE.Mesh(roofGeo, stone);
    roof.position.y = 8.7; group.add(roof);
    // gold "level up" chevron arrow hovering above, pointing up
    const aPts: [number, number][] = [[3.5, -11], [3.5, 2], [9, 2], [0, 12], [-9, 2], [-3.5, 2], [-3.5, -11]];
    const aShape = new THREE.Shape();
    aShape.moveTo(aPts[0][0], aPts[0][1]);
    for (let i = 1; i < aPts.length; i++) aShape.lineTo(aPts[i][0], aPts[i][1]);
    aShape.closePath();
    const aGeo = new THREE.ExtrudeGeometry(aShape, { depth: 5, bevelEnabled: true, bevelThickness: 1.2, bevelSize: 1, bevelSegments: 1 });
    aGeo.center();
    const arrow = new THREE.Mesh(aGeo, gold);
    arrow.scale.setScalar(0.62);
    arrow.position.set(0, 18.5, 3); group.add(arrow);
  } else { // 'endturn' — forward arrow
    const gold = M(0xe7c24a, { roughness: 0.5 });
    const pts: [number, number][] = [[-11, -3.5], [2, -3.5], [2, -9], [12, 0], [2, 9], [2, 3.5], [-11, 3.5]];
    const shape = new THREE.Shape();
    shape.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 6, bevelEnabled: true, bevelThickness: 1.8, bevelSize: 1.5, bevelSegments: 1 });
    geo.center();
    group.add(new THREE.Mesh(geo, gold));
  }
  for (const m of mats) { m.userData.baseColor = m.color.clone(); m.userData.baseEmissive = m.emissiveIntensity; }
  // centre the icon and scale it to a consistent on-button height
  const box = new THREE.Box3().setFromObject(group);
  const c = box.getCenter(new THREE.Vector3());
  group.children.forEach(ch => ch.position.sub(c));
  const sizeY = Math.max(box.max.y - box.min.y, 0.001);
  group.scale.setScalar(32 / sizeY);
  return { group, mats };
}

// Drop-in 3D replacement for the 2D Renderer: same public surface that main.ts
// and the replay viewers use, plus pickHex() for raycast selection.
export class Renderer3D {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private P: Palette;

  private mapHexes: HexCoord[] = [];
  private mapRadius = 0;

  private tileGroup = new THREE.Group();
  private overlayGroup = new THREE.Group();
  private structureGroup = new THREE.Group();
  private unitGroup = new THREE.Group();

  private tileMeshes = new Map<string, THREE.Object3D>();
  private capMeshes = new Map<string, THREE.Mesh>();
  private unitMeshes = new Map<string, THREE.Object3D>();
  private boosterAuras = new Map<string, THREE.Mesh[]>(); // pulsating range rings, keyed by unit id
  private unitHpBars = new Map<string, { group: THREE.Group; fg: THREE.Mesh; barW: number }>();
  private lastUnitHp = new Map<string, number>(); // for detecting damage → hit explosions
  private templeMeshes = new Map<string, { mesh: THREE.Object3D; color: number; level: number }>();
  private teleportMeshes = new Map<string, THREE.Object3D>();
  private highlightPool: THREE.Mesh[] = [];

  private capGeo: THREE.CylinderGeometry;
  private highlightGeo: THREE.CylinderGeometry;
  private fogMat: THREE.MeshStandardMaterial;
  // Dimmed clones of the tiles' lit materials (cached, keyed by the lit material),
  // applied to a tile's meshes while it is explored-but-unseen.
  private darkMatCache = new Map<THREE.Material, THREE.Material>();
  // The fog shade currently targeted for each tile, so syncFog only re-shades on change.
  private tileFogState = new Map<string, 'lit' | 'dark' | 'hidden'>();
  // Tiles currently fading between lit and dimmed, advanced each frame.
  private tileFades = new Map<string, TileFade>();
  // Same fog dimming for structures (temples/portals), keyed by 'T'+id / 'P'+id.
  private structFogState = new Map<string, 'lit' | 'dark' | 'hidden'>();
  private structFades = new Map<string, StructFade>();
  // Class-owned singletons (geometries/materials/textures) that are shared across
  // many objects and must NEVER be freed by disposeObject() — doing so would
  // corrupt every other object that still references them. See RND-LEAK-1.
  private sharedResources = new Set<unknown>();

  private moveAnims = new Map<string, { from: HexCoord; start: number }>();
  private unitFacing = new Map<string, { cur: number; tgt: number }>(); // animated facing (rot.y)
  private unitFaded = new Map<string, boolean>(); // current forest-stealth fade state
  private lastFacingNow = 0;
  // Expanding ground rings shown when an attack splashes multiple units (AoE).
  private shockwaves: { start: number; mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; geo: THREE.RingGeometry }[] = [];

  // Rotating yellow pointer hovering over the currently-selected temple.
  private templePointer: THREE.Group | null = null;
  private templePointerBaseY = 0;

  // ── Three.js HUD layer: screen-space buttons rendered over the board ──
  private hudScene = new THREE.Scene();
  private hudCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
  private hudButtons: HudButton[] = [];
  private hudVisible = false;
  private readonly hudW = 104;
  private readonly hudH = 50;
  private readonly hudGap = 16;
  private explosions: {
    start: number; group: THREE.Group;
    cx: number; cy: number; cz: number;
    flash: THREE.Mesh; flashMat: THREE.MeshBasicMaterial; flashGeo: THREE.SphereGeometry;
    sparks: { mesh: THREE.Mesh; vel: THREE.Vector3 }[];
    sparkMat: THREE.MeshBasicMaterial; sparkGeo: THREE.SphereGeometry;
    light: THREE.PointLight | null; sizeMul: number;
  }[] = [];
  private explosionLights: THREE.PointLight[] = []; // reused pool (avoids shader recompiles)

  private lastState: GameState | null = null;
  private lastViewer?: number;
  private lastOmniscient?: boolean;

  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.P = makePalette();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputEncoding = THREE.sRGBEncoding;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x12131a);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    this.camera.position.set(0, 16, 18);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 70;
    this.controls.maxPolarAngle = Math.PI * 0.49; // stay above the board

    // Main lighting — dimmed so the map / terrain / structures read less bright.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4456, 0.48));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(-14, 24, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 90;
    const d = 24;
    sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
    sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.15);
    fill.position.set(12, 9, -10);
    this.scene.add(fill);

    // Unit-only lights (UNIT_LAYER): re-brighten units so they stay prominent
    // while the dimmer main lights leave the rest of the map muted.
    const unitKey = new THREE.DirectionalLight(0xffffff, 0.35);
    unitKey.position.set(-14, 24, 12);
    unitKey.layers.set(UNIT_LAYER);
    this.scene.add(unitKey);
    const unitAmb = new THREE.HemisphereLight(0xffffff, 0x44506a, 0.3);
    unitAmb.layers.set(UNIT_LAYER);
    this.scene.add(unitAmb);

    // Reusable pool of explosion point-lights (always present at intensity 0, so
    // the shader light-count never changes — no recompile hitch on each hit).
    for (let i = 0; i < 4; i++) {
      const pl = new THREE.PointLight(0xffd27a, 0, 7, 2);
      this.scene.add(pl);
      this.explosionLights.push(pl);
    }

    this.scene.add(this.tileGroup, this.overlayGroup, this.structureGroup, this.unitGroup);

    // Rotating yellow "active temple" pointer (a downward pyramid + cube), hidden
    // until a temple is selected. Spins + bobs in advanceAnimations.
    this.templePointer = new THREE.Group();
    const ptrMat = new THREE.MeshStandardMaterial({ color: 0xffd23a, emissive: 0xffb000, emissiveIntensity: 0.6, roughness: 0.5, metalness: 0 });
    const ptrCone = new THREE.Mesh(new THREE.CylinderGeometry(0, 0.24, 0.42, 4), ptrMat);
    ptrCone.rotation.x = Math.PI; // point down at the temple
    ptrCone.position.y = 0.21;
    const ptrCube = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), ptrMat);
    ptrCube.position.y = 0.56;
    ptrCube.rotation.set(Math.PI / 4, Math.PI / 4, 0);
    this.templePointer.add(ptrCone, ptrCube);
    this.templePointer.visible = false;
    this.templePointer.traverse(o => o.layers.enable(UNIT_LAYER)); // keep it bright
    this.scene.add(this.templePointer);

    // Shared overlay geometries/materials.
    // Solid dark hex prism (same shape/size as a tile) used to replace a tile
    // that is fogged: features are hidden and this opaque dark tile shows instead.
    this.capGeo = new THREE.CylinderGeometry(HEX_R, HEX_R, TILE_H, 6);
    this.highlightGeo = new THREE.CylinderGeometry(HEX_R * 0.92, HEX_R * 0.92, 0.03, 6);
    this.fogMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 1 }); // unexplored: opaque near-black

    // Register the shared singletons so disposeObject() never frees them. The
    // shared unit face texture is created lazily by voxelWarrior on the first
    // unit build, so it is added in disposeObject (and is also tagged with
    // userData.shared = true as a belt-and-suspenders guard).
    this.sharedResources.add(this.capGeo);
    this.sharedResources.add(this.highlightGeo);
    this.sharedResources.add(this.fogMat);

    this.hudCamera.position.z = 40; // ortho HUD camera looks down -z at the slabs
    // Light the HUD rock slabs from the top-left-front so the chiselled facets read.
    this.hudScene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const hudKey = new THREE.DirectionalLight(0xffffff, 0.85);
    hudKey.position.set(-0.5, 0.9, 0.8);
    this.hudScene.add(hudKey);
    const hudRim = new THREE.DirectionalLight(0x9fb0d0, 0.35);
    hudRim.position.set(0.6, -0.4, 0.5);
    this.hudScene.add(hudRim);
    this.canvas.addEventListener('pointermove', e => this.onHudHover(e));

    this.startLoop();
  }

  init(mapRadius: number): void {
    this.mapRadius = mapRadius;
    this.mapHexes = generateHexMap(mapRadius);
    this.disposeGroup(this.tileGroup);
    this.disposeGroup(this.overlayGroup);
    this.disposeGroup(this.structureGroup);
    this.disposeGroup(this.unitGroup);
    this.tileMeshes.clear();
    this.capMeshes.clear();
    this.tileFogState.clear();
    // Drop any in-flight tile fades and their throwaway clone materials.
    for (const fade of this.tileFades.values()) for (const fm of fade.meshes) for (const t of fm.temps) t.dispose();
    this.tileFades.clear();
    this.structFogState.clear();
    this.structFades.clear();
    // Drop the dimmed-material clones from the previous map (lit materials are
    // palette-cached and reused, so only the clones are freed here).
    for (const dim of this.darkMatCache.values()) { this.sharedResources.delete(dim); dim.dispose(); }
    this.darkMatCache.clear();
    this.unitMeshes.clear();
    this.boosterAuras.clear();
    this.unitHpBars.clear();
    this.lastUnitHp.clear();
    this.templeMeshes.clear();
    this.teleportMeshes.clear();
    this.highlightPool = [];
    this.moveAnims.clear();
    this.unitFacing.clear();
    this.unitFaded.clear();
    for (const s of this.shockwaves) { this.overlayGroup.remove(s.mesh); s.geo.dispose(); s.mat.dispose(); }
    this.shockwaves = [];
    this.explosions = [];
    for (const l of this.explosionLights) l.intensity = 0;
    this.controls.target.set(0, 0, 0);
  }

  // ── public API parity with the 2D renderer ──

  get zoom(): number { return 1; }
  zoomIn(): void { this.dolly(0.85); }
  zoomOut(): void { this.dolly(1.18); }
  pan(_dx: number, _dy: number): void { /* orbit controls handle panning (right-drag) */ }
  getHexSize(): number { return HEX_R; }
  getCenter(): { x: number; y: number } { return { x: 0, y: 0 }; }

  private dolly(factor: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const len = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    offset.setLength(len);
    this.camera.position.copy(this.controls.target).add(offset);
  }

  resizeToContainer(): boolean {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return false;
    const cur = this.renderer.getSize(new THREE.Vector2());
    if (Math.round(cur.x) === w && Math.round(cur.y) === h) return false;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // HUD ortho camera maps 1 world unit = 1 pixel, origin at screen centre.
    this.hudCamera.left = -w / 2; this.hudCamera.right = w / 2;
    this.hudCamera.top = h / 2; this.hudCamera.bottom = -h / 2;
    this.hudCamera.updateProjectionMatrix();
    this.layoutHud(w, h);
    return true;
  }

  startMoveAnimation(unitId: string, fromHex: HexCoord): void {
    this.moveAnims.set(unitId, { from: { ...fromHex }, start: performance.now() });
  }

  // Turn a unit to face a target tile (e.g. the tile it just attacked). The
  // rotation is animated in advanceAnimations.
  faceUnitToward(unitId: string, target: HexCoord): void {
    const unit = this.lastState?.units.find(u => u.id === unitId);
    const f = this.unitFacing.get(unitId);
    if (!unit || !f) return;
    const from = hexToWorld(unit.pos);
    const to = hexToWorld(target);
    const dx = to.x - from.x, dz = to.z - from.z;
    if (dx || dz) f.tgt = Math.atan2(dx, dz) + forwardOffset(unit.type);
  }

  // Expanding ground ring marking a splash/AoE impact, centred on a tile.
  private startShockwave(pos: HexCoord, delayMs = 0): void {
    const { x, z } = hexToWorld(pos);
    const geo = new THREE.RingGeometry(0.62, 0.82, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffb24a, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.06, z);
    mesh.renderOrder = 997;
    this.overlayGroup.add(mesh);
    this.shockwaves.push({ start: performance.now() + delayMs, mesh, mat, geo });
  }

  // Light-burst explosion at the hit tile: an expanding additive flash, flying
  // sparks, and a brief point-light flash on the surroundings. No weapon motion.
  startHitAnimation(pos: HexCoord, delayMs = 0, damage = 0): void {
    const { x, z } = hexToWorld(pos);
    const cy = 0.7;
    // Bigger hits make bigger blasts.
    const mag = THREE.MathUtils.clamp(0.55 + damage * 0.06, 0.55, 1.9);
    const group = new THREE.Group();

    const flashGeo = new THREE.SphereGeometry(0.28, 12, 10);
    const flashMat = new THREE.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const flash = new THREE.Mesh(flashGeo, flashMat);
    flash.position.set(x, cy, z);
    group.add(flash);

    const sparkGeo = new THREE.SphereGeometry(0.06, 6, 5);
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xfff1c8, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const sparks: { mesh: THREE.Mesh; vel: THREE.Vector3 }[] = [];
    const nSparks = THREE.MathUtils.clamp(Math.round(6 + damage * 0.6), 6, 20);
    for (let i = 0; i < nSparks; i++) {
      const m = new THREE.Mesh(sparkGeo, sparkMat);
      m.position.set(x, cy, z);
      const ang = (i / nSparks) * Math.PI * 2 + Math.random() * 0.6;
      const out = (2.0 + Math.random() * 2.2) * mag;
      const up = (1.8 + Math.random() * 2.4) * mag;
      sparks.push({ mesh: m, vel: new THREE.Vector3(Math.cos(ang) * out, up, Math.sin(ang) * out) });
      group.add(m);
    }

    // Grab a free pooled light (if any) and flash it at the blast.
    const used = new Set(this.explosions.map(e => e.light));
    const light = this.explosionLights.find(l => !used.has(l)) ?? null;
    if (light) light.position.set(x, cy + 0.4, z);

    this.overlayGroup.add(group);
    group.visible = delayMs <= 0; // stays hidden until its (possibly delayed) start
    this.explosions.push({ start: performance.now() + delayMs, group, cx: x, cy, cz: z, flash, flashMat, flashGeo, sparks, sparkMat, sparkGeo, light, sizeMul: mag });
  }

  /** Raycast a screen point onto the board plane → hex coord (or null). */
  pickHex(clientX: number, clientY: number): HexCoord | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const pt = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, pt)) return null;
    const { q, r } = worldToHexFractional(pt.x, pt.z);
    const hex = hexRound({ q, r });
    if (hexDistance({ q: 0, r: 0 }, hex) > this.mapRadius) return null;
    return hex;
  }

  // ── state → scene sync ──

  render(state: GameState, viewerPlayerId?: number, omniscient?: boolean): void {
    this.lastState = state;
    this.lastViewer = viewerPlayerId;
    this.lastOmniscient = omniscient;

    const playerId = viewerPlayerId ?? getCurrentPlayer(state).id;
    let explored: Set<string>;
    let visible: Set<string>;
    if (omniscient) {
      const all = new Set(this.mapHexes.map(h => hexKey(h)));
      explored = all; visible = all;
    } else {
      explored = state.explored[playerId]!;
      visible = viewerPlayerId !== undefined ? getPlayerVisible(state, viewerPlayerId) : getCurrentPlayerVisible(state);
    }

    if (this.tileMeshes.size === 0) this.buildTiles(state);
    this.detectHits(state, playerId, visible, !!omniscient);
    this.syncFog(explored, visible);
    this.syncHighlights(state, explored);
    this.syncStructures(state, explored, visible);
    this.syncUnits(state, playerId, visible, !!omniscient);
  }

  private tileKindOf(state: GameState, key: string): TileKind {
    if (state.walls.has(key)) return 'wall';
    if (state.forests.has(key)) return 'forest';
    if (state.hills.has(key)) return 'hill';
    return 'plain';
  }

  private buildTiles(state: GameState): void {
    for (const hex of this.mapHexes) {
      const key = hexKey(hex);
      const kind = this.tileKindOf(state, key);
      const tile =
        kind === 'wall' ? B.build_tileWall(THREE, this.P)
        : kind === 'forest' ? B.build_tileForest(THREE, this.P)
        : kind === 'hill' ? B.build_tileHill(THREE, this.P)
        : B.build_tilePlain(THREE, this.P);
      const { x, z } = hexToWorld(hex);
      tile.position.set(x, 0, z);
      this.tileGroup.add(tile);
      this.tileMeshes.set(key, tile);

      // Remember each tile mesh's lit material so it can be swapped for a dimmed
      // clone while explored-but-unseen (and back when visible). Protect these
      // (mostly palette-cached) materials so disposeGroup() on the next game's
      // init() can't free a material the rebuilt tiles will reuse.
      tile.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.material) return;
        m.userData.litMat = m.material;
        for (const mt of (Array.isArray(m.material) ? m.material : [m.material])) {
          this.sharedResources.add(mt);
        }
      });

      // Solid dark tile shown when this hex is unexplored (hides the real terrain).
      const cap = new THREE.Mesh(this.capGeo, this.fogMat);
      cap.rotation.y = Math.PI / 6;
      cap.position.set(x, -TILE_H / 2, z);
      cap.receiveShadow = true;
      cap.visible = false;
      this.overlayGroup.add(cap);
      this.capMeshes.set(key, cap);
    }
  }

  private syncFog(explored: Set<string>, visible: Set<string>): void {
    for (const hex of this.mapHexes) {
      const key = hexKey(hex);
      const want: 'lit' | 'dark' | 'hidden' =
        visible.has(key) ? 'lit' : explored.has(key) ? 'dark' : 'hidden';
      const prev = this.tileFogState.get(key);
      if (prev === want) continue;
      this.tileFogState.set(key, want);
      const tile = this.tileMeshes.get(key)!;
      const cap = this.capMeshes.get(key)!;
      if (want === 'hidden') {
        // Unexplored: hide the terrain entirely behind a flush, opaque dark hex.
        this.clearTileFade(key);
        tile.visible = false;
        cap.visible = true;
      } else {
        // Visible or explored-but-unseen: show the real terrain. For the latter we
        // dim every material on the tile itself (prism + grass + trees + flowers)
        // in place — no extra overlay shape — so the land reads as "remembered".
        // Enemy units on it stay hidden (syncUnits skips out-of-sight enemies), so
        // the player sees the terrain without the current enemy disposition.
        tile.visible = true;
        cap.visible = false;
        const targetFactor = want === 'dark' ? FOG_MEMORY_SHADE : 1;
        if (prev === 'lit' || prev === 'dark') {
          // Real terrain ↔ real terrain: ease the dim in/out instead of snapping.
          this.startTileFade(tile, key, targetFactor);
        } else {
          // First reveal (was unexplored): show the settled shade immediately.
          this.clearTileFade(key);
          this.shadeTile(tile, want === 'dark');
        }
      }
    }
  }

  // Begin (or redirect) a lit↔dimmed fade for a tile. While fading, the tile's
  // meshes wear throwaway material clones whose colour is lerped each frame.
  private startTileFade(tile: THREE.Object3D, key: string, toFactor: number): void {
    const now = performance.now();
    const existing = this.tileFades.get(key);
    if (existing) {
      // Reverse/redirect from wherever the fade currently is — no popping.
      existing.fromFactor = this.fadeFactorNow(existing, now);
      existing.toFactor = toFactor;
      existing.start = now;
      return;
    }
    const meshes: TileFade['meshes'] = [];
    tile.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const lit = m.userData.litMat as THREE.Material | THREE.Material[] | undefined;
      if (!lit) return;
      const litArr = Array.isArray(lit) ? lit : [lit];
      const temps = litArr.map(x => x.clone());
      m.material = Array.isArray(lit) ? temps : temps[0]!;
      const bases = litArr.map(x => {
        const sm = x as THREE.MeshStandardMaterial;
        return { color: sm.color ? sm.color.clone() : null, emissive: sm.emissive ? sm.emissive.clone() : null };
      });
      meshes.push({ mesh: m, litMat: lit, temps, bases });
    });
    const fromFactor = toFactor === 1 ? FOG_MEMORY_SHADE : 1;
    const fade: TileFade = { fromFactor, toFactor, start: now, meshes };
    this.applyFadeFactor(fade, fromFactor); // correct colour on the very first frame
    this.tileFades.set(key, fade);
  }

  private fadeFactorNow(fade: { fromFactor: number; toFactor: number; start: number }, now: number): number {
    const t = Math.min(Math.max((now - fade.start) / FOG_FADE_MS, 0), 1);
    const e = t * t * (3 - 2 * t); // smoothstep
    return fade.fromFactor + (fade.toFactor - fade.fromFactor) * e;
  }

  private applyFadeFactor(fade: TileFade, f: number): void {
    for (const fm of fade.meshes) {
      for (let i = 0; i < fm.temps.length; i++) {
        const tm = fm.temps[i] as THREE.MeshStandardMaterial;
        const base = fm.bases[i]!;
        if (base.color && tm.color) tm.color.copy(base.color).multiplyScalar(f);
        if (base.emissive && tm.emissive) tm.emissive.copy(base.emissive).multiplyScalar(f);
      }
    }
  }

  // Advance every in-flight tile fade; settle finished ones onto shared materials.
  private updateTileFades(now: number): void {
    if (this.tileFades.size === 0) return;
    for (const [key, fade] of this.tileFades) {
      this.applyFadeFactor(fade, this.fadeFactorNow(fade, now));
      if (now - fade.start >= FOG_FADE_MS) {
        for (const fm of fade.meshes) {
          fm.mesh.material = fade.toFactor === 1 ? fm.litMat : this.dimMaterial(fm.litMat);
          for (const t of fm.temps) t.dispose();
        }
        this.tileFades.delete(key);
      }
    }
  }

  private clearTileFade(key: string): void {
    const fade = this.tileFades.get(key);
    if (!fade) return;
    for (const fm of fade.meshes) {
      fm.mesh.material = fm.litMat;
      for (const t of fm.temps) t.dispose();
    }
    this.tileFades.delete(key);
  }

  // Swap a tile's meshes between their lit materials and dimmed clones.
  private shadeTile(tile: THREE.Object3D, dark: boolean): void {
    tile.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const lit = m.userData.litMat as THREE.Material | THREE.Material[] | undefined;
      if (!lit) return;
      m.material = dark ? this.dimMaterial(lit) : lit;
    });
  }

  // A dimmed clone of a lit material (cached, keyed by the lit material). The base
  // colour and any emissive are scaled down so the lit material is untouched and
  // shared across every tile that needs dimming. Material arrays are dimmed pairwise.
  private dimMaterial(lit: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
    if (Array.isArray(lit)) return lit.map(m => this.dimMaterial(m) as THREE.Material);
    let dim = this.darkMatCache.get(lit);
    if (!dim) {
      dim = lit.clone();
      const dm = dim as THREE.MeshStandardMaterial;
      if (dm.color) dm.color.multiplyScalar(FOG_MEMORY_SHADE);
      if (dm.emissive) dm.emissive.multiplyScalar(FOG_MEMORY_SHADE);
      this.darkMatCache.set(lit, dim);
      this.sharedResources.add(dim); // never freed by disposeObject()
    }
    return dim;
  }

  // ── Structure fog dimming (temples/portals) ──
  // Their materials are unique per structure, so we scale colour/emissive in place
  // (capturing the lit base once) instead of cloning like the shared tile materials.
  private structParts(root: THREE.Object3D): StructPart[] {
    const parts: StructPart[] = [];
    root.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.material) return;
      for (const raw of (Array.isArray(m.material) ? m.material : [m.material])) {
        const sm = raw as THREE.MeshStandardMaterial;
        if (sm.color && !sm.userData.litBaseColor) sm.userData.litBaseColor = sm.color.clone();
        if (sm.emissive && !sm.userData.litBaseEmissive) sm.userData.litBaseEmissive = sm.emissive.clone();
        parts.push({ mat: sm, baseColor: sm.userData.litBaseColor ?? null, baseEmissive: sm.userData.litBaseEmissive ?? null });
      }
    });
    return parts;
  }

  private setStructFactor(parts: StructPart[], f: number): void {
    for (const p of parts) {
      if (p.baseColor && p.mat.color) p.mat.color.copy(p.baseColor).multiplyScalar(f);
      if (p.baseEmissive && p.mat.emissive) p.mat.emissive.copy(p.baseEmissive).multiplyScalar(f);
    }
  }

  private startStructFade(root: THREE.Object3D, id: string, toFactor: number): void {
    const now = performance.now();
    const existing = this.structFades.get(id);
    if (existing) {
      existing.fromFactor = this.fadeFactorNow(existing, now);
      existing.toFactor = toFactor;
      existing.start = now;
      return;
    }
    const parts = this.structParts(root);
    const fromFactor = toFactor === 1 ? FOG_MEMORY_SHADE : 1;
    this.setStructFactor(parts, fromFactor);
    this.structFades.set(id, { parts, fromFactor, toFactor, start: now });
  }

  private updateStructFades(now: number): void {
    if (this.structFades.size === 0) return;
    for (const [id, fade] of this.structFades) {
      this.setStructFactor(fade.parts, this.fadeFactorNow(fade, now));
      if (now - fade.start >= FOG_FADE_MS) this.structFades.delete(id);
    }
  }

  // Apply lit/dark/hidden fog to a structure mesh, fading between lit and dark and
  // snapping only on first appearance / rebuild (forceInstant).
  private applyStructFog(root: THREE.Object3D, id: string, want: 'lit' | 'dark' | 'hidden', forceInstant: boolean): void {
    const prev = forceInstant ? undefined : this.structFogState.get(id);
    if (prev === want) return;
    this.structFogState.set(id, want);
    if (want === 'hidden') { this.structFades.delete(id); root.visible = false; return; }
    root.visible = true;
    if (prev === 'lit' || prev === 'dark') {
      this.startStructFade(root, id, want === 'dark' ? FOG_MEMORY_SHADE : 1);
    } else {
      this.structFades.delete(id);
      this.setStructFactor(this.structParts(root), want === 'dark' ? FOG_MEMORY_SHADE : 1);
    }
  }

  private syncHighlights(state: GameState, explored: Set<string>): void {
    const moveSet = new Set(state.moveHexes.map(h => hexKey(h)));
    const attackSet = new Set(state.attackHexes.map(h => hexKey(h)));
    const buildSet = new Set(state.buildHexes.map(h => hexKey(h)));
    const supportSet = new Set(state.supportHexes.map(h => hexKey(h)));

    let i = 0;
    const place = (hex: HexCoord, color: number) => {
      let mesh = this.highlightPool[i];
      if (!mesh) {
        mesh = new THREE.Mesh(this.highlightGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4 }));
        mesh.rotation.y = Math.PI / 6;
        this.overlayGroup.add(mesh);
        this.highlightPool[i] = mesh;
      }
      const { x, z } = hexToWorld(hex);
      mesh.position.set(x, 0.05, z);
      (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
      mesh.visible = true;
      i++;
    };

    for (const hex of this.mapHexes) {
      const key = hexKey(hex);
      if (!explored.has(key)) continue;
      if (attackSet.has(key)) place(hex, 0xd23232);
      else if (moveSet.has(key)) place(hex, 0x3cc850);
      else if (buildSet.has(key)) place(hex, 0x00c8ff);
      else if (supportSet.has(key)) place(hex, 0x5096e1);
    }
    for (; i < this.highlightPool.length; i++) this.highlightPool[i].visible = false;
  }

  private syncStructures(state: GameState, explored: Set<string>, visible: Set<string>): void {
    for (const temple of state.temples) {
      const key = hexKey(temple.pos);
      const owner = temple.ownerId !== null ? state.players.find(p => p.id === temple.ownerId) : null;
      const colorNum = owner ? new THREE.Color(owner.color).getHex() : this.P.colors.neutral;
      let entry = this.templeMeshes.get(temple.id);
      let rebuilt = false;
      if (!entry || entry.color !== colorNum || entry.level !== temple.level) {
        if (entry) { this.structureGroup.remove(entry.mesh); this.disposeObject(entry.mesh); }
        const mesh = buildTemple(colorNum, temple.level);
        const { x, z } = hexToWorld(temple.pos);
        mesh.position.set(x, 0, z);
        this.structureGroup.add(mesh);
        entry = { mesh, color: colorNum, level: temple.level };
        this.templeMeshes.set(temple.id, entry);
        rebuilt = true;
      }
      // Remembered-but-unseen temples dim like the terrain (fading) instead of
      // staying bright; only currently-visible temples show at full brightness.
      const want = visible.has(key) ? 'lit' : explored.has(key) ? 'dark' : 'hidden';
      this.applyStructFog(entry.mesh, 'T' + temple.id, want, rebuilt);
    }

    // Position the rotating pointer over the selected temple.
    const selId = state.selectionMode === 'temple' ? state.selectedTempleId : null;
    const selTemple = selId ? state.temples.find(t => t.id === selId) : null;
    if (this.templePointer) {
      if (selTemple) {
        const { x, z } = hexToWorld(selTemple.pos);
        const entry = this.templeMeshes.get(selTemple.id);
        const topY = entry ? new THREE.Box3().setFromObject(entry.mesh).max.y : 2.4;
        this.templePointerBaseY = topY + 0.5;
        this.templePointer.position.set(x, this.templePointerBaseY, z);
        this.templePointer.visible = true;
      } else {
        this.templePointer.visible = false;
      }
    }

    for (const tp of state.teleportBuildings) {
      const key = hexKey(tp.pos);
      let mesh = this.teleportMeshes.get(tp.id);
      let rebuilt = false;
      if (!mesh) {
        const builder = state.players.find(p => p.id === tp.builtByPlayerId);
        const colorNum = builder ? new THREE.Color(builder.color).getHex() : this.P.colors.neutral;
        mesh = buildPortal(colorNum);
        const { x, z } = hexToWorld(tp.pos);
        mesh.position.set(x, 0, z);
        this.structureGroup.add(mesh);
        this.teleportMeshes.set(tp.id, mesh);
        rebuilt = true;
      }
      const want = visible.has(key) ? 'lit' : explored.has(key) ? 'dark' : 'hidden';
      this.applyStructFog(mesh, 'P' + tp.id, want, rebuilt);
    }
  }

  private buildUnitMesh(unit: Unit, colorNum: number): THREE.Object3D {
    const wrap = buildUnitModel(unit.type, colorNum);
    // Support units get pulsating range "circles" (rings only — tiles inside are
    // NOT highlighted). Green = healer, orange = damage, cyan = range.
    const auraRadius = SUPPORT_RANGE * Math.sqrt(3) * HEX_R * 0.95;
    if (unit.type === 'healer') this.addAuraField(wrap, unit.id, 0x7be54a, auraRadius);
    else if (unit.type === 'damageBooster') this.addAuraField(wrap, unit.id, 0xff6a2a, auraRadius);
    else if (unit.type === 'rangeBooster') this.addAuraField(wrap, unit.id, 0x4fe3ff, auraRadius);
    return wrap;
  }

  // Concentric pulsating ring "circles" marking a support unit's range. No
  // filled disc, so the tiles inside are never highlighted/tinted.
  private addAuraField(wrap: THREE.Group, unitId: string, color: number, radius: number): void {
    const meshes: THREE.Mesh[] = [];
    // Two thin "ripple" rings at the range edge. The pulse loop scales each from
    // the centre outward (0 → 1) and fades it, so circles emanate from the unit.
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(radius * 0.95, radius, 64), // thin circle, not a thick tile-tinting band
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.4,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.07;
      wrap.add(mesh);
      meshes.push(mesh);
    }
    this.boosterAuras.set(unitId, meshes);
  }

  // Floating HP bar above a unit (billboarded toward the camera each frame).
  private addHpBar(parent: THREE.Object3D, unitId: string): void {
    const barW = 0.9, barH = 0.13;
    const group = new THREE.Group();
    group.position.y = 2.05; // above the ~1.6-tall unit

    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(barW + 0.06, barH + 0.06),
      new THREE.MeshBasicMaterial({ color: 0x101014, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }),
    );
    bg.renderOrder = 998;
    group.add(bg);

    const fg = new THREE.Mesh(
      new THREE.PlaneGeometry(barW, barH),
      new THREE.MeshBasicMaterial({ color: 0x44cc44, transparent: true, depthTest: false, depthWrite: false }),
    );
    fg.position.z = 0.001;
    fg.renderOrder = 999;
    group.add(fg);

    parent.add(group);
    this.unitHpBars.set(unitId, { group, fg, barW });
  }

  private updateHpBar(unitId: string, hp: number, maxHp: number): void {
    const bar = this.unitHpBars.get(unitId);
    if (!bar) return;
    bar.group.visible = hp < maxHp; // only show once the unit has been hit
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    bar.fg.scale.x = Math.max(0.0001, ratio);
    bar.fg.position.x = (-bar.barW * (1 - ratio)) / 2; // shrink from the right
    const c = ratio > 0.5 ? 0x44cc44 : ratio > 0.25 ? 0xcccc44 : 0xcc4444;
    (bar.fg.material as THREE.MeshBasicMaterial).color.setHex(c);
  }

  // Spawn a hit explosion wherever a unit lost HP since the last render — covers
  // your attacks, splash, revenge damage, AND enemy attacks, uniformly.
  private detectHits(state: GameState, playerId: number, visible: Set<string>, omniscient: boolean): void {
    const alive = new Set<string>();
    const hits: { pos: HexCoord; mine: boolean; dmg: number }[] = [];
    for (const unit of state.units) {
      alive.add(unit.id);
      const prev = this.lastUnitHp.get(unit.id);
      if (prev !== undefined && unit.hp < prev && (omniscient || visible.has(hexKey(unit.pos)))) {
        hits.push({ pos: { ...unit.pos }, mine: unit.playerId === playerId, dmg: prev - unit.hp });
      }
      this.lastUnitHp.set(unit.id, unit.hp);
    }
    for (const id of [...this.lastUnitHp.keys()]) if (!alive.has(id)) this.lastUnitHp.delete(id);
    // Split the explosions in time: the struck enemy first, your unit's hit-back after.
    hits.sort((a, b) => Number(a.mine) - Number(b.mine));
    hits.forEach((h, i) => this.startHitAnimation(h.pos, i * 260, h.dmg));
    // Splash/AoE: when one attack damages 2+ enemy units, add an expanding ground
    // ring centred on the hardest-hit tile so the area effect reads clearly.
    const enemyHits = hits.filter(h => !h.mine);
    if (enemyHits.length >= 2) {
      const primary = enemyHits.reduce((a, b) => (b.dmg > a.dmg ? b : a));
      this.startShockwave(primary.pos, 0);
    }
  }

  private syncUnits(state: GameState, playerId: number, visible: Set<string>, omniscient: boolean): void {
    const seen = new Set<string>();
    const now = performance.now();
    for (const unit of state.units) {
      if (unit.hp <= 0) continue;
      const key = hexKey(unit.pos);
      if (!omniscient && unit.playerId !== playerId && !visible.has(key)) continue;
      if (!omniscient && unit.playerId !== playerId && !isForestUnitRevealed(state, unit.pos, playerId)) continue;
      seen.add(unit.id);

      let mesh = this.unitMeshes.get(unit.id);
      if (!mesh) {
        const player = state.players.find(p => p.id === unit.playerId)!;
        const colorNum = new THREE.Color(player.color).getHex();
        // The model lives in an inner "facer" group that we rotate to face the
        // unit's heading; the outer group carries position + the HP bar (so the
        // billboarded HP bar never inherits the unit's facing rotation).
        const model = this.buildUnitMesh(unit, colorNum);
        const off = forwardOffset(unit.type);
        model.rotation.y = off;
        mesh = new THREE.Group();
        mesh.add(model);
        mesh.userData.facer = model;
        this.addHpBar(mesh, unit.id);
        mesh.traverse(o => o.layers.enable(UNIT_LAYER)); // lit by the brighter unit-only lights
        this.unitGroup.add(mesh);
        this.unitMeshes.set(unit.id, mesh);
        this.unitFacing.set(unit.id, { cur: off, tgt: off });
      }
      this.updateHpBar(unit.id, unit.hp, unit.stats.maxHp);

      // Forest stealth: fade the viewer's own units while they're hidden in a
      // forest (not revealed to the enemy); solid once spotted.
      this.applyForestFade(state, unit, mesh, playerId, omniscient);

      let pos = hexToWorld(unit.pos);
      let elev = this.elevationAt(state, unit.pos);
      const anim = this.moveAnims.get(unit.id);
      if (anim) {
        const t = Math.min((now - anim.start) / MOVE_ANIM_MS, 1);
        const ease = 1 - Math.pow(1 - t, 3);
        const from = hexToWorld(anim.from);
        pos = { x: from.x + (pos.x - from.x) * ease, z: from.z + (pos.z - from.z) * ease };
        const fromElev = this.elevationAt(state, anim.from);
        elev = fromElev + (elev - fromElev) * ease;
        // Face the direction of travel.
        const dx = hexToWorld(unit.pos).x - from.x, dz = hexToWorld(unit.pos).z - from.z;
        const f = this.unitFacing.get(unit.id);
        if (f && (dx || dz)) f.tgt = Math.atan2(dx, dz) + forwardOffset(unit.type);
        if (t >= 1) this.moveAnims.delete(unit.id);
      }
      mesh.position.set(pos.x, elev, pos.z);
      mesh.visible = true;
    }
    // Remove meshes for units that died / went out of view.
    for (const [id, mesh] of this.unitMeshes) {
      if (!seen.has(id)) {
        this.unitGroup.remove(mesh);
        this.disposeObject(mesh);
        this.unitMeshes.delete(id);
        this.boosterAuras.delete(id);
        this.unitHpBars.delete(id);
        this.unitFacing.delete(id);
        this.unitFaded.delete(id);
      }
    }
  }

  // y offset for a unit standing on this tile: lifted on hills, perched on temples.
  private elevationAt(state: GameState, pos: HexCoord): number {
    const k = hexKey(pos);
    let y = state.hills.has(k) ? HILL_ELEV : 0;
    if (state.temples.some(t => hexKey(t.pos) === k)) y = Math.max(y, TEMPLE_ELEV);
    return y;
  }

  // Fade the viewer's own units while hidden in a forest (not revealed to the
  // enemy). Materials are per-unit (no shared cache), so toggling opacity is safe.
  private applyForestFade(state: GameState, unit: Unit, mesh: THREE.Object3D, viewerId: number, omniscient: boolean): void {
    let faded = false;
    if (!omniscient && unit.playerId === viewerId && state.forests.has(hexKey(unit.pos))) {
      const enemy = state.players.find(p => p.id !== unit.playerId);
      if (enemy) faded = !isForestUnitRevealed(state, unit.pos, enemy.id);
    }
    if (this.unitFaded.get(unit.id) === faded) return;
    this.unitFaded.set(unit.id, faded);
    const facer = (mesh.userData.facer as THREE.Object3D) ?? mesh;
    facer.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mt of mats) { (mt as THREE.Material).transparent = faded; (mt as THREE.Material).opacity = faded ? FOREST_FADE : 1; }
    });
  }

  // ── render loop + animation ──

  private startLoop(): void {
    const tick = () => {
      this.resizeToContainer();
      this.controls.update();
      this.advanceAnimations();
      this.renderer.render(this.scene, this.camera);
      // HUD pass: draw the screen-space buttons on top of the board.
      if (this.hudVisible && this.hudButtons.length) {
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(this.hudScene, this.hudCamera);
        this.renderer.autoClear = true;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ── HUD buttons (Three.js screen-space layer) ──

  setHudButtons(defs: { id: string; label: string; icon?: string }[]): void {
    for (const b of this.hudButtons) {
      this.hudScene.remove(b.group);
      b.rock.geometry.dispose();
      b.rockMat.dispose();
      b.labelTex?.dispose();
      b.iconGroup?.traverse(o => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
      b.group.traverse(o => { const m = o as THREE.Mesh; if (m.material && m.material !== b.rockMat) (m.material as THREE.Material).dispose(); });
    }
    this.hudButtons = [];
    for (const d of defs) {
      const group = new THREE.Group();
      // chiselled rock slab body
      const rockMat = new THREE.MeshStandardMaterial({ color: ROCK_NORMAL, flatShading: true, roughness: 1, metalness: 0, side: THREE.DoubleSide });
      const rock = new THREE.Mesh(rockSlabGeometry(this.hudW, this.hudH), rockMat);
      rock.renderOrder = 1000;
      group.add(rock);
      const b: HudButton = { id: d.id, group, rock, rockMat, label: d.label, enabled: true, hovered: false, w: this.hudW, h: this.hudH };
      if (d.icon) {
        // 3D icon sitting on the slab face
        const { group: ig, mats } = buildHudIcon(d.icon);
        ig.position.z = ROCK_PEAK_Z + 3;
        ig.renderOrder = 1001;
        group.add(ig);
        b.iconGroup = ig; b.iconMats = mats;
      } else {
        // text label plane on the slab face
        const labelCanvas = document.createElement('canvas');
        const labelTex = new THREE.CanvasTexture(labelCanvas);
        labelTex.anisotropy = 4;
        const labelMat = new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthTest: false, depthWrite: false });
        const labelMesh = new THREE.Mesh(new THREE.PlaneGeometry(this.hudW - 14, this.hudH - 10), labelMat);
        labelMesh.position.z = ROCK_PEAK_Z + 2;
        labelMesh.renderOrder = 1001;
        group.add(labelMesh);
        b.labelCanvas = labelCanvas; b.labelTex = labelTex;
      }
      this.applyRockState(b);
      this.drawHudLabel(b);
      this.hudScene.add(group);
      this.hudButtons.push(b);
    }
    this.layoutHud(this.canvas.clientWidth, this.canvas.clientHeight);
  }

  setHudVisible(v: boolean): void { this.hudVisible = v; }

  updateHudButton(id: string, enabled: boolean): void {
    const b = this.hudButtons.find(x => x.id === id);
    if (b && b.enabled !== enabled) { b.enabled = enabled; this.applyRockState(b); this.drawHudLabel(b); }
  }

  // Which enabled HUD button (if any) is under this pointer position?
  hitHudButton(clientX: number, clientY: number): string | null {
    if (!this.hudVisible || !this.hudButtons.length) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.hudCamera);
    const hit = this.raycaster.intersectObjects(this.hudButtons.map(b => b.rock), false);
    if (!hit.length) return null;
    const b = this.hudButtons.find(x => x.rock === hit[0].object);
    return b && b.enabled ? b.id : null;
  }

  private layoutHud(w: number, h: number): void {
    if (!w || !h || !this.hudButtons.length) return;
    // Scale the buttons down on small/phone screens so they don't dominate.
    const scale = w < 480 ? 0.74 : w < 760 ? 0.88 : 1;
    const bw = this.hudW * scale, gap = this.hudGap * scale, bh = this.hudH * scale;
    const n = this.hudButtons.length;
    const total = n * bw + (n - 1) * gap;
    let x = -total / 2 + bw / 2;
    const margin = w < 480 ? 26 : 18; // a touch higher on phones (clear the safe area)
    const y = -h / 2 + margin + bh / 2;
    for (const b of this.hudButtons) {
      b.group.scale.setScalar(scale);
      b.group.position.set(x, y, 0);
      x += bw + gap;
    }
  }

  private onHudHover(e: PointerEvent): void {
    if (!this.hudVisible || !this.hudButtons.length) return;
    const id = this.hitHudButton(e.clientX, e.clientY);
    let changed = false;
    for (const b of this.hudButtons) {
      const hov = b.enabled && b.id === id;
      if (b.hovered !== hov) { b.hovered = hov; this.applyRockState(b); changed = true; }
    }
    if (id) this.canvas.style.cursor = 'pointer';
    else if (changed) this.canvas.style.cursor = '';
  }

  // Tint the rock slab by state (slightly raised on hover, greyed when disabled).
  private applyRockState(b: HudButton): void {
    const color = !b.enabled ? ROCK_DISABLED : b.hovered ? ROCK_HOVER : ROCK_NORMAL;
    b.rockMat.color.setHex(color);
    b.group.position.z = b.hovered && b.enabled ? 2 : 0; // tiny pop on hover
    // Dim the 3D icon when the button is disabled.
    if (b.iconMats) {
      for (const m of b.iconMats) {
        const base = m.userData.baseColor as THREE.Color;
        if (b.enabled) { m.color.copy(base); m.emissiveIntensity = m.userData.baseEmissive ?? 0; }
        else { m.color.copy(base).multiplyScalar(0.4); m.emissiveIntensity = (m.userData.baseEmissive ?? 0) * 0.2; }
      }
    }
  }

  // Draw just the label text (transparent) onto the slab-face plane.
  private drawHudLabel(b: HudButton): void {
    if (!b.labelCanvas || !b.labelTex) return; // icon buttons have no text label
    const dpr = 2;
    const W = (b.w - 14) * dpr, H = (b.h - 10) * dpr;
    b.labelCanvas.width = W; b.labelCanvas.height = H;
    const c = b.labelCanvas.getContext('2d')!;
    c.clearRect(0, 0, W, H);
    c.fillStyle = b.enabled ? '#f1f3f8' : '#7b8494';
    c.font = `800 ${17 * dpr}px -apple-system, system-ui, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 3 * dpr; c.shadowOffsetY = 1.5 * dpr;
    c.fillText(b.label, W / 2, H / 2 + dpr);
    b.labelTex.needsUpdate = true;
  }

  private advanceAnimations(): void {
    const now = performance.now();
    this.updateTileFades(now);
    this.updateStructFades(now);
    // Smoothly rotate each unit toward its facing target (set by moves/attacks).
    if (this.unitFacing.size > 0) {
      const dt = Math.min((now - this.lastFacingNow) / 1000, 0.1);
      this.lastFacingNow = now;
      const step = TURN_SPEED * dt;
      for (const [id, f] of this.unitFacing) {
        const mesh = this.unitMeshes.get(id);
        const facer = mesh?.userData.facer as THREE.Object3D | undefined;
        if (!facer) continue;
        let d = Math.atan2(Math.sin(f.tgt - f.cur), Math.cos(f.tgt - f.cur)); // shortest path
        if (Math.abs(d) <= step) f.cur = f.tgt; else f.cur += Math.sign(d) * step;
        facer.rotation.y = f.cur;
      }
    } else {
      this.lastFacingNow = now;
    }
    // Splash shockwave rings: expand across the splash radius and fade out.
    if (this.shockwaves.length > 0) {
      const SHOCK_MS = 520;
      this.shockwaves = this.shockwaves.filter(s => {
        const t = (now - s.start) / SHOCK_MS;
        if (t < 0) { s.mesh.visible = false; return true; } // still delayed
        if (t >= 1) { this.overlayGroup.remove(s.mesh); s.geo.dispose(); s.mat.dispose(); return false; }
        s.mesh.visible = true;
        s.mesh.scale.setScalar(0.4 + t * 1.7); // outer edge reaches the neighbour tiles
        s.mat.opacity = 0.6 * (1 - t);
        return true;
      });
    }
    // Spin + bob the selected-temple pointer.
    if (this.templePointer && this.templePointer.visible) {
      this.templePointer.rotation.y = now * 0.0022;
      this.templePointer.position.y = this.templePointerBaseY + Math.sin(now * 0.004) * 0.12;
    }
    // Billboard HP bars to face the camera.
    if (this.unitHpBars.size > 0) {
      for (const bar of this.unitHpBars.values()) bar.group.quaternion.copy(this.camera.quaternion);
    }
    // Booster/healer range rings ripple outward from the unit: each ring scales
    // 0 → 1 (centre → edge) on a loop and fades, offset in phase.
    if (this.boosterAuras.size > 0) {
      const t = now / 1000;
      for (const meshes of this.boosterAuras.values()) {
        const n = meshes.length;
        for (let i = 0; i < n; i++) {
          const ph = ((t * 0.7) + i / n) % 1; // 0→1 loop, offset per ring
          const s = 0.06 + ph * 0.94;          // expand from the unit outward
          meshes[i].scale.setScalar(s);
          (meshes[i].material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - ph);
        }
      }
    }
    // Re-sync unit positions while moves are in flight.
    if (this.moveAnims.size > 0 && this.lastState) {
      const playerId = this.lastViewer ?? getCurrentPlayer(this.lastState).id;
      const visible = this.lastOmniscient
        ? new Set(this.mapHexes.map(h => hexKey(h)))
        : (this.lastViewer !== undefined ? getPlayerVisible(this.lastState, this.lastViewer) : getCurrentPlayerVisible(this.lastState));
      this.syncUnits(this.lastState, playerId, visible, !!this.lastOmniscient);
    }
    if (this.explosions.length > 0) {
      this.explosions = this.explosions.filter(ex => {
        const t = (now - ex.start) / EXPLOSION_MS;
        if (t < 0) { ex.group.visible = false; if (ex.light) ex.light.intensity = 0; return true; } // still delayed
        ex.group.visible = true;
        if (t >= 1) {
          if (ex.light) ex.light.intensity = 0;
          this.overlayGroup.remove(ex.group);
          ex.flashGeo.dispose();
          ex.sparkGeo.dispose();
          ex.flashMat.dispose();
          ex.sparkMat.dispose();
          return false;
        }
        // Flash core: expand and fade (size scaled by hit magnitude).
        ex.flash.scale.setScalar(ex.sizeMul * (1 + t * 3.5));
        ex.flashMat.opacity = Math.pow(1 - t, 1.4);
        // Light flash: bright, then fade quickly.
        if (ex.light) ex.light.intensity = 9 * ex.sizeMul * Math.pow(1 - t, 2);
        // Sparks: fly out with a little gravity, fading.
        const sec = (now - ex.start) / 1000;
        for (const sp of ex.sparks) {
          sp.mesh.position.set(
            ex.cx + sp.vel.x * sec,
            ex.cy + sp.vel.y * sec - 5.0 * sec * sec,
            ex.cz + sp.vel.z * sec,
          );
        }
        ex.sparkMat.opacity = Math.max(0, 1 - t);
        return true;
      });
    }
  }

  // ── disposal ──

  private disposeGroup(group: THREE.Group): void {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const child = group.children[i];
      group.remove(child);
      this.disposeObject(child);
    }
  }

  // Free the GPU resources owned by an object tree (per-unit / per-temple meshes),
  // WITHOUT touching shared singletons. Disposes geometry, materials, AND each
  // material's texture map — otherwise every unit death / temple rebuild leaked
  // its materials and 512² face texture (RND-LEAK-1).
  private disposeObject(obj: THREE.Object3D): void {
    // The shared unit face texture is built lazily by voxelWarrior the first time
    // a humanoid unit is created; make sure it's registered before we dispose.
    const faceTex = getSharedFaceTexture();
    if (faceTex) this.sharedResources.add(faceTex);

    const isShared = (res: unknown): boolean =>
      this.sharedResources.has(res) || !!(res && (res as { userData?: { shared?: boolean } }).userData?.shared);

    obj.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.geometry && !isShared(m.geometry)) m.geometry.dispose();
      if (!m.material) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (!mat || isShared(mat)) continue;
        const map = (mat as THREE.MeshStandardMaterial).map;
        if (map && !isShared(map)) map.dispose();
        mat.dispose();
      }
    });
  }
}
