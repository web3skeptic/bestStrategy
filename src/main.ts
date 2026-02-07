import { GameState, UnitType, UNIT_COSTS } from './types';
import { pixelToHex, hexEqual, hexKey } from './hex';
import { Renderer } from './renderer';
import {
  createGameState,
  getCurrentPlayer,
  getUnitAt,
  getTempleAt,
  selectUnit,
  selectTemple,
  deselectAll,
  moveUnit,
  attackUnit,
  canCaptureTemple,
  captureTemple,
  spawnUnit,
  endTurn,
  calculateEncirclement,
  getEffectiveDefense,
  getCurrentPlayerVisible,
  canAfford,
} from './game';
import { runAITurn } from './ai';

const AI_PLAYER_ID = 1;
const AI_DELAY_MS = 600; // delay before AI acts (so player sees the transition)

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;

let state: GameState = createGameState();
const renderer = new Renderer(canvas);
renderer.init(state.mapRadius);

// ── UI elements ──
const turnInfoEl = document.getElementById('turnInfo')!;
const unitInfoEl = document.getElementById('unitInfo')!;
const auraInfoEl = document.getElementById('auraInfo')!;
const endTurnBtn = document.getElementById('endTurnBtn')!;
const restartBtn = document.getElementById('restartBtn') as HTMLButtonElement;
const spawnBar = document.getElementById('spawnBar')!;
const spawnWarriorBtn = document.getElementById('spawnWarrior')!;
const spawnArcherBtn = document.getElementById('spawnArcher')!;
const spawnBomberBtn = document.getElementById('spawnBomber')!;
const spawnSniperBtn = document.getElementById('spawnSniper')!;
const captureBtn = document.getElementById('captureBtn')!;
const logToggle = document.getElementById('logToggle')!;
const logArrow = document.getElementById('logArrow')!;
const combatLog = document.getElementById('combatLog')!;

function render(): void {
  renderer.render(state);
  updateUI();
}

function updateUI(): void {
  const player = getCurrentPlayer(state);
  turnInfoEl.style.color = player.color;
  turnInfoEl.textContent = `${player.name}'s Turn`;
  const income = state.temples.filter(t => t.ownerId === player.id).length;
  auraInfoEl.textContent = `⚡${player.aura} (+${income}/turn)`;
  auraInfoEl.style.color = player.color;

  if (state.phase === 'gameOver') {
    turnInfoEl.textContent = state.winner ? `${state.winner.name} Wins!` : 'Draw!';
    restartBtn.style.display = 'block';
  } else {
    restartBtn.style.display = 'none';
  }

  // Selected unit info
  if (state.selectionMode === 'unit' && state.selectedUnitId) {
    const unit = state.units.find(u => u.id === state.selectedUnitId);
    if (unit) {
      const typeName = unit.type.charAt(0).toUpperCase() + unit.type.slice(1);
      const enc = calculateEncirclement(state, unit);
      const encStr = enc.attackMultiplier > 1 ? ` | Enc x${enc.attackMultiplier.toFixed(1)}` : '';
      const effDef = getEffectiveDefense(state, unit);
      const defStr = effDef > unit.stats.defense ? `${effDef}(⛰+2)` : `${effDef}`;
      unitInfoEl.textContent = `${typeName} HP:${unit.hp}/${unit.stats.maxHp} ATK:${unit.stats.attack} DEF:${defStr} RNG:${unit.stats.range}${encStr}`;

      // Show capture button if unit can capture a temple
      const capturable = canCaptureTemple(state, unit);
      if (capturable) {
        captureBtn.style.display = 'block';
        captureBtn.textContent = `⚔ Capture Temple`;
      } else {
        captureBtn.style.display = 'none';
      }
    }
  } else if (state.selectionMode === 'temple' && state.selectedTempleId) {
    const temple = state.temples.find(t => t.id === state.selectedTempleId);
    if (temple) {
      const unitOnTemple = getUnitAt(state, temple.pos);
      unitInfoEl.textContent = unitOnTemple ? 'Temple (occupied)' : 'Temple — Pick unit to spawn';
    }
    captureBtn.style.display = 'none';
  } else {
    unitInfoEl.textContent = '';
    captureBtn.style.display = 'none';
  }

  // Spawn bar visibility — only when temple selected AND no unit on it
  if (state.selectionMode === 'temple' && state.selectedTempleId) {
    const temple = state.temples.find(t => t.id === state.selectedTempleId);
    const unitOnTemple = temple ? getUnitAt(state, temple.pos) : true;
    if (!unitOnTemple) {
      spawnBar.style.display = 'flex';
      updateSpawnBtn(spawnWarriorBtn, 'warrior');
      updateSpawnBtn(spawnArcherBtn, 'archer');
      updateSpawnBtn(spawnBomberBtn, 'bomber');
      updateSpawnBtn(spawnSniperBtn, 'sniper');
    } else {
      spawnBar.style.display = 'none';
    }
  } else {
    spawnBar.style.display = 'none';
  }
}

function updateSpawnBtn(btn: HTMLElement, type: UnitType): void {
  const affordable = canAfford(state, type);
  btn.classList.toggle('disabled', !affordable);
}

function logCombat(msg: string): void {
  const line = document.createElement('div');
  line.textContent = msg;
  combatLog.prepend(line);
  while (combatLog.children.length > 50) {
    combatLog.removeChild(combatLog.lastChild!);
  }
}

// ── Canvas click/tap → game coordinates ──
function canvasEventToHex(clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const mx = (clientX - rect.left) * dpr;
  const my = (clientY - rect.top) * dpr;
  const center = renderer.getCenter();
  return pixelToHex(mx, my, renderer.getHexSize(), center.x, center.y);
}

function handleHexClick(clientX: number, clientY: number): void {
  if (state.phase === 'gameOver') return;
  if (aiRunning) return;
  if (getCurrentPlayer(state).id === AI_PLAYER_ID) return;
  const hex = canvasEventToHex(clientX, clientY);
  const currentPlayer = getCurrentPlayer(state);

  // ── Unit mode: try attack ──
  if (state.selectionMode === 'unit' && state.attackHexes.some(h => hexEqual(h, hex))) {
    const result = attackUnit(state, hex);
    if (result) {
      const tEnc = result.targetEncirclement;
      const aEnc = result.attackerEncirclement;
      const tEncStr = tEnc.attackMultiplier > 1 ? ` [target x${tEnc.attackMultiplier.toFixed(2)}]` : '';
      const aEncStr = aEnc.attackMultiplier > 1 ? ` [attacker x${aEnc.attackMultiplier.toFixed(2)}]` : '';
      logCombat(`Attack!${tEncStr} Dealt ${result.damageDealt} dmg${result.targetKilled ? ' (KILLED!)' : ''}, received ${result.damageReceived} revenge${aEncStr}${result.attackerKilled ? ' (KILLED!)' : ''}`);
      for (const splash of result.splashHits) {
        logCombat(`  Splash: ${splash.damage} dmg${splash.killed ? ' (KILLED!)' : ''}`);
      }
      render();
      return;
    }
  }

  // ── Unit mode: try move ──
  if (state.selectionMode === 'unit' && state.moveHexes.some(h => hexEqual(h, hex))) {
    if (moveUnit(state, hex)) {
      const temple = getTempleAt(state, hex);
      if (temple && temple.ownerId !== currentPlayer.id) {
        logCombat(`Moved onto temple at (${hex.q},${hex.r}) — capture next turn!`);
      } else {
        logCombat(`Moved to (${hex.q}, ${hex.r})`);
      }
      render();
      return;
    }
  }

  // ── Select unit or temple ──
  const unit = getUnitAt(state, hex);
  if (unit && unit.playerId === currentPlayer.id) {
    selectUnit(state, unit.id);
    render();
    return;
  }

  // Click on owned temple (only if no unit on it, otherwise we selected the unit above)
  const temple = getTempleAt(state, hex);
  if (temple && temple.ownerId === currentPlayer.id && !getUnitAt(state, hex)) {
    selectTemple(state, temple.id);
    render();
    return;
  }

  // Deselect
  deselectAll(state);
  render();
}

// ── Spawn buttons ──
function handleSpawnBtn(type: UnitType): void {
  if (state.selectionMode !== 'temple' || !state.selectedTempleId) return;
  if (!canAfford(state, type)) return;

  if (spawnUnit(state, state.selectedTempleId, type)) {
    logCombat(`Spawned ${type} for ${UNIT_COSTS[type]} aura`);
    // After spawn, select the new unit so player can move/attack immediately
    const temple = state.temples.find(t => t.id === state.selectedTempleId);
    if (temple) {
      const newUnit = getUnitAt(state, temple.pos);
      if (newUnit) {
        selectUnit(state, newUnit.id);
      }
    }
    render();
  }
}

spawnWarriorBtn.addEventListener('click', () => handleSpawnBtn('warrior'));
spawnArcherBtn.addEventListener('click', () => handleSpawnBtn('archer'));
spawnBomberBtn.addEventListener('click', () => handleSpawnBtn('bomber'));
spawnSniperBtn.addEventListener('click', () => handleSpawnBtn('sniper'));

// ── Capture button ──
captureBtn.addEventListener('click', () => {
  if (state.selectionMode !== 'unit' || !state.selectedUnitId) return;
  const unit = state.units.find(u => u.id === state.selectedUnitId);
  if (!unit) return;
  const temple = canCaptureTemple(state, unit);
  if (!temple) return;
  captureTemple(state, unit, temple);
  logCombat(`Captured temple at (${temple.pos.q},${temple.pos.r})!`);
  render();
});

// ── Mouse click ──
canvas.addEventListener('click', (e) => {
  handleHexClick(e.clientX, e.clientY);
});

// ── Mouse drag to pan ──
let mouseDragging = false;
let mouseLastX = 0;
let mouseLastY = 0;
let mouseDragDist = 0;

canvas.addEventListener('mousedown', (e) => {
  if (renderer.zoom > 1.0) {
    mouseDragging = true;
    mouseLastX = e.clientX;
    mouseLastY = e.clientY;
    mouseDragDist = 0;
  }
});

window.addEventListener('mousemove', (e) => {
  if (!mouseDragging) return;
  const dpr = window.devicePixelRatio || 1;
  const dx = (e.clientX - mouseLastX) * dpr;
  const dy = (e.clientY - mouseLastY) * dpr;
  mouseDragDist += Math.abs(dx) + Math.abs(dy);
  renderer.pan(dx, dy);
  mouseLastX = e.clientX;
  mouseLastY = e.clientY;
  render();
});

window.addEventListener('mouseup', () => {
  mouseDragging = false;
});

// Suppress click after drag
canvas.addEventListener('click', (e) => {
  if (mouseDragDist > 10) {
    e.stopImmediatePropagation();
    mouseDragDist = 0;
  }
}, true);

// ── Touch handling (tap, drag pan, pinch zoom) ──
let lastTouchDist = 0;
let touchStartX = 0;
let touchStartY = 0;
let touchLastX = 0;
let touchLastY = 0;
let touchDragDist = 0;
let touchFingers = 0;

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  touchFingers = e.touches.length;
  touchDragDist = 0;
  if (e.touches.length === 1) {
    touchStartX = e.touches[0]!.clientX;
    touchStartY = e.touches[0]!.clientY;
    touchLastX = touchStartX;
    touchLastY = touchStartY;
  }
  if (e.touches.length === 2) {
    lastTouchDist = getTouchDist(e);
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (e.touches.length === 1 && touchFingers === 1 && renderer.zoom > 1.0) {
    const dpr = window.devicePixelRatio || 1;
    const dx = (e.touches[0]!.clientX - touchLastX) * dpr;
    const dy = (e.touches[0]!.clientY - touchLastY) * dpr;
    touchDragDist += Math.abs(dx) + Math.abs(dy);
    renderer.pan(dx, dy);
    touchLastX = e.touches[0]!.clientX;
    touchLastY = e.touches[0]!.clientY;
    render();
  }
  if (e.touches.length === 2) {
    touchFingers = 2;
    const dist = getTouchDist(e);
    const delta = dist - lastTouchDist;
    if (Math.abs(delta) > 10) {
      if (delta > 0) renderer.zoomIn();
      else renderer.zoomOut();
      lastTouchDist = dist;
      render();
    }
  }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  if (touchFingers === 1 && touchDragDist < 15 && e.changedTouches.length === 1) {
    const t = e.changedTouches[0]!;
    handleHexClick(t.clientX, t.clientY);
  }
  if (e.touches.length === 0) {
    touchFingers = 0;
  }
}, { passive: false });

function getTouchDist(e: TouchEvent): number {
  const a = e.touches[0]!;
  const b = e.touches[1]!;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

// ── Mouse wheel zoom ──
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.deltaY < 0) renderer.zoomIn();
  else renderer.zoomOut();
  render();
}, { passive: false });

// ── Zoom buttons ──
document.getElementById('zoomInBtn')!.addEventListener('click', () => {
  renderer.zoomIn();
  render();
});
document.getElementById('zoomOutBtn')!.addEventListener('click', () => {
  renderer.zoomOut();
  render();
});

// ── Keyboard ──
document.addEventListener('keydown', (e) => {
  if (state.phase === 'gameOver') {
    if (e.key === 'r' || e.key === 'R') restartGame();
    return;
  }
  switch (e.key) {
    case 'Escape':
      deselectAll(state);
      render();
      break;
    case 'Enter':
      doEndTurn();
      break;
    case '+':
    case '=':
      renderer.zoomIn();
      render();
      break;
    case '-':
      renderer.zoomOut();
      render();
      break;
  }
});

// ── Buttons ──
endTurnBtn.addEventListener('click', () => {
  if (state.phase === 'gameOver') return;
  doEndTurn();
});

restartBtn.addEventListener('click', restartGame);

// ── Combat log toggle ──
let logOpen = false;
logToggle.addEventListener('click', () => {
  logOpen = !logOpen;
  combatLog.classList.toggle('open', logOpen);
  logArrow.textContent = logOpen ? '▼' : '▲';
});

// ── Helpers ──
let aiRunning = false;

function doEndTurn(): void {
  if (aiRunning) return;
  const prevPlayer = getCurrentPlayer(state).name;
  endTurn(state);
  const newPlayer = getCurrentPlayer(state);
  logCombat(`${prevPlayer} ended turn → ${newPlayer.name} (Aura: ${newPlayer.aura})`);
  render();

  // If it's now AI's turn, run AI after a short delay
  if (newPlayer.id === AI_PLAYER_ID && state.phase !== 'gameOver') {
    aiRunning = true;
    setTimeout(() => {
      runAI();
      aiRunning = false;
    }, AI_DELAY_MS);
  }
}

function runAI(): void {
  if (state.phase === 'gameOver') return;

  // Get player 0's visible hexes BEFORE AI acts (to know what player can "see")
  const playerVisible = getCurrentPlayerVisible(state);

  const actions = runAITurn(state);
  for (const action of actions) {
    // Only log actions the human player can see
    if (playerVisible.has(hexKey(action.pos))) {
      logCombat(action.description);
    }
  }

  // AI ends its turn
  const aiName = getCurrentPlayer(state).name;
  endTurn(state);
  const nextPlayer = getCurrentPlayer(state);
  logCombat(`${aiName} ended turn → ${nextPlayer.name} (Aura: ${nextPlayer.aura})`);
  render();
}

function restartGame(): void {
  state = createGameState();
  renderer.init(state.mapRadius);
  logCombat('--- New Game ---');
  render();
}

// ── Resize handling ──
window.addEventListener('resize', () => render());

// ── Initial render ──
render();
logCombat('Game started! Player 1 goes first.');
