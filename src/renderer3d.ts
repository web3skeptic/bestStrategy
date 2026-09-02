import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { GameState, HexCoord, Unit, StrategicSite, Capital, Farm, FertileSite, TeleportBuilding, SUPPORT_RANGE, unitYetToMove, FactionId } from './types';
import { generateHexMap, hexKey, hexDistance, hexRound } from './hex';
import { getCurrentPlayer, getCurrentPlayerVisible, getPlayerVisible, isForestUnitRevealed, getUnitAt, canStartFounding, getZocHexes, getAgrarTerritory, getAgrarCultivation } from './game';
import { makePalette, Palette, hexToWorld, worldToHexFractional, HEX_R, TILE_H } from './three/palette';
import * as B from './three/builders.gen';
import { buildPortal } from './voxelPortal';
import { buildTemple } from './voxelTemple';
import { buildFarm, buildFertileSite } from './voxelFarm';
import { buildUnitModel } from './voxelUnits';
import { getSharedFaceTexture } from './voxelWarrior';

const MOVE_ANIM_MS = 260;
const EXPLOSION_MS = 440;
const UNIT_LAYER = 1; // extra layer lit by unit-only lights so units stay bright
const HILL_ELEV = 0.18;     // units on a hill sit slightly higher
const STRUCTURE_ELEV = 0.5;    // units on a temple tile perch on its steps, not inside it
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
  priceCanvas?: HTMLCanvasElement;   // optional dynamic aura-price strip (e.g. temple level-up)
  priceTex?: THREE.CanvasTexture;
  price?: string;                    // current price text, '' = none
  iconGroup?: THREE.Group;
  iconMats?: THREE.MeshStandardMaterial[];
  label: string;
  enabled: boolean;
  hovered: boolean;
  armed: boolean;   // destroy slab: showing its "Sure?" confirm state
  w: number;
  h: number;
}

// Stone-slab colours by state.
const ROCK_NORMAL = 0x5e6470;
const ROCK_HOVER = 0x7a8290;
const ROCK_DISABLED = 0x2a2e36;
// Armed (destroy slab awaiting its confirm tap) — loud blood-red so the two-tap
// guard reads unmistakably.
const ROCK_ARMED = 0x8a2a2a;
const ROCK_ARMED_HOVER = 0xb03636;
const RED_TINT = new THREE.Color(0xff5a5a); // icon flush colour while armed

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
  } else if (kind === 'skull') { // 'skull' — disband / destroy own unit
    const bone = M(0xe8e2d0, { roughness: 0.9 });
    const socket = M(0x14100e, { roughness: 1 });
    // cranium — a slightly flattened low-poly dome
    const cran = new THREE.Mesh(new THREE.SphereGeometry(9, 8, 6), bone);
    cran.scale.set(1, 0.92, 0.8); cran.position.y = 3; group.add(cran);
    // jaw block
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(11, 6, 6.5), bone);
    jaw.position.y = -6; group.add(jaw);
    // eye sockets — recessed dark cylinders
    for (const dx of [-4, 4]) {
      const eye = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 2.5, 7), socket);
      eye.rotation.x = Math.PI / 2; eye.position.set(dx, 3.5, 6.4); group.add(eye);
    }
    // nasal cavity — a small dark wedge
    const nose = new THREE.Mesh(new THREE.ConeGeometry(1.8, 4, 4), socket);
    nose.position.set(0, -1, 6.6); group.add(nose);
    // teeth ridge — thin bone strip under the jaw front
    const teeth = new THREE.Mesh(new THREE.BoxGeometry(9, 2.4, 1.5), bone);
    teeth.position.set(0, -3.4, 6.2); group.add(teeth);
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
  // Tracks the faction each cached mesh was built with, so a unit whose
  // owner reveals their faction mid-game (Round-1 Warrior/Archer/Founder)
  // gets its mesh rebuilt with the faction banner instead of staying stuck
  // on the pre-reveal (no-banner) model forever.
  private unitMeshFaction = new Map<string, FactionId | null>();
  private boosterAuras = new Map<string, THREE.Mesh[]>(); // pulsating range rings, keyed by unit id
  private unitHpBars = new Map<string, { group: THREE.Group; fg: THREE.Mesh; barW: number }>();
  // Ids of the local player's units currently showing the pulsating "still to
  // move" yellow tint (their per-unit materials' emissive is driven in
  // advanceAnimations). Populated in syncUnits under the same turn/viewer gate.
  private toMoveTintIds = new Set<string>();
  // Ids of temples currently showing the pulsating warm-yellow tint — either they
  // sit on a reachable move hex for the selected unit, or a local unit stands on
  // them with a pending capture. Driven in the same pulse block as toMoveTintIds
  // (same phase); the temple model itself is tinted (no floating markers).
  private structureTintIds = new Set<string>();
  private lastUnitHp = new Map<string, number>(); // for detecting damage → hit explosions
  private lastStructHp = new Map<string, number>(); // Capital/Temple/Farm — same purpose, structure combat pass
  private structureMeshes = new Map<string, { mesh: THREE.Object3D; color: number; level: number; stage: number }>();
  private structHpBars = new Map<string, { group: THREE.Group; fg: THREE.Mesh; barW: number; yOffset: number }>();
  private structFlashUntil = new Map<string, number>(); // brief red hit-flash, cleared in advanceAnimations
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
  private structurePointer: THREE.Group | null = null;
  private structurePointerBaseY = 0;

  // Desktop camera-key state (Q/E rotate, WASD pan). main.ts feeds key up/down
  // here; applyCameraKeys() drives smooth continuous motion in the render loop.
  private camKeys = new Set<string>();
  private camKeysLastNow = 0;

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
    // Steeper, more top-down default pitch (~33° from vertical vs the old ~48°):
    // a flatter, more bird's-eye view makes individual hexes easier to pick and
    // keeps raised hills from hiding tiles behind them. Distance is scaled to
    // 1/1.3 of the original (0,20,13) framing — same pitch, ~30% closer, so the
    // whole board reads ~30% larger on screen (this is the base offset that
    // both the initial view AND focusOnHex's default zoom dolly from).
    this.camera.position.set(0, 15.4, 10);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 70;
    // Clamp the tilt well above the horizon (~72° from vertical). Letting the
    // player flatten the view to near-horizontal made hex raycast picking flaky
    // and let hills occlude the tiles behind them, so the low-angle range is cut.
    this.controls.maxPolarAngle = Math.PI * 0.40; // stay comfortably above the board
    this.controls.enablePan = true;
    this.controls.enableRotate = true;
    this.controls.enableZoom = true;
    // Pan parallel to the ground plane (map-style) rather than in screen space,
    // so a one-finger drag slides the camera across the board.
    this.controls.screenSpacePanning = false;
    // Mobile (touch) gesture map: one finger pans the camera position across the
    // board; two fingers pinch-to-zoom AND orbit the view angle (azimuth + pitch).
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    // Desktop mouse map: PRIMARY (left) drag pans the camera across the map — parity
    // with mobile's one-finger pan, so the natural drag moves the view instead of
    // being stuck orbiting the home temple. Rotate/orbit moves to the RIGHT button
    // (like mobile's secondary two-finger orbit); middle-drag dollies; wheel zooms.
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    // Snappier pan (default is 1.0). panSpeed affects mouse + touch; kept high so
    // one-finger pan feels fast. rotateSpeed only affects desktop mouse-drag orbit
    // now (two-finger touch rotate is handled manually below via twist).
    this.controls.rotateSpeed = 1.1;
    this.controls.panSpeed = 2.0;

    // ── Touch two-finger camera: map-style TWIST-to-rotate + pinch-zoom ──
    // OrbitControls' built-in DOLLY_ROTATE rotates from the two-finger MIDPOINT
    // ("hold one, drag the other"), which felt confusing and coupled zoom↔rotate.
    // Instead, while ≥2 fingers are down we turn OrbitControls' rotate OFF (so its
    // two-finger path is pure pinch-zoom) and rotate the azimuth ourselves from the
    // TWIST — the change in angle of the finger-to-finger vector, like Google/Apple
    // Maps. Pitch is kept locked during the gesture (no accidental tilt). Desktop
    // fires no touch events, so its mouse map (left-pan / right-orbit / wheel-zoom)
    // is untouched.
    const TWIST_DEADZONE = 0.006; // rad per move: ignore micro-jitter
    const TWIST_MULT = 1.0;       // 1:1 twist, like a paper map under your fingers
    const _twOff = new THREE.Vector3();
    const _twSph = new THREE.Spherical();
    let twistPrev: number | null = null;
    const twoFingerAngle = (t: TouchList) =>
      Math.atan2(t[1].clientY - t[0].clientY, t[1].clientX - t[0].clientX);

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length >= 2) {
        this.controls.enableRotate = false;              // pinch-zoom only from OrbitControls
        const pol = this.controls.getPolarAngle();
        this.controls.minPolarAngle = this.controls.maxPolarAngle = pol; // freeze tilt
        twistPrev = twoFingerAngle(e.touches);
      }
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length < 2 || twistPrev === null) return;
      const cur = twoFingerAngle(e.touches);
      let d = cur - twistPrev;
      if (d > Math.PI) d -= 2 * Math.PI;               // unwrap the ±π seam
      else if (d < -Math.PI) d += 2 * Math.PI;
      twistPrev = cur;
      if (Math.abs(d) < TWIST_DEADZONE) return;
      // Twisting the fingers turns the map with them (verified empirically:
      // clockwise twist → world rotates clockwise under the fingers). Orbit
      // azimuth about controls.target; the render-loop controls.update() reads
      // camera.position back each frame, so damping isn't fought.
      _twOff.copy(this.camera.position).sub(this.controls.target);
      _twSph.setFromVector3(_twOff);
      _twSph.theta += d * TWIST_MULT;
      _twOff.setFromSpherical(_twSph);
      this.camera.position.copy(this.controls.target).add(_twOff);
    }, { passive: true });

    const endTwoFinger = (e: TouchEvent) => {
      if (e.touches.length < 2) {                        // dropped below two fingers
        this.controls.enableRotate = true;               // restore desktop/other orbit
        this.controls.minPolarAngle = 0;
        this.controls.maxPolarAngle = Math.PI * 0.40;    // restore tilt range (matches init clamp)
        twistPrev = null;                                // no jump when a finger lingers
      }
    };
    canvas.addEventListener('touchend', endTwoFinger);
    canvas.addEventListener('touchcancel', endTwoFinger);

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
    this.structurePointer = new THREE.Group();
    const ptrMat = new THREE.MeshStandardMaterial({ color: 0xffd23a, emissive: 0xffb000, emissiveIntensity: 0.6, roughness: 0.5, metalness: 0 });
    const ptrCone = new THREE.Mesh(new THREE.CylinderGeometry(0, 0.24, 0.42, 4), ptrMat);
    ptrCone.rotation.x = Math.PI; // point down at the temple
    ptrCone.position.y = 0.21;
    const ptrCube = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), ptrMat);
    ptrCube.position.y = 0.56;
    ptrCube.rotation.set(Math.PI / 4, Math.PI / 4, 0);
    this.structurePointer.add(ptrCone, ptrCube);
    this.structurePointer.visible = false;
    this.structurePointer.traverse(o => o.layers.enable(UNIT_LAYER)); // keep it bright
    this.scene.add(this.structurePointer);

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
    this.unitMeshFaction.clear();
    this.boosterAuras.clear();
    this.unitHpBars.clear();
    this.toMoveTintIds.clear();
    this.structureTintIds.clear();
    this.lastUnitHp.clear();
    this.lastStructHp.clear();
    this.structHpBars.clear();
    this.structFlashUntil.clear();
    this.structureMeshes.clear();
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

  // Debug/testing hook (see window.__tinted): count of units currently showing
  // the "still to move" yellow tint. Mirrors __own/__sel — harmless in production.
  tintedUnitCount(): number {
    return this.toMoveTintIds.size;
  }
  // Latest "show to-move tint" decision from render(), reused by the in-flight
  // move re-sync in advanceAnimations so the tint doesn't flicker off mid-animation.
  private lastShowToMove = false;

  get zoom(): number { return 1; }
  zoomIn(): void { this.dolly(0.85); }
  zoomOut(): void { this.dolly(1.18); }
  pan(_dx: number, _dy: number): void { /* orbit controls handle panning (right-drag) */ }
  getHexSize(): number { return HEX_R; }
  getCenter(): { x: number; y: number } { return { x: 0, y: 0 }; }

  // Re-center the camera on a specific hex (e.g. the local player's home temple
  // at game start), preserving the current view angle/distance, then apply a
  // slight zoom-in. Call after init() so it overrides the default (0,0,0) target.
  focusOnHex(hex: HexCoord, zoom = 0.82): void {
    const { x, z } = hexToWorld(hex);
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.set(x, 0, z);
    this.camera.position.set(x + offset.x, offset.y, z + offset.z);
    this.dolly(zoom);
    this.controls.update();
  }

  private dolly(factor: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const len = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    offset.setLength(len);
    this.camera.position.copy(this.controls.target).add(offset);
  }

  // ── Desktop camera keys (Q/E rotate, WASD pan) ──
  // main.ts translates keydown/keyup into these calls (respecting input focus /
  // open overlays); the actual motion is applied per-frame in applyCameraKeys so
  // it's smooth and continuous rather than a discrete jump.
  setCameraKey(action: 'rotL' | 'rotR' | 'panF' | 'panB' | 'panL' | 'panR', pressed: boolean): void {
    if (pressed) this.camKeys.add(action); else this.camKeys.delete(action);
  }
  clearCameraKeys(): void { this.camKeys.clear(); }

  private applyCameraKeys(): void {
    if (this.camKeys.size === 0) { this.camKeysLastNow = 0; return; }
    const now = performance.now();
    const dt = this.camKeysLastNow ? Math.min((now - this.camKeysLastNow) / 1000, 0.05) : 0;
    this.camKeysLastNow = now;
    if (dt <= 0) return;

    const target = this.controls.target;

    // Rotate the view around the target (azimuth only), mirroring the two-finger
    // twist path so OrbitControls damping isn't fought.
    const ROT_SPEED = 1.6; // rad/s
    let dTheta = 0;
    if (this.camKeys.has('rotL')) dTheta += ROT_SPEED * dt;
    if (this.camKeys.has('rotR')) dTheta -= ROT_SPEED * dt;
    if (dTheta !== 0) {
      const off = this.camera.position.clone().sub(target);
      const sph = new THREE.Spherical().setFromVector3(off);
      sph.theta += dTheta;
      off.setFromSpherical(sph);
      this.camera.position.copy(target).add(off);
    }

    // Pan the target (and camera) across the ground plane, relative to the current
    // facing. Speed scales with zoom distance so it feels consistent at any zoom.
    const fwd = new THREE.Vector3().subVectors(target, this.camera.position);
    fwd.y = 0;
    if (fwd.lengthSq() > 1e-6) {
      fwd.normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const move = new THREE.Vector3();
      if (this.camKeys.has('panF')) move.add(fwd);    // W
      if (this.camKeys.has('panB')) move.sub(fwd);    // S
      if (this.camKeys.has('panR')) move.add(right);  // D
      if (this.camKeys.has('panL')) move.sub(right);  // A
      if (move.lengthSq() > 0) {
        const dist = this.camera.position.distanceTo(target);
        move.normalize().multiplyScalar(dist * 0.9 * dt);
        // Keep the target within a soft bound of the board so the view can't fly
        // off; move the camera by the SAME (clamped) delta to preserve the offset.
        const bound = (this.mapRadius + 2) * HEX_R * 1.8;
        const nx = THREE.MathUtils.clamp(target.x + move.x, -bound, bound);
        const nz = THREE.MathUtils.clamp(target.z + move.z, -bound, bound);
        this.camera.position.x += nx - target.x;
        this.camera.position.z += nz - target.z;
        target.x = nx; target.z = nz;
      }
    }
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

  /**
   * Raycast a screen point onto the board → hex coord (or null).
   *
   * Selection-reliability pass: prefer a REAL raycast against the actual
   * tile meshes over a flat y=0 math plane. Hills/structures raise the
   * visible surface (elevationAt) but the old flat-plane projection always
   * assumed y=0 — with any camera tilt, that silently resolves a click on
   * an elevated tile (or a unit standing on one) to the WRONG hex (the one
   * behind/beyond it from the camera's angle), which is exactly the
   * "clicks don't reliably select the intended unit" symptom. Raycasting
   * the tile geometry itself always lands on the surface actually drawn on
   * screen, elevation included. Falls back to the flat-plane projection
   * only if the ray somehow misses every tile (shouldn't happen once tiles
   * are built, but keeps this defensive).
   */
  pickHex(clientX: number, clientY: number): HexCoord | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);

    if (this.tileMeshes.size > 0) {
      const hits = this.raycaster.intersectObjects([...this.tileMeshes.values()], true);
      for (const hit of hits) {
        let o: THREE.Object3D | null = hit.object;
        while (o && o.userData.hexKey === undefined) o = o.parent;
        if (o) {
          const [qs, rs] = (o.userData.hexKey as string).split(',');
          return { q: Number(qs), r: Number(rs) };
        }
      }
    }

    const pt = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, pt)) return null;
    const { q, r } = worldToHexFractional(pt.x, pt.z);
    const hex = hexRound({ q, r });
    if (hexDistance({ q: 0, r: 0 }, hex) > this.mapRadius) return null;
    return hex;
  }

  /** Debug snapshot of the camera/controls state (used by tests/verification). */
  cameraDebug() {
    const t = this.controls.target;
    const p = this.camera.position;
    return {
      pos: { x: p.x, y: p.y, z: p.z },
      target: { x: t.x, y: t.y, z: t.z },
      azimuth: this.controls.getAzimuthalAngle(),
      polar: this.controls.getPolarAngle(),
      polarMin: this.controls.minPolarAngle,
      polarMax: this.controls.maxPolarAngle,
      distance: this.camera.position.distanceTo(this.controls.target),
    };
  }

  /** Project a hex's board position to screen pixel coords (for tests). */
  projectHex(h: HexCoord): { x: number; y: number } {
    const w = hexToWorld(h);
    const v = new THREE.Vector3(w.x, 0, w.z).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
    };
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

    // Show the "still to move" tint only on the LOCAL viewer's own units, and
    // only while it is that viewer's turn to act (never during an AI/opponent
    // turn or an omniscient/spectator view). Also gates the pending-capture
    // temple tint (case b) below.
    const showToMove = viewerPlayerId !== undefined && !omniscient
      && state.phase === 'playing' && state.currentPlayerIndex === viewerPlayerId;
    this.lastShowToMove = showToMove;

    if (this.tileMeshes.size === 0) this.buildTiles(state);
    this.detectHits(state, playerId, visible, !!omniscient);
    this.syncFog(explored, visible);
    this.syncHighlights(state, explored, playerId);
    this.syncStructures(state, explored, visible, showToMove, playerId);
    this.syncUnits(state, playerId, visible, !!omniscient, showToMove);
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
      tile.userData.hexKey = key; // selection-reliability pass — see pickHex
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

  private syncHighlights(state: GameState, explored: Set<string>, playerId: number): void {
    const moveSet = new Set(state.moveHexes.map(h => hexKey(h)));
    // Unit targets and structure targets (Capital/City/Temple) share the same
    // "you can attack this" red highlight — attackUnit vs attackStructure is
    // resolved by what's actually standing on the tile when clicked.
    const attackSet = new Set([...state.attackHexes, ...state.structureAttackHexes].map(h => hexKey(h)));
    const buildSet = new Set(state.buildHexes.map(h => hexKey(h)));
    const supportSet = new Set(state.supportHexes.map(h => hexKey(h)));
    // §23-25 — roads are persistent world decoration, not a transient
    // selection highlight, but this pool already redraws every frame from
    // live state, so a low-priority tan tint (below move/attack/build/
    // support) is a cheap placeholder pending real road art (§70 policy).
    const roadSet = new Set(state.roads.map(r => hexKey(r.pos)));
    // §26 — a lowest-priority amber warning tint on enemy ZOC hexes, so the
    // player can see WHY a unit's move range stops short before they even
    // click it, not just infer it from the highlight's shorter-than-expected
    // edge. Only computed while a unit is selected (matches move/attack/etc,
    // which are likewise selection-scoped) to avoid a constant board-wide cost.
    const zocSet = state.selectionMode === 'unit' && state.selectedUnitId
      ? getZocHexes(state, playerId)
      : new Set<string>();
    // Agrar Infrastructure Reach / Cultivated Influence — Farm-UX pass:
    // shown only for the VIEWER's own Agrar territory, and only while it's
    // actually useful (a Builder selected, an owned Farm selected, or a
    // Farm/Road/teleport build mode active via state.buildHexes) — not a
    // permanent board-wide wash. Two visually distinct rings: infrastructure
    // reach (radius 2, subtle outer wash — where a new Farm/Road may land)
    // and cultivated influence (radius 1 from active Farms only, stronger
    // inner tint — blocks enemy Temple founding/reconstruction) so the
    // player never has to infer either invisible radius.
    const territorySet = new Set<string>();
    const cultivationSet = new Set<string>();
    const viewerPlayer = state.players.find(p => p.id === playerId);
    if (viewerPlayer?.faction === 'agrar') {
      const selectedUnit = state.selectionMode === 'unit' && state.selectedUnitId
        ? state.units.find(u => u.id === state.selectedUnitId) : undefined;
      const selectedOwnFarm = state.selectionMode === 'site' && state.selectedSiteId
        ? state.farms.some(f => f.id === state.selectedSiteId && f.ownerId === playerId) : false;
      const relevant = state.buildHexes.length > 0
        || (selectedUnit?.type === 'founder' && selectedUnit.playerId === playerId)
        || selectedOwnFarm;
      if (relevant) {
        for (const key of getAgrarTerritory(state, playerId)) territorySet.add(key);
        for (const key of getAgrarCultivation(state, playerId)) cultivationSet.add(key);
      }
    }

    let i = 0;
    const place = (hex: HexCoord, color: number, opacity: number, pulse = false) => {
      let mesh = this.highlightPool[i];
      if (!mesh) {
        mesh = new THREE.Mesh(this.highlightGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4 }));
        mesh.rotation.y = Math.PI / 6;
        this.overlayGroup.add(mesh);
        this.highlightPool[i] = mesh;
      }
      const { x, z } = hexToWorld(hex);
      // Sit the tint just above the tile's actual surface so it stays visible on
      // raised hills / temple mounds instead of being buried inside them — this
      // matters for the red attack highlight on an enemy standing on high ground.
      mesh.position.set(x, this.elevationAt(state, hex) + 0.05, z);
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.color.setHex(color);
      mat.opacity = opacity;
      mesh.visible = true;
      // Farm-UX pass (§15/§18) — Farm build-placement hexes pulse continuously
      // (driven every animation frame in advanceAnimations) instead of sitting
      // at one flat opacity like every other highlight kind, so legal Farm
      // cells are unmistakably distinct from ordinary movement/build tints.
      mesh.userData.pulse = pulse;
      if (pulse) mesh.userData.pulseBaseOpacity = opacity;
      i++;
    };

    for (const hex of this.mapHexes) {
      const key = hexKey(hex);
      if (!explored.has(key)) continue;
      // Attackable enemies get a bold red tint. The set comes straight from the
      // engine's state.attackHexes (updateHighlights → getEffectiveRange, fog /
      // forest visibility, hasAttacked & cantShootAfterMove gating) — i.e. the
      // exact legal-target set combat validation uses, never re-derived here.
      if (attackSet.has(key)) place(hex, 0xff2020, 0.62);
      else if (moveSet.has(key)) place(hex, 0x3cc850, 0.4);
      else if (buildSet.has(key) && state.buildKind === 'farm') place(hex, 0x2ee65a, 0.55, true); // pulsating agricultural green — see place()
      else if (buildSet.has(key) && state.buildKind === 'road') place(hex, 0xd9944a, 0.45); // distinct road-specific tan/orange, static
      else if (buildSet.has(key)) place(hex, 0x00c8ff, 0.4); // teleport / fallback
      else if (supportSet.has(key)) place(hex, 0x5096e1, 0.4);
      else if (roadSet.has(key)) place(hex, 0xb98c50, 0.3);
      else if (zocSet.has(key)) place(hex, 0xff9a2a, 0.22);
      // Cultivated Influence (radius 1, active Farms only) is the tighter,
      // stronger-tinted inner ring; Infrastructure Reach (radius 2, Capital
      // + Farms) is the subtler outer wash — visually distinct so the two
      // never get confused despite overlapping (§5 Farm-UX pass).
      else if (cultivationSet.has(key)) place(hex, 0xa020f0, 0.34);
      else if (territorySet.has(key)) place(hex, 0xe8401f, 0.2);
    }
    for (; i < this.highlightPool.length; i++) this.highlightPool[i].visible = false;
  }

  // Placeholder visual "tier" fed into the reused buildTemple(color, tier)
  // model — there's no more level system, but the model's tier scaling is a
  // convenient existing placeholder for "how developed does this look" (§70
  // asset-fallback policy: reuse an existing model rather than block on new
  // art). Capitals render at the top tier; a founding/neutral/ruined site at
  // the bottom; a completed City/Temple in between.
  private structureVisualTier(kind: 'capital' | 'neutralOrRuins' | 'founding' | 'completed'): number {
    switch (kind) {
      case 'capital': return 10;
      case 'completed': return 5;
      case 'founding': return 2;
      case 'neutralOrRuins': default: return 1;
    }
  }

  private syncStructures(state: GameState, explored: Set<string>, visible: Set<string>, showToMove = false, playerId = -1): void {
    // Structures the selected unit could step onto (same set / explored gating
    // as the flat green move highlights in syncHighlights — the structure mesh
    // occludes those flat tints, which is exactly why we tint the model itself here).
    const moveSet = new Set(state.moveHexes.map(h => hexKey(h)));

    interface StructureVisual { id: string; pos: HexCoord; kind: 'capital' | 'site' | 'farm' | 'fertile'; tier: number; colorNum: number; canPendingFound: boolean; hp: number; maxHp: number; }
    const structures: StructureVisual[] = [];
    for (const capital of state.capitals as Capital[]) {
      const owner = state.players.find(p => p.id === capital.playerId);
      structures.push({
        id: capital.id, pos: capital.pos, kind: 'capital',
        tier: this.structureVisualTier('capital'),
        colorNum: owner ? new THREE.Color(owner.color).getHex() : this.P.colors.neutral,
        canPendingFound: false,
        hp: capital.hp, maxHp: capital.maxHp,
      });
    }
    for (const site of state.strategicSites as StrategicSite[]) {
      const owner = site.ownerId !== null ? state.players.find(p => p.id === site.ownerId) : null;
      const foundingOwner = site.founding ? state.players.find(p => p.id === site.founding!.playerId) : null;
      const isCompleted = site.state === 'temple' || site.state === 'upgradingTemple';
      const isFounding = site.state === 'foundingTemple';
      structures.push({
        id: site.id, pos: site.pos, kind: 'site',
        tier: this.structureVisualTier(isCompleted ? 'completed' : isFounding ? 'founding' : 'neutralOrRuins'),
        colorNum: owner ? new THREE.Color(owner.color).getHex()
          : foundingOwner ? new THREE.Color(foundingOwner.color).getHex()
          : this.P.colors.neutral,
        canPendingFound: site.state === 'neutral' || site.state === 'ruins',
        hp: site.hp, maxHp: site.maxHp,
      });
    }
    // Farms — Agrar's physical income buildings, own dedicated low-profile
    // model (voxelFarm.ts) with a 3-stage damage look driven by HP fraction.
    for (const farm of state.farms as Farm[]) {
      const owner = state.players.find(p => p.id === farm.ownerId);
      structures.push({
        id: farm.id, pos: farm.pos, kind: 'farm',
        tier: this.structureVisualTier('founding'),
        colorNum: owner ? new THREE.Color(owner.color).getHex() : this.P.colors.neutral,
        canPendingFound: false,
        hp: farm.hp, maxHp: farm.maxHp,
      });
    }

    // Fertile Sites (v14, Agrar-vs-Agrar only — empty array otherwise): a
    // pure occupation objective, so unlike everything else here it has no
    // HP/maxHp at all (hp:0 skips the HP-bar block below, matching its
    // "no combat, presence-only" design).
    for (const site of state.fertileSites as FertileSite[]) {
      const owner = site.ownerId !== null ? state.players.find(p => p.id === site.ownerId) : null;
      structures.push({
        id: site.id, pos: site.pos, kind: 'fertile',
        tier: this.structureVisualTier('founding'),
        colorNum: owner ? new THREE.Color(owner.color).getHex() : this.P.colors.neutral,
        canPendingFound: false,
        hp: 0, maxHp: 0,
      });
    }

    // Farms are the only structure that can vanish outright (destroyed, not
    // Ruins) — prune any mesh whose id no longer appears in the live state.
    const liveIds = new Set(structures.map(s => s.id));
    for (const [id, entry] of this.structureMeshes) {
      if (liveIds.has(id)) continue;
      this.structureGroup.remove(entry.mesh);
      this.disposeObject(entry.mesh);
      this.structureMeshes.delete(id);
      this.structureTintIds.delete(id);
      const bar = this.structHpBars.get(id);
      if (bar) { this.disposeObject(bar.group); this.structHpBars.delete(id); }
      this.structFlashUntil.delete(id);
    }

    for (const st of structures) {
      const key = hexKey(st.pos);
      // Coarse 3-stage damage look (structure combat pass §11/§26): above
      // 66% HP = normal, 33-66% = damaged, below 33% = heavily damaged. Only
      // meaningful once a structure actually has HP (maxHp > 0) — a
      // neutral/founding site's tier already carries that distinction.
      const stage: number = st.maxHp <= 0 ? 0 : st.hp / st.maxHp > 0.66 ? 0 : st.hp / st.maxHp > 0.33 ? 1 : 2;
      let entry = this.structureMeshes.get(st.id);
      let rebuilt = false;
      if (!entry || entry.color !== st.colorNum || entry.level !== st.tier || (st.kind === 'farm' && entry.stage !== stage)) {
        if (entry) { this.structureGroup.remove(entry.mesh); this.disposeObject(entry.mesh); }
        const mesh = st.kind === 'farm' ? buildFarm(st.colorNum, stage as 0 | 1 | 2)
          : st.kind === 'fertile' ? buildFertileSite(st.colorNum === this.P.colors.neutral ? null : st.colorNum)
          : buildTemple(st.colorNum, st.tier);
        const { x, z } = hexToWorld(st.pos);
        mesh.position.set(x, 0, z);
        this.structureGroup.add(mesh);
        entry = { mesh, color: st.colorNum, level: st.tier, stage };
        this.structureMeshes.set(st.id, entry);
        rebuilt = true;
      } else {
        entry.stage = stage;
      }
      // Remembered-but-unseen structures dim like the terrain (fading) instead
      // of staying bright; only currently-visible structures show at full brightness.
      const want = visible.has(key) ? 'lit' : explored.has(key) ? 'dark' : 'hidden';
      this.applyStructFog(entry.mesh, 'T' + st.id, want, rebuilt);

      // Structure HP bar (§10) — a small billboarded bar above the model,
      // same visual language as unit HP bars. Visible while damaged, while
      // this structure is the current site selection, or briefly after a
      // hit (structFlashUntil, set in detectHits) — never on a pristine,
      // unselected structure (avoids cluttering an otherwise clean board).
      if (st.maxHp > 0) {
        let bar = this.structHpBars.get(st.id);
        if (!bar || rebuilt) {
          if (bar) this.disposeObject(bar.group);
          bar = this.addStructHpBar(entry.mesh, st.id, st.kind);
        }
        const isSelected = state.selectionMode === 'site' && state.selectedSiteId === st.id;
        const recentlyHit = this.structFlashUntil.has(st.id);
        this.updateStructHpBar(st.id, st.hp, st.maxHp, isSelected || recentlyHit);
      }

      // Warm-yellow tint (emissive pulsed in advanceAnimations, same phase as the
      // unit to-move tint):
      //   (a) a reachable move destination for the selected unit — explored-gated
      //       exactly like the flat move highlights.
      //   (b) a local Builder/Acolyte stands on it and could start founding —
      //       gated like the unit to-move tint (own unit, viewer's turn).
      const tintA = explored.has(key) && moveSet.has(key);
      let tintB = false;
      if (showToMove && st.canPendingFound) {
        const u = getUnitAt(state, st.pos);
        tintB = !!u && u.playerId === playerId && canStartFounding(state, u) !== null;
      }
      if (tintA || tintB) this.structureTintIds.add(st.id);
      else if (this.structureTintIds.delete(st.id)) this.setStructureEmissive(entry.mesh, null);
    }

    // Position the rotating pointer over the selected structure.
    const selId = state.selectionMode === 'site' ? state.selectedSiteId : null;
    const selStructure = selId ? structures.find(s => s.id === selId) : null;
    if (this.structurePointer) {
      if (selStructure) {
        const { x, z } = hexToWorld(selStructure.pos);
        const entry = this.structureMeshes.get(selStructure.id);
        const topY = entry ? new THREE.Box3().setFromObject(entry.mesh).max.y : 2.4;
        this.structurePointerBaseY = topY + 0.5;
        this.structurePointer.position.set(x, this.structurePointerBaseY, z);
        this.structurePointer.visible = true;
      } else {
        this.structurePointer.visible = false;
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

  private buildUnitMesh(unit: Unit, colorNum: number, faction?: FactionId | null): THREE.Object3D {
    const wrap = buildUnitModel(unit.type, colorNum, faction);
    // Support units get pulsating range "circles" (rings only — tiles inside are
    // NOT highlighted). Green = healer, orange = damage, cyan = range.
    // Radius of the N-tile ring in world units (linear in tile count).
    const ringR = (n: number) => n * Math.sqrt(3) * HEX_R * 0.95;
    if (unit.type === 'healer' || unit.type === 'damageBooster') {
      // Two-tile falloff: a bright inner ring (full strength, r1) plus a fainter
      // outer ring (half strength, r2).
      const color = unit.type === 'healer' ? 0x7be54a : 0xff6a2a;
      this.addAuraField(wrap, unit.id, color, [
        { r: ringR(1), op: 0.5 },
        { r: ringR(2), op: 0.22 },
      ]);
    } else if (unit.type === 'rangeBooster') {
      // Tight one-tile reach: radiating pulsating rings sized to r1.
      this.addAuraField(wrap, unit.id, 0x4fe3ff, [
        { r: ringR(1), op: 0.5 },
        { r: ringR(1), op: 0.5 },
      ]);
    }
    return wrap;
  }

  // Concentric pulsating ring "circles" marking a support unit's range. No
  // filled disc, so the tiles inside are never highlighted/tinted. Each entry in
  // `rings` becomes a thin ripple that expands from the unit out to its radius;
  // its base opacity encodes strength (brighter inner = full, fainter outer = half).
  private addAuraField(wrap: THREE.Group, unitId: string, color: number, rings: { r: number; op: number }[]): void {
    const meshes: THREE.Mesh[] = [];
    for (const ring of rings) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(ring.r * 0.95, ring.r, 64), // thin circle, not a thick tile-tinting band
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: ring.op,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.07;
      mesh.userData.baseOpacity = ring.op;
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

  // Drive the "still to move" yellow tint by setting the unit model's per-unit
  // MeshStandardMaterial emissive. `rgb` = pulsing yellow while tinted, or null to
  // clear it back to black. Shared materials (none on units today, but the face
  // texture's material could be) are skipped so the tint never bleeds across units.
  private setUnitEmissive(mesh: THREE.Object3D, rgb: [number, number, number] | null): void {
    mesh.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.material) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (this.sharedResources.has(mat) || (mat as { userData?: { shared?: boolean } }).userData?.shared) continue;
        const sm = mat as THREE.MeshStandardMaterial;
        if (!sm.emissive) continue;
        if (rgb) sm.emissive.setRGB(rgb[0], rgb[1], rgb[2]);
        else sm.emissive.setRGB(0, 0, 0);
      }
    });
  }

  // Drive the temple reachable / pending-capture yellow tint. Mirrors
  // setUnitEmissive, but temples ship their own emissive glows (team-tinted
  // niches, cyan magic core), so each material's original emissive is captured
  // on first tint and restored when the tint clears — never left black.
  private setStructureEmissive(mesh: THREE.Object3D, rgb: [number, number, number] | null): void {
    mesh.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.material) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (this.sharedResources.has(mat) || (mat as { userData?: { shared?: boolean } }).userData?.shared) continue;
        const sm = mat as THREE.MeshStandardMaterial;
        if (!sm.emissive) continue;
        const ud = sm.userData as { baseEmissive?: THREE.Color };
        if (rgb) {
          if (!ud.baseEmissive) ud.baseEmissive = sm.emissive.clone();
          sm.emissive.setRGB(rgb[0], rgb[1], rgb[2]);
        } else if (ud.baseEmissive) {
          sm.emissive.copy(ud.baseEmissive);
        }
        // No baseEmissive on clear ⇒ this material was never tinted (e.g. the
        // mesh was just rebuilt on owner change and the stale tint id is being
        // dropped) — its as-built emissive already IS the cleared state, so
        // leave it untouched instead of blacking out the temple's glow parts.
      }
    });
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

  // Floating HP bar above a structure (Capital/Temple/Farm) — same visual
  // language as addHpBar, just a taller offset for the bigger models and a
  // wider bar for the Capital/Temple's larger footprint (structure combat
  // pass §10).
  private addStructHpBar(parent: THREE.Object3D, id: string, kind: 'capital' | 'site' | 'farm' | 'fertile'): { group: THREE.Group; fg: THREE.Mesh; barW: number; yOffset: number } {
    const barW = kind === 'farm' ? 0.9 : 1.15, barH = 0.15;
    const yOffset = kind === 'farm' ? 0.85 : kind === 'capital' ? 3.4 : 2.6;
    const group = new THREE.Group();
    group.position.y = yOffset;

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
    const bar = { group, fg, barW, yOffset };
    this.structHpBars.set(id, bar);
    return bar;
  }

  // `forceVisible` covers "currently selected" and "recently hit" (structure
  // combat pass §10) — otherwise the bar only shows once actually damaged,
  // same rule as units, so a pristine board stays uncluttered.
  private updateStructHpBar(id: string, hp: number, maxHp: number, forceVisible: boolean): void {
    const bar = this.structHpBars.get(id);
    if (!bar) return;
    bar.group.visible = forceVisible || hp < maxHp;
    const ratio = Math.max(0, Math.min(1, hp / maxHp));
    bar.fg.scale.x = Math.max(0.0001, ratio);
    bar.fg.position.x = (-bar.barW * (1 - ratio)) / 2;
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

    // Structure combat pass — same hit-detection treatment for Capital/
    // Temple/Farm: a flash+spark burst on hit, and a brief red emissive
    // flash on the model itself (destruction, if any, follows from the
    // normal structure sync — a Farm vanishes, a Temple/Capital just sits
    // there at 0/low HP until its state actually changes).
    const structAlive = new Set<string>();
    const structHits: { id: string; pos: HexCoord; dmg: number }[] = [];
    const noteStruct = (id: string, pos: HexCoord, hp: number) => {
      structAlive.add(id);
      const prev = this.lastStructHp.get(id);
      if (prev !== undefined && hp < prev && (omniscient || visible.has(hexKey(pos)))) {
        structHits.push({ id, pos: { ...pos }, dmg: prev - hp });
      }
      this.lastStructHp.set(id, hp);
    };
    for (const capital of state.capitals) noteStruct(capital.id, capital.pos, capital.hp);
    for (const site of state.strategicSites) {
      if (site.state === 'temple' || site.state === 'upgradingTemple') noteStruct(site.id, site.pos, site.hp);
    }
    for (const farm of state.farms) if (farm.state === 'farm') noteStruct(farm.id, farm.pos, farm.hp);
    for (const id of [...this.lastStructHp.keys()]) if (!structAlive.has(id)) this.lastStructHp.delete(id);
    for (const h of structHits) {
      this.startHitAnimation(h.pos, 0, h.dmg);
      this.structFlashUntil.set(h.id, performance.now() + 260);
    }

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

  private syncUnits(state: GameState, playerId: number, visible: Set<string>, omniscient: boolean, showToMove = false): void {
    const seen = new Set<string>();
    const now = performance.now();
    for (const unit of state.units) {
      if (unit.hp <= 0) continue;
      const key = hexKey(unit.pos);
      if (!omniscient && unit.playerId !== playerId && !visible.has(key)) continue;
      if (!omniscient && unit.playerId !== playerId && !isForestUnitRevealed(state, unit.pos, playerId)) continue;
      seen.add(unit.id);

      const player = state.players.find(p => p.id === unit.playerId)!;
      let mesh = this.unitMeshes.get(unit.id);
      if (mesh && this.unitMeshFaction.get(unit.id) !== player.faction) {
        // Faction just revealed (or otherwise changed) — rebuild with the
        // correct banner rather than leaving a stale pre-reveal model.
        this.unitGroup.remove(mesh);
        this.disposeObject(mesh);
        this.unitMeshes.delete(unit.id);
        mesh = undefined;
      }
      if (!mesh) {
        const colorNum = new THREE.Color(player.color).getHex();
        // The model lives in an inner "facer" group that we rotate to face the
        // unit's heading; the outer group carries position + the HP bar (so the
        // billboarded HP bar never inherits the unit's facing rotation).
        const model = this.buildUnitMesh(unit, colorNum, player.faction);
        const off = forwardOffset(unit.type);
        model.rotation.y = off;
        mesh = new THREE.Group();
        mesh.add(model);
        mesh.userData.facer = model;
        this.addHpBar(mesh, unit.id);
        mesh.traverse(o => o.layers.enable(UNIT_LAYER)); // lit by the brighter unit-only lights
        this.unitGroup.add(mesh);
        this.unitMeshes.set(unit.id, mesh);
        this.unitMeshFaction.set(unit.id, player.faction);
        this.unitFacing.set(unit.id, { cur: off, tgt: off });
      }
      this.updateHpBar(unit.id, unit.hp, unit.stats.maxHp);
      // "Still to move" tint: own units, viewer's turn, unit yet to act. Track the
      // id set (emissive pulsed in advanceAnimations); clear emissive the moment a
      // unit drops out of the set (moved/attacked, turn ended, etc.).
      const tint = showToMove && unit.playerId === playerId && unitYetToMove(unit);
      if (tint) this.toMoveTintIds.add(unit.id);
      else if (this.toMoveTintIds.delete(unit.id)) this.setUnitEmissive(mesh, null);

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
        this.unitMeshFaction.delete(id);
        this.boosterAuras.delete(id);
        this.unitHpBars.delete(id);
        this.toMoveTintIds.delete(id);
        this.unitFacing.delete(id);
        this.unitFaded.delete(id);
      }
    }
  }

  // y offset for a unit standing on this tile: lifted on hills, perched on structures.
  private elevationAt(state: GameState, pos: HexCoord): number {
    const k = hexKey(pos);
    let y = state.hills.has(k) ? HILL_ELEV : 0;
    const onStructure = state.capitals.some(c => hexKey(c.pos) === k) || state.strategicSites.some(s => hexKey(s.pos) === k);
    if (onStructure) y = Math.max(y, STRUCTURE_ELEV);
    return y;
  }

  // Fade the viewer's own units while hidden in a forest (not revealed to the
  // enemy). Materials are per-unit (no shared cache), so toggling opacity is safe.
  private applyForestFade(state: GameState, unit: Unit, mesh: THREE.Object3D, viewerId: number, omniscient: boolean): void {
    let faded = false;
    if (!omniscient && unit.playerId === viewerId && state.forests.has(hexKey(unit.pos))) {
      // Hidden (faded) only while NO enemy can see it. In an N-player game we
      // check every opponent, not just "the other player".
      const enemies = state.players.filter(p => p.id !== unit.playerId);
      faded = enemies.length > 0 && enemies.every(e => !isForestUnitRevealed(state, unit.pos, e.id));
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
      this.applyCameraKeys();
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

  setHudButtons(defs: { id: string; label: string; icon?: string; price?: boolean }[]): void {
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
      const b: HudButton = { id: d.id, group, rock, rockMat, label: d.label, enabled: true, hovered: false, armed: false, w: this.hudW, h: this.hudH };
      if (d.icon) {
        // 3D icon sitting on the slab face
        const { group: ig, mats } = buildHudIcon(d.icon);
        ig.position.z = ROCK_PEAK_Z + 3;
        ig.renderOrder = 1001;
        if (d.price) { ig.position.y = 6; ig.scale.setScalar(0.78); } // lift to make room for the price strip
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
      if (d.price) {
        // dynamic aura-price strip along the bottom of the slab
        const priceCanvas = document.createElement('canvas');
        const priceTex = new THREE.CanvasTexture(priceCanvas);
        priceTex.anisotropy = 4;
        const priceMat = new THREE.MeshBasicMaterial({ map: priceTex, transparent: true, depthTest: false, depthWrite: false });
        const priceMesh = new THREE.Mesh(new THREE.PlaneGeometry(this.hudW - 12, 24), priceMat);
        priceMesh.position.set(0, -this.hudH / 2 + 13, ROCK_PEAK_Z + 4);
        priceMesh.renderOrder = 1002;
        group.add(priceMesh);
        b.priceCanvas = priceCanvas; b.priceTex = priceTex;
      }
      this.applyRockState(b);
      this.drawHudLabel(b);
      this.drawHudPrice(b);
      this.hudScene.add(group);
      this.hudButtons.push(b);
    }
    this.layoutHud(this.canvas.clientWidth, this.canvas.clientHeight);
  }

  setHudVisible(v: boolean): void { this.hudVisible = v; }

  updateHudButton(id: string, enabled: boolean): void {
    const b = this.hudButtons.find(x => x.id === id);
    if (b && b.enabled !== enabled) { b.enabled = enabled; this.applyRockState(b); this.drawHudLabel(b); this.drawHudPrice(b); }
  }

  // Show/hide a single HUD slab. Since contextual slabs (temple / destroy) come
  // and go, the row re-lays out over the currently-visible slabs so there is
  // never a hole where a hidden slab's slot would be.
  setHudButtonVisible(id: string, visible: boolean): void {
    const b = this.hudButtons.find(x => x.id === id);
    if (b && b.group.visible !== visible) {
      b.group.visible = visible;
      this.layoutHud(this.canvas.clientWidth, this.canvas.clientHeight);
    }
  }

  // Arm/disarm a slab's two-tap confirm state (used by the destroy slab). Armed
  // paints the rock blood-red; the caller sets the confirm text via the price
  // strip (setHudButtonPrice).
  setHudButtonArmed(id: string, armed: boolean): void {
    const b = this.hudButtons.find(x => x.id === id);
    if (b && b.armed !== armed) { b.armed = armed; this.applyRockState(b); this.drawHudPrice(b); }
  }

  // Set the dynamic aura-price text on a button's price strip (e.g. '⚡12').
  setHudButtonPrice(id: string, text: string | null): void {
    const b = this.hudButtons.find(x => x.id === id);
    if (!b) return;
    const t = text || '';
    if (b.price !== t) { b.price = t; this.drawHudPrice(b); }
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
    const hit = this.raycaster.intersectObjects(this.hudButtons.filter(b => b.group.visible).map(b => b.rock), false);
    if (!hit.length) return null;
    const b = this.hudButtons.find(x => x.rock === hit[0].object);
    return b && b.enabled ? b.id : null;
  }

  private layoutHud(w: number, h: number): void {
    if (!w || !h || !this.hudButtons.length) return;
    // Lay out only the currently-visible slabs, centred — contextual slabs
    // (temple / destroy) appear and disappear, so the row recentres to avoid a
    // gap where a hidden slab would otherwise sit.
    const shown = this.hudButtons.filter(b => b.group.visible);
    if (!shown.length) return;
    // Scale the buttons down on small/phone screens so they don't dominate.
    const scale = w < 480 ? 0.74 : w < 760 ? 0.88 : 1;
    const bw = this.hudW * scale, gap = this.hudGap * scale, bh = this.hudH * scale;
    const n = shown.length;
    const total = n * bw + (n - 1) * gap;
    let x = -total / 2 + bw / 2;
    const margin = w < 480 ? 26 : 18; // a touch higher on phones (clear the safe area)
    const y = -h / 2 + margin + bh / 2;
    for (const b of shown) {
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

  // Tint the rock slab by state (slightly raised on hover, greyed when disabled,
  // blood-red when armed for a destroy confirm).
  private applyRockState(b: HudButton): void {
    const color = !b.enabled ? ROCK_DISABLED
      : b.armed ? (b.hovered ? ROCK_ARMED_HOVER : ROCK_ARMED)
      : b.hovered ? ROCK_HOVER : ROCK_NORMAL;
    b.rockMat.color.setHex(color);
    b.group.position.z = b.hovered && b.enabled ? 2 : 0; // tiny pop on hover
    // Dim the 3D icon when disabled; flush it red when armed.
    if (b.iconMats) {
      for (const m of b.iconMats) {
        const base = m.userData.baseColor as THREE.Color;
        if (!b.enabled) { m.color.copy(base).multiplyScalar(0.4); m.emissiveIntensity = (m.userData.baseEmissive ?? 0) * 0.2; }
        else if (b.armed) { m.color.copy(base).lerp(RED_TINT, 0.55); m.emissiveIntensity = m.userData.baseEmissive ?? 0; }
        else { m.color.copy(base); m.emissiveIntensity = m.userData.baseEmissive ?? 0; }
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

  // Draw the dynamic aura-price (e.g. '⚡12') onto the bottom price strip, on a
  // subtle dark pill so it stays legible over the icon. Gold when affordable,
  // muted grey when the button is disabled (can't afford).
  private drawHudPrice(b: HudButton): void {
    if (!b.priceCanvas || !b.priceTex) return;
    const dpr = 2;
    const W = (b.w - 12) * dpr, H = 24 * dpr;
    b.priceCanvas.width = W; b.priceCanvas.height = H;
    const c = b.priceCanvas.getContext('2d')!;
    c.clearRect(0, 0, W, H);
    const text = b.price || '';
    if (text) {
      c.font = `800 ${15 * dpr}px -apple-system, system-ui, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const tw = c.measureText(text).width;
      const pw = tw + 16 * dpr, ph = 20 * dpr, px = W / 2 - pw / 2, py = H / 2 - ph / 2;
      c.fillStyle = b.armed ? 'rgba(50,0,0,0.55)' : 'rgba(0,0,0,0.5)';
      c.beginPath(); c.roundRect(px, py, pw, ph, 8 * dpr); c.fill();
      c.shadowColor = 'rgba(0,0,0,0.7)'; c.shadowBlur = 2 * dpr; c.shadowOffsetY = 1 * dpr;
      c.fillStyle = b.armed ? '#ffdada' : b.enabled ? '#ffd98a' : '#9a8f73';
      c.fillText(text, W / 2, H / 2 + dpr);
    }
    b.priceTex.needsUpdate = true;
  }

  private advanceAnimations(): void {
    const now = performance.now();
    this.updateTileFades(now);
    this.updateStructFades(now);
    // Farm build-placement pulse (§15/§18 Farm-UX pass) — a fast, strong
    // opacity breathe on every legal-Farm-hex highlight, well above the
    // usual ~1.3s/subtle pulses elsewhere on the board so it reads as its
    // own distinct mode, not a variant of the ordinary move/attack tints.
    const pulseOsc = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now * 0.008));
    for (const mesh of this.highlightPool) {
      if (!mesh.visible || !mesh.userData.pulse) continue;
      const base = (mesh.userData.pulseBaseOpacity as number) ?? 0.5;
      (mesh.material as THREE.MeshBasicMaterial).opacity = base * pulseOsc;
    }
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
    if (this.structurePointer && this.structurePointer.visible) {
      this.structurePointer.rotation.y = now * 0.0022;
      this.structurePointer.position.y = this.structurePointerBaseY + Math.sin(now * 0.004) * 0.12;
    }
    // Billboard HP bars to face the camera.
    if (this.unitHpBars.size > 0) {
      for (const bar of this.unitHpBars.values()) bar.group.quaternion.copy(this.camera.quaternion);
    }
    if (this.structHpBars.size > 0) {
      for (const bar of this.structHpBars.values()) bar.group.quaternion.copy(this.camera.quaternion);
    }
    // Structure hit-flash: a brief solid red emissive punch (structure combat
    // pass §11), cleared once its timer lapses — restores the model's normal
    // tint/emissive state (including the pulsing "pending found" tint above,
    // which reapplies next frame if still active).
    if (this.structFlashUntil.size > 0) {
      for (const [id, until] of [...this.structFlashUntil]) {
        const entry = this.structureMeshes.get(id);
        if (now >= until) {
          this.structFlashUntil.delete(id);
          if (entry && !this.structureTintIds.has(id)) this.setStructureEmissive(entry.mesh, null);
        } else if (entry) {
          this.setStructureEmissive(entry.mesh, [0.8, 0.05, 0.05]);
        }
      }
    }
    // Pulse the "still to move" yellow tint: a subtle, uniform emissive breathe
    // on the tinted units' materials (~1.3s period). Kept low so it reads as a
    // faint yellow wash, not a solid recolor.
    if (this.toMoveTintIds.size > 0 || this.structureTintIds.size > 0) {
      const osc = 0.5 + 0.5 * Math.sin(now * 0.005); // 0..1, ~1.3s period
      const e = 0.10 + 0.26 * osc;                    // emissive strength
      const rgb: [number, number, number] = [e, e * 0.88, e * 0.20]; // warm yellow
      for (const id of this.toMoveTintIds) {
        const mesh = this.unitMeshes.get(id);
        if (mesh) this.setUnitEmissive(mesh, rgb);
      }
      // Temples breathe in sync with the units (same phase / rgb).
      for (const id of this.structureTintIds) {
        const entry = this.structureMeshes.get(id);
        if (entry) this.setStructureEmissive(entry.mesh, rgb);
      }
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
          const base = (meshes[i].userData.baseOpacity as number | undefined) ?? 0.5;
          (meshes[i].material as THREE.MeshBasicMaterial).opacity = base * (1 - ph);
        }
      }
    }
    // Re-sync unit positions while moves are in flight.
    if (this.moveAnims.size > 0 && this.lastState) {
      const playerId = this.lastViewer ?? getCurrentPlayer(this.lastState).id;
      const visible = this.lastOmniscient
        ? new Set(this.mapHexes.map(h => hexKey(h)))
        : (this.lastViewer !== undefined ? getPlayerVisible(this.lastState, this.lastViewer) : getCurrentPlayerVisible(this.lastState));
      this.syncUnits(this.lastState, playerId, visible, !!this.lastOmniscient, this.lastShowToMove);
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
