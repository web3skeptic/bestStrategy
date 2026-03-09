import { GameState, UnitType, HexCoord, UNIT_COSTS, TEMPLE_AURA_PER_LEVEL, templeUpgradeCost, SUPPORT_RANGE, TECH_NODES, TechId, TELEPORT_BUILD_COST, UnitStats } from './types';
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
  getUnlockedUnits,
  canResearch,
  researchTech,
  UNIT_STATS,
  canBuildTeleportPair,
  buildTeleportPair,
  getValidTeleportHexes,
  getValidTeleportHexesForOtherTemples,
  getTeleportAt,
} from './game';
import { runAITurn } from './ai';
import { MultiplayerClient } from './multiplayer';
import { deserialize } from './serializer';
import type { ServerMessage } from './protocol';

const AI_PLAYER_ID = 1;
const AI_DELAY_MS = 600;

// ── Settings defaults (snapshot at startup for reset) ──
const UNIT_STATS_DEFAULT: Record<UnitType, UnitStats> = Object.fromEntries(
  (Object.keys(UNIT_STATS) as UnitType[]).map(k => [k, { ...UNIT_STATS[k] }])
) as Record<UnitType, UnitStats>;
const UNIT_COSTS_DEFAULT: Record<UnitType, number> = { ...UNIT_COSTS };

let aiEnabled = true;
let gameStarted = false;
let multiplayerMode = false;
let myPlayerSlot: 0 | 1 = 0;
let mpClient: MultiplayerClient | null = null;

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
const buildTeleportBtn = document.getElementById('teleportBtn')!;
const logToggle = document.getElementById('logToggle')!;
const logArrow = document.getElementById('logArrow')!;
const combatLog = document.getElementById('combatLog')!;
const techTreeBtn = document.getElementById('techTreeBtn')!;
const techOverlay = document.getElementById('techOverlay')!;
const techCloseBtn = document.getElementById('techCloseBtn')!;
const techBody = document.getElementById('techBody')!;
const techAuraInfo = document.getElementById('techAuraInfo')!;
const opponentTurnOverlay = document.getElementById('opponentTurnOverlay')!;
const opponentTurnNameEl = document.getElementById('opponentTurnName')!;
const myPlayerBadge = document.getElementById('myPlayerBadge')!;
const settingsBtn = document.getElementById('settingsBtn')!;
const settingsOverlay = document.getElementById('settingsOverlay')!;
const settingsCloseBtn = document.getElementById('settingsCloseBtn')!;
const settingsBody = document.getElementById('settingsBody')!;
const settingsResetBtn = document.getElementById('settingsResetBtn')!;

// ── Lobby elements ──
const menuOnline = document.getElementById('menuOnline')!;
const lobbyMain = document.getElementById('lobbyMain')!;
const lobbyLogin = document.getElementById('lobbyLogin')!;
const lobbyRoomListPanel = document.getElementById('lobbyRoomList')!;
const lobbyWaiting = document.getElementById('lobbyWaiting')!;
const lobbyUsernameInput = document.getElementById('lobbyUsernameInput') as HTMLInputElement;
const lobbyLoginBtn = document.getElementById('lobbyLoginBtn')!;
const lobbyLoginStatus = document.getElementById('lobbyLoginStatus')!;
const lobbyLoginBack = document.getElementById('lobbyLoginBack')!;
const lobbyWelcomeMsg = document.getElementById('lobbyWelcomeMsg')!;
const lobbyCreateRoomBtn = document.getElementById('lobbyCreateRoomBtn')!;
const lobbyRoomListEl = document.getElementById('lobbyRoomListEl')!;
const lobbyRefreshBtn = document.getElementById('lobbyRefreshBtn')!;
const lobbyJoinCodeInput = document.getElementById('lobbyJoinCodeInput') as HTMLInputElement;
const lobbyJoinCodeBtn = document.getElementById('lobbyJoinCodeBtn')!;
const lobbyRoomStatus = document.getElementById('lobbyRoomStatus')!;
const lobbyRoomBack = document.getElementById('lobbyRoomBack')!;
const lobbyRoomCode = document.getElementById('lobbyRoomCode')!;
const lobbyWaitingStatus = document.getElementById('lobbyWaitingStatus')!;
const lobbyWaitingBack = document.getElementById('lobbyWaitingBack')!;

function showLobbyPanel(panel: 'main' | 'login' | 'rooms' | 'waiting'): void {
  lobbyMain.classList.toggle('hidden', panel !== 'main');
  lobbyLogin.classList.toggle('hidden', panel !== 'login');
  lobbyRoomListPanel.classList.toggle('hidden', panel !== 'rooms');
  lobbyWaiting.classList.toggle('hidden', panel !== 'waiting');
}

// ── sendOrCall: in multiplayer mode send action to server; locally call fn ──

function sendOrCall(action: object, localFn: () => void): void {
  if (multiplayerMode && mpClient) {
    mpClient.sendAction(action as Parameters<MultiplayerClient['sendAction']>[0]);
  } else {
    localFn();
    render();
  }
}

// ── Multiplayer event handler ──

function handleMultiplayerEvent(event: ServerMessage): void {
  switch (event.type) {
    case 'logged_in': {
      lobbyLoginStatus.textContent = '';
      lobbyWelcomeMsg.textContent = `Logged in as ${event.username}`;
      showLobbyPanel('rooms');
      mpClient!.listRooms();
      break;
    }
    case 'error': {
      lobbyLoginStatus.textContent = event.message;
      lobbyLoginStatus.className = 'lobby-status err';
      break;
    }
    case 'room_created': {
      lobbyRoomCode.textContent = event.roomId;
      lobbyWaitingStatus.textContent = 'Waiting for opponent to join…';
      showLobbyPanel('waiting');
      break;
    }
    case 'room_list': {
      lobbyRoomListEl.innerHTML = '';
      if (event.rooms.length === 0) {
        lobbyRoomListEl.innerHTML = '<div style="color:#556;font-size:12px;padding:4px">No open rooms</div>';
      }
      for (const room of event.rooms) {
        const item = document.createElement('div');
        item.className = 'lobby-room-item';
        item.innerHTML = `<span>${room.id} — ${room.player1Name}</span>`;
        const btn = document.createElement('button');
        btn.textContent = 'Join';
        btn.addEventListener('click', () => {
          mpClient!.joinRoom(room.id);
        });
        item.appendChild(btn);
        lobbyRoomListEl.appendChild(item);
      }
      break;
    }
    case 'game_start': {
      myPlayerSlot = event.playerSlot;
      multiplayerMode = true;
      aiEnabled = false;
      state = deserialize(event.state);
      renderer.init(state.mapRadius);
      gameStarted = true;
      buildingTeleport = null;
      hideMenu();
      closeTechTree();
      combatLog.innerHTML = '';
      const myPlayer = state.players[myPlayerSlot];
      console.log(`[MP] game_start: slot=${myPlayerSlot} name="${myPlayer?.name}" color=${myPlayer?.color} currentPlayerIndex=${state.currentPlayerIndex}`);
      logCombat(`--- Online Game started (you are Player ${myPlayerSlot + 1}) ---`);
      render();
      break;
    }
    case 'state_update': {
      state = deserialize(event.state);
      render();
      logCombat(event.lastAction);
      break;
    }
    case 'action_error': {
      logCombat(`Error: ${event.message}`);
      break;
    }
    case 'opponent_disconnected': {
      logCombat('Opponent disconnected. Waiting for reconnect…');
      break;
    }
    case 'opponent_reconnected': {
      logCombat('Opponent reconnected.');
      break;
    }
  }
}

// ── Lobby button wiring ──

menuOnline.addEventListener('click', () => {
  showLobbyPanel('login');
});

lobbyLoginBack.addEventListener('click', () => showLobbyPanel('main'));
lobbyRoomBack.addEventListener('click', () => showLobbyPanel('main'));
lobbyWaitingBack.addEventListener('click', () => {
  mpClient?.disconnect();
  mpClient = null;
  multiplayerMode = false;
  showLobbyPanel('main');
});

lobbyLoginBtn.addEventListener('click', async () => {
  const username = lobbyUsernameInput.value.trim();
  if (!username) return;
  lobbyLoginStatus.textContent = 'Connecting…';
  lobbyLoginStatus.className = 'lobby-status';

  const wsUrl = window.location.protocol === 'https:'
    ? `wss://${window.location.host}`
    : `ws://${window.location.host}`;

  if (!mpClient) {
    mpClient = new MultiplayerClient(wsUrl, handleMultiplayerEvent);
  }
  try {
    await mpClient.connect();
    mpClient.login(username);
  } catch {
    lobbyLoginStatus.textContent = 'Could not connect to server';
    lobbyLoginStatus.className = 'lobby-status err';
    mpClient = null;
  }
});

lobbyUsernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') lobbyLoginBtn.click();
});

lobbyCreateRoomBtn.addEventListener('click', () => {
  mpClient!.createRoom();
});

lobbyRefreshBtn.addEventListener('click', () => {
  lobbyRoomStatus.textContent = '';
  mpClient!.listRooms();
});

lobbyJoinCodeBtn.addEventListener('click', () => {
  const code = lobbyJoinCodeInput.value.trim().toUpperCase();
  if (code.length < 1) return;
  lobbyRoomStatus.textContent = 'Joining…';
  lobbyRoomStatus.className = 'lobby-status';
  mpClient!.joinRoom(code);
});

lobbyJoinCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') lobbyJoinCodeBtn.click();
});

// ── Menu ──

function showMenu(): void {
  menuOverlay.classList.remove('hidden');
  if (!gameStarted) showLobbyPanel('main');
}

function hideMenu(): void {
  menuOverlay.classList.add('hidden');
}

function startGame(vsAI: boolean): void {
  multiplayerMode = false;
  aiEnabled = vsAI;
  buildingTeleport = null;
  const players = aiEnabled
    ? [{ name: 'Player 1', color: '#ff4444' }, { name: 'AI', color: '#4488ff' }]
    : [{ name: 'Player 1', color: '#ff4444' }, { name: 'Player 2', color: '#4488ff' }];
  state = createGameState(players);
  renderer.init(state.mapRadius);
  gameStarted = true;
  hideMenu();
  closeTechTree();
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
  const waitingForOpponent = multiplayerMode
    && state.phase !== 'gameOver'
    && state.currentPlayerIndex !== myPlayerSlot;
  if (!waitingForOpponent) {
    renderer.render(state, multiplayerMode ? myPlayerSlot : undefined);
  }
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

      buildTeleportBtn.style.display = 'none';
    }
  } else if (state.selectionMode === 'temple' && state.selectedTempleId) {
    const temple = state.temples.find(t => t.id === state.selectedTempleId);
    if (temple) {
      const unitOnTemple = getUnitAt(state, temple.pos);
      const income = temple.level * TEMPLE_AURA_PER_LEVEL;
      // Count existing portals for this temple
      const existingPortals = state.teleportBuildings.filter(t => t.templeId === temple.id).length;
      const portalNote = existingPortals > 0 ? ` | ⬡ Portal: ${existingPortals}/1` : '';
      if (unitOnTemple) {
        unitInfoEl.textContent = `Temple Lv.${temple.level} (occupied) — ⚡${income}/turn${portalNote}`;
      } else {
        unitInfoEl.textContent = `Temple Lv.${temple.level} — ⚡${income}/turn — Spawn unit${portalNote}`;
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

      // Build teleport button
      if (canBuildTeleportPair(state, temple.id)) {
        buildTeleportBtn.style.display = 'block';
        buildTeleportBtn.classList.toggle('active', buildingTeleport?.templeId === temple.id);
        buildTeleportBtn.textContent = buildingTeleport?.templeId === temple.id
          ? (buildingTeleport.phase === 1 ? '⬡ Pick hex near this temple…' : '⬡ Pick hex near another temple…')
          : `⬡ Build Portal Pair (${TELEPORT_BUILD_COST}⚡)`;
      } else {
        buildTeleportBtn.style.display = 'none';
        if (buildingTeleport?.templeId === temple.id) cancelBuildTeleport();
      }
    }
    captureBtn.style.display = 'none';
  } else {
    unitInfoEl.textContent = '';
    captureBtn.style.display = 'none';
    upgradeTempleBtn.style.display = 'none';
    buildTeleportBtn.style.display = 'none';
    if (buildingTeleport) cancelBuildTeleport();
  }

  // Spawn bar
  if (state.selectionMode === 'temple' && state.selectedTempleId) {
    const temple = state.temples.find(t => t.id === state.selectedTempleId);
    const unitOnTemple = temple ? getUnitAt(state, temple.pos) : true;
    if (!unitOnTemple) {
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

  updateOpponentTurnOverlay();
  updateMyPlayerBadge();
}

function updateOpponentTurnOverlay(): void {
  const isOpponentTurn = multiplayerMode
    && state.phase !== 'gameOver'
    && state.currentPlayerIndex !== myPlayerSlot;
  if (isOpponentTurn) {
    opponentTurnNameEl.textContent = state.players[1 - myPlayerSlot].name;
    opponentTurnOverlay.classList.remove('hidden');
  } else {
    opponentTurnOverlay.classList.add('hidden');
  }
}

function updateMyPlayerBadge(): void {
  if (!multiplayerMode || !gameStarted) {
    myPlayerBadge.style.display = 'none';
    return;
  }
  const me = state.players[myPlayerSlot];
  if (!me) return;
  myPlayerBadge.style.display = 'inline-block';
  myPlayerBadge.style.color = me.color;
  myPlayerBadge.textContent = `You: P${myPlayerSlot + 1}`;
}

const SPAWN_BTN_LABELS: Record<UnitType, string> = {
  warrior:      '⚔ Warrior',
  archer:       '🏹 Archer',
  catapult:     '💣 Catapult',
  horserider:   '🐎 Horserider',
  heavyknight:  '🛡 H.Knight',
  spearsman:    '🗡 Spearsman',
  healer:       '✚ Healer',
  damageBooster:'🔥 Dmg+',
  rangeBooster: '↔ Rng+',
};

function updateSpawnBtn(btn: HTMLElement, type: UnitType): void {
  const player = getCurrentPlayer(state);
  const unlocked = getUnlockedUnits(state.playerTech[player.id]!);
  if (!unlocked.has(type)) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  btn.textContent = `${SPAWN_BTN_LABELS[type]} (${UNIT_COSTS[type]})`;
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

// ── Build teleport mode ──

interface BuildTeleportState {
  templeId: string;
  phase: 1 | 2;
  firstPos: HexCoord | null;
}

let buildingTeleport: BuildTeleportState | null = null;

function enterBuildTeleport(templeId: string): void {
  buildingTeleport = { templeId, phase: 1, firstPos: null };
  state.buildHexes = getValidTeleportHexes(state, templeId);
  render();
}

function cancelBuildTeleport(): void {
  buildingTeleport = null;
  state.buildHexes = [];
  render();
}

buildTeleportBtn.addEventListener('click', () => {
  if (buildingTeleport) {
    cancelBuildTeleport();
  } else if (state.selectionMode === 'temple' && state.selectedTempleId) {
    if (canBuildTeleportPair(state, state.selectedTempleId)) {
      enterBuildTeleport(state.selectedTempleId);
    }
  }
});

// ── Settings UI ──

const UNIT_DISPLAY: Record<UnitType, string> = {
  warrior:      '⚔ Warrior',
  archer:       '🏹 Archer',
  catapult:     '💣 Catapult',
  horserider:   '🐎 Horserider',
  heavyknight:  '🛡 H.Knight',
  spearsman:    '🗡 Spearsman',
  healer:       '✚ Healer',
  damageBooster:'🔥 Dmg Booster',
  rangeBooster: '↔ Rng Booster',
};

const STAT_FIELDS: Array<{ key: keyof UnitStats; label: string; min: number; step: number }> = [
  { key: 'maxHp',        label: 'HP',      min: 1,   step: 1   },
  { key: 'attack',       label: 'ATK',     min: 0,   step: 1   },
  { key: 'defense',      label: 'DEF',     min: 0,   step: 1   },
  { key: 'speed',        label: 'SPD',     min: 1,   step: 1   },
  { key: 'range',        label: 'RNG',     min: 1,   step: 1   },
  { key: 'vision',       label: 'VIS',     min: 1,   step: 1   },
  { key: 'splash',       label: 'Splash',  min: 0,   step: 1   },
  { key: 'splashFactor', label: 'SplshX',  min: 0,   step: 0.1 },
];

function syncLiveUnits(type: UnitType): void {
  for (const unit of state.units) {
    if (unit.type !== type) continue;
    const s = UNIT_STATS[type];
    for (const field of STAT_FIELDS) {
      (unit.stats as unknown as Record<string, number>)[field.key] =
        (s as unknown as Record<string, number>)[field.key];
    }
    if (unit.hp > unit.stats.maxHp) unit.hp = unit.stats.maxHp;
  }
  render();
}

function renderSettings(): void {
  settingsBody.innerHTML = '';
  for (const type of Object.keys(UNIT_DISPLAY) as UnitType[]) {
    const stats = UNIT_STATS[type];
    const card = document.createElement('div');
    card.className = 'settings-unit-card';

    const header = document.createElement('div');
    header.className = 'settings-unit-header';
    header.innerHTML = `<span class="settings-unit-name">${UNIT_DISPLAY[type]}</span>`;

    const costWrap = document.createElement('label');
    costWrap.className = 'settings-field';
    costWrap.innerHTML = `<span>Cost</span>`;
    const costInput = document.createElement('input');
    costInput.type = 'number';
    costInput.min = '1';
    costInput.step = '1';
    costInput.value = String(UNIT_COSTS[type]);
    costInput.addEventListener('input', () => {
      const v = parseInt(costInput.value);
      if (!isNaN(v) && v >= 1) { UNIT_COSTS[type] = v; render(); }
    });
    costWrap.appendChild(costInput);
    header.appendChild(costWrap);
    card.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'settings-fields';
    for (const field of STAT_FIELDS) {
      const lbl = document.createElement('label');
      lbl.className = 'settings-field';
      lbl.innerHTML = `<span>${field.label}</span>`;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = String(field.min);
      inp.step = String(field.step);
      inp.value = String((stats as unknown as Record<string, number>)[field.key]);
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        if (!isNaN(v) && v >= field.min) {
          (UNIT_STATS[type] as unknown as Record<string, number>)[field.key] = v;
          syncLiveUnits(type);
        }
      });
      lbl.appendChild(inp);
      grid.appendChild(lbl);
    }
    card.appendChild(grid);
    settingsBody.appendChild(card);
  }
}

function openSettings(): void {
  renderSettings();
  settingsOverlay.classList.remove('hidden');
}

function closeSettings(): void {
  settingsOverlay.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsCloseBtn.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });
settingsResetBtn.addEventListener('click', () => {
  for (const type of Object.keys(UNIT_STATS) as UnitType[]) {
    Object.assign(UNIT_STATS[type], UNIT_STATS_DEFAULT[type]);
    UNIT_COSTS[type] = UNIT_COSTS_DEFAULT[type];
    syncLiveUnits(type);
  }
  renderSettings();
});

// ── Tech tree UI ──

const BRANCH_META: Record<string, { title: string }> = {
  movement:        { title: 'Branch: Movement — Pick ONE' },
  stat_bonus:      { title: 'Branch: Stat Bonus — Pick ONE' },
  support:         { title: 'Branch: Support Unit — Pick ONE' },

};

function renderTechTree(): void {
  const player = getCurrentPlayer(state);
  const tech = state.playerTech[player.id]!;
  techAuraInfo.textContent = `⚡ ${player.aura} aura`;

  techBody.innerHTML = '';

  // Section 1: Unit unlocks (no branch)
  const unitUnlockNodes = TECH_NODES.filter(n => n.unitUnlock && !n.branch && n.prereqs.length === 0);
  appendSection(techBody, 'Unit Unlocks', undefined, unitUnlockNodes, tech, player.aura);

  // Section 2: Catapult sub-upgrade
  const catapultUpgrade = TECH_NODES.filter(n => n.id === 'catapult_splash');
  appendSection(techBody, 'Catapult Upgrade', undefined, catapultUpgrade, tech, player.aura);

  // Section 3+: Branches
  const branches = ['movement', 'stat_bonus', 'support'];
  for (const branch of branches) {
    const nodes = TECH_NODES.filter(n => n.branch === branch);
    const meta = BRANCH_META[branch]!;
    appendSection(techBody, meta.title, branch, nodes, tech, player.aura);
  }
}

function appendSection(
  container: HTMLElement,
  title: string,
  branch: string | undefined,
  nodes: typeof TECH_NODES,
  tech: { researched: Set<TechId> },
  aura: number,
): void {
  if (nodes.length === 0) return;

  const section = document.createElement('div');
  section.className = 'tech-section';

  const titleEl = document.createElement('div');
  titleEl.className = 'tech-section-title';
  titleEl.textContent = title;
  section.appendChild(titleEl);

  if (branch) {
    const branchHasPick = nodes.some(n => tech.researched.has(n.id));
    if (branchHasPick) {
      const label = document.createElement('div');
      label.className = 'tech-branch-label';
      label.textContent = '✓ Choice made — branch locked';
      section.appendChild(label);
    }
  }

  const nodesRow = document.createElement('div');
  nodesRow.className = 'tech-nodes';

  for (const node of nodes) {
    const prereqsMet = node.prereqs.every(p => tech.researched.has(p));
    const branchBlocked = !!node.branch && nodes.some(n => n.id !== node.id && tech.researched.has(n.id));
    const isResearched = tech.researched.has(node.id);
    const canAffordIt = aura >= node.cost;

    let stateClass = '';
    let statusText = '';
    let statusClass = '';
    if (isResearched) {
      stateClass = 'tech-node--researched';
      statusText = '✓ Researched';
      statusClass = 'status-researched';
    } else if (!prereqsMet || branchBlocked) {
      stateClass = 'tech-node--locked';
      statusText = branchBlocked ? '✗ Branch taken' : '✗ Requires prerequisite';
      statusClass = 'status-locked';
    } else if (!canAffordIt) {
      stateClass = 'tech-node--poor';
      statusText = `Need ${node.cost} ⚡`;
      statusClass = 'status-poor';
    } else {
      statusText = `Available`;
      statusClass = 'status-available';
    }

    const card = document.createElement('div');
    card.className = `tech-node ${stateClass}`;
    card.innerHTML = `
      <div class="tech-node-name">${node.name}</div>
      <div class="tech-node-cost">Cost: ${node.cost} ⚡</div>
      <div class="tech-node-desc">${node.description}</div>
      <div class="tech-node-status ${statusClass}">${statusText}</div>
    `;

    if (!isResearched && prereqsMet && !branchBlocked && canAffordIt) {
      card.addEventListener('click', () => {
        sendOrCall({ type: 'action_research', techId: node.id }, () => {
          if (researchTech(state, node.id)) {
            logCombat(`Researched: ${node.name} (−${node.cost} ⚡)`);
            renderTechTree();
          }
        });
        renderTechTree();
      });
    }

    nodesRow.appendChild(card);
  }

  section.appendChild(nodesRow);
  container.appendChild(section);
}

function openTechTree(): void {
  if (!gameStarted) return;
  if (aiEnabled && getCurrentPlayer(state).id === AI_PLAYER_ID) return;
  if (multiplayerMode && state.currentPlayerIndex !== myPlayerSlot) return;
  renderTechTree();
  techOverlay.classList.remove('hidden');
}

function closeTechTree(): void {
  techOverlay.classList.add('hidden');
}

techTreeBtn.addEventListener('click', openTechTree);
techCloseBtn.addEventListener('click', closeTechTree);
techOverlay.addEventListener('click', (e) => {
  if (e.target === techOverlay) closeTechTree();
});

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
  if (multiplayerMode && state.currentPlayerIndex !== myPlayerSlot) return;
  const hex = canvasEventToHex(clientX, clientY);
  const currentPlayer = getCurrentPlayer(state);

  // ── Unit mode: try attack ──
  if (state.selectionMode === 'unit' && state.attackHexes.some(h => hexEqual(h, hex))) {
    sendOrCall({ type: 'action_attack', targetPos: hex }, () => {
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
      }
    });
    return;
  }

  // ── Build teleport mode: place portals (UI is always local, only final action is sent) ──
  if (buildingTeleport) {
    const bt = buildingTeleport;
    if (state.buildHexes.some(h => hexEqual(h, hex))) {
      if (bt.phase === 1) {
        bt.firstPos = { ...hex };
        bt.phase = 2;
        state.buildHexes = getValidTeleportHexesForOtherTemples(state, bt.templeId);
        render();
        return;
      } else if (bt.phase === 2 && bt.firstPos) {
        const firstPos = bt.firstPos;
        const templeId = bt.templeId;
        cancelBuildTeleport();
        sendOrCall({ type: 'action_build_teleport', templeIdA: templeId, posA: firstPos, posB: hex }, () => {
          const placed = buildTeleportPair(state, templeId, firstPos, hex);
          if (placed) logCombat(`Built teleport portal pair for ${TELEPORT_BUILD_COST}⚡`);
        });
        return;
      }
    } else {
      cancelBuildTeleport();
      render();
      return;
    }
  }

  // ── Unit mode: try move ──
  if (state.selectionMode === 'unit' && state.moveHexes.some(h => hexEqual(h, hex))) {
    sendOrCall({ type: 'action_move', dest: hex }, () => {
      const moveResult = moveUnit(state, hex);
      if (moveResult.moved) {
        const temple = getTempleAt(state, hex);
        if (temple && temple.ownerId !== currentPlayer.id) {
          logCombat(`Moved onto temple at (${hex.q},${hex.r}) — capture next turn!`);
        } else {
          logCombat(`Moved to (${hex.q}, ${hex.r})`);
        }
      }
    });
    return;
  }

  // ── Select unit or temple ──
  const unit = getUnitAt(state, hex);
  if (unit && unit.playerId === currentPlayer.id) {
    sendOrCall({ type: 'action_select_unit', unitId: unit.id }, () => selectUnit(state, unit.id));
    return;
  }

  const temple = getTempleAt(state, hex);
  if (temple && temple.ownerId === currentPlayer.id && !getUnitAt(state, hex)) {
    sendOrCall({ type: 'action_select_temple', templeId: temple.id }, () => selectTemple(state, temple.id));
    return;
  }

  // Deselect
  if (buildingTeleport) cancelBuildTeleport();
  sendOrCall({ type: 'action_deselect' }, () => deselectAll(state));
}

// ── Spawn buttons ──
function handleSpawnBtn(type: UnitType): void {
  if (state.selectionMode !== 'temple' || !state.selectedTempleId) return;
  if (!canAfford(state, type)) return;
  const templeId = state.selectedTempleId;
  sendOrCall({ type: 'action_spawn', templeId, unitType: type }, () => {
    if (spawnUnit(state, templeId, type)) {
      logCombat(`Spawned ${type} for ${UNIT_COSTS[type]} aura`);
      const temple = state.temples.find(t => t.id === templeId);
      if (temple) {
        const newUnit = getUnitAt(state, temple.pos);
        if (newUnit) selectUnit(state, newUnit.id);
      }
    }
  });
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
  const templeId = state.selectedTempleId;
  const temple = state.temples.find(t => t.id === templeId);
  if (!temple) return;
  const prevLevel = temple.level;
  sendOrCall({ type: 'action_upgrade_temple', templeId }, () => {
    if (upgradeTemple(state, templeId)) {
      logCombat(`Temple upgraded Lv.${prevLevel}→${temple.level}!`);
    }
  });
});

// ── Capture button ──
captureBtn.addEventListener('click', () => {
  if (state.selectionMode !== 'unit' || !state.selectedUnitId) return;
  const unit = state.units.find(u => u.id === state.selectedUnitId);
  if (!unit) return;
  const temple = canCaptureTemple(state, unit);
  if (!temple) return;
  const pos = temple.pos;
  sendOrCall({ type: 'action_capture' }, () => {
    captureTemple(state, unit, temple);
    logCombat(`Captured temple at (${pos.q},${pos.r})!`);
  });
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
  if (multiplayerMode && state.currentPlayerIndex !== myPlayerSlot) return;
  if (buildingTeleport) cancelBuildTeleport();
  if (multiplayerMode && mpClient) {
    mpClient.endTurn();
    return;
  }
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
