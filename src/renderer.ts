import { GameState, HexCoord, Unit, Temple, TeleportBuilding, UNIT_COSTS, HILL_DEFENSE_BONUS, HILL_RANGE_BONUS } from './types';
import { generateHexMap, hexToPixel, hexEqual, hexKey, hexDistance } from './hex';
import { getCurrentPlayer, calculateEncirclement, getCurrentPlayerVisible, getPlayerVisible, isForestUnitRevealed, getSupportBoostsForUnit } from './game';

import hitSpriteSrc from './assets/actions/hit.png';
import atlasSrc from './assets/tiles/atlas.png';
import atlasManifest from './assets/tiles/atlas.json';

import warriorSrc from './assets/units/warrior/warrior_standing.png';
import { renderVoxelWarriorSprite } from './voxelWarrior';
import archerSrc from './assets/units/archer/archer_standing.png';
import catapultSrc from './assets/units/catapult/catapult_standing.png';
import horseriderSrc from './assets/units/horserider/horserider_standing.png';
import heavyknightSrc from './assets/units/heavyknight/heavyknight_standing.png';
import spearsmanSrc from './assets/units/spearsman/spearsman_standing.png';
import healerSrc from './assets/units/healer/healer_standing.png';
import damageBoosterSrc from './assets/units/damagebooster/damagebooster_standing.png';
import rangeBoosterSrc from './assets/units/rangebooster/rangebooster_standing.png';

const BASE_HEX_SIZE = 48;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3.0;
const ZOOM_STEP = 0.15;
const SHOW_TILE_OUTLINES = false;
const MOVE_ANIM_DURATION_MS = 220; // duration of unit move slide animation
const HIT_ANIM = {
  frames:      16,  // 4×4 sprite sheet
  frameMs:     35,  // ms per frame for frames 0–(split-1)
  fastFrameMs: 17,  // ms per frame after split (≈2× speed)
  split:        8,  // frame index where speed doubles
  get totalMs() { return this.split * this.frameMs + (this.frames - this.split) * this.fastFrameMs; },
};

// Preload tile sprite images
function loadImage(src: string): HTMLImageElement {
  const img = new Image();
  img.src = src;
  return img;
}

const HIT_SPRITE = loadImage(hitSpriteSrc);

// Single sprite atlas — one image, one HTTP request.
// Re-run  node scripts/build-tile-atlas.mjs  whenever tiles are added or changed.
const ATLAS_IMG = loadImage(atlasSrc);

interface TileFrame { x: number; y: number; w: number; h: number; }
const TILE_FRAMES = atlasManifest.tiles as Record<string, TileFrame[]>;

/** Deterministically pick a sprite variant based on hex coords so tiles are stable across renders. */
function pickTileFrame(key: string, q: number, r: number): TileFrame {
  const frames = TILE_FRAMES[key] ?? [];
  if (frames.length === 0) return { x: 0, y: 0, w: 1, h: 1 };
  const idx = Math.abs(q * 7 + r * 13) % frames.length;
  return frames[idx];
}

// Warriors use the pre-rendered "Voxel Guy" 3D model; if WebGL is unavailable
// the render returns null and we fall back to the flat warrior sprite.
const voxelWarriorUrl = renderVoxelWarriorSprite();
const UNIT_SPRITES: Record<string, HTMLImageElement> = {
  warrior: loadImage(voxelWarriorUrl ?? warriorSrc),
  archer: loadImage(archerSrc),
  catapult: loadImage(catapultSrc),
  horserider: loadImage(horseriderSrc),
  heavyknight: loadImage(heavyknightSrc),
  spearsman: loadImage(spearsmanSrc),
  healer: loadImage(healerSrc),
  damageBooster: loadImage(damageBoosterSrc),
  rangeBooster: loadImage(rangeBoosterSrc),
};

// Manual per-tile adjustments. All values are relative to tile center.
// offsetX/offsetY: shift the sprite in pixels (at zoom=1, size=48).
//   Positive X → right, positive Y → down.
// scaleX/scaleY: squeeze or stretch the sprite.
//   1.0 = normal, 0.8 = 80% width, 1.2 = 120% height, etc.
type TileKey = 'plain' | 'forest' | 'hill' | 'wall' | 'fogofwar';
const TILE_ADJUSTMENTS: Record<TileKey, {
  offsetX: number; offsetY: number; scaleX: number; scaleY: number;
}> = {
  plain:    { offsetX:  0, offsetY:  5, scaleX: 0.8,  scaleY: 1.05 },
  forest:   { offsetX:  0, offsetY: -3, scaleX: 0.85, scaleY: 1.05 },
  hill:     { offsetX:  0, offsetY:  5, scaleX: 0.8,  scaleY: 1.1  },
  wall:     { offsetX:  0, offsetY: -5, scaleX: 0.8,  scaleY: 1.1  },
  fogofwar: { offsetX:  0, offsetY:  5, scaleX: 0.83, scaleY: 1.05 },
};

// Manual per-unit-type adjustments. Same convention as TILE_ADJUSTMENTS.
// baseScale controls the overall sprite size relative to hex size (replaces the hardcoded 1.6).
const UNIT_ADJUSTMENTS: Record<string, {
  offsetX: number; offsetY: number; scaleX: number; scaleY: number; baseScale: number;
}> = {
  warrior:      { offsetX: 0, offsetY: -20, scaleX: 1.0, scaleY: 1.0, baseScale: 1.6 },
  archer:       { offsetX: 0, offsetY: -20, scaleX: 1.0, scaleY: 1.0, baseScale: 1.3 },
  catapult:     { offsetX: 0, offsetY: 0, scaleX: 1.0, scaleY: 1.0, baseScale: 1.6 },
  horserider:   { offsetX: 0, offsetY: 0, scaleX: 1.0, scaleY: 1.0, baseScale: 1.6 },
  heavyknight:  { offsetX: 0, offsetY: 0, scaleX: 1.0, scaleY: 1.0, baseScale: 1.6 },
  spearsman:    { offsetX: 0, offsetY: 0, scaleX: 1.0, scaleY: 1.0, baseScale: 1.6 },
  healer:       { offsetX: 0, offsetY: 0, scaleX: 1.0, scaleY: 1.0, baseScale: 1.6 },
  damageBooster:{ offsetX: 0, offsetY: 0, scaleX: 1.0, scaleY: 1.0, baseScale: 1.6 },
  rangeBooster: { offsetX: 0, offsetY: 0, scaleX: 1.0, scaleY: 1.0, baseScale: 1.6 },
};

interface UnitAnim {
  fromHex: HexCoord;
  startTime: number;
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private mapHexes: HexCoord[] = [];
  private _sortedHexes: HexCoord[] = []; // pre-sorted by r (pixel-Y order never changes)
  private _zoom = 1.0;
  private _panX = 0;
  private _panY = 0;
  private _unitAnims = new Map<string, UnitAnim>();
  private _hitAnims = new Map<string, number>(); // hexKey → startTime
  private _lastState: GameState | null = null;
  private _lastViewer: number | undefined;
  private _lastOmniscient: boolean | undefined;
  private _rafScheduled = false;

  // Cached static board layer (tiles + fog + overlays + temples + teleports).
  // Rebuilt only on real state changes / zoom / pan / resize — NOT every frame.
  // Each animation frame just blits this and redraws the dynamic units on top.
  private _boardCanvas: HTMLCanvasElement;
  private _boardCtx: CanvasRenderingContext2D;
  private _boardDirty = true;
  // Visibility computed during a board rebuild and reused by the per-frame unit
  // pass, so getPlayerVisible() doesn't run on every animation frame.
  private _playerId = 0;
  private _visible: Set<string> = new Set();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this._boardCanvas = document.createElement('canvas');
    this._boardCtx = this._boardCanvas.getContext('2d')!;
    // Once any sprite finishes decoding, the cached board (and units) must be
    // repainted — otherwise tiles stay as fallback markers until the next action.
    const assets = [ATLAS_IMG, HIT_SPRITE, ...Object.values(UNIT_SPRITES)];
    for (const img of assets) {
      if (img.complete && img.naturalWidth) continue;
      // { once: true }: each sprite only needs to trigger a single repaint when it
      // finishes decoding, and the listener auto-removes — without it, every sprite
      // kept a live listener and fired a full board rebuild on each load (RND-BUG-2).
      img.addEventListener('load', () => { this._boardDirty = true; this._draw(); }, { once: true });
    }
  }

  init(mapRadius: number): void {
    this.mapHexes = generateHexMap(mapRadius);
    // Pixel-Y = size * 1.5 * r + cy, so relative depth order is determined purely by r.
    // Sort once here — no need to re-sort every frame.
    this._sortedHexes = [...this.mapHexes].sort((a, b) => a.r - b.r);
    this._panX = 0;
    this._panY = 0;
    this._boardDirty = true;
  }

  /** Call just before applying a move so the unit slides from its current hex. */
  startMoveAnimation(unitId: string, fromHex: HexCoord): void {
    this._unitAnims.set(unitId, { fromHex: { ...fromHex }, startTime: performance.now() });
  }

  /** Play the hit sprite animation centered on the given hex. */
  startHitAnimation(pos: HexCoord): void {
    this._hitAnims.set(hexKey(pos), performance.now());
  }

  get zoom(): number { return this._zoom; }

  zoomIn(): void {
    this._zoom = Math.min(MAX_ZOOM, this._zoom + ZOOM_STEP);
    this._boardDirty = true;
  }

  zoomOut(): void {
    this._zoom = Math.max(MIN_ZOOM, this._zoom - ZOOM_STEP);
    if (this._zoom <= 1.0) {
      this._panX = 0;
      this._panY = 0;
    }
    this._boardDirty = true;
  }

  pan(dx: number, dy: number): void {
    this._panX += dx;
    this._panY += dy;
    this._boardDirty = true;
  }

  get hexSize(): number {
    return BASE_HEX_SIZE * this._zoom;
  }

  get centerX(): number { return this.canvas.width / 2 + this._panX; }
  get centerY(): number { return this.canvas.height / 2 + this._panY; }

  /** Sync canvas backing size to its CSS box. Returns true if the size changed. */
  resizeToContainer(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      return true;
    }
    return false;
  }

  render(state: GameState, viewerPlayerId?: number, omniscient?: boolean): void {
    this._lastState = state;
    this._lastViewer = viewerPlayerId;
    this._lastOmniscient = omniscient;
    // A public render means game state may have changed — rebuild the cached
    // board layer on the next _draw().
    this._boardDirty = true;
    this._draw();
  }

  // Composite one frame: blit the cached static board, then draw the dynamic
  // layer (units + hit sprites + game-over) on top. The animation loop calls
  // this directly, so the board is NOT rebuilt on every frame.
  private _draw(): void {
    this._rafScheduled = false;
    const state = this._lastState;
    if (!state) return;
    if (this.resizeToContainer()) this._boardDirty = true; // resize clears the canvas

    const ctx = this.ctx;
    const size = this.hexSize;
    const cx = this.centerX;
    const cy = this.centerY;
    const omniscient = this._lastOmniscient;

    // Rebuild the static board only when something affecting it changed.
    if (this._boardDirty) this._renderBoard(state);

    // Blit the cached board, then draw dynamic content over it.
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this._boardCanvas, 0, 0);

    const playerId = this._playerId;
    const visible = this._visible;

    // Draw units
    const aliveUnits = state.units.filter(u => u.hp > 0);
    for (const unit of aliveUnits) {
      const key = hexKey(unit.pos);
      if (!omniscient && unit.playerId !== playerId && !visible.has(key)) continue;
      if (!omniscient && unit.playerId !== playerId && !isForestUnitRevealed(state, unit.pos, playerId)) continue;
      this.drawUnit(unit, state, size, cx, cy);
    }

    // Draw hit animations on top of everything
    const nowHit = performance.now();
    for (const [key, startTime] of this._hitAnims) {
      const elapsed = nowHit - startTime;
      const slowPart = HIT_ANIM.split * HIT_ANIM.frameMs;
      const frameIndex = elapsed < slowPart
        ? Math.floor(elapsed / HIT_ANIM.frameMs)
        : HIT_ANIM.split + Math.floor((elapsed - slowPart) / HIT_ANIM.fastFrameMs);
      if (frameIndex >= HIT_ANIM.frames) { this._hitAnims.delete(key); continue; }
      // Reconstruct a HexCoord from the key (q,r stored as "q,r")
      const [q, r] = key.split(',').map(Number);
      const { x, y } = hexToPixel({ q, r }, size, cx, cy);
      this.drawHitFrame(x, y, size, frameIndex);
    }

    // Draw game over overlay
    if (state.phase === 'gameOver') {
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      const fontSize = Math.min(48 * this._zoom, 48);
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      if (state.winner) {
        ctx.fillStyle = state.winner.color;
        ctx.fillText(`${state.winner.name} Wins!`, cx, cy);
      } else {
        ctx.fillStyle = '#ccc';
        ctx.fillText('Draw!', cx, cy);
      }
    }

    // Keep re-rendering while move or hit animations are running
    const now = performance.now();
    let anyActive = false;
    for (const anim of this._unitAnims.values()) {
      if (now - anim.startTime < MOVE_ANIM_DURATION_MS) { anyActive = true; break; }
    }
    if (!anyActive) {
      for (const startTime of this._hitAnims.values()) {
        if (now - startTime < HIT_ANIM.totalMs) { anyActive = true; break; }
      }
    }
    if (anyActive && !this._rafScheduled) {
      this._rafScheduled = true;
      requestAnimationFrame(() => this._draw());
    } else if (!anyActive) {
      this._unitAnims.clear();
      this._hitAnims.clear();
    }
  }

  // Render the static board (tiles, fog, action overlays, temples, teleports)
  // into the offscreen cache. Expensive (per-tile canvas filters!) but only
  // runs on real state changes / zoom / pan / resize — never per frame.
  private _renderBoard(state: GameState): void {
    if (this._boardCanvas.width !== this.canvas.width || this._boardCanvas.height !== this.canvas.height) {
      this._boardCanvas.width = this.canvas.width;
      this._boardCanvas.height = this.canvas.height;
    }

    // Redirect the shared draw helpers to the offscreen context for this pass.
    const mainCtx = this.ctx;
    this.ctx = this._boardCtx;
    try {
      const ctx = this.ctx;
      const size = this.hexSize;
      const cx = this.centerX;
      const cy = this.centerY;
      const viewerPlayerId = this._lastViewer;
      const omniscient = this._lastOmniscient;

      ctx.filter = 'none';
      ctx.clearRect(0, 0, this._boardCanvas.width, this._boardCanvas.height);
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, this._boardCanvas.width, this._boardCanvas.height);

      const moveSet = new Set(state.moveHexes.map(h => hexKey(h)));
      const attackSet = new Set(state.attackHexes.map(h => hexKey(h)));
      const supportSet = new Set(state.supportHexes.map(h => hexKey(h)));
      const buildSet = new Set(state.buildHexes.map(h => hexKey(h)));

      const playerId = viewerPlayerId ?? getCurrentPlayer(state).id;
      // Omniscient mode (replay viewer "All" view): treat every map hex as
      // explored AND visible, and bypass per-player unit visibility below.
      let explored: Set<string>;
      let visible: Set<string>;
      if (omniscient) {
        const allKeys = new Set(this.mapHexes.map(h => hexKey(h)));
        explored = allKeys;
        visible = allKeys;
      } else {
        explored = state.explored[playerId]!;
        visible = viewerPlayerId !== undefined ? getPlayerVisible(state, viewerPlayerId) : getCurrentPlayerVisible(state);
      }
      // Cache visibility for the per-frame unit pass in _draw().
      this._playerId = playerId;
      this._visible = visible;

    // Draw hex tiles — pre-sorted by r coord (== pixel-Y order, never changes).
    // Splitting into two filter passes avoids setting ctx.filter per tile (very expensive).

    // Collect per-hex draw info in one pass so we don't re-compute per filter group.
    interface TileDraw {
      hex: HexCoord; x: number; y: number; key: string;
      isExplored: boolean; isVisible: boolean;
      isWall: boolean; isForest: boolean; isHill: boolean;
    }
    const tileDraws: TileDraw[] = this._sortedHexes.map(hex => {
      const { x, y } = hexToPixel(hex, size, cx, cy);
      const key = hexKey(hex);
      return {
        hex, x, y, key,
        isExplored: explored.has(key),
        isVisible:  visible.has(key),
        isWall:     state.walls.has(key),
        isForest:   state.forests.has(key),
        isHill:     state.hills.has(key),
      };
    });

    // Pass A: all bright tiles (no dim filter — fastest canvas path)
    ctx.filter = 'saturate(0.5)';
    for (const td of tileDraws) {
      const { hex, x, y, key, isExplored, isVisible, isWall, isForest, isHill } = td;
      if (!isExplored) {
        const fogFrame    = pickTileFrame('fogofwar', hex.q, hex.r);
        const fogMirrored = (Math.abs(hex.q * 19 + hex.r * 37) % 10) < 4;
        this.drawTileSprite(x, y, size, fogFrame, TILE_ADJUSTMENTS.fogofwar, fogMirrored);
        continue;
      }
      if (!isVisible) continue; // drawn in pass B
      const tileKey: TileKey = isWall ? 'wall' : isForest ? 'forest' : isHill ? 'hill' : 'plain';
      const tileFrame    = pickTileFrame(tileKey, hex.q, hex.r);
      const tileMirrored = (Math.abs(hex.q * 17 + hex.r * 31) % 10) < 4;
      this.drawTileSprite(x, y, size, tileFrame, TILE_ADJUSTMENTS[tileKey], tileMirrored);
      if (!ATLAS_IMG.complete || !ATLAS_IMG.naturalWidth) {
        if (isWall) this.drawWallMarker(x, y, size);
        if (isForest) this.drawForestMarker(x, y, size);
        if (isHill) this.drawHillMarker(x, y, size);
      }
    }

    // Pass B: dim tiles (explored but not currently visible) — single filter change
    ctx.filter = 'brightness(0.35) saturate(0.5)';
    for (const td of tileDraws) {
      const { hex, x, y, isExplored, isVisible, isWall, isForest, isHill } = td;
      if (!isExplored || isVisible) continue;
      const tileKey: TileKey = isWall ? 'wall' : isForest ? 'forest' : isHill ? 'hill' : 'plain';
      const tileFrame    = pickTileFrame(tileKey, hex.q, hex.r);
      const tileMirrored = (Math.abs(hex.q * 17 + hex.r * 31) % 10) < 4;
      this.drawTileSprite(x, y, size, tileFrame, TILE_ADJUSTMENTS[tileKey], tileMirrored);
      if (!ATLAS_IMG.complete || !ATLAS_IMG.naturalWidth) {
        if (isWall) this.drawWallMarker(x, y, size);
        if (isForest) this.drawForestMarker(x, y, size);
        if (isHill) this.drawHillMarker(x, y, size);
      }
    }
    ctx.filter = 'none';

    // Pass C: overlays (move/attack/border/build/support) — no filter needed
    for (const hex of this._sortedHexes) {
      const { x, y } = hexToPixel(hex, size, cx, cy);
      const key = hexKey(hex);
      if (!explored.has(key)) continue; // unexplored hexes have no overlays

      const isWall   = state.walls.has(key);
      const isForest = state.forests.has(key);
      const tileStroke = SHOW_TILE_OUTLINES ? (isWall ? '#333333' : isForest ? '#2a5a2a' : '#444466') : null;

      if (!isWall) {
        if (attackSet.has(key)) {
          this.drawHex(x, y, size, 'rgba(180,50,50,0.35)', 'transparent');
        } else if (moveSet.has(key)) {
          this.drawHex(x, y, size, 'rgba(50,150,50,0.35)', 'transparent');
        }
      }
      if (tileStroke) this.drawHexStroke(x, y, size, tileStroke);
      if (buildSet.has(key)) {
        this.drawHex(x, y, size, 'rgba(0,220,255,0.10)', '#2aaabb');
      }
      if (supportSet.has(key) && !attackSet.has(key) && !moveSet.has(key)) {
        this.drawHex(x, y, size, 'rgba(100,180,255,0.08)', '#3a7aaa');
      }
    }

    // Draw temples (only if explored)
    for (const temple of state.temples) {
      const key = hexKey(temple.pos);
      if (!explored.has(key)) continue;
      this.drawTemple(temple, state, size, cx, cy);
    }

    // Draw teleport buildings (visible if tile is explored)
    for (const tp of state.teleportBuildings) {
      if (!explored.has(hexKey(tp.pos))) continue;
      const builder = state.players.find(p => p.id === tp.builtByPlayerId);
      this.drawTeleportBuilding(tp, builder?.color ?? '#aaa', !!tp.pairedId, size, cx, cy, !visible.has(hexKey(tp.pos)));
    }

      ctx.filter = 'none';
    } finally {
      this.ctx = mainCtx;
    }
    this._boardDirty = false;
  }

  private hexPath(x: number, y: number, size: number): void {
    // Pointy-top hexagon: vertex at top and bottom (30° offset)
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 6 + (Math.PI / 3) * i;
      const hx = x + size * Math.cos(angle);
      const hy = y + size * Math.sin(angle);
      if (i === 0) ctx.moveTo(hx, hy);
      else ctx.lineTo(hx, hy);
    }
    ctx.closePath();
  }

  private drawHex(x: number, y: number, size: number, fill: string, stroke: string): void {
    const ctx = this.ctx;
    this.hexPath(x, y, size);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke !== 'transparent') {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private drawHexStroke(x: number, y: number, size: number, stroke: string): void {
    const ctx = this.ctx;
    this.hexPath(x, y, size);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // NOTE: caller is responsible for setting ctx.filter before calling this.
  // No save/restore — mirroring is undone manually to avoid state stack overhead.
  private drawTileSprite(
    x: number, y: number, size: number,
    frame: TileFrame,
    adj: { offsetX: number; offsetY: number; scaleX: number; scaleY: number },
    mirrored = false,
  ): void {
    if (!ATLAS_IMG.complete || !ATLAS_IMG.naturalWidth) return;
    const ctx = this.ctx;

    const scale = size / BASE_HEX_SIZE;
    const baseWidth  = 2.2 * size;
    const baseHeight = baseWidth * (frame.h / frame.w);
    const drawWidth  = baseWidth  * adj.scaleX;
    const drawHeight = baseHeight * adj.scaleY;
    const dx = x + adj.offsetX * scale - drawWidth  / 2;
    const dy = y + adj.offsetY * scale - drawHeight / 2;

    if (mirrored) {
      ctx.translate(x * 2, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(ATLAS_IMG, frame.x, frame.y, frame.w, frame.h, dx, dy, drawWidth, drawHeight);
      // Undo mirror without save/restore: reverse order, inverse ops
      ctx.scale(-1, 1);
      ctx.translate(-x * 2, 0);
    } else {
      ctx.drawImage(ATLAS_IMG, frame.x, frame.y, frame.w, frame.h, dx, dy, drawWidth, drawHeight);
    }
  }

  private drawHitFrame(x: number, y: number, size: number, frameIndex: number): void {
    if (!HIT_SPRITE.complete || !HIT_SPRITE.naturalWidth) return;
    const ctx = this.ctx;
    const cols = 4;
    const rows = 4;
    const frameW = HIT_SPRITE.naturalWidth / cols;
    const frameH = HIT_SPRITE.naturalHeight / rows;
    const col = frameIndex % cols;
    const row = Math.floor(frameIndex / cols);
    const drawSize = size * 2.4;
    ctx.drawImage(
      HIT_SPRITE,
      col * frameW, row * frameH, frameW, frameH,
      x - drawSize / 2, y - drawSize / 2, drawSize, drawSize,
    );
  }

  private drawWallMarker(x: number, y: number, size: number): void {
    const ctx = this.ctx;
    const s = size * 0.3;
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s);
    ctx.lineTo(x + s, y + s);
    ctx.moveTo(x + s, y - s);
    ctx.lineTo(x - s, y + s);
    ctx.stroke();
  }

  private drawForestMarker(x: number, y: number, size: number): void {
    const ctx = this.ctx;
    const s = size * 0.22;
    for (const ox of [-s * 0.7, s * 0.7]) {
      const tx = x + ox;
      const ty = y + s * 0.3;
      ctx.fillStyle = '#5a3a1a';
      ctx.fillRect(tx - s * 0.1, ty, s * 0.2, s * 0.6);
      ctx.beginPath();
      ctx.moveTo(tx, ty - s * 0.8);
      ctx.lineTo(tx - s * 0.6, ty + s * 0.1);
      ctx.lineTo(tx + s * 0.6, ty + s * 0.1);
      ctx.closePath();
      ctx.fillStyle = '#2a7a2a';
      ctx.fill();
    }
    const cty = y;
    ctx.fillStyle = '#5a3a1a';
    ctx.fillRect(x - s * 0.12, cty + s * 0.1, s * 0.24, s * 0.7);
    ctx.beginPath();
    ctx.moveTo(x, cty - s * 1.1);
    ctx.lineTo(x - s * 0.7, cty + s * 0.2);
    ctx.lineTo(x + s * 0.7, cty + s * 0.2);
    ctx.closePath();
    ctx.fillStyle = '#3a8a3a';
    ctx.fill();
  }

  private drawHillMarker(x: number, y: number, size: number): void {
    const ctx = this.ctx;
    const s = size * 0.25;
    ctx.beginPath();
    ctx.moveTo(x, y - s);
    ctx.lineTo(x - s * 0.8, y + s * 0.4);
    ctx.lineTo(x + s * 0.8, y + s * 0.4);
    ctx.closePath();
    ctx.fillStyle = '#6a6a3a';
    ctx.fill();
    ctx.strokeStyle = '#8a8a5a';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawUnit(unit: Unit, state: GameState, size: number, cx: number, cy: number): void {
    const ctx = this.ctx;
    const dest = hexToPixel(unit.pos, size, cx, cy);
    let x = dest.x;
    let y = dest.y;
    const anim = this._unitAnims.get(unit.id);
    if (anim) {
      const elapsed = performance.now() - anim.startTime;
      const t = Math.min(elapsed / MOVE_ANIM_DURATION_MS, 1);
      const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const from = hexToPixel(anim.fromHex, size, cx, cy);
      x = from.x + (dest.x - from.x) * ease;
      y = from.y + (dest.y - from.y) * ease;
    }
    const player = state.players.find(p => p.id === unit.playerId)!;
    const s = size;


    const iconScale = s / BASE_HEX_SIZE;

    // Draw unit sprite if available
    const unitSprite = UNIT_SPRITES[unit.type];
    if (unitSprite && unitSprite.complete && unitSprite.naturalWidth) {
      const adj = UNIT_ADJUSTMENTS[unit.type] ?? { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, baseScale: 1.6 };
      const scale = s / BASE_HEX_SIZE;
      const spriteW = s * adj.baseScale * adj.scaleX;
      const spriteH = spriteW * (unitSprite.naturalHeight / unitSprite.naturalWidth) * (adj.scaleY / adj.scaleX);
      const dx = x + adj.offsetX * scale - spriteW / 2;
      const dy = y + adj.offsetY * scale - spriteH / 2;
      ctx.drawImage(unitSprite, dx, dy, spriteW, spriteH);
    } else {
      // Fallback: colored circle + geometric icon when sprite hasn't loaded
      ctx.beginPath();
      ctx.arc(x, y, s * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = player.color;
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;

      if (unit.type === 'catapult') {
        ctx.beginPath();
        ctx.arc(x, y + 1 * iconScale, 6 * iconScale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 4 * iconScale, y - 4 * iconScale);
        ctx.lineTo(x + 7 * iconScale, y - 7 * iconScale);
        ctx.stroke();
        ctx.fillStyle = '#ffcc00';
        ctx.beginPath();
        ctx.arc(x + 7 * iconScale, y - 7 * iconScale, 2 * iconScale, 0, Math.PI * 2);
        ctx.fill();
      } else if (unit.type === 'archer') {
        ctx.beginPath();
        ctx.arc(x - 2 * iconScale, y, 8 * iconScale, -Math.PI * 0.4, Math.PI * 0.4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 2 * iconScale, y);
        ctx.lineTo(x + 8 * iconScale, y);
        ctx.moveTo(x + 5 * iconScale, y - 3 * iconScale);
        ctx.lineTo(x + 8 * iconScale, y);
        ctx.lineTo(x + 5 * iconScale, y + 3 * iconScale);
        ctx.stroke();
      } else if (unit.type === 'horserider') {
        ctx.beginPath();
        ctx.moveTo(x - 8 * iconScale, y + 3 * iconScale);
        ctx.lineTo(x + 2 * iconScale, y + 3 * iconScale);
        ctx.lineTo(x + 2 * iconScale, y + 6 * iconScale);
        ctx.lineTo(x + 8 * iconScale, y);
        ctx.lineTo(x + 2 * iconScale, y - 6 * iconScale);
        ctx.lineTo(x + 2 * iconScale, y - 3 * iconScale);
        ctx.lineTo(x - 8 * iconScale, y - 3 * iconScale);
        ctx.closePath();
        ctx.stroke();
      } else if (unit.type === 'heavyknight') {
        ctx.beginPath();
        ctx.moveTo(x, y - 8 * iconScale);
        ctx.lineTo(x - 6 * iconScale, y - 4 * iconScale);
        ctx.lineTo(x - 6 * iconScale, y + 2 * iconScale);
        ctx.lineTo(x, y + 8 * iconScale);
        ctx.lineTo(x + 6 * iconScale, y + 2 * iconScale);
        ctx.lineTo(x + 6 * iconScale, y - 4 * iconScale);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y - 6 * iconScale);
        ctx.lineTo(x, y + 5 * iconScale);
        ctx.moveTo(x - 5 * iconScale, y - 1 * iconScale);
        ctx.lineTo(x + 5 * iconScale, y - 1 * iconScale);
        ctx.stroke();
      } else if (unit.type === 'spearsman') {
        ctx.beginPath();
        ctx.moveTo(x - 7 * iconScale, y + 7 * iconScale);
        ctx.lineTo(x + 7 * iconScale, y - 7 * iconScale);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 7 * iconScale, y - 7 * iconScale);
        ctx.lineTo(x + 2 * iconScale, y - 7 * iconScale);
        ctx.moveTo(x + 7 * iconScale, y - 7 * iconScale);
        ctx.lineTo(x + 7 * iconScale, y - 2 * iconScale);
        ctx.stroke();
      } else if (unit.type === 'healer') {
        const arm = 7 * iconScale;
        const thick = 2.5 * iconScale;
        ctx.fillStyle = '#fff';
        ctx.fillRect(x - thick, y - arm, thick * 2, arm * 2);
        ctx.fillRect(x - arm, y - thick, arm * 2, thick * 2);
      } else if (unit.type === 'damageBooster') {
        ctx.beginPath();
        ctx.moveTo(x, y - 8 * iconScale);
        ctx.lineTo(x - 4 * iconScale, y + 4 * iconScale);
        ctx.lineTo(x, y + 1 * iconScale);
        ctx.lineTo(x + 4 * iconScale, y + 4 * iconScale);
        ctx.closePath();
        ctx.strokeStyle = '#ffaa44';
        ctx.fillStyle = 'rgba(255,160,50,0.35)';
        ctx.fill();
        ctx.stroke();
      } else if (unit.type === 'rangeBooster') {
        ctx.beginPath();
        ctx.moveTo(x - 3 * iconScale, y);
        ctx.lineTo(x - 8 * iconScale, y);
        ctx.moveTo(x - 6 * iconScale, y - 3 * iconScale);
        ctx.lineTo(x - 8 * iconScale, y);
        ctx.lineTo(x - 6 * iconScale, y + 3 * iconScale);
        ctx.moveTo(x + 3 * iconScale, y);
        ctx.lineTo(x + 8 * iconScale, y);
        ctx.moveTo(x + 6 * iconScale, y - 3 * iconScale);
        ctx.lineTo(x + 8 * iconScale, y);
        ctx.lineTo(x + 6 * iconScale, y + 3 * iconScale);
        ctx.strokeStyle = '#88ddff';
        ctx.stroke();
        ctx.fillStyle = '#88ddff';
        ctx.beginPath();
        ctx.arc(x, y, 2 * iconScale, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(x - 5 * iconScale, y - 7 * iconScale);
        ctx.lineTo(x + 5 * iconScale, y + 7 * iconScale);
        ctx.moveTo(x - 3 * iconScale, y + 1 * iconScale);
        ctx.lineTo(x + 3 * iconScale, y - 1 * iconScale);
        ctx.stroke();
      }
    }

    // HP bar
    const barWidth = s * 0.8;
    const barHeight = Math.max(3, 4 * iconScale);
    const barX = x - barWidth / 2;
    const barY = y + s * 0.5;
    const hpRatio = unit.hp / unit.stats.maxHp;

    ctx.fillStyle = '#333';
    ctx.fillRect(barX, barY, barWidth, barHeight);
    ctx.fillStyle = hpRatio > 0.5 ? '#44cc44' : hpRatio > 0.25 ? '#cccc44' : '#cc4444';
    ctx.fillRect(barX, barY, barWidth * hpRatio, barHeight);

    // Hill bonus indicator
    if (state.hills.has(hexKey(unit.pos))) {
      ctx.font = `bold ${Math.max(8, 10 * iconScale)}px sans-serif`;
      ctx.fillStyle = '#aaffaa';
      ctx.textAlign = 'center';
      ctx.fillText(`🛡+${HILL_DEFENSE_BONUS} 🏹+${HILL_RANGE_BONUS}`, x, barY + barHeight + Math.max(10, 12 * iconScale));
    }

    // Support boost indicator
    const { damageBonus, rangeBonus } = getSupportBoostsForUnit(state, unit);
    if (damageBonus > 0 || rangeBonus > 0) {
      const parts: string[] = [];
      if (damageBonus > 0) parts.push(`⚔+${damageBonus}`);
      if (rangeBonus > 0) parts.push(`🏹+${rangeBonus}`);
      const labelY = barY + barHeight + (state.hills.has(hexKey(unit.pos)) ? Math.max(20, 24 * iconScale) : Math.max(10, 12 * iconScale));
      ctx.font = `bold ${Math.max(7, 9 * iconScale)}px sans-serif`;
      ctx.fillStyle = '#ffcc66';
      ctx.textAlign = 'center';
      ctx.fillText(parts.join(' '), x, labelY);
    }

    // Dimmed overlay if unit already acted
    if (unit.playerId === getCurrentPlayer(state).id && unit.hasAttacked) {
      ctx.beginPath();
      ctx.arc(x, y, s * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fill();
    }
  }

  private drawTemple(temple: Temple, state: GameState, size: number, cx: number, cy: number): void {
    const ctx = this.ctx;
    const { x, y } = hexToPixel(temple.pos, size, cx, cy);
    const s = size;
    const iconScale = s / BASE_HEX_SIZE;
    const isSelected = state.selectedTempleId === temple.id;

    const owner = temple.ownerId !== null ? state.players.find(p => p.id === temple.ownerId) : null;
    const color = owner ? owner.color : '#888888';

    if (isSelected) {
      ctx.beginPath();
      ctx.arc(x, y, s * 0.65, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(x, y - s * 0.45);
    ctx.lineTo(x - s * 0.35, y + s * 0.25);
    ctx.lineTo(x + s * 0.35, y + s * 0.25);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x, y - 2 * iconScale, 4 * iconScale, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();

    // Level label
    const labelY = y + s * 0.5;
    ctx.font = `bold ${Math.max(8, 9 * iconScale)}px sans-serif`;
    ctx.fillStyle = '#ddd';
    ctx.textAlign = 'center';
    ctx.fillText(`Lv.${temple.level}`, x, labelY);
  }

  private drawTeleportBuilding(tp: TeleportBuilding, playerColor: string, isPaired: boolean, size: number, cx: number, cy: number, dimmed: boolean): void {
    const ctx = this.ctx;
    const { x, y } = hexToPixel(tp.pos, size, cx, cy);
    const scale = size / BASE_HEX_SIZE;

    ctx.save();
    if (dimmed) ctx.globalAlpha = 0.45;

    // Outer glow ring
    const outerR = size * 0.38;
    ctx.beginPath();
    ctx.arc(x, y, outerR, 0, Math.PI * 2);
    ctx.strokeStyle = isPaired ? playerColor : '#666';
    ctx.lineWidth = 3 * scale;
    ctx.stroke();

    // Inner ring (cyan glow)
    const innerR = size * 0.24;
    ctx.beginPath();
    ctx.arc(x, y, innerR, 0, Math.PI * 2);
    ctx.strokeStyle = isPaired ? 'rgba(0,230,255,0.85)' : 'rgba(150,150,150,0.5)';
    ctx.lineWidth = 2 * scale;
    ctx.stroke();

    // Fill centre with faint glow
    const grad = ctx.createRadialGradient(x, y, 0, x, y, innerR);
    grad.addColorStop(0, isPaired ? 'rgba(0,200,255,0.35)' : 'rgba(100,100,100,0.15)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.arc(x, y, innerR, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // ↔ symbol (two opposing arrows)
    const arm = 7 * scale;
    ctx.strokeStyle = isPaired ? '#00eeff' : '#888';
    ctx.lineWidth = 1.5 * scale;
    ctx.beginPath();
    // left arrow
    ctx.moveTo(x - arm * 0.3, y);
    ctx.lineTo(x - arm, y);
    ctx.moveTo(x - arm * 0.65, y - arm * 0.4);
    ctx.lineTo(x - arm, y);
    ctx.lineTo(x - arm * 0.65, y + arm * 0.4);
    // right arrow
    ctx.moveTo(x + arm * 0.3, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x + arm * 0.65, y - arm * 0.4);
    ctx.lineTo(x + arm, y);
    ctx.lineTo(x + arm * 0.65, y + arm * 0.4);
    ctx.stroke();

    ctx.restore();
  }

  getHexSize(): number {
    return this.hexSize;
  }

  getCenter(): { x: number; y: number } {
    return { x: this.centerX, y: this.centerY };
  }
}
