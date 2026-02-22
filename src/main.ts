import { GameState, UnitType, UNIT_COSTS, TEMPLE_AURA_PER_LEVEL, templeUpgradeCost, SUPPORT_RANGE } from './types';
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
  getEffectiveAttack,
  getEffectiveRange,
  getCurrentPlayerVisible,
  canAfford,
  upgradeTemple,
  canUpgradeTemple,
  getPopulationCap,
  getPopulationCount,
  HEALER_HEAL_AMOUNT,
  DAMAGE_BOOST_AMOUNT,
  RANGE_BOOST_AMOUNT,
} from './game';
import { runAITurn } from './ai';

const AI_PLAYER_ID = 1;
const AI_DELAY_MS = 600;

let aiEnabled = true;
let gameStarted = false;

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;

let state: GameState = createGameState();
const renderer = new Renderer(canvas);
renderer.init(state.mapRadius);

// ── UI elements ──
const menuOverlay = document.getElementById('menuOverlay')!;
const menuVsAI = document.getElementById('menuVsAI')!;
const menu2P = document.getElementById('menu2P')!;
const menuBtn = document.getElementById('menuBtn')!;
const turnInfoEl = document.getElementById('turnInfo')!;
const unitInfoEl = document.getElementById('unitInfo')!;
const auraInfoEl = document.getElementById('auraInfo')!;
const popInfoEl = document.getElementById('popInfo')!;
const endTurnBtn = document.getElementById('endTurnBtn')!;
const restartBtn = document.getElementById('restartBtn') as HTMLButtonElement;
const spawnBar = document.getElementById('spawnBar')!;
const spawnWarriorBtn = document.getElementById('spawnWarrior')!;
const spawnArcherBtn = document.getElementById('spawnArcher')!;
const spawnCatapultBtn = document.getElementById('spawnCatapult')!;
const spawnHorseriderBtn = document.getElementById('spawnHorserider')!;
const spawnHeavyknightBtn = document.getElementById('spawnHeavyknight')!;
const spawnSpearsmanBtn = document.getElementById('spawnSpearsman')!;
const spawnHealerBtn = document.getElementById('spawnHealer')!;
const spawnDamageBoosterBtn = document.getElementById('spawnDamageBooster')!;
const spawnRangeBoosterBtn = document.getElementById('spawnRangeBooster')!;
const captureBtn = document.getElementById('captureBtn')!;
const upgradeTempleBtn = document.getElementById('upgradeTempleBtn')!;
const logToggle = document.getElementById('logToggle')!;
const logArrow = document.getElementById('logArrow')!;
const combatLog = document.getElementById('combatLog')!;

// ── Menu ──

function showMenu(): void {
  menuOverlay.classList.remove('hidden');
}

function hideMenu(): void {
  menuOverlay.classList.add('hidden');
}

function startGame(vsAI: boolean): void {
  aiEnabled = vsAI;
  const players = aiEnabled
    ? [{ name: 'Player 1', color: '#ff4444' }, { name: 'AI', color: '#4488ff' }]
    : [{ name: 'Player 1', color: '#ff4444' }, { name: 'Player 2', color: '#4488ff' }];
  state = createGameState(players);
  renderer.init(state.mapRadius);
  gameStarted = true;
  hideMenu();
  combatLog.innerHTML = '';
  logCombat(`--- New Game (${aiEnabled ? 'vs AI' : '2 Players'}) ---`);
  logCombat('Player 1 goes first.');
  render();
}

menuVsAI.addEventListener('click', () => startGame(true));
menu2P.addEventListener('click', () => startGame(false));
menuBtn.addEventListener('click', () => showMenu());

// ── Render & UI ──

function render(): void {
  renderer.render(state);
  updateUI();
}

function updateUI(): void {
  const player = getCurrentPlayer(state);
  turnInfoEl.style.color = player.color;
  turnInfoEl.textContent = `${player.name}'s Turn`;

  const ownedTemples = state.temples.filter(t => t.ownerId === player.id);
  const income = ownedTemples.reduce((sum, t) => sum + t.level * TEMPLE_AURA_PER_LEVEL, 0);
  auraInfoEl.textContent = `⚡${player.aura} (+${income}/t)`;
  auraInfoEl.style.color = player.color;

  const popCap = getPopulationCap(state, player.id);
  const popCount = getPopulationCount(state, player.id);
  popInfoEl.textContent = `Pop:${popCount}/${popCap}`;
  popInfoEl.style.color = popCount >= popCap ? '#ff8888' : '#aaa';

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
      const TYPE_NAMES: Partial<Record<UnitType, string>> = {
        damageBooster: 'Dmg Booster',
        rangeBooster: 'Rng Booster',
      };
      const typeName = TYPE_NAMES[unit.type] ?? (unit.type.charAt(0).toUpperCase() + unit.type.slice(1));
      const enc = calculateEncirclement(state, unit);
      const encStr = enc.attackMultiplier > 1 ? ` | Enc x${enc.attackMultiplier.toFixed(1)}` : '';
      const effDef = getEffectiveDefense(state, unit);
      const effAtk = getEffectiveAttack(state, unit);
      const effRng = getEffectiveRange(state, unit);
      const defStr = effDef > unit.stats.defense ? `${effDef}(⛰+2)` : `${effDef}`;
      const atkStr = effAtk > unit.stats.attack ? `${effAtk}(🔥+${effAtk - unit.stats.attack})` : `${effAtk}`;
      const rngStr = effRng > unit.stats.range ? `${effRng}(+${effRng - unit.stats.range})` : `${effRng}`;
      const bonusNote = unit.stats.bonusAgainst ? ' [spear bonus]' : '';
      let supportNote = '';
      if (unit.type === 'healer') supportNote = ` | ✚${HEALER_HEAL_AMOUNT}HP/t (r${SUPPORT_RANGE})`;
      if (unit.type === 'damageBooster') supportNote = ` | +${DAMAGE_BOOST_AMOUNT}ATK (r${SUPPORT_RANGE})`;
      if (unit.type === 'rangeBooster') supportNote = ` | +${RANGE_BOOST_AMOUNT}RNG (r${SUPPORT_RANGE})`;
      unitInfoEl.textContent = `${typeName} HP:${unit.hp}/${unit.stats.maxHp} ATK:${atkStr} DEF:${defStr} RNG:${rngStr}${encStr}${bonusNote}${supportNote}`;

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
      const income = temple.level * TEMPLE_AURA_PER_LEVEL;
      if (unitOnTemple) {
        unitInfoEl.textContent = `Temple Lv.${temple.level} (occupied) — ⚡${income}/turn`;
      } else {
        unitInfoEl.textContent = `Temple Lv.${temple.level} — ⚡${income}/turn — Spawn unit`;
      }

      // Upgrade button
      const upgradeCost = templeUpgradeCost(temple.level);
      if (upgradeCost !== null) {
        upgradeTempleBtn.style.display = 'block';
        upgradeTempleBtn.textContent = `⬆ Upgrade Lv.${temple.level}→${temple.level + 1} (${upgradeCost}⚡)`;
        upgradeTempleBtn.classList.toggle('disabled', player.aura < upgradeCost);
      } else {
        upgradeTempleBtn.style.display = 'none';
      }
    }
    captureBtn.style.display = 'none';
  } else {
    unitInfoEl.textContent = '';
    captureBtn.style.display = 'none';
    upgradeTempleBtn.style.display = 'none';
  }

  // Spawn bar
  if (state.selectionMode === 'temple' && state.selectedTempleId) {
    const temple = state.temples.find(t => t.id === state.selectedTempleId);
    const unitOnTemple = temple ? getUnitAt(state, temple.pos) : true;
    const alreadySpawned = temple ? state.spawnedTempleIds.has(temple.id) : false;
    if (!unitOnTemple && !alreadySpawned) {
      spawnBar.style.display = 'flex';
      updateSpawnBtn(spawnWarriorBtn, 'warrior');
      updateSpawnBtn(spawnArcherBtn, 'archer');
      updateSpawnBtn(spawnCatapultBtn, 'catapult');
      updateSpawnBtn(spawnHorseriderBtn, 'horserider');
      updateSpawnBtn(spawnHeavyknightBtn, 'heavyknight');
      updateSpawnBtn(spawnSpearsmanBtn, 'spearsman');
      updateSpawnBtn(spawnHealerBtn, 'healer');
      updateSpawnBtn(spawnDamageBoosterBtn, 'damageBooster');
      updateSpawnBtn(spawnRangeBoosterBtn, 'rangeBooster');
    } else {
      spawnBar.style.display = 'none';
    }
  } else {
    spawnBar.style.display = 'none';
  }

  // Hide upgrade btn when no temple selected
  if (state.selectionMode !== 'temple') {
    upgradeTempleBtn.style.display = 'none';
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

// ── Canvas click/tap -> game coordinates ──
function canvasEventToHex(clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const mx = (clientX - rect.left) * dpr;
  const my = (clientY - rect.top) * dpr;
  const center = renderer.getCenter();
  return pixelToHex(mx, my, renderer.getHexSize(), center.x, center.y);
}

function handleHexClick(clientX: number, clientY: number): void {
  if (!gameStarted) return;
  if (state.phase === 'gameOver') return;
  if (aiRunning) return;
  if (aiEnabled && getCurrentPlayer(state).id === AI_PLAYER_ID) return;
  const hex = canvasEventToHex(clientX, clientY);
  const currentPlayer = getCurrentPlayer(state);

  // ── Unit mode: try attack ──
  if (state.selectionMode === 'unit' && state.attackHexes.some(h => hexEqual(h, hex))) {
    const result = attackUnit(state, hex);
    if (result) {
      const tEnc = result.targetEncirclement;
      const aEnc = result.attackerEncirclement;
      const tEncStr = tEnc.attackMultiplier > 1 ? ` [enc x${tEnc.attackMultiplier.toFixed(2)}]` : '';
      const aEncStr = aEnc.attackMultiplier > 1 ? ` [enc x${aEnc.attackMultiplier.toFixed(2)}]` : '';
      const bonusStr = result.typeBonus > 1 ? ` [spear x${result.typeBonus}]` : '';
      logCombat(`Attack!${bonusStr}${tEncStr} Dealt ${result.damageDealt} dmg${result.targetKilled ? ' (KILLED!)' : ''}, received ${result.damageReceived} revenge${aEncStr}${result.attackerKilled ? ' (KILLED!)' : ''}`);
      for (const splash of result.splashHits) {
        logCombat(`  Splash: ${splash.damage} dmg${splash.killed ? ' (KILLED!)' : ''}`);
      }
      render();
      return;
    }
  }

  // ── Unit mode: try move ──
  if (state.selectionMode === 'unit' && state.moveHexes.some(h => hexEqual(h, hex))) {
    const moveResult = moveUnit(state, hex);
    if (moveResult.moved) {
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
spawnCatapultBtn.addEventListener('click', () => handleSpawnBtn('catapult'));
spawnHorseriderBtn.addEventListener('click', () => handleSpawnBtn('horserider'));
spawnHeavyknightBtn.addEventListener('click', () => handleSpawnBtn('heavyknight'));
spawnSpearsmanBtn.addEventListener('click', () => handleSpawnBtn('spearsman'));
spawnHealerBtn.addEventListener('click', () => handleSpawnBtn('healer'));
spawnDamageBoosterBtn.addEventListener('click', () => handleSpawnBtn('damageBooster'));
spawnRangeBoosterBtn.addEventListener('click', () => handleSpawnBtn('rangeBooster'));

// ── Upgrade temple button ──
upgradeTempleBtn.addEventListener('click', () => {
  if (state.selectionMode !== 'temple' || !state.selectedTempleId) return;
  const temple = state.temples.find(t => t.id === state.selectedTempleId);
  if (!temple) return;
  const prevLevel = temple.level;
  if (upgradeTemple(state, state.selectedTempleId)) {
    logCombat(`Temple upgraded Lv.${prevLevel}→${temple.level}!`);
    render();
  }
});

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
  if (e.key === 'Escape') {
    if (menuOverlay.classList.contains('hidden')) {
      showMenu();
    } else {
      if (gameStarted) hideMenu();
    }
    return;
  }
  if (!menuOverlay.classList.contains('hidden')) return;

  if (state.phase === 'gameOver') return;
  switch (e.key) {
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

restartBtn.addEventListener('click', () => showMenu());

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

  if (aiEnabled && newPlayer.id === AI_PLAYER_ID && state.phase !== 'gameOver') {
    aiRunning = true;
    setTimeout(() => {
      runAI();
      aiRunning = false;
    }, AI_DELAY_MS);
  }
}

function runAI(): void {
  if (state.phase === 'gameOver') return;

  const playerVisible = getCurrentPlayerVisible(state);

  const actions = runAITurn(state);
  for (const action of actions) {
    if (playerVisible.has(hexKey(action.pos))) {
      logCombat(action.description);
    }
  }

  const aiName = getCurrentPlayer(state).name;
  endTurn(state);
  const nextPlayer = getCurrentPlayer(state);
  logCombat(`${aiName} ended turn → ${nextPlayer.name} (Aura: ${nextPlayer.aura})`);
  render();
}

// ── Resize handling ──
window.addEventListener('resize', () => {
  if (gameStarted) render();
});

// ── Initial state: show menu ──
showMenu();
