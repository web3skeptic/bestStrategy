import { GameState, HexCoord, Unit, Temple, UNIT_COSTS, HILL_DEFENSE_BONUS } from './types';
import { generateHexMap, hexToPixel, hexEqual, hexKey } from './hex';
import { getCurrentPlayer, calculateEncirclement, getCurrentPlayerVisible } from './game';

const BASE_HEX_SIZE = 48;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3.0;
const ZOOM_STEP = 0.15;

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private mapHexes: HexCoord[] = [];
  private _zoom = 1.0;
  private _panX = 0;
  private _panY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  init(mapRadius: number): void {
    this.mapHexes = generateHexMap(mapRadius);
    this._panX = 0;
    this._panY = 0;
  }

  get zoom(): number { return this._zoom; }

  zoomIn(): void {
    this._zoom = Math.min(MAX_ZOOM, this._zoom + ZOOM_STEP);
  }

  zoomOut(): void {
    this._zoom = Math.max(MIN_ZOOM, this._zoom - ZOOM_STEP);
    if (this._zoom <= 1.0) {
      this._panX = 0;
      this._panY = 0;
    }
  }

  pan(dx: number, dy: number): void {
    this._panX += dx;
    this._panY += dy;
  }

  get hexSize(): number {
    return BASE_HEX_SIZE * this._zoom;
  }

  get centerX(): number { return this.canvas.width / 2 + this._panX; }
  get centerY(): number { return this.canvas.height / 2 + this._panY; }

  resizeToContainer(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(state: GameState): void {
    this.resizeToContainer();
    const ctx = this.ctx;
    const size = this.hexSize;
    const cx = this.centerX;
    const cy = this.centerY;

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const moveSet = new Set(state.moveHexes.map(h => hexKey(h)));
    const attackSet = new Set(state.attackHexes.map(h => hexKey(h)));

    const playerId = getCurrentPlayer(state).id;
    const explored = state.explored[playerId]!;
    const visible = getCurrentPlayerVisible(state);

    // Draw hex tiles
    for (const hex of this.mapHexes) {
      const { x, y } = hexToPixel(hex, size, cx, cy);
      const key = hexKey(hex);
      const isExplored = explored.has(key);
      const isVisible = visible.has(key);
      const isHill = state.hills.has(key);
      const isWall = state.walls.has(key);

      if (!isExplored) {
        this.drawHex(x, y, size, '#111122', '#222233');
        continue;
      }

      // Base color
      let fillColor: string;
      if (isWall) {
        fillColor = '#1a1a1a';
      } else if (isHill) {
        fillColor = '#3a3a2a';
      } else {
        fillColor = '#2a2a4a';
      }

      if (!isWall) {
        if (attackSet.has(key)) {
          fillColor = '#553333';
        } else if (moveSet.has(key)) {
          fillColor = '#335533';
        }
      }

      this.drawHex(x, y, size, fillColor, isWall ? '#333333' : '#444466');

      // Wall marker — rocky cross pattern
      if (isWall) {
        this.drawWallMarker(x, y, size);
      }

      // Hill indicator
      if (isHill) {
        this.drawHillMarker(x, y, size);
      }

      // Fog overlay for explored but not currently visible
      if (!isVisible) {
        this.drawHex(x, y, size, 'rgba(0,0,0,0.45)', 'transparent');
      }
    }

    // Draw temples (only if explored)
    for (const temple of state.temples) {
      const key = hexKey(temple.pos);
      if (!explored.has(key)) continue;
      this.drawTemple(temple, state, size, cx, cy);
    }

    // Draw units
    const aliveUnits = state.units.filter(u => u.hp > 0);
    for (const unit of aliveUnits) {
      const key = hexKey(unit.pos);
      // Show own units always, enemy units only if visible
      if (unit.playerId !== playerId && !visible.has(key)) continue;
      this.drawUnit(unit, state, size, cx, cy);
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
  }

  private drawHex(x: number, y: number, size: number, fill: string, stroke: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 180) * (60 * i);
      const hx = x + size * Math.cos(angle);
      const hy = y + size * Math.sin(angle);
      if (i === 0) ctx.moveTo(hx, hy);
      else ctx.lineTo(hx, hy);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke !== 'transparent') {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private drawWallMarker(x: number, y: number, size: number): void {
    const ctx = this.ctx;
    const s = size * 0.3;
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 2;
    // X pattern
    ctx.beginPath();
    ctx.moveTo(x - s, y - s);
    ctx.lineTo(x + s, y + s);
    ctx.moveTo(x + s, y - s);
    ctx.lineTo(x - s, y + s);
    ctx.stroke();
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
    const { x, y } = hexToPixel(unit.pos, size, cx, cy);
    const player = state.players.find(p => p.id === unit.playerId)!;
    const isSelected = state.selectedUnitId === unit.id;
    const s = size;

    // Selection ring
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(x, y, s * 0.6, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Unit circle
    ctx.beginPath();
    ctx.arc(x, y, s * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = player.color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Unit type icon
    const iconScale = s / BASE_HEX_SIZE;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    if (unit.type === 'sniper') {
      // Crosshair icon
      ctx.beginPath();
      ctx.arc(x, y, 7 * iconScale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 10 * iconScale, y);
      ctx.lineTo(x + 10 * iconScale, y);
      ctx.moveTo(x, y - 10 * iconScale);
      ctx.lineTo(x, y + 10 * iconScale);
      ctx.stroke();
      // Center dot
      ctx.fillStyle = '#ff4444';
      ctx.beginPath();
      ctx.arc(x, y, 2 * iconScale, 0, Math.PI * 2);
      ctx.fill();
    } else if (unit.type === 'bomber') {
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
    } else {
      ctx.beginPath();
      ctx.moveTo(x - 5 * iconScale, y - 7 * iconScale);
      ctx.lineTo(x + 5 * iconScale, y + 7 * iconScale);
      ctx.moveTo(x - 3 * iconScale, y + 1 * iconScale);
      ctx.lineTo(x + 3 * iconScale, y - 1 * iconScale);
      ctx.stroke();
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

    // Hill defense indicator
    if (state.hills.has(hexKey(unit.pos))) {
      ctx.font = `bold ${Math.max(8, 10 * iconScale)}px sans-serif`;
      ctx.fillStyle = '#aaffaa';
      ctx.textAlign = 'center';
      ctx.fillText(`+${HILL_DEFENSE_BONUS}`, x, barY + barHeight + Math.max(10, 12 * iconScale));
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
  }

  getHexSize(): number {
    return this.hexSize;
  }

  getCenter(): { x: number; y: number } {
    return { x: this.centerX, y: this.centerY };
  }
}
