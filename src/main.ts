import { GameState, UnitType, HexCoord, UNIT_COSTS, SUPPORT_RANGE, TECH_NODES, TechId, TELEPORT_BUILD_COST, UnitStats, Player, PLAYER_COLORS, RULES_VERSION, FactionId } from './types';
import { SITE_ESTABLISH_COST, AGRAR_FARM_COST, FARM_SLOTS_PER_CITY, TEMPLE_DEVOTION_COST, TEMPLE_DEVOTION_MAX_LEVEL } from './factions';
import { hexEqual, hexKey } from './hex';
import { Renderer3D } from './renderer3d';
import {
  createGameState,
  getCurrentPlayer,
  getUnitAt,
  getStrategicSiteAt,
  selectUnit,
  selectSite,
  deselectAll,
  moveUnit,
  attackUnit,
  canStartFounding,
  startFounding,
  attackStructure,
  getStructureAt,
  getOwnedStructures,
  getPlayerCapital,
  canDestroyUnit,
  destroyUnit,
  spawnUnit,
  endTurn,
  calculateEncirclement,
  getEffectiveDefense,
  getEffectiveAttack,
  getEffectiveRange,
  getCurrentPlayerVisible,
  getPlayerVisible,
  canAfford,
  getPopulationCap,
  getPopulationCount,
  HEALER_HEAL_AMOUNT,
  DAMAGE_BOOST_AMOUNT,
  RANGE_BOOST_AMOUNT,
  getPlayerIncome,
  getUnlockedUnits,
  canResearch,
  researchTech,
  UNIT_STATS,
  canBuildTeleportPair,
  buildTeleportPair,
  getValidTeleportHexes,
  getValidTeleportHexesForOtherTemples,
  getTeleportAt,
  canBuildFarm,
  buildFarm,
  getValidFarmHexes,
  getCityFarms,
  canBuyDevotion,
  buyDevotion,
  isFoundingRound,
  isAwaitingFactionReveal,
  chooseFaction,
  founderDisplayName,
  unitDisplayName,
  getUnitCost,
} from './game';
import { getUnitThumbnail, getPortalThumbnail } from './unitThumbnails';
import { runAITurn, runHardAITurn } from './ai';
import { MultiplayerClient } from './multiplayer';
import { serialize, deserialize, SerializedGameState, IncompatibleRulesVersionError } from './serializer';
import type { ServerMessage } from './protocol';

// ── Unit artwork (bundled by Vite) — same sprites the board renderer uses ──
import warriorImg from './assets/units/warrior/warrior_standing.png';
import archerImg from './assets/units/archer/archer_standing.png';
import catapultImg from './assets/units/catapult/catapult_standing.png';
import horseriderImg from './assets/units/horserider/horserider_standing.png';
import heavyknightImg from './assets/units/heavyknight/heavyknight_standing.png';
import spearsmanImg from './assets/units/spearsman/spearsman_standing.png';
import healerImg from './assets/units/healer/healer_standing.png';
import damageBoosterImg from './assets/units/damagebooster/damagebooster_standing.png';
import rangeBoosterImg from './assets/units/rangebooster/rangebooster_standing.png';

const UNIT_ART: Record<UnitType, string> = {
  warrior:      warriorImg,
  archer:       archerImg,
  catapult:     catapultImg,
  horserider:   horseriderImg,
  heavyknight:  heavyknightImg,
  spearsman:    spearsmanImg,
  healer:       healerImg,
  damageBooster: damageBoosterImg,
  rangeBooster:  rangeBoosterImg,
  // Placeholder — Founder/Builder/Acolyte has no dedicated art yet (§70 asset
  // fallback policy). Reuses the Warrior thumbnail; it's never recruitable via
  // the build-card UI anyway (starts on the board, converts in place).
  founder:      warriorImg,
};

const AI_DELAY_MS = 600;

// Per-slot controller kind for the current LOCAL game (index === player slot).
// 'human' = a local seat, 'normal'/'hard' = an AI seat of that difficulty. This
// generalizes the old single "AI is slot 1" assumption to N players with any mix
// of humans and AIs (1 human + 3 AI, hotseat N humans, etc.).
type ControllerKind = 'human' | 'normal' | 'hard';
let controllers: ControllerKind[] = ['human', 'normal'];

// Is the given local slot controlled by an AI? (Never true in online play — the
// server is authoritative there and no local AI runs.)
function isAISlot(idx: number): boolean {
  return !multiplayerMode && controllers[idx] !== undefined && controllers[idx] !== 'human';
}

// ── Settings defaults (snapshot at startup for reset) ──
const UNIT_STATS_DEFAULT: Record<UnitType, UnitStats> = Object.fromEntries(
  (Object.keys(UNIT_STATS) as UnitType[]).map(k => [k, { ...UNIT_STATS[k] }])
) as Record<UnitType, UnitStats>;
const UNIT_COSTS_DEFAULT: Record<UnitType, number> = { ...UNIT_COSTS };

let gameStarted = false;
let multiplayerMode = false;
let spectatorMode = false;
let myPlayerSlot = 0;
let mpClient: MultiplayerClient | null = null;

// Optimistic-research rollback snapshot (MP only). Set when a research purchase
// is applied locally before the server confirms; cleared on the next authoritative
// state_update, or restored if the server rejects the action.
let researchRollback: SerializedGameState | null = null;

// After spawning in MP we don't know the server-assigned unit id, so remember the
// temple we spawned from and auto-select whatever unit lands on it in the next
// state_update (mirrors the local path's spawn→select for instant move range).
let pendingSpawnSelectTempleId: string | null = null;

// Hot-seat hand-off: true while the opaque privacy curtain is up between two local
// human seats (see doEndTurn / dismissHandoff). Never set in vs-AI or online games.
let handoffPending = false;

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement;

let state: GameState = createGameState();
const renderer = new Renderer3D(canvas);
renderer.init(state.mapRadius);
// Debug-only getters for automated verification of touch camera controls.
(window as any).__cam = () => renderer.cameraDebug();
(window as any).__tinted = () => renderer.tintedUnitCount();
(window as any).__sel = () => ({
  mode: state.selectionMode,
  siteId: state.selectedSiteId,
  unitId: state.selectedUnitId,
});
(window as any).__own = () => {
  const myId = state.players[myPlayerSlot]?.id;
  return {
    structures: getOwnedStructures(state, myId ?? -1).map(s => ({ id: s.id, ...renderer.projectHex(s.pos) })),
    units: state.units.filter(u => u.playerId === myId).map(u => ({ id: u.id, ...renderer.projectHex(u.pos) })),
  };
};
// End Turn / Research are rendered as Three.js HUD buttons (bottom-centre) with
// 3D icons instead of text: a forward arrow for End Turn, a flask for Research.
renderer.setHudButtons([
  { id: 'endTurn', label: 'End Turn', icon: 'endturn' },
  { id: 'research', label: 'Research', icon: 'flask' },
  { id: 'found', label: 'Found', icon: 'temple', price: true },
  // Contextual: shown only when a living own unit is selected on your turn. The
  // 'price' strip doubles as the two-tap "Sure?" confirm label.
  { id: 'destroy', label: 'Destroy', icon: 'skull', price: true },
]);

// ── UI elements ──
const menuOverlay = document.getElementById('menuOverlay')!;
const menuVsAI = document.getElementById('menuVsAI')!;
const menu2P = document.getElementById('menu2P')!;
const menuBtn = document.getElementById('menuBtn')!;
const menuContinueBtn = document.getElementById('menuContinue') as HTMLButtonElement;
const turnInfoEl = document.getElementById('turnInfo')!;
// The subtitle line was removed from the DOM; keep a detached stub so the many
// `unitInfoEl.textContent = …` assignments below stay harmless no-ops.
const unitInfoEl = document.getElementById('unitInfo') ?? document.createElement('div');
const auraInfoEl = document.getElementById('auraInfo')!;
const popInfoEl = document.getElementById('popInfo')!;
const endTurnBtn = document.getElementById('endTurnBtn')!;
const restartBtn = document.getElementById('restartBtn') as HTMLButtonElement;
const spawnBar = document.getElementById('spawnBar')!;
const spawnBarWrap = document.getElementById('spawnBarWrap')!;
const spawnArrowLeft = document.getElementById('spawnArrowLeft') as HTMLButtonElement;
const spawnArrowRight = document.getElementById('spawnArrowRight') as HTMLButtonElement;
const captureBtn = document.getElementById('captureBtn')!;
const buildTeleportBtn = document.getElementById('teleportBtn')!;
const economyBtn = document.getElementById('economyBtn') as HTMLButtonElement;

// Two-tap confirm guard for the destroy/disband HUD slab. Holds the unit id the
// slab is currently "armed" for; re-armed only when the SAME unit is tapped
// twice. Any selection change / re-render for a different unit resets it.
let destroyArmedUnitId: string | null = null;

// Show the contextual destroy slab for `unitId`, reflecting the current armed
// state (red tint + "Sure?" strip when armed).
function syncDestroySlab(unitId: string): void {
  const armed = destroyArmedUnitId === unitId;
  renderer.updateHudButton('destroy', true); // always tappable while shown
  renderer.setHudButtonArmed('destroy', armed);
  renderer.setHudButtonPrice('destroy', armed ? 'Sure?' : '');
  renderer.setHudButtonVisible('destroy', true);
}

function hideDestroySlab(): void {
  renderer.setHudButtonArmed('destroy', false);
  renderer.setHudButtonPrice('destroy', '');
  renderer.setHudButtonVisible('destroy', false);
}
const logToggle = document.getElementById('logToggle')!;
const logArrow = document.getElementById('logArrow')!;
const combatLog = document.getElementById('combatLog')!;
const techTreeBtn = document.getElementById('techTreeBtn')!;
const techOverlay = document.getElementById('techOverlay')!;
const techCloseBtn = document.getElementById('techCloseBtn')!;
const techBody = document.getElementById('techBody')!;
const techAuraInfo = document.getElementById('techAuraInfo')!;
const opponentTurnOverlay = document.getElementById('opponentTurnOverlay')!;
const opponentTurnCardEl = document.getElementById('opponentTurnCard')!;
const opponentTurnNameEl = document.getElementById('opponentTurnName')!;
const waitingIndicator = document.getElementById('waitingIndicator')!;
const waitingIndicatorName = document.getElementById('waitingIndicatorName')!;
const toastStack = document.getElementById('toastStack')!;
const factionChoiceOverlay = document.getElementById('factionChoiceOverlay')!;
const fcTitle = document.getElementById('fcTitle')!;
const fcAgrarCard = document.getElementById('fcAgrarCard')!;
const fcTempleCard = document.getElementById('fcTempleCard')!;
const fcLockedNote = document.getElementById('fcLockedNote')!;
const foundingRoundBanner = document.getElementById('foundingRoundBanner')!;

// ── Toast notifications (carved-stone chips, auto-dismiss, stack) ──
function showToast(msg: string, kind: 'good' | 'bad' | 'neutral' = 'neutral'): void {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'good' ? ' good' : kind === 'bad' ? ' bad' : '');
  el.textContent = msg;
  toastStack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => el.remove(), 320);
  }, 3500);
}

// Strategic-site state snapshot, diffed each render() so founding completion/
// failure/destruction (which can happen silently — resolved at the start of
// the founding player's round, or via combat, on any player's turn, locally
// or via a server state update) always raises a toast from the local
// viewer's perspective. Replaces the old instant-capture toast (§7-11).
let prevSiteStates = new Map<string, string>();
function snapshotSiteStates(): void {
  prevSiteStates = new Map(state.strategicSites.map(s => [s.id, s.state]));
}
function checkTempleCaptureToasts(): void {
  // Treat a changed site set (new game / first render) as a silent (re)init.
  const sameBoard = prevSiteStates.size === state.strategicSites.length
    && state.strategicSites.every(s => prevSiteStates.has(s.id));
  if (!sameBoard) { snapshotSiteStates(); return; }

  const viewer = viewerPlayerSlot();
  const nameOf = (id: number | null): string =>
    id === null ? 'Neutral' : (state.players[id]?.name ?? `Player ${id + 1}`);

  for (const s of state.strategicSites) {
    const prev = prevSiteStates.get(s.id)!;
    if (prev === s.state) continue;
    if (s.state === 'city' || s.state === 'temple') {
      const isMine = viewer !== null && s.ownerId === viewer;
      showToast(isMine ? `You founded a ${s.state}` : `${nameOf(s.ownerId)} founded a ${s.state}`, isMine ? 'good' : undefined);
    } else if (s.state === 'ruins' && (prev === 'city' || prev === 'temple')) {
      showToast('A structure was reduced to Ruins');
    } else if ((s.state === 'neutral' || s.state === 'ruins') && (prev === 'foundingCity' || prev === 'foundingTemple')) {
      showToast('A founding attempt failed', 'bad');
    }
  }
  snapshotSiteStates();
}
const myPlayerBadge = document.getElementById('myPlayerBadge')!;
const settingsBtn = document.getElementById('settingsBtn')!;
const settingsOverlay = document.getElementById('settingsOverlay')!;
const settingsCloseBtn = document.getElementById('settingsCloseBtn')!;
const settingsBody = document.getElementById('settingsBody')!;
const settingsResetBtn = document.getElementById('settingsResetBtn')!;

// The per-unit stat editor is a balancing/dev tool, not a player feature. It is
// gated behind ?debug=1: the gear chip stays hidden and openSettings() is a
// no-op in the default build.
const DEBUG = new URLSearchParams(location.search).has('debug');
// .hud-gear is display:none in CSS; reveal it (as a slab chip) only in debug.
if (DEBUG) settingsBtn.style.display = 'inline-flex';

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
const lobbyGameListEl = document.getElementById('lobbyGameListEl')!;
const lobbyRefreshGamesBtn = document.getElementById('lobbyRefreshGamesBtn')!;
const spectatorBanner = document.getElementById('spectatorBanner')!;
const spectatorInfo = document.getElementById('spectatorInfo')!;
const lobbySetup = document.getElementById('lobbySetup')!;
const playerListEl = document.getElementById('playerList')!;

function showLobbyPanel(panel: 'main' | 'login' | 'rooms' | 'waiting' | 'setup'): void {
  lobbyMain.classList.toggle('hidden', panel !== 'main');
  lobbyLogin.classList.toggle('hidden', panel !== 'login');
  lobbyRoomListPanel.classList.toggle('hidden', panel !== 'rooms');
  lobbyWaiting.classList.toggle('hidden', panel !== 'waiting');
  lobbySetup.classList.toggle('hidden', panel !== 'setup');
  if (panel === 'main') updateContinueButton(); // reflect any saved local game
  if (panel === 'setup') renderSetupSlots();
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

// After a MP spawn, select the unit the server placed on the flagged temple so
// its movement range shows immediately — matching the local spawn→select flow.
// Also nudges the server's selection so a follow-up move validates against it.
function maybeAutoSelectSpawned(): void {
  if (!pendingSpawnSelectTempleId || !multiplayerMode || spectatorMode) { pendingSpawnSelectTempleId = null; return; }
  const structureId = pendingSpawnSelectTempleId;
  pendingSpawnSelectTempleId = null;
  if (state.currentPlayerIndex !== myPlayerSlot) return;   // not my turn anymore
  const structure = getOwnedStructures(state, myPlayerSlot).find(s => s.id === structureId);
  const unit = structure ? getUnitAt(state, structure.pos) : null;
  if (unit && unit.playerId === myPlayerSlot && state.selectedUnitId !== unit.id) {
    selectUnit(state, unit.id);                                     // local: instant range
    mpClient?.sendAction({ type: 'action_select_unit', unitId: unit.id }); // keep server in sync
  }
}

// Apply an authoritative server state, tweening any position changes the local
// player can legitimately see (same eased path local play uses) instead of
// teleporting units. The server sends per-action updates to the ACTING player, so
// our own moves animate step-by-step; an opponent's moves are reconciled from the
// single end-of-turn update (units slide from their last-seen tile to the new one).
//
// Fog safety: we only animate a unit when its OLD tile was visible to us (or it's
// our own unit). A unit emerging from the fog just appears at its new tile — we
// never draw a slide out of a hidden origin, so no hidden disposition leaks.
function applyStateWithAnimation(newState: GameState): void {
  const viewer = renderViewerSlot();
  if (gameStarted && !spectatorMode && multiplayerMode && viewer !== undefined) {
    const prev = state;
    const prevVisible = getPlayerVisible(prev, viewer);
    const prevById = new Map(prev.units.map(u => [u.id, u]));
    for (const u of newState.units) {
      if (u.hp <= 0) continue;
      const old = prevById.get(u.id);
      if (!old || old.hp <= 0 || hexEqual(old.pos, u.pos)) continue;
      const mine = u.playerId === viewer;
      if (mine || prevVisible.has(hexKey(old.pos))) {
        renderer.startMoveAnimation(u.id, old.pos);
      }
    }
  }
  state = newState;
}

// ── Multiplayer event handler ──

function handleMultiplayerEvent(event: ServerMessage): void {
  try {
    handleMultiplayerEventInner(event);
  } catch (err) {
    if (err instanceof IncompatibleRulesVersionError) {
      // The server was updated to a new ruleset mid-session (stale tab). Fail
      // cleanly instead of leaving the UI in a half-deserialized, broken state.
      logCombat('This game used an older ruleset and can no longer be displayed. Please reload the page.');
      alert('This game used an older, incompatible ruleset. Please reload the page.');
      return;
    }
    throw err;
  }
}

function handleMultiplayerEventInner(event: ServerMessage): void {
  switch (event.type) {
    case 'logged_in': {
      lobbyLoginStatus.textContent = '';
      lobbyWelcomeMsg.textContent = `Logged in as ${event.username}`;
      showLobbyPanel('rooms');
      mpClient!.listRooms();
      mpClient!.listGames();
      break;
    }
    case 'error': {
      lobbyLoginStatus.textContent = event.message;
      lobbyLoginStatus.className = 'lobby-status err';
      break;
    }
    case 'room_created': {
      lobbyRoomCode.textContent = event.roomId;
      lobbyWaitingStatus.textContent = event.expectedPlayers > 2
        ? `Waiting for players… 1/${event.expectedPlayers} joined`
        : 'Waiting for opponent to join…';
      showLobbyPanel('waiting');
      break;
    }
    case 'room_waiting': {
      lobbyRoomCode.textContent = event.roomId;
      lobbyWaitingStatus.textContent = `Waiting for players… ${event.joined}/${event.expected} joined`;
      showLobbyPanel('waiting');
      break;
    }
    case 'room_list': {
      const rooms = event.rooms ?? [];
      lobbyRoomListEl.innerHTML = '';
      if (rooms.length === 0) {
        lobbyRoomListEl.innerHTML = '<div style="color:#556;font-size:12px;padding:4px">No open rooms</div>';
      }
      for (const room of rooms) {
        const item = document.createElement('div');
        item.className = 'lobby-room-item';
        const size = room.expectedPlayers > 2
          ? ` <span style="color:#89a">[${room.joinedPlayers}/${room.expectedPlayers}]</span>`
          : '';
        item.innerHTML = `<span>${room.id} — ${room.player1Name}${size}</span>`;
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
      cancelAITurn();
      myPlayerSlot = event.playerSlot;
      multiplayerMode = true;
      controllers = [];  // online: server-authoritative, no local AI
      state = deserialize(event.state);
      snapshotSiteStates();   // fresh baseline so no stale capture toasts fire
      renderer.init(state.mapRadius);
      gameStarted = true;
      buildingTeleport = null;
      buildingFarm = null;
  handoffPending = false;
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
      researchRollback = null;   // authoritative state supersedes any optimistic research
      applyStateWithAnimation(deserialize(event.state)); // tween visible moves, don't teleport
      maybeAutoSelectSpawned();  // auto-select a freshly-spawned unit (task: instant range)
      // If the tech tree is open (view-only browsing during the opponent's turn),
      // re-render it so node clickability tracks whose turn it now is.
      if (!techOverlay.classList.contains('hidden')) renderTechTree();
      render();
      logCombat(event.lastAction);
      break;
    }
    case 'action_error': {
      // If an optimistic research purchase was rejected, roll it back so the UI
      // matches the server. (Card gating makes this path rare — a desync only.)
      if (researchRollback) {
        state = deserialize(researchRollback);
        researchRollback = null;
        if (!techOverlay.classList.contains('hidden')) renderTechTree();
        render();
      }
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
    case 'game_list': {
      const games = event.games ?? [];
      lobbyGameListEl.innerHTML = '';
      if (games.length === 0) {
        lobbyGameListEl.innerHTML = '<div style="color:#556;font-size:12px;padding:4px">No active games</div>';
      }
      for (const game of games) {
        const item = document.createElement('div');
        item.className = 'lobby-room-item';
        const statusLabel = game.status === 'done' ? ' (finished)' : '';
        const specLabel = game.spectatorCount > 0 ? ` [${game.spectatorCount} watching]` : '';
        item.innerHTML = `<span>${game.player1Name} vs ${game.player2Name}${statusLabel}${specLabel}</span>`;
        const btn = document.createElement('button');
        btn.textContent = 'Watch';
        btn.addEventListener('click', () => {
          mpClient!.spectateGame(game.gameId);
        });
        item.appendChild(btn);
        lobbyGameListEl.appendChild(item);
      }
      break;
    }
    case 'spectate_start': {
      cancelAITurn();
      spectatorMode = true;
      multiplayerMode = true;
      controllers = [];  // online: server-authoritative, no local AI
      state = deserialize(event.state);
      snapshotSiteStates();   // fresh baseline so no stale capture toasts fire
      renderer.init(state.mapRadius);
      gameStarted = true;
      buildingTeleport = null;
      buildingFarm = null;
  handoffPending = false;
      hideMenu();
      closeTechTree();
      combatLog.innerHTML = '';
      spectatorBanner.style.display = 'block';
      spectatorInfo.textContent = `${event.player1Name} vs ${event.player2Name}`;
      logCombat(`--- Spectating: ${event.player1Name} vs ${event.player2Name} ---`);
      render();
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
  spectatorMode = false;
  spectatorBanner.style.display = 'none';
  showLobbyPanel('main');
});

lobbyLoginBtn.addEventListener('click', async () => {
  const username = lobbyUsernameInput.value.trim();
  if (!username) return;
  lobbyLoginStatus.textContent = 'Connecting…';
  lobbyLoginStatus.className = 'lobby-status';

  // VITE_WS_URL lets you point at a separately-hosted server (e.g. Railway/Render).
  // Falls back to same-origin under the app's base path (BASE_URL ends in '/'),
  // so it works at root ('/ws') and under a sub-path mount ('/game/ws').
  const wsScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = (import.meta.env.VITE_WS_URL as string | undefined) ??
    `${wsScheme}://${window.location.host}${import.meta.env.BASE_URL}ws`;

  if (!mpClient) {
    mpClient = new MultiplayerClient(wsUrl, handleMultiplayerEvent);
  }
  try {
    await mpClient.connect();
    mpClient.login(username);
  } catch {
    lobbyLoginStatus.textContent = 'Could not connect to server';
    lobbyLoginStatus.className = 'lobby-status err';
    mpClient.disconnect();
    mpClient = null;
  }
});

lobbyUsernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') lobbyLoginBtn.click();
});

// Online rooms are 1v1 only (the Asymmetric Tribes redesign is a 2-player game).
lobbyCreateRoomBtn.addEventListener('click', () => {
  mpClient!.createRoom(2);
});

lobbyRefreshBtn.addEventListener('click', () => {
  lobbyRoomStatus.textContent = '';
  mpClient!.listRooms();
  mpClient!.listGames();
});

lobbyRefreshGamesBtn.addEventListener('click', () => {
  mpClient!.listGames();
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

// Disconnect from any live multiplayer game (player or spectator) and reset the
// multiplayer flags. Safe to call when not in a multiplayer game (no-op).
function leaveActiveGame(): void {
  if (mpClient) {
    mpClient.disconnect();
    mpClient = null;
  }
  multiplayerMode = false;
  spectatorMode = false;
}

function showMenu(): void {
  // Pause the local game while the menu is up: cancel any pending AI turn so it
  // can't run (and potentially END the game) behind the menu. Otherwise a
  // scheduled runAI() fires while we're on the menu, silently advancing/finishing
  // the game and leaving the "Continue" CTA stale (offering a game that just
  // ended, or one that's a single AI move from a loss). Re-armed on resume
  // (restoreGame / Esc-to-close both call maybeRunAITurn).
  cancelAITurn();
  saveGame(); // snapshot the local game before leaving to the menu (no-op online)
  menuOverlay.classList.remove('hidden');
  // Clear any turn indicators so they don't linger over the menu.
  handoffPending = false;
  opponentTurnOverlay.classList.add('hidden');
  waitingIndicator.classList.add('hidden');
  renderer.clearCameraKeys(); // drop any held camera keys behind the menu
  if (spectatorMode) {
    // Disconnect spectator and clean up
    leaveActiveGame();
    spectatorBanner.style.display = 'none';
    gameStarted = false;
    // Show action buttons again for next game
    endTurnBtn.style.display = '';
    techTreeBtn.style.display = '';
    if (DEBUG) settingsBtn.style.display = 'inline-flex';
  } else if (multiplayerMode) {
    // Leaving a live multiplayer PLAYER game — disconnect the socket so its
    // state_update can't clobber a subsequent local game.
    leaveActiveGame();
  }
  if (!gameStarted) showLobbyPanel('main');
  // Refresh the Continue CTA every time the menu opens — including mid-game,
  // where showLobbyPanel('main') is skipped (gameStarted is true) but the main
  // menu panel is still what's shown over the board.
  updateContinueButton();
}

function hideMenu(): void {
  menuOverlay.classList.add('hidden');
}

// ── Save / resume (LOCAL modes only) ──────────────────────────────────────
// Persist the logical game state to localStorage so a player can leave to the
// menu (or reload) and resume vs AI / vs Hard AI / 2P exactly where they left
// off. Online play is server-authoritative and is never saved here.
const SAVE_KEY = 'bs:savedGame:v1';
interface SavedGame {
  v: 1;
  // Games now store the full per-slot controller layout. Legacy saves that
  // predate N-player support stored `aiEnabled`/`aiDifficulty` for a fixed
  // 2-player game — still honoured via controllersFromSave() below.
  controllers?: ControllerKind[];
  aiEnabled?: boolean;
  aiDifficulty?: 'normal' | 'hard';
  state: SerializedGameState; // full board/units/temples/resources/turn (Sets→arrays)
}

// Reconstruct the controller layout from a save, mapping legacy 2-player saves.
function controllersFromSave(save: SavedGame): ControllerKind[] {
  if (save.controllers && save.controllers.length) return save.controllers;
  const aiKind: ControllerKind = save.aiDifficulty === 'hard' ? 'hard' : 'normal';
  return save.aiEnabled ? ['human', aiKind] : ['human', 'human'];
}

// Best-effort snapshot of the active local game. A finished game clears the
// save so we never "continue" a game that's already over. Never throws.
function saveGame(): void {
  if (!gameStarted || multiplayerMode || spectatorMode) return; // local active only
  try {
    if (state.phase === 'gameOver') { localStorage.removeItem(SAVE_KEY); return; }
    const save: SavedGame = {
      v: 1,
      controllers: [...controllers],
      state: serialize(state),
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch { /* persistence is best-effort — never break gameplay */ }
}

function loadSavedGame(): SavedGame | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const save = JSON.parse(raw) as SavedGame;
    if (!save || save.v !== 1 || !save.state) return null;
    if (!save.controllers && save.aiEnabled === undefined) return null;
    if (save.state.phase === 'gameOver') return null; // don't resume a finished game
    // A save from an older, incompatible ruleset (missing/mismatched
    // rulesVersion) — treat as if there's no save rather than crash on resume.
    if (save.state.rulesVersion !== RULES_VERSION) { localStorage.removeItem(SAVE_KEY); return null; }
    return save;
  } catch { return null; }
}

function hasValidLocalSave(): boolean {
  return loadSavedGame() !== null;
}

// Rebuild the scene + HUD from a saved snapshot, mirroring the start-game path
// (the same renderer.init + render the multiplayer game_start handler uses),
// just seeded from saved state instead of a fresh map.
function restoreGame(): void {
  const save = loadSavedGame();
  if (!save) return;
  cancelAITurn();
  leaveActiveGame();             // resets multiplayer/spectator flags + socket
  spectatorBanner.style.display = 'none';
  controllers = controllersFromSave(save);
  buildingTeleport = null;
  buildingFarm = null;
  handoffPending = false;
  state = deserialize(save.state);
  snapshotSiteStates();   // fresh baseline so no stale capture toasts fire
  renderer.init(state.mapRadius);
  gameStarted = true;
  hideMenu();
  closeTechTree();
  combatLog.innerHTML = '';
  logCombat('--- Resumed saved game ---');
  // Preselect the human's temple unless it's the AI's move to resume.
  if (!isAISlot(state.currentPlayerIndex)) autoSelectTemple();
  render();
  maybeRunAITurn();              // if it was the AI's turn, let it continue
}

// Show the "Continue game" CTA only when a valid local save exists.
function updateContinueButton(): void {
  menuContinueBtn.style.display = hasValidLocalSave() ? 'block' : 'none';
}

// Build a human-readable name for a local seat.
function seatName(kind: ControllerKind, idx: number): string {
  if (kind === 'human') return `Player ${idx + 1}`;
  return kind === 'hard' ? `Hard AI ${idx + 1}` : `AI ${idx + 1}`;
}

// Start a LOCAL game with an arbitrary per-slot controller layout (N players,
// any mix of humans and AIs). This is the single entry point behind the classic
// quick-start buttons AND the custom-setup screen.
function startLocalGame(kinds: ControllerKind[]): void {
  // Cancel any pending AI turn from a prior game before swapping in new state,
  // and disconnect any live multiplayer socket so it can't clobber this game.
  cancelAITurn();
  leaveActiveGame();
  spectatorBanner.style.display = 'none';
  controllers = [...kinds];
  buildingTeleport = null;
  buildingFarm = null;
  handoffPending = false;
  const players = kinds.map((kind, i) => ({
    name: seatName(kind, i),
    color: PLAYER_COLORS[i % PLAYER_COLORS.length]!,
  }));
  state = createGameState(players);
  snapshotSiteStates();   // fresh baseline so no stale capture toasts fire
  renderer.init(state.mapRadius);
  gameStarted = true;
  hideMenu();
  closeTechTree();
  combatLog.innerHTML = '';
  const humans = kinds.filter(k => k === 'human').length;
  const ais = kinds.length - humans;
  logCombat(`--- New Game (${kinds.length} players: ${humans} human, ${ais} AI) ---`);
  logCombat(`${getCurrentPlayer(state).name} goes first.`);
  autoSelectTemple();   // pre-select the human's temple (no-op if an AI moves first)
  // Open the camera centered on the local human's home temple with a slight
  // zoom-in, instead of the default board-center framing.
  const humanSeat = controllers.findIndex(k => k === 'human');
  if (humanSeat >= 0) {
    const homeCapital = getPlayerCapital(state, humanSeat);
    if (homeCapital) renderer.focusOnHex(homeCapital.pos);
  }
  render();
  maybeRunAITurn();     // if an AI won the coin flip, let it take its first turn
}

// Back-compat wrapper for the classic 2-player quick-start buttons.
function startGame(vsAI: boolean, difficulty: 'normal' | 'hard' = 'normal'): void {
  startLocalGame(vsAI ? ['human', difficulty] : ['human', 'human']);
}

menuContinueBtn.addEventListener('click', () => restoreGame());
menuVsAI.addEventListener('click', () => startGame(true, 'normal'));
menu2P.addEventListener('click', () => startGame(false));
(document.getElementById('menuVsHardAI') as HTMLButtonElement).addEventListener('click', () => startGame(true, 'hard'));
menuBtn.addEventListener('click', () => showMenu());

// ── Custom game setup (N players, human/AI mix) ──
const menuCustom = document.getElementById('menuCustom')!;
const setupPlayersCountEl = document.getElementById('setupPlayersCount')!;
const setupPlayersDec = document.getElementById('setupPlayersDec')!;
const setupPlayersInc = document.getElementById('setupPlayersInc')!;
const setupSlotsEl = document.getElementById('setupSlots')!;
const setupInfoEl = document.getElementById('setupInfo')!;
const setupStartBtn = document.getElementById('setupStartBtn')!;
const setupBack = document.getElementById('setupBack')!;

// Working controller layout for the setup screen. Slot 0 defaults to human, the
// rest to normal AI — the classic "1 human vs N AIs" default.
let setupKinds: ControllerKind[] = ['human', 'normal'];

function renderSetupSlots(): void {
  setupPlayersCountEl.textContent = String(setupKinds.length);
  setupSlotsEl.innerHTML = '';
  const KIND_LABELS: [ControllerKind, string][] = [
    ['human', 'Human'], ['normal', 'AI — Normal'], ['hard', 'AI — Hard'],
  ];
  setupKinds.forEach((kind, i) => {
    const row = document.createElement('div');
    row.className = 'setup-slot';
    const swatch = document.createElement('div');
    swatch.className = 'slot-swatch';
    swatch.style.background = PLAYER_COLORS[i % PLAYER_COLORS.length]!;
    const label = document.createElement('div');
    label.className = 'slot-label';
    label.textContent = `Seat ${i + 1}`;
    const sel = document.createElement('select');
    for (const [val, text] of KIND_LABELS) {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = text;
      if (val === kind) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => { setupKinds[i] = sel.value as ControllerKind; updateSetupInfo(); });
    row.append(swatch, label, sel);
    setupSlotsEl.appendChild(row);
  });
  updateSetupInfo();
}

function updateSetupInfo(): void {
  const humans = setupKinds.filter(k => k === 'human').length;
  const ais = setupKinds.length - humans;
  const radius = 6 + Math.max(0, setupKinds.length - 2);
  setupInfoEl.textContent =
    `${humans} human · ${ais} AI — map radius ${radius}, ${setupKinds.length * 2} temples`;
}

menuCustom.addEventListener('click', () => showLobbyPanel('setup'));
setupBack.addEventListener('click', () => showLobbyPanel('main'));
// The Asymmetric Tribes redesign is 1v1 only — seat count is fixed at 2
// (still pick human/AI per seat), so the +/- steppers are inert now.
setupPlayersDec.addEventListener('click', () => {});
setupPlayersInc.addEventListener('click', () => {});
setupStartBtn.addEventListener('click', () => startLocalGame(setupKinds));

// ── Faction choice (end of the Founding Round, §5-6) ──
//
// Local (hotseat/vs-AI) faction secrecy is honor-system only: unlike online
// play (server-authoritative hiding — see gameManager.ts stripHiddenFaction),
// a second local human seat CAN see the first seat's overlay if they look at
// the same screen at the wrong moment. Full hotseat-curtain secrecy for this
// step is a deliberate simplification, not an oversight.

// AI-controlled local seats auto-pick the instant the pause begins — a coin
// flip is fine; this is not a fairness-sensitive decision to model deeply yet.
function maybeAutoChooseFactionForAI(): void {
  if (multiplayerMode || spectatorMode) return;
  if (!isAwaitingFactionReveal(state)) return;
  let changed = false;
  for (let i = 0; i < state.players.length; i++) {
    if (controllers[i] && controllers[i] !== 'human' && state.players[i]?.faction === null) {
      chooseFaction(state, i, Math.random() < 0.5 ? 'agrar' : 'temple');
      changed = true;
    }
  }
  if (changed) render();
}

// Which local seat (if any) should see the picker right now: in multiplayer,
// only the local viewer's own slot; locally, the first human seat that still
// needs to choose (sequential — see the honor-system note above).
function pendingFactionSlot(): number | null {
  if (!isAwaitingFactionReveal(state)) return null;
  if (multiplayerMode) {
    if (spectatorMode) return null;
    return state.players[myPlayerSlot]?.faction === null ? myPlayerSlot : null;
  }
  for (let i = 0; i < state.players.length; i++) {
    if (controllers[i] === 'human' && state.players[i]?.faction === null) return i;
  }
  return null;
}

function submitFactionChoice(faction: FactionId): void {
  const slot = pendingFactionSlot();
  if (slot === null) return;
  if (multiplayerMode) {
    mpClient?.sendAction({ type: 'action', action: 'choose-faction', params: { faction } });
    return;
  }
  chooseFaction(state, slot, faction);
  render();
  maybeAutoChooseFactionForAI();
  maybeRunAITurn(); // in case the reveal just completed and it's actually an AI's move
}

fcAgrarCard.addEventListener('click', () => submitFactionChoice('agrar'));
fcTempleCard.addEventListener('click', () => submitFactionChoice('temple'));

function updateFactionOverlay(): void {
  const slot = pendingFactionSlot();
  if (slot === null) {
    // Still show a brief "locked in, waiting" note for the online player who
    // already chose but the opponent hasn't revealed yet.
    if (!spectatorMode && isAwaitingFactionReveal(state) && multiplayerMode && state.players[myPlayerSlot]?.faction !== null) {
      factionChoiceOverlay.classList.remove('hidden');
      fcTitle.textContent = 'Faction locked in';
      fcAgrarCard.classList.add('hidden');
      fcTempleCard.classList.add('hidden');
      fcLockedNote.classList.remove('hidden');
    } else {
      factionChoiceOverlay.classList.add('hidden');
    }
    return;
  }
  factionChoiceOverlay.classList.remove('hidden');
  fcAgrarCard.classList.remove('hidden');
  fcTempleCard.classList.remove('hidden');
  fcLockedNote.classList.add('hidden');
  fcTitle.textContent = multiplayerMode
    ? 'Choose your civilization'
    : `${state.players[slot]?.name ?? `Player ${slot + 1}`} — choose your civilization`;
}

// ── Render & UI ──

function render(): void {
  maybeAutoChooseFactionForAI();
  updateFactionOverlay();
  foundingRoundBanner.classList.toggle('hidden', !(gameStarted && !spectatorMode && isFoundingRound(state)));
  checkTempleCaptureToasts(); // raise a toast for any temple that changed hands
  if (spectatorMode) {
    // Spectators always see the full board (no fog, no player-specific view)
    renderer.render(state);
    updateUI();
    return;
  }
  if (localPlayerEliminated()) {
    // Eliminated online player watches the whole board (omniscient), like a spectator.
    renderer.render(state, undefined, true);
  } else if (handoffPending) {
    // Hot-seat privacy: the opaque hand-off curtain covers the board, so don't
    // render the next human's perspective behind it (would leak through on dismiss
    // timing). The board is drawn as soon as the curtain is tapped away.
  } else {
    // Always render from the LOCAL viewer's own seat — never the acting player's.
    // During an opponent's turn (AI or remote) this keeps the board on-screen,
    // fog-limited to what the viewer can legitimately see, instead of an opaque
    // curtain. renderViewerSlot() returns the viewer's slot (own units + fog),
    // so an opponent's hidden units/moves stay concealed.
    renderer.render(state, renderViewerSlot());
  }
  updateUI();
  // Persist after every state change in a local game (render() is the chokepoint
  // for all local mutations via sendOrCall + end-turn + AI turns). No-op online.
  saveGame();
}

// Tint the orange/peach gradient title toward the active player's colour while
// keeping the warm carved-stone display look.
function setTurnTitle(text: string, color: string): void {
  turnInfoEl.textContent = text;
  turnInfoEl.style.backgroundImage =
    `linear-gradient(180deg, #ffe0bd 0%, ${color} 55%, ${color} 100%)`;
}

// True while a player's Capital still stands (§11 — permanent until
// destroyed, and destruction already ends the match), so this is always true
// pre-gameOver. Kept as a real check rather than a hardcoded `true` in case a
// future mechanic changes that.
function isPlayerAlive(p: Player): boolean {
  const capital = getPlayerCapital(state, p.id);
  return !!capital && capital.hp > 0;
}

// Dev/testing switch: reveal EVERY player's economy in the HUD (aura · pop/cap).
// OFF by default → fog-of-war: you see only your OWN books; other players keep
// just their name, colour dot and the whose-turn highlight. Turn it on from the
// browser console with EITHER of:
//   localStorage.setItem('bsDevStats', '1')   // persists across reloads
//   window.__bsDevStats = true                // live, current tab only
// Re-read every render so it toggles without a reload. Turn it off with
// localStorage.removeItem('bsDevStats') / window.__bsDevStats = false.
function devStatsEnabled(): boolean {
  try {
    if ((window as any).__bsDevStats === true) return true;
    return localStorage.getItem('bsDevStats') === '1';
  } catch {
    return (window as any).__bsDevStats === true;
  }
}

// A local hot-seat game = 2+ human seats sharing one device. These are the only
// games that keep the opaque hand-off curtain (privacy between humans); vs-AI and
// online games instead show a fog-limited board with a subtle waiting indicator.
function isHotseat(): boolean {
  return !multiplayerMode && !spectatorMode
    && controllers.filter(k => k === 'human').length >= 2;
}

// The seat this client views the board & economy from — its own perspective,
// NEVER the acting player's. Online → the seat we own. Local single-human vs AI →
// the (fixed) human seat, so the board stays on the human's perspective even while
// an AI is thinking. Local hot-seat → whichever human's turn it is. null = none
// (spectator / no human seat), meaning "show the current player" for the board.
function viewerPlayerSlot(): number | null {
  if (spectatorMode) return null;
  if (multiplayerMode) return myPlayerSlot;
  if (isHotseat()) return isAISlot(state.currentPlayerIndex) ? null : state.currentPlayerIndex;
  const human = controllers.indexOf('human');
  return human >= 0 ? human : null;
}

// Same as viewerPlayerSlot() but shaped for renderer.render()'s viewerPlayerId arg
// (undefined = "use current player", used for hot-seat where viewer == current).
function renderViewerSlot(): number | undefined {
  const s = viewerPlayerSlot();
  return s === null ? undefined : s;
}

// The player whose economy this client is allowed to see by default (fog of war).
function localViewerId(): number | null {
  return viewerPlayerSlot();
}

// Per-player status chips: colour dot + name, current player highlighted,
// eliminated players dimmed/struck. Economy numbers (aura · pop/cap) are shown
// only for the LOCAL player by default — opponents' economy is hidden (fog of
// war) unless dev-stats mode is on (see devStatsEnabled) or you're spectating.
function updatePlayerList(): void {
  if (!gameStarted) { playerListEl.innerHTML = ''; return; }
  playerListEl.innerHTML = '';
  const revealAll = devStatsEnabled() || spectatorMode;
  const viewer = localViewerId();
  for (const p of state.players) {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    if (p.id === state.currentPlayerIndex && state.phase !== 'gameOver') chip.classList.add('current');
    if (!isPlayerAlive(p)) chip.classList.add('dead');
    const you = (multiplayerMode && !spectatorMode && p.id === myPlayerSlot) ? ' (you)' : '';
    // Fog of war: economy shown only for your own chip (or everyone in dev/spectator).
    const showStats = revealAll || (viewer !== null && p.id === viewer);
    const statHtml = showStats
      ? `<span class="chip-stat">⚡${p.aura} · ${getPopulationCount(state, p.id)}/${getPopulationCap(state, p.id)}</span>`
      : '';
    chip.innerHTML =
      `<span class="chip-dot" style="background:${p.color}"></span>` +
      `<span>${p.name}${you}</span>` +
      statHtml;
    playerListEl.appendChild(chip);
  }
}

// Single source of truth for "can the local human act right now": their turn, in
// a live game, not spectating. Gates HUD slabs, spawn bar, research, and hex taps
// so online opponent-turn blocking is consistent rather than scattered.
function localHasTurn(): boolean {
  if (spectatorMode || state.phase === 'gameOver') return false;
  return multiplayerMode ? state.currentPlayerIndex === myPlayerSlot : !isAISlot(state.currentPlayerIndex);
}

function updateUI(): void {
  const player = getCurrentPlayer(state);
  updatePlayerList();
  // The persistent "Player X's Turn" label was removed from the top bar; the
  // turn banner now shows only the game-over result (set below). Turn logic is
  // unaffected — `player` is still used for the stat pills + HUD state.
  turnInfoEl.textContent = '';

  // 3D HUD action buttons (End Turn / Research) — shown during an active game;
  // End Turn is enabled only on the local player's turn.
  const myTurn = localHasTurn();
  renderer.setHudVisible(gameStarted && !spectatorMode);
  renderer.updateHudButton('endTurn', myTurn);
  renderer.updateHudButton('research', gameStarted && !spectatorMode && state.phase !== 'gameOver');
  // The 3rd slab starts founding for the selected unit (a Builder/Acolyte
  // standing on a neutral/ruined site — §7-10, replaces the old temple-level
  // slab, there's no more leveling). INVISIBLE unless a unit that can found
  // right now is selected; when shown it displays the establish cost (gold).
  const selUnitForFound = state.selectionMode === 'unit' && state.selectedUnitId
    ? state.units.find(u => u.id === state.selectedUnitId)
    : null;
  const foundCheck = selUnitForFound && myTurn ? canStartFounding(state, selUnitForFound) : null;
  if (foundCheck) {
    renderer.updateHudButton('found', true);
    renderer.setHudButtonPrice('found', `⚡${SITE_ESTABLISH_COST}`);
    renderer.setHudButtonVisible('found', true);
  } else {
    renderer.setHudButtonVisible('found', false); // no founder selected (or can't found here)
  }

  // In spectator mode, hide all action controls
  if (spectatorMode) {
    endTurnBtn.style.display = 'none';
    restartBtn.style.display = 'none';
    setSpawnBarVisible(false);
    captureBtn.style.display = 'none';
    hideDestroySlab();
    buildTeleportBtn.style.display = 'none';
    techTreeBtn.style.display = 'none';
    settingsBtn.style.display = 'none';
    opponentTurnOverlay.classList.add('hidden');
    waitingIndicator.classList.add('hidden');

    updateStatPills(player);

    if (state.phase === 'gameOver') {
      setTurnTitle(state.winner ? `${state.winner.name} Wins!` : 'Draw!', state.winner ? state.winner.color : '#f4863a');
    }
    unitInfoEl.textContent = '';
    return;
  }

  // Stat pills reflect the LOCAL viewer's economy, not the acting player's —
  // otherwise an opponent's aura/pop would leak while they take their turn now
  // that the board is no longer hidden behind an opaque curtain.
  const vSlot = viewerPlayerSlot();
  updateStatPills(vSlot !== null ? (state.players[vSlot] ?? player) : player);

  if (state.phase === 'gameOver') {
    setTurnTitle(state.winner ? `${state.winner.name} Wins!` : 'Draw!', state.winner ? state.winner.color : '#f4863a');
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
      const typeName = unit.type === 'founder'
        ? founderDisplayName(state.players.find(p => p.id === unit.playerId)?.faction)
        : (TYPE_NAMES[unit.type] ?? (unit.type.charAt(0).toUpperCase() + unit.type.slice(1)));
      const enc = calculateEncirclement(state, unit);
      const encStr = enc.attackMultiplier > 1 ? ` | Enc x${enc.attackMultiplier.toFixed(1)}` : '';
      const effDef = getEffectiveDefense(state, unit);
      const effAtk = getEffectiveAttack(state, unit);
      const effRng = getEffectiveRange(state, unit);
      const defStr = effDef > unit.stats.defense ? `${effDef}(⛰+${effDef - unit.stats.defense})` : `${effDef}`;
      const atkStr = effAtk > unit.stats.attack ? `${effAtk}(🔥+${effAtk - unit.stats.attack})` : `${effAtk}`;
      const rngStr = effRng > unit.stats.range ? `${effRng}(+${effRng - unit.stats.range})` : `${effRng}`;
      let supportNote = '';
      if (unit.type === 'healer') supportNote = ` | ✚${HEALER_HEAL_AMOUNT}HP/t (r1 full·r2 half)`;
      if (unit.type === 'damageBooster') supportNote = ` | +${DAMAGE_BOOST_AMOUNT}ATK (r1 full·r2 half)`;
      if (unit.type === 'rangeBooster') supportNote = ` | +${RANGE_BOOST_AMOUNT}RNG (r1)`;
      unitInfoEl.textContent = `${typeName} HP:${unit.hp}/${unit.stats.maxHp} ATK:${atkStr} DEF:${defStr} RNG:${rngStr}${encStr}${supportNote}`;

      const foundable = canStartFounding(state, unit);
      if (foundable) {
        captureBtn.style.display = 'block';
        captureBtn.textContent = `⚒ Found ${foundable.targetState === 'city' ? 'City' : 'Temple'} (⚡${SITE_ESTABLISH_COST})`;
      } else {
        captureBtn.style.display = 'none';
      }

      // Destroy/disband slab — only for the local player's own unit on their turn.
      if (myTurn && canDestroyUnit(state, unit.id)) {
        // Re-render for a different unit disarms the confirm state.
        if (destroyArmedUnitId !== unit.id) destroyArmedUnitId = null;
        syncDestroySlab(unit.id);
      } else {
        destroyArmedUnitId = null;
        hideDestroySlab();
      }

      buildTeleportBtn.style.display = 'none';
    }
  } else if (state.selectionMode === 'site' && state.selectedSiteId) {
    const siteId = state.selectedSiteId;
    const capital = state.capitals.find(c => c.id === siteId);
    const site = capital ? undefined : state.strategicSites.find(s => s.id === siteId);
    const structurePos = capital?.pos ?? site?.pos;
    if (structurePos) {
      const unitOnStructure = getUnitAt(state, structurePos);
      const economyNote = site && site.state === 'city'
        ? ` | 🌾 Farms: ${getCityFarms(state, siteId).length}/${FARM_SLOTS_PER_CITY}`
        : site && site.state === 'temple'
          ? ` | 🕯 Devotion: ${site.devotionLevel}/${TEMPLE_DEVOTION_MAX_LEVEL}`
          : '';
      const label = capital
        ? `Capital HP ${capital.hp}/${capital.maxHp}`
        : `${site!.state === 'city' ? 'City' : 'Temple'} HP ${site!.hp}/${site!.maxHp}${economyNote}`;
      const existingPortals = state.teleportBuildings.filter(t => t.templeId === siteId).length;
      const portalNote = existingPortals > 0 ? ` | ⬡ Portal: ${existingPortals}/1` : '';
      unitInfoEl.textContent = unitOnStructure
        ? `${label} (occupied — clear tile to spawn)${portalNote}`
        : `${label} — Spawn unit${portalNote}`;

      // Build teleport button
      if (canBuildTeleportPair(state, siteId)) {
        buildTeleportBtn.style.display = 'block';
        buildTeleportBtn.classList.toggle('active', buildingTeleport?.templeId === siteId);
        buildTeleportBtn.textContent = buildingTeleport?.templeId === siteId
          ? (buildingTeleport.phase === 1 ? '⬡ Pick hex near this structure…' : '⬡ Pick hex near another structure…')
          : `⬡ Build Portal Pair (${TELEPORT_BUILD_COST}⚡)`;
      } else {
        buildTeleportBtn.style.display = 'none';
        if (buildingTeleport?.templeId === siteId) clearBuildTeleport();
      }

      // Build Farm / Buy Devotion button — Agrar Cities place a physical Farm
      // (hex-picking mode, like teleport); Temple sites buy a Devotion level
      // directly (no hex needed).
      if (myTurn && site && site.state === 'city') {
        const hasHex = getValidFarmHexes(state, siteId).some(h => canBuildFarm(state, siteId, h));
        if (hasHex || buildingFarm?.citySiteId === siteId) {
          economyBtn.style.display = 'block';
          economyBtn.disabled = false;
          economyBtn.classList.toggle('active', buildingFarm?.citySiteId === siteId);
          economyBtn.textContent = buildingFarm?.citySiteId === siteId
            ? '⚑ Pick a hex for the Farm…'
            : `⚑ Build Farm (${AGRAR_FARM_COST}⚡)`;
        } else {
          economyBtn.style.display = 'none';
          if (buildingFarm?.citySiteId === siteId) clearBuildFarm();
        }
      } else if (myTurn && site && site.state === 'temple') {
        economyBtn.style.display = 'block';
        economyBtn.classList.remove('active');
        economyBtn.disabled = !canBuyDevotion(state, siteId);
        economyBtn.textContent = site.devotionLevel >= TEMPLE_DEVOTION_MAX_LEVEL
          ? '🕯 Devotion (max)'
          : `🕯 Buy Devotion (${TEMPLE_DEVOTION_COST}⚡)`;
      } else {
        economyBtn.style.display = 'none';
        if (buildingFarm) clearBuildFarm();
      }
    }
    captureBtn.style.display = 'none';
    destroyArmedUnitId = null;
    hideDestroySlab();
  } else {
    unitInfoEl.textContent = '';
    captureBtn.style.display = 'none';
    destroyArmedUnitId = null;
    hideDestroySlab();
    buildTeleportBtn.style.display = 'none';
    if (buildingTeleport) clearBuildTeleport();
    economyBtn.style.display = 'none';
    if (buildingFarm) clearBuildFarm();
  }

  // Spawn bar — shown whenever an owned temple is selected. When a unit occupies
  // the temple tile the cards are greyed/disabled (spawn is blocked until the
  // tile is cleared) rather than hidden, so the player sees why they can't spawn.
  if (state.selectionMode === 'site' && state.selectedSiteId) {
    setSpawnBarVisible(true);
    updateUnitCards();
  } else {
    setSpawnBarVisible(false);
  }

  updateOpponentTurnOverlay();
  updateMyPlayerBadge();
}

// §11 — a player's Capital is permanent and can't be captured, only
// destroyed, and destruction already ends the match (checkWinCondition). So
// there's no more "eliminated but game continues" state to detect here —
// this is now always false pre-gameOver. Kept as a real check (rather than a
// hardcoded false) in case a future mechanic changes that.
function localPlayerEliminated(): boolean {
  if (!multiplayerMode || spectatorMode || !gameStarted || state.phase !== 'playing') return false;
  const me = state.players[myPlayerSlot];
  if (!me) return false;
  const capital = getPlayerCapital(state, me.id);
  return !capital || capital.hp <= 0;
}

// True while the active turn belongs to someone other than the local human:
// a remote opponent in online play, or the AI in single-player vs-AI (both
// "normal" and "hard"). False in pure hotseat 2-player (no AI, no remote), so
// the curtain never shows there — and false for an eliminated online player, who
// watches the remaining game instead of being frozen behind the curtain.
function isOpponentActive(): boolean {
  if (spectatorMode || state.phase === 'gameOver') return false;
  if (localPlayerEliminated()) return false;
  if (multiplayerMode) return state.currentPlayerIndex !== myPlayerSlot;
  return isAISlot(state.currentPlayerIndex);
}

function updateOpponentTurnOverlay(): void {
  // Two distinct "someone else's turn" states:
  //  • Hot-seat hand-off (2+ humans, one device) → FULL opaque curtain for privacy,
  //    tapped away by the next human when they pick up the device.
  //  • vs-AI / online opponent → NO opaque curtain. The board stays visible,
  //    fog-limited to the viewer's own perspective, with a small non-blocking
  //    "Waiting for {name} to move…" pill so play never feels hidden.
  if (handoffPending) {
    opponentTurnCardEl.innerHTML =
      `<div class="spinner">🎮</div>` +
      `<div class="label">Pass the device to</div>` +
      `<div class="opp-name">${getCurrentPlayer(state).name}</div>` +
      `<div class="sublabel">Tap anywhere to start their turn</div>`;
    opponentTurnOverlay.classList.remove('hidden');
    waitingIndicator.classList.add('hidden');
    return;
  }
  opponentTurnOverlay.classList.add('hidden');
  if (isOpponentActive()) {
    waitingIndicatorName.textContent = getCurrentPlayer(state).name;
    waitingIndicator.classList.remove('hidden');
  } else {
    waitingIndicator.classList.add('hidden');
  }
}

function updateMyPlayerBadge(): void {
  if (!multiplayerMode || !gameStarted) {
    myPlayerBadge.style.display = 'none';
    return;
  }
  if (spectatorMode) {
    myPlayerBadge.style.display = 'inline-block';
    myPlayerBadge.style.color = '#e90';
    myPlayerBadge.textContent = 'Spectator';
    return;
  }
  const me = state.players[myPlayerSlot];
  if (!me) return;
  myPlayerBadge.style.display = 'inline-block';
  if (localPlayerEliminated()) {
    myPlayerBadge.style.color = '#e90';
    myPlayerBadge.textContent = `P${myPlayerSlot + 1} — eliminated (watching)`;
  } else {
    myPlayerBadge.style.color = me.color;
    myPlayerBadge.textContent = `You: P${myPlayerSlot + 1}`;
  }
}

// ── Stat pills (aura income + population) ──
function updateStatPills(player: Player): void {
  const income = getPlayerIncome(state, player.id);
  auraInfoEl.innerHTML =
    `<span class="pill-icon gem-icon"></span>` +
    `<span class="pill-value">${player.aura}</span>` +
    `<span class="pill-sub">(+${income}/t)</span>`;

  const popCap = getPopulationCap(state, player.id);
  const popCount = getPopulationCount(state, player.id);
  popInfoEl.innerHTML =
    `<span class="pill-icon">👥</span>` +
    `<span class="pill-value">${popCount}/${popCap}</span>`;
  popInfoEl.classList.toggle('pop-full', popCount >= popCap);
}

// ── Unit build cards ──
const UNIT_CARD_NAMES: Record<UnitType, string> = {
  warrior:      'Warrior',
  archer:       'Archer',
  catapult:     'Catapult',
  horserider:   'Horserider',
  heavyknight:  'H. Knight',
  spearsman:    'Spearsman',
  healer:       'Healer',
  damageBooster: 'Dmg Boost',
  rangeBooster:  'Rng Boost',
  founder:      'Founder', // not recruitable — see founderDisplayName for the in-game label
};

// Order matches the original spawn bar.
const UNIT_CARD_ORDER: UnitType[] = [
  'warrior', 'archer', 'catapult', 'horserider', 'heavyknight',
  'spearsman', 'healer', 'damageBooster', 'rangeBooster',
];

// One reusable card element per unit type — built once, shown/hidden + updated
// on each render so we never recreate DOM (keeps the create handler wiring stable).
const unitCards = new Map<UnitType, HTMLElement>();

function buildUnitCards(): void {
  for (const type of UNIT_CARD_ORDER) {
    const card = document.createElement('div');
    card.className = 'unit-card disabled';

    const thumb = document.createElement('img');
    thumb.className = 'unit-card-thumb';
    thumb.src = UNIT_ART[type];
    thumb.alt = UNIT_CARD_NAMES[type];
    thumb.draggable = false;

    const name = document.createElement('div');
    name.className = 'unit-card-name';
    name.textContent = UNIT_CARD_NAMES[type];

    const cost = document.createElement('div');
    cost.className = 'unit-card-cost';
    // cost value gets refreshed in updateUnitCards (settings can change it)

    card.append(thumb, name, cost);
    card.addEventListener('click', () => {
      if (card.classList.contains('disabled')) return;
      handleSpawnBtn(type);
    });

    unitCards.set(type, card);
    spawnBar.appendChild(card);
  }
}

// Show/hide the whole spawn-bar (wrapper holds the scroll arrows + tray).
function setSpawnBarVisible(visible: boolean): void {
  spawnBarWrap.style.display = visible ? 'flex' : 'none';
  if (visible) updateSpawnArrows();
}

// Reveal the scroll arrows only when the tray overflows, and disable an arrow
// once the tray is scrolled fully to that end.
function updateSpawnArrows(): void {
  const overflowing = spawnBar.scrollWidth > spawnBar.clientWidth + 1;
  const display = overflowing ? 'flex' : 'none';
  spawnArrowLeft.style.display = display;
  spawnArrowRight.style.display = display;
  if (!overflowing) return;
  const max = spawnBar.scrollWidth - spawnBar.clientWidth;
  spawnArrowLeft.disabled = spawnBar.scrollLeft <= 1;
  spawnArrowRight.disabled = spawnBar.scrollLeft >= max - 1;
}

function scrollSpawnBar(dir: number): void {
  // Page by roughly two card widths so each tap moves a meaningful chunk.
  const delta = Math.max(120, Math.round(spawnBar.clientWidth * 0.7));
  spawnBar.scrollBy({ left: dir * delta, behavior: 'smooth' });
}

spawnArrowLeft.addEventListener('click', () => scrollSpawnBar(-1));
spawnArrowRight.addEventListener('click', () => scrollSpawnBar(1));
spawnBar.addEventListener('scroll', updateSpawnArrows, { passive: true });
window.addEventListener('resize', () => {
  if (spawnBarWrap.style.display !== 'none') updateSpawnArrows();
});

function updateUnitCards(): void {
  const player = getCurrentPlayer(state);
  const unlocked = getUnlockedUnits(state.playerTech[player.id]!, player.faction);
  // A unit standing on the selected structure's tile blocks spawning (can't
  // stack onto an occupied spawn tile) — grey every card while occupied.
  const selStructure = state.selectionMode === 'site' && state.selectedSiteId
    ? getOwnedStructures(state, player.id).find(s => s.id === state.selectedSiteId)
    : undefined;
  const templeOccupied = selStructure ? !!getUnitAt(state, selStructure.pos) : false;
  for (const type of UNIT_CARD_ORDER) {
    const card = unitCards.get(type)!;
    // Match the old build menu: locked units are hidden entirely.
    if (!unlocked.has(type)) {
      card.style.display = 'none';
      continue;
    }
    card.style.display = '';
    const affordable = canAfford(state, type) && !templeOccupied;
    card.classList.toggle('disabled', !affordable);

    // Card art = a 3D render of the unit model, team-tinted to the current
    // player. Regenerated only when the player colour changes (cached otherwise).
    const thumb = card.querySelector('.unit-card-thumb') as HTMLImageElement;
    if (thumb && thumb.dataset.thumbColor !== player.color) {
      try { thumb.src = getUnitThumbnail(type, player.color); thumb.dataset.thumbColor = player.color; }
      catch { /* keep the PNG fallback set in buildUnitCards */ }
    }

    // Faction-flavored name (§37/§38 — e.g. Pikeman vs Spearsman for the same slot).
    const name = card.querySelector('.unit-card-name')!;
    name.textContent = unitDisplayName(type, player.faction);

    // Refresh cost (faction-flavored; base UNIT_COSTS is still editable via
    // the settings panel and used as the fallback pre-reveal).
    const cost = card.querySelector('.unit-card-cost')!;
    cost.innerHTML = `<span class="cost-icon">⚡</span>${getUnitCost(type, player.faction)}`;
  }
  // Visible card count can change as units unlock → recheck overflow/arrows.
  updateSpawnArrows();
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

// Clear teleport-build state WITHOUT triggering a render. Safe to call from
// inside updateUI()/render() (avoids a nested re-entrant render).
function clearBuildTeleport(): void {
  buildingTeleport = null;
  state.buildHexes = [];
}

// User-initiated cancel: clear state and re-render.
function cancelBuildTeleport(): void {
  clearBuildTeleport();
  render();
}

buildTeleportBtn.addEventListener('click', () => {
  if (buildingTeleport) {
    cancelBuildTeleport();
  } else if (state.selectionMode === 'site' && state.selectedSiteId) {
    if (canBuildTeleportPair(state, state.selectedSiteId)) {
      enterBuildTeleport(state.selectedSiteId);
    }
  }
});

// ── Build Farm / Buy Devotion mode (phase 4 economy) ──

interface BuildFarmState {
  citySiteId: string;
}

let buildingFarm: BuildFarmState | null = null;

function enterBuildFarm(citySiteId: string): void {
  buildingFarm = { citySiteId };
  state.buildHexes = getValidFarmHexes(state, citySiteId);
  render();
}

// Clear farm-build state WITHOUT triggering a render — safe from inside render().
function clearBuildFarm(): void {
  buildingFarm = null;
  state.buildHexes = [];
}

function cancelBuildFarm(): void {
  clearBuildFarm();
  render();
}

economyBtn.addEventListener('click', () => {
  if (buildingFarm) {
    cancelBuildFarm();
    return;
  }
  if (state.selectionMode !== 'site' || !state.selectedSiteId) return;
  const siteId = state.selectedSiteId;
  const site = state.strategicSites.find(s => s.id === siteId);
  if (!site) return;
  if (site.state === 'city') {
    if (getValidFarmHexes(state, siteId).some(h => canBuildFarm(state, siteId, h))) {
      enterBuildFarm(siteId);
    }
  } else if (site.state === 'temple') {
    sendOrCall({ type: 'action', action: 'buy-devotion', params: { templeId: siteId } }, () => {
      if (buyDevotion(state, siteId)) logCombat(`Purchased a Devotion level (${TEMPLE_DEVOTION_COST}⚡)`);
    });
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
  founder:      '🔨 Founder',
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
  if (!DEBUG) return;            // unit-stat editor is debug-only (?debug=1)
  renderSettings();
  settingsOverlay.classList.remove('hidden');
  renderer.clearCameraKeys();
}

function closeSettings(): void {
  settingsOverlay.classList.add('hidden');
}

if (DEBUG) settingsBtn.addEventListener('click', openSettings);
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
  appendSection(techBody, 'Unit Unlocks', undefined, unitUnlockNodes, tech, player.aura, player.color);

  // Section 2: Catapult sub-upgrade
  const catapultUpgrade = TECH_NODES.filter(n => n.id === 'catapult_splash');
  appendSection(techBody, 'Catapult Upgrade', undefined, catapultUpgrade, tech, player.aura, player.color);

  // Section 3+: Branches
  const branches = ['movement', 'stat_bonus', 'support'];
  for (const branch of branches) {
    const nodes = TECH_NODES.filter(n => n.branch === branch);
    const meta = BRANCH_META[branch]!;
    appendSection(techBody, meta.title, branch, nodes, tech, player.aura, player.color);
  }
}

// The art a tech card "stands for": the unlocked unit, the teleport portal, or
// the catapult for its splash sub-upgrade. Rendered (team-coloured) the same way
// as the build-card thumbnails, so the tech tree shows the actual game model.
function techNodeArt(node: typeof TECH_NODES[number], color: string): string | null {
  if (node.unitUnlock) return getUnitThumbnail(node.unitUnlock, color);
  if (node.id === 'teleports') return getPortalThumbnail(color);
  if (node.id === 'catapult_splash') return getUnitThumbnail('catapult', color);
  return null;
}

function appendSection(
  container: HTMLElement,
  title: string,
  branch: string | undefined,
  nodes: typeof TECH_NODES,
  tech: { researched: Set<TechId> },
  aura: number,
  playerColor: string,
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

    const artUrl = techNodeArt(node, playerColor);
    const artHtml = artUrl
      ? `<img class="tech-node-art" src="${artUrl}" alt="${node.name}" draggable="false">`
      : '';

    const card = document.createElement('div');
    card.className = `tech-node ${stateClass}`;
    card.innerHTML = `
      ${artHtml}
      <div class="tech-node-name">${node.name}</div>
      <div class="tech-node-cost">Cost: ${node.cost} ⚡</div>
      <div class="tech-node-desc">${node.description}</div>
      <div class="tech-node-status ${statusClass}">${statusText}</div>
    `;

    if (!isResearched && prereqsMet && !branchBlocked && canAffordIt && localHasTurn()) {
      card.addEventListener('click', () => {
        if (!localHasTurn()) return; // view-only on an opponent's turn (server rejects too)
        const applyLocal = (): void => {
          if (researchTech(state, node.id)) {
            logCombat(`Researched: ${node.name} (−${node.cost} ⚡)`);
            renderTechTree();
          }
        };
        if (multiplayerMode && mpClient) {
          // Optimistic: apply the purchase locally for instant feedback (aura
          // pill drops, unit unlocks appear) instead of waiting for the server
          // round-trip. Snapshot first so a (rare) server rejection can roll it
          // back; the authoritative state_update otherwise reconciles it.
          researchRollback = serialize(state);
          applyLocal();
          render();                       // reflect deducted aura / unlocks now
          mpClient.sendAction({ type: 'action_research', techId: node.id });
        } else {
          applyLocal();
          render();
        }
      });
    }

    nodesRow.appendChild(card);
  }

  section.appendChild(nodesRow);
  container.appendChild(section);
}

function openTechTree(): void {
  if (!gameStarted) return;
  if (spectatorMode) return;
  // The tech tree stays openable and browsable even when it's NOT your turn
  // (view-only) — buying a tech is gated to your own turn in renderTechTree.
  renderTechTree();
  techOverlay.classList.remove('hidden');
  renderer.clearCameraKeys();
}

function closeTechTree(): void {
  techOverlay.classList.add('hidden');
}

techTreeBtn.addEventListener('click', openTechTree);
techCloseBtn.addEventListener('click', closeTechTree);
techOverlay.addEventListener('click', (e) => {
  if (e.target === techOverlay) closeTechTree();
});

// ── Temple level-up (3rd HUD slab) ──
// Upgrades the currently-selected temple — same action as the old upgrade
// button. The slab is greyed out by updateUI() unless the upgrade is valid.
// Start founding at the neutral/ruined site the selected unit (a Builder/
// Acolyte) is standing on. Replaces the old temple-upgrade slab — there's no
// more leveling (§7-10).
function doFound(): void {
  if (state.selectionMode !== 'unit' || !state.selectedUnitId) return;
  const unit = state.units.find(u => u.id === state.selectedUnitId);
  if (!unit) return;
  const check = canStartFounding(state, unit);
  if (!check) return;
  sendOrCall({ type: 'action', action: 'found', params: { unitId: unit.id } }, () => {
    if (startFounding(state, unit.id)) {
      logCombat(`Began founding a ${check.targetState} at (${unit.pos.q},${unit.pos.r})`);
    }
  });
}

// ── Canvas click/tap -> game coordinates (raycast onto the 3D board) ──
function canvasEventToHex(clientX: number, clientY: number) {
  return renderer.pickHex(clientX, clientY);
}

function handleHexClick(clientX: number, clientY: number): void {
  if (!gameStarted) return;
  if (spectatorMode) return;
  if (handoffPending) return;   // curtain up — ignore board taps behind it
  if (state.phase === 'gameOver') return;
  if (aiRunning) return;
  if (isAISlot(state.currentPlayerIndex)) return;
  if (multiplayerMode && state.currentPlayerIndex !== myPlayerSlot) return;
  const hex = canvasEventToHex(clientX, clientY);
  if (!hex) return; // clicked off the board
  const currentPlayer = getCurrentPlayer(state);

  // ── Unit mode: try attack ──
  if (state.selectionMode === 'unit' && state.attackHexes.some(h => hexEqual(h, hex))) {
    const attackerId = state.selectedUnitId; // capture before the attack resolves
    if (attackerId) renderer.faceUnitToward(attackerId, hex); // turn to face the target
    if (multiplayerMode && mpClient) {
      mpClient.sendAction({ type: 'action_attack', targetPos: hex });
    } else {
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
      // The 3D renderer spawns a hit explosion wherever a unit's HP dropped
      // (target, splash, AND your unit's revenge damage), driven by render().
      render();
    }
    return;
  }

  // ── Unit mode: try structure attack (Capital/City/Temple) ──
  if (state.selectionMode === 'unit' && state.structureAttackHexes.some(h => hexEqual(h, hex))) {
    const attackerId = state.selectedUnitId;
    if (attackerId) renderer.faceUnitToward(attackerId, hex);
    sendOrCall({ type: 'action', action: 'attack-structure', params: { unitId: attackerId, targetPos: hex } }, () => {
      const result = attackStructure(state, hex);
      if (result) {
        logCombat(`Struck a structure! Dealt ${result.damageDealt} dmg${result.destroyed ? ' (DESTROYED!)' : ''}${result.gameOver ? ' — CAPITAL DOWN, GAME OVER!' : ''}`);
      }
      render();
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

  // ── Build Farm mode: place a Farm hex (UI is always local, only final action is sent) ──
  if (buildingFarm) {
    const citySiteId = buildingFarm.citySiteId;
    if (state.buildHexes.some(h => hexEqual(h, hex))) {
      clearBuildFarm();
      sendOrCall({ type: 'action', action: 'build-farm', params: { templeId: citySiteId, pos: hex } }, () => {
        const built = buildFarm(state, citySiteId, hex);
        if (built) logCombat(`Built a Farm at (${hex.q},${hex.r}) for ${AGRAR_FARM_COST}⚡`);
      });
      return;
    } else {
      cancelBuildFarm();
      render();
      return;
    }
  }

  // ── Unit mode: try move ──
  if (state.selectionMode === 'unit' && state.moveHexes.some(h => hexEqual(h, hex))) {
    sendOrCall({ type: 'action_move', dest: hex }, () => {
      const movingUnit = state.units.find(u => u.id === state.selectedUnitId);
      if (movingUnit) renderer.startMoveAnimation(movingUnit.id, movingUnit.pos);
      const moveResult = moveUnit(state, hex);
      if (moveResult.moved) {
        const site = getStrategicSiteAt(state, hex);
        if (movingUnit?.type === 'founder' && site && (site.state === 'neutral' || site.state === 'ruins')) {
          logCombat(`Moved onto a foundable site at (${hex.q},${hex.r}) — Found available!`);
        } else {
          logCombat(`Moved to (${hex.q}, ${hex.r})`);
        }
      }
    });
    return;
  }

  // ── Select unit or structure ──
  const unit = getUnitAt(state, hex);
  const structureRef = getStructureAt(state, hex);
  const structureId = structureRef
    ? (structureRef.kind === 'capital' ? structureRef.capital.id : structureRef.kind === 'farm' ? structureRef.farm.id : structureRef.site.id)
    : undefined;
  const structureOwner = structureRef
    ? (structureRef.kind === 'capital' ? structureRef.capital.playerId : structureRef.kind === 'farm' ? structureRef.farm.ownerId : structureRef.site.ownerId)
    : null;
  const myUnitHere = unit && unit.playerId === currentPlayer.id;
  const myStructureHere = !!structureId && structureOwner === currentPlayer.id;

  // Own structure with a friendly unit standing on it: tapping toggles
  // structure ⇄ unit so the structure's recruit tray stays reachable even
  // while occupied. First tap surfaces the structure; tap again controls the unit.
  if (myStructureHere && myUnitHere) {
    const structureSelected = state.selectionMode === 'site' && state.selectedSiteId === structureId;
    if (structureSelected) {
      sendOrCall({ type: 'action_select_unit', unitId: unit!.id }, () => selectUnit(state, unit!.id));
    } else {
      sendOrCall({ type: 'action_select_temple', templeId: structureId! }, () => selectSite(state, structureId!));
    }
    return;
  }

  if (myUnitHere) {
    sendOrCall({ type: 'action_select_unit', unitId: unit!.id }, () => selectUnit(state, unit!.id));
    return;
  }

  if (myStructureHere) {
    sendOrCall({ type: 'action_select_temple', templeId: structureId! }, () => selectSite(state, structureId!));
    return;
  }

  // Deselect
  if (buildingTeleport) cancelBuildTeleport();
  if (buildingFarm) cancelBuildFarm();
  sendOrCall({ type: 'action_deselect' }, () => deselectAll(state));
}

// ── Spawn buttons ──
function handleSpawnBtn(type: UnitType): void {
  if (!localHasTurn()) return; // no recruiting on an opponent's turn (online)
  if (state.selectionMode !== 'site' || !state.selectedSiteId) return;
  if (!canAfford(state, type)) return;
  const structureId = state.selectedSiteId;
  // Block spawning onto an occupied structure tile, with feedback.
  const selStructure = getOwnedStructures(state, getCurrentPlayer(state).id).find(s => s.id === structureId);
  if (selStructure && getUnitAt(state, selStructure.pos)) {
    logCombat('Cannot spawn: a unit is standing on the structure');
    return;
  }
  // MP: no local mutation runs, so flag the structure for auto-select once the
  // server echoes back the spawned unit (see the state_update handler).
  if (multiplayerMode) pendingSpawnSelectTempleId = structureId;
  sendOrCall({ type: 'action_spawn', templeId: structureId, unitType: type }, () => {
    try {
      if (spawnUnit(state, structureId, type)) {
        const spawnPlayer = getCurrentPlayer(state);
        logCombat(`Spawned ${unitDisplayName(type, spawnPlayer.faction)} for ${getUnitCost(type, spawnPlayer.faction)} aura`);
        const structure = getOwnedStructures(state, getCurrentPlayer(state).id).find(s => s.id === structureId);
        if (structure) {
          const newUnit = getUnitAt(state, structure.pos);
          if (newUnit) selectUnit(state, newUnit.id);   // show its move range at once
        }
      }
    } catch (e: unknown) {
      logCombat(e instanceof Error ? e.message : 'Cannot spawn unit');
    }
  });
}

// Build the unit-card tray once; clicks are wired per-card to handleSpawnBtn.
buildUnitCards();

// ── Found button (2D fallback for the 3D HUD "found" slab) ──
captureBtn.addEventListener('click', () => doFound());


// ── Tap-to-select ──
// Camera rotate / zoom / pan are handled by the 3D orbit controls (which attach
// their own listeners to the canvas). Here we only turn a *tap* into a hex
// selection — distinguished from an orbit *drag* by total pointer travel, so
// rotating the board doesn't also select a tile. Works for mouse and touch.
let pointerActive = false;
let pointerPrevX = 0;
let pointerPrevY = 0;
let pointerTravel = 0;

canvas.addEventListener('pointerdown', (e) => {
  pointerActive = true;
  pointerPrevX = e.clientX;
  pointerPrevY = e.clientY;
  pointerTravel = 0;
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointerActive) return;
  pointerTravel += Math.abs(e.clientX - pointerPrevX) + Math.abs(e.clientY - pointerPrevY);
  pointerPrevX = e.clientX;
  pointerPrevY = e.clientY;
});

canvas.addEventListener('pointerup', (e) => {
  if (!pointerActive) return;
  pointerActive = false;
  if (pointerTravel < 8) { // a tap, not a drag
    const hud = renderer.hitHudButton(e.clientX, e.clientY);
    if (hud) { handleHudClick(hud); return; } // tapped a 3D HUD button
    handleHexClick(e.clientX, e.clientY);
  }
});

// Dispatch a Three.js HUD button tap to the same handlers as the old buttons.
function handleHudClick(id: string): void {
  if (id === 'endTurn') { if (state.phase !== 'gameOver') doEndTurn(); }
  else if (id === 'research') openTechTree();
  else if (id === 'found') doFound();
  else if (id === 'destroy') doDestroyUnit();
}

// Disband the selected unit, guarded by a two-tap confirm on the HUD slab.
function doDestroyUnit(): void {
  if (state.selectionMode !== 'unit' || !state.selectedUnitId) return;
  const unit = state.units.find(u => u.id === state.selectedUnitId);
  if (!unit || !canDestroyUnit(state, unit.id)) return;

  // First tap arms the slab (red tint + "Sure?"); second tap on the SAME unit
  // executes. No browser confirm() dialog.
  if (destroyArmedUnitId !== unit.id) {
    destroyArmedUnitId = unit.id;
    syncDestroySlab(unit.id);
    return;
  }

  const unitId = unit.id;
  const unitType = unit.type;
  destroyArmedUnitId = null;
  renderer.setHudButtonArmed('destroy', false); // clear red immediately (esp. online round-trip)
  renderer.setHudButtonPrice('destroy', '');
  sendOrCall({ type: 'action_destroy', unitId }, () => {
    destroyUnit(state, unitId);
    logCombat(`Disbanded ${unitType}.`);
  });
}

canvas.addEventListener('pointercancel', () => { pointerActive = false; });

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
function isTypingTarget(e: KeyboardEvent): boolean {
  const ae = e.target as HTMLElement | null;
  return !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
}
document.addEventListener('keydown', (e) => {
  if (isTypingTarget(e)) return;
  if (e.key === 'Escape') {
    if (menuOverlay.classList.contains('hidden')) {
      showMenu();
    } else {
      // Resume in place: re-arm a paused AI turn (no-op if it's the human's turn
      // or the game is over — showMenu() cancels it when the menu opens).
      if (gameStarted) { hideMenu(); maybeRunAITurn(); }
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

// ── Desktop camera keys: Q/E rotate, WASD pan ──
// Continuous motion is applied in the renderer's frame loop; here we just track
// which keys are down. Ignored while typing in a field or with an overlay open.
const CAM_KEY_MAP: Record<string, 'rotL' | 'rotR' | 'panF' | 'panB' | 'panL' | 'panR'> = {
  q: 'rotL', e: 'rotR', w: 'panF', s: 'panB', a: 'panL', d: 'panR',
};
function cameraKeysBlocked(): boolean {
  if (!gameStarted) return true;
  const ae = document.activeElement as HTMLElement | null;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return true;
  if (!menuOverlay.classList.contains('hidden')) return true;
  if (!techOverlay.classList.contains('hidden')) return true;
  if (!settingsOverlay.classList.contains('hidden')) return true;
  return false;
}
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const action = CAM_KEY_MAP[e.key.toLowerCase()];
  if (!action || cameraKeysBlocked()) return;
  renderer.setCameraKey(action, true);
});
window.addEventListener('keyup', (e) => {
  const action = CAM_KEY_MAP[e.key.toLowerCase()];
  if (action) renderer.setCameraKey(action, false); // release even if currently blocked
});
window.addEventListener('blur', () => renderer.clearCameraKeys());

// Tap the hot-seat hand-off curtain to reveal the next player's board.
opponentTurnOverlay.addEventListener('click', () => dismissHandoff());

// ── Combat log toggle ──
let logOpen = false;
logToggle.addEventListener('click', () => {
  logOpen = !logOpen;
  combatLog.classList.toggle('open', logOpen);
  logArrow.textContent = logOpen ? '▼' : '▲';
});

// ── Helpers ──
let aiRunning = false;
let aiTimer: ReturnType<typeof setTimeout> | null = null;

// Cancel any pending AI turn and reset the running flag. Called before a new
// game's state is swapped in so a stale runAI() can't fire on fresh state.
function cancelAITurn(): void {
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
  aiRunning = false;
}

// Pre-select the local human's temple at the start of their turn so the
// unit-build cards are visible by default (prefers an unoccupied temple).
function autoSelectTemple(): void {
  if (spectatorMode || multiplayerMode) return;
  if (state.phase === 'gameOver') return;
  if (isAISlot(state.currentPlayerIndex)) return;
  const me = getCurrentPlayer(state);
  const owned = getOwnedStructures(state, me.id);
  const target = owned.find(s => !getUnitAt(state, s.pos)) ?? owned[0];
  if (target) selectSite(state, target.id);
}

// Schedule the AI's turn when it's the AI's move (also handles AI winning the
// random first-move coin flip at game start).
function maybeRunAITurn(): void {
  if (!aiRunning && state.phase !== 'gameOver' && isAISlot(state.currentPlayerIndex)) {
    aiRunning = true;
    // Clear `aiRunning` BEFORE runAI() runs, not after. runAI() ends by calling
    // maybeRunAITurn() again to chain the next turn; if the guard were still set
    // that re-arm would be suppressed and consecutive AI seats (N-player games
    // with ≥2 AI) would stall behind the turn curtain. runAI() is fully
    // synchronous, so there is no re-entrancy window while the flag is down.
    aiTimer = setTimeout(() => { aiTimer = null; aiRunning = false; runAI(); }, AI_DELAY_MS);
  }
}

function doEndTurn(): void {
  if (spectatorMode) return;
  if (handoffPending) return;   // curtain up — next player hasn't started their turn
  if (aiRunning) return;
  if (multiplayerMode && state.currentPlayerIndex !== myPlayerSlot) return;
  if (buildingTeleport) cancelBuildTeleport();
  if (buildingFarm) cancelBuildFarm();
  if (multiplayerMode && mpClient) {
    mpClient.endTurn();
    return;
  }
  const prevPlayer = getCurrentPlayer(state).name;
  endTurn(state);
  const newPlayer = getCurrentPlayer(state);
  logCombat(`${prevPlayer} ended turn → ${newPlayer.name} (Aura: ${newPlayer.aura})`);
  // Hot-seat privacy: when the device passes from one human seat to another, raise
  // the opaque hand-off curtain and defer selecting/rendering the next player's
  // board until they tap to begin (dismissHandoff). Only for human→human here;
  // AI turns fall through to the fog-limited waiting indicator instead.
  if (isHotseat() && !isAISlot(state.currentPlayerIndex) && state.phase !== 'gameOver') {
    handoffPending = true;
    updateUI();            // raise the curtain (render() would draw the next view behind it)
    return;
  }
  if (!isAISlot(state.currentPlayerIndex)) autoSelectTemple(); // human turn → preselect temple
  render();
  maybeRunAITurn();
}

// Dismiss the hot-seat hand-off curtain: the next human has picked up the device,
// so reveal their board (pre-selecting their temple) from their own perspective.
function dismissHandoff(): void {
  if (!handoffPending) return;
  handoffPending = false;
  autoSelectTemple();
  render();
}

function runAI(): void {
  if (state.phase === 'gameOver' || !isAISlot(state.currentPlayerIndex)) return;

  const playerVisible = getCurrentPlayerVisible(state);

  // Each AI seat runs at its own difficulty; runAITurn/runHardAITurn default the
  // acting player to the current slot, so this drives any AI in an N-player game.
  const actions = controllers[state.currentPlayerIndex] === 'hard' ? runHardAITurn(state) : runAITurn(state);
  for (const action of actions) {
    if (playerVisible.has(hexKey(action.pos))) {
      logCombat(action.description);
    }
  }

  const aiName = getCurrentPlayer(state).name;
  endTurn(state);
  const nextPlayer = getCurrentPlayer(state);
  logCombat(`${aiName} ended turn → ${nextPlayer.name} (Aura: ${nextPlayer.aura})`);
  autoSelectTemple(); // back to the human → preselect their temple
  render();
  maybeRunAITurn();
}

// ── Resize handling ──
window.addEventListener('resize', () => {
  if (gameStarted) render();
});

// ── Initial state: show menu ──
showMenu();
