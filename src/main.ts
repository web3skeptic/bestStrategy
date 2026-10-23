import { GameState, Unit, UnitType, HexCoord, UNIT_COSTS, SUPPORT_RANGE, TECH_NODES, TechId, PlayerTech, TELEPORT_BUILD_COST, UnitStats, Player, PLAYER_COLORS, RULES_VERSION, FactionId, HILL_DEFENSE_BONUS } from './types';
import { SITE_ESTABLISH_COST, AGRAR_FARM_COST, MAX_ACTIVE_FARMS, TEMPLE_UPGRADE_COST, ROAD_COST_PER_HEX, ROAD_PILLAGE_REBUILD_COST, ROAD_SEGMENTS_PER_ACTIVATION, FERTILE_SITE_INCOME, FARM_MIN_SPACING } from './factions';
import { hexEqual, hexKey, hexDistance, hexNeighbors } from './hex';
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
  isOnAgrarHomeGround,
  HOME_GROUND_DEFENSE_BONUS,
  getCurrentPlayerVisible,
  getPlayerVisible,
  canAfford,
  getPopulationCap,
  getPopulationCount,
  getUnitCommandCost,
  getProductionSlots,
  getBusyProductionSlotCount,
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
  canStartFarm,
  startFarm,
  getValidFarmHexes,
  getFarmPlacementResult,
  getAgrarTerritory,
  isSiteCultivationBlocked,
  canStartTempleUpgrade,
  startTempleUpgrade,
  canBuildRoad,
  buildRoadPath,
  getValidRoadHexes,
  getRoadPlacementResult,
  isLegalRoadTile,
  canPillageRoad,
  pillageRoad,
  getRoadAt,
  canClaimFertileSite,
  claimFertileSite,
  isAwaitingFactionReveal,
  chooseFaction,
  founderDisplayName,
  unitDisplayName,
  getUnitCost,
} from './game';
import { getUnitThumbnail } from './unitThumbnails';
import { createMenuScene, MenuScene, MenuPlace } from './menuScene';
import { runAiTurn, difficultyLabel, normalizeDifficulty, AiDifficulty } from './ai';
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
  // Placeholder — Builder/Acolyte has no dedicated art yet (§46 asset
  // fallback policy). Reuses the Warrior thumbnail.
  founder:      warriorImg,
};

const AI_DELAY_MS = 600;

// Per-slot controller kind for the current LOCAL game (index === player slot).
// 'human' = a local seat, 'easy'/'medium'/'hard' = an AI seat of that difficulty. This
// generalizes the old single "AI is slot 1" assumption to N players with any mix
// of humans and AIs (1 human + 3 AI, hotseat N humans, etc.).
type ControllerKind = 'human' | AiDifficulty;
let controllers: ControllerKind[] = ['human', 'medium'];

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

// Online session bookkeeping, used to get back into the same room/game after a
// dropped connection.
let mpRoomId: string | null = null;            // room we're seated (or waiting) in
let mpSpectatingGameId: string | null = null;  // game we're watching
let mpReconnecting = false;                    // logged in again, rejoin still to send
let mpRetryTimer: number | null = null;
let mpRetryCount = 0;

// Instant selection (online): the latest select/deselect applied locally while
// actions are still awaiting the server. Re-applied on top of replies to older
// actions so the selection doesn't flicker back. See sendOrCall.
let pendingLocalSelection: (() => void) | null = null;

// Optimistic-research rollback snapshot (MP only). Set when a research purchase
// is applied locally before the server confirms; cleared on the next authoritative
// state_update, or restored if the server rejects the action.
let researchRollback: SerializedGameState | null = null;

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
(window as any).__perf = () => renderer.perfInfo();
// iOS Safari only applies :active (button press feedback) when the page has a
// touch listener; a passive no-op is enough and costs nothing.
document.addEventListener('touchstart', () => {}, { passive: true });

// The board is completely covered while the menu is up (the menu draws its own
// living-board scene), so stop rendering it — two 3D scenes at once was the
// main cause of menu lag on phones. Tracks every way the menu opens/closes.
{
  const overlay = document.getElementById('menuOverlay')!;
  const sync = () => renderer.setPaused(!overlay.classList.contains('hidden'));
  new MutationObserver(sync).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  sync();
}
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
const captureBtn = document.getElementById('captureBtn') as HTMLButtonElement;
const buildTeleportBtn = document.getElementById('teleportBtn')!;
const economyBtn = document.getElementById('economyBtn') as HTMLButtonElement;
const placementCancelBtn = document.getElementById('placementCancelBtn') as HTMLButtonElement;
const placementLegendEl = document.getElementById('placementLegend')!;

// Two-tap confirm guard for the destroy/disband HUD slab. Holds the unit id the
// slab is currently "armed" for; re-armed only when the SAME unit is tapped
// twice. Any selection change / re-render for a different unit resets it.
let destroyArmedUnitId: string | null = null;

// End-round notification (§21-23). `endTurnArmed` is the two-tap confirm
// guard for ending the round while units remain unacted (mirrors
// destroyArmedUnitId's pattern) — reset the instant the turn actually ends.
// `announcedAllActedThisTurn` gates the one-time "All units have acted"
// toast so it fires once per turn, not on every re-render.
let endTurnArmed = false;
let announcedAllActedThisTurn = false;

// A unit "has an action left" until BOTH hasMoved and hasAttacked are spent.
// Move/attack order is agnostic (see game.ts) — a unit that has attacked but
// not yet moved (or vice versa) still has a legal action available, so only
// having spent both truly means done for the round (§22). Builder-only
// actions (found, build-farm, build-road) always set both flags together,
// since those fully consume the activation regardless of order.
function unactedUnitCount(state: GameState, playerId: number): number {
  return state.units.filter(u => u.hp > 0 && u.playerId === playerId && !(u.hasMoved && u.hasAttacked)).length;
}

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
const trainingQueueBanner = document.getElementById('trainingQueueBanner')!;

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
    if (s.state === 'temple' && prev === 'foundingTemple') {
      const isMine = viewer !== null && s.ownerId === viewer;
      showToast(isMine ? `You founded a Temple I` : `${nameOf(s.ownerId)} founded a Temple I`, isMine ? 'good' : undefined);
    } else if (s.state === 'temple' && prev === 'upgradingTemple') {
      const isMine = viewer !== null && s.ownerId === viewer;
      showToast(isMine ? `Your Temple reached Temple II` : `${nameOf(s.ownerId)}'s Temple reached Temple II`, isMine ? 'good' : undefined);
    } else if (s.state === 'ruins' && (prev === 'temple' || prev === 'upgradingTemple')) {
      showToast('A Temple was reduced to Ruins');
    } else if ((s.state === 'neutral' || s.state === 'ruins') && prev === 'foundingTemple') {
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
const lobbyDifficulty = document.getElementById('lobbyDifficulty')!;
const difficultyBack = document.getElementById('difficultyBack')!;

function showLobbyPanel(panel: 'main' | 'login' | 'rooms' | 'waiting' | 'setup' | 'difficulty'): void {
  lobbyMain.classList.toggle('hidden', panel !== 'main');
  lobbyLogin.classList.toggle('hidden', panel !== 'login');
  lobbyRoomListPanel.classList.toggle('hidden', panel !== 'rooms');
  lobbyWaiting.classList.toggle('hidden', panel !== 'waiting');
  lobbySetup.classList.toggle('hidden', panel !== 'setup');
  lobbyDifficulty.classList.toggle('hidden', panel !== 'difficulty');
  if (panel === 'main') { updateContinueButton(); showMenuSheet('main'); } // reflect any saved local game, back to the main stack
  if (panel === 'difficulty') fillOpponentPortraits();
  if (panel === 'setup') renderSetupSlots();
}

// Opponent cards carry a rendered 3D portrait (same thumbnails as the unit
// cards), tinted to the card's colour. Rendered once, on first open.
let opponentPortraitsDone = false;
function fillOpponentPortraits(): void {
  if (opponentPortraitsDone) return;
  opponentPortraitsDone = true;
  for (const card of Array.from(document.querySelectorAll<HTMLElement>('#lobbyDifficulty .opp-card'))) {
    const [type, faction] = (card.dataset.art ?? 'warrior:temple').split(':') as [UnitType, FactionId];
    const tint = getComputedStyle(card).getPropertyValue('--tint').trim() || '#f5c451';
    const img = card.querySelector<HTMLImageElement>('.opp-art');
    if (img) img.src = getUnitThumbnail(type, tint, faction);
  }
}

// ── sendOrCall: in multiplayer mode send action to server; locally call fn ──

function isSelectionAction(action: object): boolean {
  const t = (action as { type?: string }).type;
  return t === 'action_select_unit' || t === 'action_select_temple' || t === 'action_deselect';
}

function sendOrCall(action: object, localFn: () => void): void {
  if (multiplayerMode && mpClient) {
    // Selection changes only UI state, so apply it locally at once instead of
    // waiting a round-trip for the server's echo (which used to make every tap
    // lag on a slow connection). The server's reply then confirms it.
    if (isSelectionAction(action) && !spectatorMode) {
      try { localFn(); } catch { /* the server's reply will correct it */ }
      if (mpClient.sendAction(action as Parameters<MultiplayerClient['sendAction']>[0])) pendingLocalSelection = localFn;
      render();
      return;
    }
    mpClient.sendAction(action as Parameters<MultiplayerClient['sendAction']>[0]);
  } else {
    localFn();
    render();
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
  // Spectators see every unit, so every move animates for them.
  if (gameStarted && multiplayerMode && (spectatorMode || viewer !== undefined)) {
    const prev = state;
    const prevVisible = spectatorMode || viewer === undefined ? null : getPlayerVisible(prev, viewer);
    const prevById = new Map(prev.units.map(u => [u.id, u]));
    for (const u of newState.units) {
      if (u.hp <= 0) continue;
      const old = prevById.get(u.id);
      if (!old || old.hp <= 0 || hexEqual(old.pos, u.pos)) continue;
      const mine = u.playerId === viewer;
      if (!prevVisible || mine || prevVisible.has(hexKey(old.pos))) {
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
      if (mpReconnecting) { finishReconnect(); break; }
      lobbyLoginStatus.textContent = '';
      lobbyWelcomeMsg.textContent = `Logged in as ${event.username}`;
      showLobbyPanel('rooms');
      mpClient!.listRooms();
      mpClient!.listGames();
      break;
    }
    case 'error': {
      // During a reconnect the server may still hold our old session for a
      // moment ("Username already taken") — just try again shortly.
      if (mpReconnecting && mpClient) { mpReconnecting = false; mpClient.disconnect(); scheduleReconnect(); break; }
      lobbyLoginStatus.textContent = event.message;
      lobbyLoginStatus.className = 'lobby-status err';
      break;
    }
    case 'room_created': {
      mpRoomId = event.roomId;
      lobbyRoomCode.textContent = event.roomId;
      lobbyWaitingStatus.textContent = event.expectedPlayers > 2
        ? `Waiting for players… 1/${event.expectedPlayers} joined`
        : 'Waiting for opponent to join…';
      showLobbyPanel('waiting');
      break;
    }
    case 'room_waiting': {
      mpRoomId = event.roomId;
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
        // Names come from other players: escape them (a name like
        // <img onerror=…> used to run script in everyone's lobby).
        item.innerHTML = `<span>${escapeHtml(room.id)} — ${escapeHtml(room.player1Name)}${size}</span>`;
        const btn = document.createElement('button');
        btn.textContent = 'Join';
        btn.addEventListener('click', () => {
          mpRoomId = room.id;
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
      researchRollback = null;
      pendingLocalSelection = null;
      hideOpponentCountdown();
      controllers = [];  // online: server-authoritative, no local AI
      state = deserialize(event.state);
      snapshotSiteStates();   // fresh baseline so no stale capture toasts fire
      renderer.init(state.mapRadius);
      gameStarted = true;
      buildingTeleport = null;
      buildingFarm = null;
      buildingRoad = null;
  handoffPending = false;
      hideMenu();
      closeTechTree();
      combatLog.innerHTML = '';
      // Open on our own Capital, as local games do. The default board-centre
      // framing showed only fog online, and on a phone the home area was
      // entirely off-screen.
      const homeCapital = getPlayerCapital(state, state.players[myPlayerSlot]?.id ?? myPlayerSlot);
      if (homeCapital) renderer.focusOnHex(homeCapital.pos);
      const myPlayer = state.players[myPlayerSlot];
      console.log(`[MP] game_start: slot=${myPlayerSlot} name="${myPlayer?.name}" color=${myPlayer?.color} currentPlayerIndex=${state.currentPlayerIndex}`);
      logCombat(`--- Online Game started (you are Player ${myPlayerSlot + 1}) ---`);
      render();
      break;
    }
    case 'state_update': {
      researchRollback = null;   // authoritative state supersedes any optimistic research
      applyStateWithAnimation(deserialize(event.state)); // tween visible moves, don't teleport
      // A reply to an older action still carries the older selection; keep the
      // newer one the player already sees until every action is answered.
      mpClient?.actionAnswered();
      if (pendingLocalSelection && mpClient && mpClient.inflight > 0) {
        try { pendingLocalSelection(); } catch { /* server state wins */ }
      } else {
        pendingLocalSelection = null;
      }
      if (state.phase === 'gameOver' && opponentCountdown) {
        const won = state.winner?.id === state.players[myPlayerSlot]?.id;
        hideOpponentCountdown();
        if (won) showToast('Your opponent left — you win!', 'good');
      }
      // If the tech tree is open (view-only browsing during the opponent's turn),
      // re-render it so node clickability tracks whose turn it now is.
      if (!techOverlay.classList.contains('hidden')) renderTechTree();
      render();
      // The server drops log lines about hexes we can't see, which can leave
      // this empty.
      if (event.lastAction) logCombat(event.lastAction);
      break;
    }
    case 'action_error': {
      mpClient?.actionAnswered();
      if (!mpClient || mpClient.inflight === 0) pendingLocalSelection = null;
      showToast(event.message, 'bad');
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
      const name = event.playerName ?? 'Opponent';
      logCombat(`${name} disconnected. Waiting for them to reconnect…`);
      if (gameStarted && !spectatorMode && state.phase !== 'gameOver') {
        showOpponentCountdown(name, event.graceMs ?? 30000);
      }
      break;
    }
    case 'opponent_reconnected': {
      logCombat(`${event.playerName ?? 'Opponent'} reconnected.`);
      hideOpponentCountdown();
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
        item.innerHTML = `<span>${escapeHtml(game.player1Name)} vs ${escapeHtml(game.player2Name)}${statusLabel}${specLabel}</span>`;
        const btn = document.createElement('button');
        btn.textContent = 'Watch';
        btn.addEventListener('click', () => {
          mpSpectatingGameId = game.gameId;
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
      buildingRoad = null;
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

// ── HTML escaping for player-provided text ──

function escapeHtml(text: unknown): string {
  return String(text ?? '').replace(/[&<>"'`]/g, c => `&#${c.charCodeAt(0)};`);
}

// Player colours come from the server; only allow plain colour syntax inside style="".
function safeCssColor(color: unknown): string {
  const c = String(color ?? '');
  return /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,20}|(rgb|hsl)a?\([0-9.,%\s]+\))$/.test(c) ? c : '#888';
}

// ── Connection loss: banner + automatic reconnect ──

const RECONNECT_DELAYS_MS = [0, 1000, 2000, 4000, 8000, 15000];
let connBanner: HTMLDivElement | null = null;

function showConnBanner(text: string, buttons: [string, () => void][]): void {
  if (!connBanner) {
    connBanner = document.createElement('div');
    connBanner.id = 'mpConnBanner';
    connBanner.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;background:#3a1210;color:#fff4dc;border:1px solid #c0503c;border-radius:10px;padding:8px 14px;font:600 14px Nunito,system-ui,sans-serif;display:flex;gap:10px;align-items:center;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:calc(100vw - 32px)';
    document.body.appendChild(connBanner);
  }
  connBanner.replaceChildren();
  const label = document.createElement('span');
  label.textContent = text;
  connBanner.appendChild(label);
  for (const [name, onClick] of buttons) {
    const b = document.createElement('button');
    b.textContent = name;
    b.style.cssText = 'font:inherit;padding:3px 10px;border-radius:6px;border:0;cursor:pointer';
    b.addEventListener('click', onClick);
    connBanner.appendChild(b);
  }
}

function hideConnBanner(): void {
  connBanner?.remove();
  connBanner = null;
}

function stopReconnect(): void {
  if (mpRetryTimer !== null) { clearTimeout(mpRetryTimer); mpRetryTimer = null; }
  mpReconnecting = false;
  hideConnBanner();
}

function leaveAfterConnectionLoss(): void {
  leaveActiveGame();
  spectatorBanner.style.display = 'none';
  gameStarted = false;
  showMenu();
}

function onConnectionDropped(): void {
  if (!mpClient) return;
  if (gameStarted && multiplayerMode) logCombat('Connection to the server lost. Reconnecting…');
  lobbyLoginStatus.textContent = 'Connection lost. Reconnecting…';
  lobbyLoginStatus.className = 'lobby-status err';
  mpReconnecting = false;
  mpRetryCount = 0;
  scheduleReconnect();
}

function scheduleReconnect(): void {
  const client = mpClient;
  if (!client) return;
  if (mpRetryCount >= RECONNECT_DELAYS_MS.length) {
    showConnBanner('Could not reconnect to the server.', [
      ['Retry', () => { mpRetryCount = 0; scheduleReconnect(); }],
      ['Leave', leaveAfterConnectionLoss],
    ]);
    lobbyLoginStatus.textContent = 'Could not reconnect to the server';
    return;
  }
  const delay = RECONNECT_DELAYS_MS[mpRetryCount++]!;
  showConnBanner(mpRetryCount > 1 ? `Connection lost. Reconnecting (attempt ${mpRetryCount})…` : 'Connection lost. Reconnecting…',
    [['Leave', leaveAfterConnectionLoss]]);
  mpRetryTimer = window.setTimeout(async () => {
    mpRetryTimer = null;
    if (mpClient !== client) return;
    try {
      await client.connect();
      if (mpClient !== client) { client.disconnect(); return; }
      if (!client.username) { finishReconnect(); return; }
      mpReconnecting = true;
      client.login(client.username); // → logged_in → finishReconnect()
    } catch {
      if (mpClient === client) scheduleReconnect();
    }
  }, delay);
}

// Logged in again: get back into the room / game we were in.
function finishReconnect(): void {
  mpReconnecting = false;
  hideConnBanner();
  lobbyLoginStatus.textContent = '';
  lobbyLoginStatus.className = 'lobby-status';
  if (!mpClient) return;
  if (spectatorMode && mpSpectatingGameId) mpClient.spectateGame(mpSpectatingGameId);
  else if (mpRoomId) mpClient.rejoinRoom(mpRoomId); // server answers with game_start (or room_waiting)
  else { mpClient.listRooms(); mpClient.listGames(); }
  if (gameStarted && multiplayerMode) logCombat('Reconnected to the server.');
  showToast('Reconnected', 'good');
}

// ── Opponent disconnected: 30-second countdown ──
// The server owns the timeout: if the opponent hasn't rejoined when it runs
// out, the server resigns them and a game-over state_update follows. This card
// just shows the wait.

let opponentCountdown: { el: HTMLDivElement; until: number; timer: number; last: number } | null = null;

function showOpponentCountdown(name: string, graceMs: number): void {
  hideOpponentCountdown();
  const el = document.createElement('div');
  el.id = 'mpOppOverlay';
  el.style.cssText = 'position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(6,14,10,.55);padding:16px';
  const card = document.createElement('div');
  card.style.cssText = 'background:#14241b;color:#fff4dc;border:1px solid #f5c451;border-radius:14px;padding:20px 24px;width:min(340px,100%);text-align:center;font-family:Nunito,system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5)';
  const title = document.createElement('div');
  title.style.cssText = "font:400 22px 'Lilita One',Nunito,sans-serif;margin-bottom:6px";
  title.textContent = `${name} disconnected`;
  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:14px;opacity:.85;margin-bottom:12px';
  const time = document.createElement('div');
  time.style.cssText = "font:400 40px 'Lilita One',Nunito,sans-serif;color:#f5c451";
  const track = document.createElement('div');
  track.style.cssText = 'height:6px;background:#0a1510;border-radius:3px;overflow:hidden;margin-top:10px';
  const bar = document.createElement('div');
  bar.style.cssText = 'height:100%;background:#f5c451;width:100%';
  track.appendChild(bar);
  const foot = document.createElement('div');
  foot.style.cssText = 'font-size:12px;opacity:.65;margin-top:10px';
  foot.textContent = "If they don't return, you win.";
  card.append(title, sub, time, track, foot);
  el.appendChild(card);
  document.body.appendChild(el);

  const now = performance.now();
  const cd = { el, until: now + graceMs, timer: 0, last: now };
  const tick = (): void => {
    const t = performance.now();
    // Paused while we're offline ourselves; the server keeps its own clock.
    if (!mpClient?.isOpen()) cd.until += t - cd.last;
    cd.last = t;
    const left = Math.max(0, cd.until - t);
    const secs = Math.ceil(left / 1000);
    time.textContent = `0:${String(secs).padStart(2, '0')}`;
    bar.style.width = `${(left / graceMs) * 100}%`;
    sub.textContent = !mpClient?.isOpen() ? 'You are offline too — timer paused'
      : left > 0 ? 'Waiting for them to reconnect…' : 'Confirming with the server…';
  };
  tick();
  cd.timer = window.setInterval(tick, 250);
  opponentCountdown = cd;
}

function hideOpponentCountdown(): void {
  if (!opponentCountdown) return;
  clearInterval(opponentCountdown.timer);
  opponentCountdown.el.remove();
  opponentCountdown = null;
}

// ── Lobby button wiring ──

menuOnline.addEventListener('click', () => {
  showLobbyPanel('login');
});

lobbyLoginBack.addEventListener('click', () => showLobbyPanel('main'));
lobbyRoomBack.addEventListener('click', () => showLobbyPanel('main'));
lobbyWaitingBack.addEventListener('click', () => {
  // Tell the server we're leaving so the room doesn't linger in everyone's list.
  // A message queued before close() is still delivered.
  if (mpClient?.isOpen() && mpRoomId) mpClient.leaveRoom(mpRoomId);
  mpRoomId = null;
  stopReconnect();
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

  stopReconnect();
  if (!mpClient) {
    mpClient = new MultiplayerClient(wsUrl, handleMultiplayerEvent);
    mpClient.onDrop = onConnectionDropped;
    mpClient.onSendFail = () => showToast(mpRetryTimer !== null || mpReconnecting ? 'Not connected — reconnecting…' : 'Not connected to the server', 'bad');
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
  mpRoomId = code;
  mpClient!.joinRoom(code);
});

lobbyJoinCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') lobbyJoinCodeBtn.click();
});

// ── Menu ──

// Disconnect from any live multiplayer game (player or spectator) and reset the
// multiplayer flags. Safe to call when not in a multiplayer game (no-op).
function leaveActiveGame(): void {
  stopReconnect();
  hideOpponentCountdown();
  if (mpClient) {
    mpClient.disconnect();
    mpClient = null;
  }
  mpRoomId = null;
  mpSpectatingGameId = null;
  pendingLocalSelection = null;
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
  ensureMenuScene();
  factionChoiceOverlay.classList.add('hidden'); // sits above the menu (z 210) — hide it while the menu is up; hideMenu restores it
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
  }
  // An online PLAYER game stays connected while the menu is up: the menu is a
  // pause screen, not a forfeit. (Closing the socket here used to drop players
  // out of their match the moment they pressed Esc.) Starting or resuming a
  // local game from the menu still disconnects, via leaveActiveGame().
  if (!gameStarted) showLobbyPanel('main');
  // Refresh the Continue CTA every time the menu opens — including mid-game,
  // where showLobbyPanel('main') is skipped (gameStarted is true) but the main
  // menu panel is still what's shown over the board.
  updateContinueButton();
}

function hideMenu(): void {
  menuOverlay.classList.add('hidden');
  disposeMenuScene();
  if (gameStarted) updateFactionOverlay(); // bring the faction pick back if it was mid-flight
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
  // Saves from before the three-level split may hold 'normal'/'expert'.
  if (save.controllers && save.controllers.length) return save.controllers.map(k => k === 'human' ? k : normalizeDifficulty(k));
  const aiKind: ControllerKind = normalizeDifficulty(save.aiDifficulty);
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
  buildingRoad = null;
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
  // Open on the local human's Capital, as a new game does (the default
  // board-centre framing can show nothing but fog, especially on a phone).
  const humanSeat = controllers.findIndex(k => k === 'human');
  const homeCapital = humanSeat >= 0 ? getPlayerCapital(state, humanSeat) : undefined;
  if (homeCapital) renderer.focusOnHex(homeCapital.pos);
  render();
  maybeRunAITurn();              // if it was the AI's turn, let it continue
}

// Show the "Continue" card only when a valid local save exists, and describe
// the save (round, who you're playing) so resuming is an informed tap.
function updateContinueButton(): void {
  if (gameStarted && multiplayerMode && !spectatorMode) {
    menuContinueBtn.style.display = '';
    document.getElementById('menuContinueTitle')!.textContent = 'Resume online game';
    document.getElementById('menuContinueSub')!.textContent = mpClient?.isOpen() ? 'Your match is still running' : 'Reconnecting to the server…';
    return;
  }
  const save = loadSavedGame();
  menuContinueBtn.style.display = save ? '' : 'none';
  if (!save) return;
  const st = save.state;
  const kinds = controllersFromSave(save);
  const humans = kinds.filter(k => k === 'human').length;
  const ais = kinds.filter(k => k !== 'human');
  const who = ais.length === 0 ? `${humans} players, one device`
    : humans === 1 && ais.length === 1 ? `vs ${ais[0]} AI`
    : `${humans} human${humans === 1 ? '' : 's'} · ${ais.length} AI`;
  const me = st.players.find(p => kinds[st.players.indexOf(p)] === 'human');
  const faction = me?.faction === 'temple' ? 'Temple' : me?.faction === 'agrar' ? 'Agrar' : null;
  document.getElementById('menuContinueTitle')!.textContent = `Continue · Round ${st.turnNumber}`;
  document.getElementById('menuContinueSub')!.textContent = [faction, who].filter(Boolean).join(' · ');
}

// ── Living-board menu scene: created whenever the menu is up, torn down when a
// game starts so it never holds a second WebGL context behind the board. ──
let menuScene: MenuScene | null = null;
function ensureMenuScene(): void {
  if (menuScene) return;
  // A canvas whose WebGL context was force-lost on dispose can't host a new
  // renderer, so every open gets a fresh canvas element in the same slot.
  const old = document.getElementById('menuScene') as HTMLCanvasElement;
  const canvas = document.createElement('canvas');
  canvas.id = 'menuScene';
  old.replaceWith(canvas);
  try {
    menuScene = createMenuScene(canvas, menuOverlay);
  } catch (e) { console.warn('[menu] living board unavailable', e); }
}
function disposeMenuScene(): void {
  menuScene?.dispose();
  menuScene = null;
}
// Every entry flies the camera to its scene; the sub-panel then opens over it.
for (const el of Array.from(document.querySelectorAll<HTMLElement>('#lobbyMain [data-cam]'))) {
  const fly = (): void => menuScene?.goTo(el.dataset.cam as MenuPlace);
  el.addEventListener('pointerenter', fly);
  el.addEventListener('click', fly);
}
for (const id of ['setupBack', 'difficultyBack', 'lobbyLoginBack', 'lobbyRoomBack', 'lobbyWaitingBack']) {
  document.getElementById(id)?.addEventListener('click', () => menuScene?.goTo('home'));
}
document.getElementById('menuRules')!.textContent = `Rules v${RULES_VERSION}`;

// Build a human-readable name for a local seat.
function seatName(kind: ControllerKind, idx: number): string {
  if (kind === 'human') return `Player ${idx + 1}`;
  return `${difficultyLabel(kind)} ${idx + 1}`;
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
  buildingRoad = null;
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
function startGame(vsAI: boolean, difficulty: AiDifficulty = 'medium'): void {
  startLocalGame(vsAI ? ['human', difficulty] : ['human', 'human']);
}

menuContinueBtn.addEventListener('click', () => {
  if (gameStarted && multiplayerMode && !spectatorMode) { hideMenu(); render(); return; }
  restoreGame();
});
menu2P.addEventListener('click', () => startGame(false));
for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.difficulty-btn'))) {
  btn.addEventListener('click', () => startGame(true, normalizeDifficulty(btn.dataset.difficulty)));
}
difficultyBack.addEventListener('click', () => showLobbyPanel('main'));
menuBtn.addEventListener('click', () => showMenu());

// ── Main-menu sheets (Polytopia-style menu, /menu-proposals-2 option A) ──
// The main stack is New game / Multiplayer / Continue / Replays. New game opens
// one sheet: tribe, then opponent (a friend on this device or an AI level),
// then Start — the chosen tribe is submitted as the human's faction pick the
// moment the game starts, so the in-game picker only shows for a second human.
const menuStack = document.getElementById('menuStack')!;
const menuNewSheet = document.getElementById('menuNewSheet')!;
const menuMpSheet = document.getElementById('menuMpSheet')!;
let menuTribe: FactionId = 'agrar';
let menuOpp: 'friend' | AiDifficulty = 'medium';
function showMenuSheet(which: 'main' | 'new' | 'mp'): void {
  menuStack.classList.toggle('hidden', which !== 'main');
  menuNewSheet.classList.toggle('hidden', which !== 'new');
  menuMpSheet.classList.toggle('hidden', which !== 'mp');
  menuOverlay.classList.toggle('sheet-open', which !== 'main');
}
document.getElementById('menuNew')!.addEventListener('click', () => showMenuSheet('new'));
document.getElementById('menuMultiplayer')!.addEventListener('click', () => showMenuSheet('mp'));
for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-menu-back]'))) el.addEventListener('click', () => showMenuSheet('main'));
for (const el of Array.from(document.querySelectorAll<HTMLButtonElement>('#menuNewSheet .mtribe'))) {
  el.addEventListener('click', () => {
    menuTribe = el.dataset.tribe as FactionId;
    document.querySelectorAll('#menuNewSheet .mtribe').forEach(x => x.classList.toggle('on', x === el));
  });
}
for (const el of Array.from(document.querySelectorAll<HTMLButtonElement>('#menuOppPills .mpill'))) {
  el.addEventListener('click', () => {
    menuOpp = el.dataset.opp === 'friend' ? 'friend' : normalizeDifficulty(el.dataset.opp);
    document.querySelectorAll('#menuOppPills .mpill').forEach(x => x.classList.toggle('on', x === el));
  });
}
document.getElementById('menuStart')!.addEventListener('click', () => {
  const tribe = menuTribe;
  if (menuOpp === 'friend') startGame(false); else startGame(true, menuOpp);
  // Pre-pick the tribe for the first human seat (a second human still picks in-game).
  if (pendingFactionSlot() !== null) submitFactionChoice(tribe);
  showMenuSheet('main');
});

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
// rest to Medium AI — the classic "1 human vs N AIs" default.
let setupKinds: ControllerKind[] = ['human', 'medium'];

function renderSetupSlots(): void {
  setupPlayersCountEl.textContent = String(setupKinds.length);
  setupSlotsEl.innerHTML = '';
  const KIND_LABELS: [ControllerKind, string][] = [
    ['human', 'Human'], ['easy', 'AI — Easy'], ['medium', 'AI — Medium'], ['hard', 'AI — Hard'],
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

// ── Faction choice (immediate, before Round 1 — phase 11 §1-3) ──
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

let factionPortraitsDone = false;
function fillFactionPortraits(): void {
  if (factionPortraitsDone) return;
  factionPortraitsDone = true;
  for (const card of [fcAgrarCard, fcTempleCard]) {
    const [type, faction] = (card.dataset.art ?? 'warrior:temple').split(':') as [UnitType, FactionId];
    const tint = getComputedStyle(card).getPropertyValue('--tint').trim() || '#f5c451';
    const img = card.querySelector<HTMLImageElement>('.fc-art');
    if (img) img.src = getUnitThumbnail(type, tint, faction);
  }
}

function updateFactionOverlay(): void {
  const slot = pendingFactionSlot();
  if (slot !== null) fillFactionPortraits();
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

// §40-42 (phase 11 correction) — human-readable reasons an Agrar Builder's
// Build Farm/Build Road button is disabled right now, mirroring the
// preconditions of canStartFarm/canBuildRoad in game.ts. Returns null when
// the action is currently available. Checked in priority order: energy,
// per-action cap/occupancy, activation, then placement.
function farmBlockReason(state: GameState, unit: Unit): string | null {
  const player = state.players.find(p => p.id === unit.playerId);
  if (!player) return 'not your unit';
  if (player.aura < AGRAR_FARM_COST) return `not enough Energy (need ⚡${AGRAR_FARM_COST})`;
  const activeFarms = state.farms.filter(f => f.ownerId === player.id).length;
  if (activeFarms >= MAX_ACTIVE_FARMS) return `maximum Farms reached (${MAX_ACTIVE_FARMS}/${MAX_ACTIVE_FARMS})`;
  if (unit.hasAttacked) return 'Builder has already used its action this round';
  if (getValidFarmHexes(state, unit).length === 0) return 'no valid Farm location adjacent to this Builder';
  return null;
}

// Farm-placement UX pass — WHY a specific tapped/clicked hex can't take a
// Farm, read straight from the engine's own canonical getFarmPlacementResult
// (game.ts) rather than re-deriving the rules here — the UI can never show a
// reason (or a legal/illegal verdict) that disagrees with actual
// construction. Returns every applicable reason, comma-joined, or null if
// the hex is actually legal.
function farmHexIllegalReason(state: GameState, unit: Unit, hex: HexCoord): string | null {
  const { legal, reasons } = getFarmPlacementResult(state, unit, hex);
  return legal ? null : reasons.join(', ');
}

function roadBlockReason(state: GameState, unit: Unit): string | null {
  const player = state.players.find(p => p.id === unit.playerId);
  if (!player) return 'not your unit';
  if (player.aura < ROAD_COST_PER_HEX) return `not enough Energy (need ⚡${ROAD_COST_PER_HEX})`;
  if (unit.hasAttacked) return 'Builder has already used its action this round';
  if (getValidRoadHexes(state, unit).length === 0) return 'no valid Road location next to this Builder and its network';
  return null;
}

// Road-placement UX pass — WHY a specific tapped/clicked Road tile is
// illegal, read straight from the engine's own canonical
// getRoadPlacementResult (game.ts), same principle as farmHexIllegalReason
// above — `selected` is whatever's already been picked this activation, so
// the SAME function reports the right reason for both the first tile and any
// continuation tile. Returns every applicable reason, comma-joined, or null
// if the hex is actually legal.
function roadHexIllegalReason(state: GameState, unit: Unit, hex: HexCoord, selected: HexCoord[]): string | null {
  const { legal, reasons } = getRoadPlacementResult(state, unit, hex, selected);
  return legal ? null : reasons.join(', ');
}

// WHY a Temple unit can't found/reconsecrate right now, mirroring
// farmBlockReason/roadBlockReason: the Found button used to just vanish
// with zero explanation whenever canStartFounding returned null, which is
// exactly what made "can't conquer a Temple" look broken (an active enemy
// Temple must be destroyed to Ruins FIRST — standing on it never works).
// Founding only needs the unit's action slot unused (move/action order is
// agnostic — § agnostic activation order), so a unit CAN move onto a valid
// Ruins/neutral site and found it the very same turn. Any Temple unit may
// found — there's no dedicated founder-type unit anymore.
function foundBlockReason(state: GameState, unit: Unit): string | null {
  const player = state.players.find(p => p.id === unit.playerId);
  if (!player) return 'not your unit';
  const site = getStrategicSiteAt(state, unit.pos);
  if (!site) return 'not standing on a sacred site';
  if (site.state === 'temple' || site.state === 'upgradingTemple') {
    return site.ownerId === player.id ? 'you already own this Temple' : 'destroy it first — attack it down to Ruins, then reconsecrate';
  }
  if (site.state === 'foundingTemple' || site.founding) return 'already being founded/reconstructed';
  if (unit.hasAttacked) return 'this unit has already used its action — wait until your next round';
  const enemyOnSite = state.units.some(u => u.hp > 0 && u.id !== unit.id && u.playerId !== unit.playerId && hexEqual(u.pos, site.pos));
  if (enemyOnSite) return 'an enemy unit is on this site';
  if (player.aura < SITE_ESTABLISH_COST) return `not enough Energy (need ⚡${SITE_ESTABLISH_COST})`;
  if (isSiteCultivationBlocked(state, site.pos, player.id)) return 'blocked by Agrar cultivation';
  return null;
}

// v14 — WHY a unit standing on an enemy-owned Road can't pillage it right
// now. Only shown at all while actually standing on one (see the caller) —
// this isn't a general-purpose action like Found/Build Farm.
function pillageRoadBlockReason(state: GameState, unit: Unit): string | null {
  if (unit.hasAttacked) return 'already acted this round';
  return null;
}

// v14 — WHY an Agrar unit standing on a Fertile Site can't claim it right
// now (1v1 Agrar-mirror only — fertileSites is empty in every other
// matchup, so this never shows there). Only shown while actually standing
// on one — see the caller.
function fertileSiteBlockReason(state: GameState, unit: Unit): string | null {
  const site = state.fertileSites.find(f => hexEqual(f.pos, unit.pos));
  if (!site) return null; // caller already checked this — defensive only
  if (site.ownerId === unit.playerId) return 'you already control this site';
  if (unit.hasAttacked) return 'already used its action this round';
  return null;
}

// WHY the "Upgrade to Temple II" button is disabled — mirroring farmBlock
// Reason/roadBlockReason/foundBlockReason: it used to just disable with the
// same static label regardless of cause (not enough Energy, an enemy's
// Temple you're merely viewing, already mid-upgrade elsewhere), giving no
// clue why a seemingly-affordable-looking upgrade wasn't starting.
function templeUpgradeBlockReason(state: GameState, siteId: string): string | null {
  const player = getCurrentPlayer(state);
  const site = state.strategicSites.find(s => s.id === siteId);
  if (!site) return 'site not found';
  if (site.ownerId !== player.id) return 'not your Temple';
  if (site.upgrade) return 'already upgrading';
  if (player.aura < TEMPLE_UPGRADE_COST) return `not enough Energy (need ⚡${TEMPLE_UPGRADE_COST})`;
  return null;
}

// ── Render & UI ──

function render(): void {
  maybeAutoChooseFactionForAI();
  updateFactionOverlay();
  // §5 (phase 11 correction) — recruits no longer appear instantly, so make
  // the wait visible: a small banner listing what's currently queued for the
  // local viewer's own player, deploying at the start of their next round.
  // Grouped by unit type with a ×N count (population/queue clarity pass) —
  // recruiting several of the same type used to just repeat its name once
  // per order ("Warrior, Warrior, Warrior"), which is exactly the "not clear
  // how many are waiting" complaint this pass is fixing.
  const vSlotForBanner = gameStarted && !spectatorMode ? viewerPlayerSlot() : null;
  const queuedForViewer = vSlotForBanner !== null ? state.trainingQueue.filter(o => o.playerId === vSlotForBanner) : [];
  if (queuedForViewer.length > 0) {
    const viewerFaction = state.players[vSlotForBanner!]?.faction;
    const counts = new Map<UnitType, number>();
    for (const o of queuedForViewer) counts.set(o.unitType, (counts.get(o.unitType) ?? 0) + 1);
    const parts = [...counts.entries()].map(([type, n]) =>
      n > 1 ? `${unitDisplayName(type, viewerFaction)} ×${n}` : unitDisplayName(type, viewerFaction));
    trainingQueueBanner.textContent = `🏭 Training: ${parts.join(', ')} — deploys next round`;
    trainingQueueBanner.classList.remove('hidden');
  } else {
    trainingQueueBanner.classList.add('hidden');
  }
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
      `<span class="chip-dot" style="background:${safeCssColor(p.color)}"></span>` +
      `<span>${escapeHtml(p.name)}${you}</span>` +
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
  // End-round notification (§21-23) — only while it's genuinely the local
  // player's turn and no ring-pick placement mode is left dangling; a unit
  // still counts as "has an action left" until BOTH its move and its action
  // slot are spent (order-agnostic — see unactedUnitCount above).
  if (myTurn && !spectatorMode && state.phase === 'playing' && !buildingFarm && !buildingRoad && !buildingTeleport) {
    const remaining = unactedUnitCount(state, player.id);
    if (remaining === 0) {
      // Auto-clear a stale "N left — Sure?" confirm arm once the player
      // finishes acting on their own — nothing left to confirm past.
      if (endTurnArmed) { endTurnArmed = false; renderer.setHudButtonArmed('endTurn', false); }
      renderer.setHudButtonPrice('endTurn', 'All Acted!');
      if (!announcedAllActedThisTurn) {
        announcedAllActedThisTurn = true;
        showToast('All units have acted — End Round', 'good');
      }
    } else if (!endTurnArmed) {
      renderer.setHudButtonPrice('endTurn', '');
    }
  } else if (!endTurnArmed) {
    renderer.setHudButtonPrice('endTurn', '');
  }
  syncPlacementCancelAndLegend();
  // The 3rd slab starts founding/reconstruction for the selected unit (a
  // Temple Acolyte standing on a neutral/ruined site — §7-10, v13), OR
  // builds a road (Agrar only, §23-25) if founding isn't available but a
  // road is — mutually exclusive per-tile states, see doFound(). INVISIBLE
  // unless one of the two is currently legal;
  // when shown it displays the relevant aura cost.
  const selUnitForFound = state.selectionMode === 'unit' && state.selectedUnitId
    ? state.units.find(u => u.id === state.selectedUnitId)
    : null;
  const foundCheck = selUnitForFound && myTurn ? canStartFounding(state, selUnitForFound) : null;
  const roadCheck = !foundCheck && selUnitForFound && myTurn
    ? getValidRoadHexes(state, selUnitForFound).some(h => canBuildRoad(state, selUnitForFound, h))
    : false;
  if (foundCheck) {
    renderer.updateHudButton('found', true);
    renderer.setHudButtonPrice('found', `⚡${SITE_ESTABLISH_COST}`);
    renderer.setHudButtonVisible('found', true);
  } else if (roadCheck) {
    renderer.updateHudButton('found', true);
    renderer.setHudButtonPrice('found', `⚡${ROAD_COST_PER_HEX}`);
    renderer.setHudButtonVisible('found', true);
  } else {
    renderer.setHudButtonVisible('found', false); // no founder selected (or nothing to do here)
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
      // Two independent, stackable DEF sources: hill terrain (any faction),
      // and Agrar's own Home Ground (+1 DEF within 1 hex of the Capital or
      // an active Farm — see isOnAgrarHomeGround/getEffectiveDefense; never
      // stacks with itself even if Capital/Farm coverage overlaps).
      const onHillNow = state.hills.has(hexKey(unit.pos));
      const onHomeGroundNow = isOnAgrarHomeGround(state, unit);
      const defBonusNotes: string[] = [];
      if (onHillNow) defBonusNotes.push(`⛰+${HILL_DEFENSE_BONUS}`);
      if (onHomeGroundNow) defBonusNotes.push(`🏠+${HOME_GROUND_DEFENSE_BONUS}`);
      const defStr = defBonusNotes.length > 0 ? `${effDef}(${defBonusNotes.join(' ')})` : `${effDef}`;
      const atkStr = effAtk > unit.stats.attack ? `${effAtk}(🔥+${effAtk - unit.stats.attack})` : `${effAtk}`;
      const rngStr = effRng > unit.stats.range ? `${effRng}(+${effRng - unit.stats.range})` : `${effRng}`;
      let supportNote = '';
      if (unit.type === 'healer') supportNote = ` | ✚${HEALER_HEAL_AMOUNT}HP/t (r1 full·r2 half)`;
      if (unit.type === 'damageBooster') supportNote = ` | +${DAMAGE_BOOST_AMOUNT}ATK (r1 full·r2 half)`;
      if (unit.type === 'rangeBooster') supportNote = ` | +${RANGE_BOOST_AMOUNT}RNG (r1)`;
      unitInfoEl.textContent = `${typeName} HP:${unit.hp}/${unit.stats.maxHp} ATK:${atkStr} DEF:${defStr} RNG:${rngStr}${encStr}${supportNote}`;

      const foundable = canStartFounding(state, unit);
      const isAgrarBuilder = unit.type === 'founder' && player.faction === 'agrar';
      if (foundable) {
        // v13 §17 — an Acolyte on Ruins this player previously owned sees
        // "Restore Temple <level>" (returns directly to that level); Ruins
        // with no memory, or memory belonging to someone else, always show
        // "Consecrate Temple I" (a fresh site always starts at level 1).
        const isOwnRuins = foundable.site.state === 'ruins' && foundable.site.previousOwnerId === player.id;
        const label = isOwnRuins ? `Restore Temple ${foundable.site.previousTempleLevel === 2 ? 'II' : 'I'}`
          : foundable.site.state === 'ruins' ? 'Consecrate Temple I'
          : 'Consecrate Temple I';
        captureBtn.style.display = 'block';
        captureBtn.disabled = false;
        captureBtn.title = '';
        captureBtn.textContent = `⚒ ${label} (⚡${SITE_ESTABLISH_COST}) — 1 round`;
      } else if (player.faction === 'temple' && getStrategicSiteAt(state, unit.pos)) {
        // The Acolyte is gone — ANY Temple unit standing on a Temple/Ruins/
        // neutral site can see this. Always shown while standing on one
        // (matches the Fertile Site/Pillage Road pattern below), never
        // silently hidden — a disabled button with a clear reason beats a
        // vanished button with none (that gap is exactly what made "can't
        // conquer a Temple" look broken — see foundBlockReason).
        const reason = foundBlockReason(state, unit);
        captureBtn.style.display = 'block';
        captureBtn.disabled = !!reason;
        captureBtn.title = reason ?? '';
        captureBtn.classList.remove('active');
        captureBtn.textContent = reason ? `⚒ Consecrate/Restore — ${reason}` : `⚒ Consecrate Temple I (⚡${SITE_ESTABLISH_COST})`;
      } else if (player.faction === 'agrar' && state.fertileSites.some(f => hexEqual(f.pos, unit.pos))) {
        // v14 — Claim Fertile Site takes priority over Build Road for a
        // Builder standing exactly on one (1v1 Agrar mirror only — any
        // Agrar unit, not just the Builder, can claim). Always shown while
        // standing on one, disabled-with-reason rather than hidden.
        const reason = fertileSiteBlockReason(state, unit);
        captureBtn.style.display = 'block';
        captureBtn.disabled = !!reason;
        captureBtn.title = reason ?? '';
        captureBtn.classList.remove('active');
        captureBtn.textContent = reason ? `🌾 Claim Fertile Site — ${reason}` : '🌾 Claim Fertile Site (consumes full activation)';
      } else if (getRoadAt(state, unit.pos) && getRoadAt(state, unit.pos)!.ownerId !== unit.playerId) {
        // v14 — Pillage Road: ANY unit (not just Agrar/Builder) standing on
        // an enemy-owned Road. Always shown while standing on one.
        const reason = pillageRoadBlockReason(state, unit);
        captureBtn.style.display = 'block';
        captureBtn.disabled = !!reason;
        captureBtn.title = reason ?? '';
        captureBtn.classList.remove('active');
        captureBtn.textContent = reason ? `⛏ Pillage Road — ${reason}` : '⛏ Pillage Road (destroys it)';
      } else if (isAgrarBuilder) {
        // §39-40 (phase 11 correction) — Build Road is ALWAYS shown for an
        // Agrar Builder, never hidden behind a hidden precondition; disabled
        // states carry a human-readable reason (title + on-button text).
        // Ring-pick hex mode, same pattern as Build Farm — see roadBlockReason.
        const picking = buildingRoad?.unitId === unit.id;
        const reason = picking ? null : roadBlockReason(state, unit);
        captureBtn.style.display = 'block';
        captureBtn.disabled = !!reason;
        captureBtn.title = reason ?? '';
        captureBtn.classList.toggle('active', picking);
        captureBtn.textContent = picking
          ? (buildingRoad!.selected.length > 0
            ? `🛤 Confirm ${buildingRoad!.selected.length}/${ROAD_SEGMENTS_PER_ACTIVATION} Road${buildingRoad!.selected.length > 1 ? 's' : ''} (⚡${roadSelectionTotalCost(buildingRoad!.selected)})`
            : `🛤 Pick a hex for the Road… (up to ${ROAD_SEGMENTS_PER_ACTIVATION})`)
          : reason ? `🛤 Build Road — ${reason}` : `🛤 Build Road (⚡${ROAD_COST_PER_HEX})`;
      } else {
        captureBtn.style.display = 'none';
        if (buildingRoad?.unitId === unit.id) clearBuildRoad();
      }

      // Build Farm button (§6-9, phase 10; always-visible §39-40, phase 11) —
      // a separate action from Found/Road above so the Builder can have both
      // available at once. ALWAYS shown for a selected Agrar Builder, with an
      // explicit disabled-state reason rather than being hidden — see
      // farmBlockReason. Ring-pick hex mode, keyed off the Builder unit.
      const ownUpgradeableSite = player.faction === 'temple' ? getStrategicSiteAt(state, unit.pos) : null;
      const unitOnOwnTempleI = !!ownUpgradeableSite && ownUpgradeableSite.state === 'temple'
        && ownUpgradeableSite.templeLevel === 1 && ownUpgradeableSite.ownerId === player.id;
      if (myTurn && isAgrarBuilder) {
        const picking = buildingFarm?.unitId === unit.id;
        const reason = picking ? null : farmBlockReason(state, unit);
        economyBtn.style.display = 'block';
        economyBtn.disabled = !!reason;
        economyBtn.title = reason ?? '';
        economyBtn.classList.toggle('active', picking);
        economyBtn.textContent = picking
          ? (buildingFarm!.selected ? `⚑ Confirm Farm (⚡${AGRAR_FARM_COST})` : '⚑ Tap a highlighted hex for the Farm…')
          : reason ? `⚑ Build Farm — ${reason}` : `⚑ Build Farm (${AGRAR_FARM_COST}⚡)`;
      } else if (myTurn && unitOnOwnTempleI) {
        // Temple-UX fix — the Upgrade action used to live ONLY on the site
        // selection (below), so a friendly unit standing on your own Temple
        // (spawned there, garrisoning it, etc.) hid the button behind an
        // extra tap to switch selection from the unit to the site — easy to
        // read as "can't upgrade while a unit is standing on it". Now shown
        // directly from the unit's own selection too, same as Build Farm.
        const reason = templeUpgradeBlockReason(state, ownUpgradeableSite!.id);
        economyBtn.style.display = 'block';
        economyBtn.classList.remove('active');
        economyBtn.disabled = !!reason;
        economyBtn.title = reason ?? '';
        economyBtn.textContent = reason
          ? `⛩ Upgrade to Temple II — ${reason}`
          : `⛩ Upgrade to Temple II (${TEMPLE_UPGRADE_COST}⚡) — 1 round`;
      } else {
        economyBtn.style.display = 'none';
        if (buildingFarm) clearBuildFarm();
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
      // §5 (phase 11) — recruiting always queues regardless of tile
      // occupancy; occupancy only matters later, at deployment.
      const unitOnStructure = getUnitAt(state, structurePos);
      // v11 — Temple I/II/upgrading economy readout (§21-23).
      let economyNote = '';
      if (site && site.state === 'temple' && site.templeLevel === 1) {
        economyNote = ' | Temple I — Income +1⚡ | Production +0';
      } else if (site && site.state === 'temple' && site.templeLevel === 2) {
        economyNote = ' | Temple II — Income +2⚡ | Production +1 (fully upgraded)';
      } else if (site && site.state === 'upgradingTemple') {
        economyNote = ' | Upgrading to Temple II — Income +1⚡ | Production +0 | completes next round';
      }
      const label = capital
        ? `Capital HP ${capital.hp}/${capital.maxHp}`
        : `Temple HP ${site!.hp}/${site!.maxHp}${economyNote}`;
      const existingPortals = state.teleportBuildings.filter(t => t.templeId === siteId).length;
      const portalNote = existingPortals > 0 ? ` | ⬡ Portal: ${existingPortals}/1` : '';
      unitInfoEl.textContent = unitOnStructure
        ? `${label} (occupied — deploys once the tile is clear)${portalNote}`
        : `${label} — Recruit here${portalNote}`;

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

      // Upgrade to Temple II button — Temple only (Agrar's Farm-building
      // lives on the Builder unit selection instead, see above). Only
      // shown for a Temple I site (§21-22 — Temple II shows no upgrade,
      // an in-progress upgrade shows no button either, see economyNote).
      if (myTurn && site && site.state === 'temple' && site.templeLevel === 1) {
        const reason = templeUpgradeBlockReason(state, siteId);
        economyBtn.style.display = 'block';
        economyBtn.classList.remove('active');
        economyBtn.disabled = !!reason;
        economyBtn.title = reason ?? '';
        economyBtn.textContent = reason
          ? `⛩ Upgrade to Temple II — ${reason}`
          : `⛩ Upgrade to Temple II (${TEMPLE_UPGRADE_COST}⚡) — 1 round`;
      } else {
        economyBtn.style.display = 'none';
        if (buildingFarm) clearBuildFarm();
      }
    }
    captureBtn.style.display = 'none';
    if (buildingRoad) clearBuildRoad();
    destroyArmedUnitId = null;
    hideDestroySlab();
  } else {
    unitInfoEl.textContent = '';
    captureBtn.style.display = 'none';
    if (buildingRoad) clearBuildRoad();
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
      `<div class="spinner"><svg viewBox="0 0 24 24"><path d="M12 2l8.7 5v10L12 22l-8.7-5V7z"/><path d="M12 7v10M7.7 9.5l4.3 2.5 4.3-2.5M7.7 14.5l4.3-2.5 4.3 2.5"/></svg></div>` +
      `<div class="label">Pass the device to</div>` +
      `<div class="hand-name">${escapeHtml(getCurrentPlayer(state).name)}</div>` +
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
  const slots = getProductionSlots(state, player.id);
  const busySlots = getBusyProductionSlotCount(state, player.id);
  popInfoEl.innerHTML =
    `<span class="pill-icon">👥</span>` +
    `<span class="pill-value">${popCount}/${popCap}</span>` +
    `<span class="pill-sub">(🏭${slots - busySlots}/${slots})</span>`;
  popInfoEl.classList.toggle('pop-full', popCount >= popCap || busySlots >= slots);
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
  founder:      'Founder', // faction-flavored name (Builder/Acolyte) comes from unitDisplayName below
};

// §5 (phase 11 correction) — the Builder/Acolyte leads the bar: it's usually
// the first thing either faction needs to recruit, since nothing else can be
// built or founded without it.
const UNIT_CARD_ORDER: UnitType[] = [
  'founder',
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

    // Queued-count badge (§ population/queue clarity pass) — how many of
    // THIS type are already waiting in the training queue at the currently
    // selected structure. Hidden (via updateUnitCards) whenever that count
    // is 0, so it never clutters a card with nothing pending.
    const queuedBadge = document.createElement('div');
    queuedBadge.className = 'unit-card-queued hidden';

    const thumb = document.createElement('img');
    thumb.className = 'unit-card-thumb';
    thumb.src = UNIT_ART[type];
    thumb.alt = UNIT_CARD_NAMES[type];
    thumb.draggable = false;

    const name = document.createElement('div');
    name.className = 'unit-card-name';
    name.textContent = UNIT_CARD_NAMES[type];

    const stats = document.createElement('div');
    stats.className = 'unit-card-stats';

    const cost = document.createElement('div');
    cost.className = 'unit-card-cost';
    // cost value gets refreshed in updateUnitCards (settings can change it)

    const pop = document.createElement('div');
    pop.className = 'unit-card-pop';
    // population/command-cost value gets refreshed in updateUnitCards too —
    // this is the "what population size does this unit take up" indicator.

    stats.append(cost, pop);
    card.append(queuedBadge, thumb, name, stats);
    card.addEventListener('click', () => {
      if (card.classList.contains('disabled')) return;
      handleSpawnBtn(type, card);
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
  // §5 (phase 11) — recruiting only QUEUES a TrainingOrder now; tile
  // occupancy at the structure is checked at DEPLOYMENT time (start of the
  // recruiting player's next round), not here, so a structure with a unit
  // standing on it is still a legal recruit target — no card should grey out
  // for that reason.
  //
  // Population/queue clarity pass — each card now shows its own population
  // (Command) cost up front, not just its Energy cost, and each of the two
  // gates is tinted independently so a disabled card actually explains WHY
  // (can't afford it vs. would bust the population cap vs. every production
  // slot is currently busy), instead of collapsing every reason into one
  // generic greyed-out look.
  const popCap = getPopulationCap(state, player.id);
  const popCount = getPopulationCount(state, player.id);
  const slots = getProductionSlots(state, player.id);
  const busySlots = getBusyProductionSlotCount(state, player.id);
  const slotsFree = busySlots < slots;
  for (const type of UNIT_CARD_ORDER) {
    const card = unitCards.get(type)!;
    // Match the old build menu: locked units are hidden entirely.
    if (!unlocked.has(type)) {
      card.style.display = 'none';
      continue;
    }
    card.style.display = '';

    const auraCost = getUnitCost(type, player.faction);
    const popCost = getUnitCommandCost(type, player.faction);
    const auraOk = player.aura >= auraCost;
    const popOk = popCount + popCost <= popCap;
    const affordable = auraOk && popOk && slotsFree;
    card.classList.toggle('disabled', !affordable);

    const reasons: string[] = [];
    if (!auraOk) reasons.push(`not enough Energy (need ⚡${auraCost})`);
    if (!popOk) reasons.push(`would exceed your population cap (👥${popCount + popCost}/${popCap})`);
    if (!slotsFree) reasons.push(`every production slot is busy (🏭${busySlots}/${slots})`);
    card.title = reasons.join(' · ');

    // Card art = a 3D render of the unit model, team-tinted to the current
    // player. Regenerated when the player colour OR faction changes (faction
    // matters since reveal — e.g. the 'horserider' slot renders a completely
    // different model for Farmer vs Raider — cached otherwise).
    const thumb = card.querySelector('.unit-card-thumb') as HTMLImageElement;
    const thumbKey = `${player.color}:${player.faction ?? ''}`;
    if (thumb && thumb.dataset.thumbKey !== thumbKey) {
      try { thumb.src = getUnitThumbnail(type, player.color, player.faction); thumb.dataset.thumbKey = thumbKey; }
      catch { /* keep the PNG fallback set in buildUnitCards */ }
    }

    // Faction-flavored name (§37/§38 — e.g. Pikeman vs Spearsman for the same slot).
    const name = card.querySelector('.unit-card-name')!;
    name.textContent = unitDisplayName(type, player.faction);

    // Refresh cost (faction-flavored; base UNIT_COSTS is still editable via
    // the settings panel and used as the fallback pre-reveal).
    const cost = card.querySelector('.unit-card-cost')!;
    cost.innerHTML = `<span class="cost-icon">⚡</span>${auraCost}`;
    cost.classList.toggle('chip-bad', !auraOk);

    // Population (Command) cost this unit will take up once recruited —
    // the missing piece that made "what population size does this take up"
    // unclear before.
    const pop = card.querySelector('.unit-card-pop')!;
    pop.innerHTML = `<span class="pop-icon">👥</span>${popCost}`;
    pop.classList.toggle('chip-bad', !popOk);

    // Queued-count badge — how many of THIS type are already waiting in the
    // training queue at the currently selected recruiting structure (§ the
    // "which units are waiting to be created" indicator). Only meaningful
    // while a structure is actually selected (recruiting is only possible
    // from the site-selection view in the first place).
    const queuedBadge = card.querySelector('.unit-card-queued')!;
    const queuedHere = state.selectionMode === 'site' && state.selectedSiteId
      ? state.trainingQueue.filter(o => o.playerId === player.id && o.structureId === state.selectedSiteId && o.unitType === type).length
      : 0;
    queuedBadge.textContent = `×${queuedHere}`;
    queuedBadge.classList.toggle('hidden', queuedHere === 0);
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
  state.buildKind = 'teleport';
  render();
}

// Clear teleport-build state WITHOUT triggering a render. Safe to call from
// inside updateUI()/render() (avoids a nested re-entrant render).
function clearBuildTeleport(): void {
  buildingTeleport = null;
  state.buildHexes = [];
  state.buildKind = null;
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

// ── Build Farm (Builder-driven, §6-9) / Buy Devotion (site-driven, §15) ──
//
// Farm-placement UX pass — Farm placement is now select-then-confirm (like
// Road below), not instant-on-click: tapping a legal hex selects it (ghost
// Farm model + a much stronger highlight — see renderer.setFarmSelectionPreview),
// tapping a different legal hex just moves the selection, and either
// pressing Confirm or tapping the already-selected hex again actually builds.
// Tapping an illegal hex always explains why (farmHexIllegalReason) and
// stays in placement mode — only Cancel/deselect/turn-change/another-mode
// actually exits it.

interface BuildFarmState {
  unitId: string;
  selected: HexCoord | null;
}

let buildingFarm: BuildFarmState | null = null;

function enterBuildFarm(unitId: string): void {
  const unit = state.units.find(u => u.id === unitId);
  buildingFarm = { unitId, selected: null };
  state.buildHexes = unit ? getValidFarmHexes(state, unit) : [];
  state.buildKind = 'farm';
  renderer.setFarmSelectionPreview(null);
  render();
}

// Clear farm-build state WITHOUT triggering a render — safe from inside render().
function clearBuildFarm(): void {
  buildingFarm = null;
  state.buildHexes = [];
  state.buildKind = null;
  renderer.setFarmSelectionPreview(null);
}

function cancelBuildFarm(): void {
  clearBuildFarm();
  render();
}

// Confirms the tentatively-selected Farm tile as one Builder activation.
// Pressing Confirm (or the Build Farm slab itself, mirroring Road's own
// press-again-to-confirm) with nothing selected yet is just a cancel.
function confirmBuildFarm(): void {
  if (!buildingFarm || !buildingFarm.selected) { cancelBuildFarm(); return; }
  const { unitId, selected } = buildingFarm;
  clearBuildFarm();
  sendOrCall({ type: 'action', action: 'build-farm', params: { unitId, pos: selected } }, () => {
    const started = startFarm(state, unitId, selected);
    if (started) {
      logCombat(`Began building a Farm at (${selected.q},${selected.r}) for ${AGRAR_FARM_COST}⚡`);
      // Refresh move/attack highlights — the Builder just spent its activation,
      // but nothing else re-derives state.moveHexes/attackHexes on its own, so
      // without this the OLD (pre-build) move range would keep rendering and
      // visually mask the new Farm/Road tile wherever the two happen to overlap.
      selectUnit(state, unitId);
    }
  });
  render();
}

economyBtn.addEventListener('click', () => {
  if (buildingFarm) {
    if (buildingFarm.selected) confirmBuildFarm(); else cancelBuildFarm();
    return;
  }
  // Agrar: Build Farm — triggered from the Builder's own unit selection.
  if (state.selectionMode === 'unit' && state.selectedUnitId) {
    const unit = state.units.find(u => u.id === state.selectedUnitId);
    if (unit && getValidFarmHexes(state, unit).some(h => canStartFarm(state, unit, h))) {
      enterBuildFarm(unit.id);
      return;
    }
    // Temple: Upgrade to Temple II — triggered from a friendly unit standing
    // on your own Temple I (mirrors the site-selection path below, so
    // standing a unit on the Temple never blocks upgrading it).
    const player = state.players.find(p => p.id === unit?.playerId);
    const site = unit ? getStrategicSiteAt(state, unit.pos) : undefined;
    if (unit && player?.faction === 'temple' && site && site.state === 'temple'
      && site.templeLevel === 1 && site.ownerId === player.id) {
      const siteId = site.id;
      sendOrCall({ type: 'action', action: 'upgrade-temple', params: { templeId: siteId } }, () => {
        if (startTempleUpgrade(state, siteId)) logCombat(`Started upgrading Temple to Temple II (${TEMPLE_UPGRADE_COST}⚡)`);
      });
    }
    return;
  }
  // Temple: Upgrade to Temple II — triggered from the Temple site selection.
  if (state.selectionMode === 'site' && state.selectedSiteId) {
    const siteId = state.selectedSiteId;
    const site = state.strategicSites.find(s => s.id === siteId);
    if (!site || site.state !== 'temple') return;
    sendOrCall({ type: 'action', action: 'upgrade-temple', params: { templeId: siteId } }, () => {
      if (startTempleUpgrade(state, siteId)) logCombat(`Started upgrading Temple to Temple II (${TEMPLE_UPGRADE_COST}⚡)`);
    });
  }
});

// ── Build Road (Builder-driven, adjacency + network-connectivity §23-25) ──
//
// Balance pass (ROAD_SEGMENTS_PER_ACTIVATION 3->2) — a Road hex must be
// adjacent to the Builder AND itself adjacent to the Capital/a Farm/an
// existing Road for the FIRST tile (see getValidRoadHexes); every later
// tile (up to ROAD_SEGMENTS_PER_ACTIVATION total) must chain directly off
// the one just picked and stay legal/affordable — mirrors buildRoadPath's
// own per-segment rules exactly (roadCandidatesFor below), so nothing the
// preview offers can ever be rejected at confirm time. This used to
// resolve instantly on the first click; it's now a genuine multi-select
// (pick 1 or 2 tiles, then confirm) so a human's Road build goes through
// the exact same buildRoadPath the AI/headless play already use, not a
// separate single-hex-only path.

interface BuildRoadState {
  unitId: string;
  selected: HexCoord[];
}

let buildingRoad: BuildRoadState | null = null;

function roadHexCost(hex: HexCoord): number {
  return state.pillagedRoadHexes.has(hexKey(hex)) ? ROAD_PILLAGE_REBUILD_COST : ROAD_COST_PER_HEX;
}

function roadSelectionTotalCost(selected: HexCoord[]): number {
  return selected.reduce((sum, h) => sum + roadHexCost(h), 0);
}

// Legal candidates for the NEXT tile given what's already selected.
function roadCandidatesFor(unit: Unit, selected: HexCoord[]): HexCoord[] {
  const player = state.players.find(p => p.id === unit.playerId);
  if (!player) return [];
  if (selected.length === 0) {
    return getValidRoadHexes(state, unit).filter(h => canBuildRoad(state, unit, h));
  }
  if (selected.length >= ROAD_SEGMENTS_PER_ACTIVATION) return [];
  const remaining = player.aura - roadSelectionTotalCost(selected);
  const last = selected[selected.length - 1]!;
  return hexNeighbors(last).filter(h =>
    hexDistance({ q: 0, r: 0 }, h) <= state.mapRadius
    && !selected.some(s => hexEqual(s, h))
    && isLegalRoadTile(state, h, player.id)
    && remaining >= roadHexCost(h));
}

function enterBuildRoad(unitId: string): void {
  const unit = state.units.find(u => u.id === unitId);
  buildingRoad = { unitId, selected: [] };
  state.buildHexes = unit ? roadCandidatesFor(unit, []) : [];
  state.buildKind = 'road';
  renderer.setRoadSelectionPreview([]);
  render();
}

// Clear road-build state WITHOUT triggering a render — safe from inside render().
function clearBuildRoad(): void {
  buildingRoad = null;
  state.buildHexes = [];
  state.buildKind = null;
  renderer.setRoadSelectionPreview([]);
}

function cancelBuildRoad(): void {
  clearBuildRoad();
  render();
}

// Confirms whatever's currently selected (1 or up to ROAD_SEGMENTS_PER_
// ACTIVATION tiles) as one Builder activation, through the exact same
// buildRoadPath mutator the AI/headless play already use.
function confirmBuildRoad(): void {
  if (!buildingRoad || buildingRoad.selected.length === 0) { cancelBuildRoad(); return; }
  const { unitId, selected } = buildingRoad;
  const totalCost = roadSelectionTotalCost(selected);
  clearBuildRoad();
  sendOrCall({ type: 'action', action: 'build-road', params: { unitId, path: selected } }, () => {
    const built = buildRoadPath(state, unitId, selected);
    if (built.length > 0) {
      logCombat(`Built ${built.length} road segment${built.length > 1 ? 's' : ''} for ${totalCost}⚡`);
      // Refresh move/attack highlights — see the identical note in confirmBuildFarm.
      selectUnit(state, unitId);
    }
  });
  render();
}

// Farm/Road placement UX pass — a visible Cancel button (works with no
// hover, so touch always has a way out of placement mode) plus a compact,
// unobtrusive legend explaining the highlight colors — kept in sync every
// render, independent of whatever else is selected.
function syncPlacementCancelAndLegend(): void {
  if (buildingFarm) {
    placementCancelBtn.style.display = 'block';
    placementCancelBtn.onclick = () => cancelBuildFarm();
    placementLegendEl.style.display = 'block';
    placementLegendEl.textContent = buildingFarm.selected
      ? 'Ghost + bright pulse = your selected Farm tile · tap it again or press Confirm to build'
      : 'Pulsing green hex = legal Farm site · tap one to preview it · tap any other tile to see why it\'s invalid';
  } else if (buildingRoad) {
    placementCancelBtn.style.display = 'block';
    placementCancelBtn.onclick = () => cancelBuildRoad();
    placementLegendEl.style.display = 'block';
    placementLegendEl.textContent = buildingRoad.selected.length === 0
      ? 'Pulsing cyan hex = legal Road start · tap one to select (up to 2 tiles this activation)'
      : 'Gold hex = selected Road · pulsing cyan = legal next tile · press Confirm when done';
  } else {
    placementCancelBtn.style.display = 'none';
    placementLegendEl.style.display = 'none';
  }
}

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

// ── Research panel (lane × tier graph) ───────────────────────────────────────
//
// Lanes: Siege, Heavy Unit, Command (linear), Stat Bonus + Support (pick-one
// branches). Tiers by prerequisite count: 0 = Foundation, 1 = Advanced,
// 2 = Elite. Prerequisites are drawn as connectors in an SVG overlay; nodes
// are compact medallions and the ONE detail pane pinned to the bottom of the
// panel carries the description, prerequisite checklist and the Research
// button — the node itself is never the buy button any more.

type TechStatus = 'researching' | 'researched' | 'slot' | 'locked' | 'branch' | 'command2' | 'poor' | 'available';
interface TechLane { title: string; branch?: string; nodes: typeof TECH_NODES; }

// Mirrors game.ts's COMMAND_2_MIN_OTHER_TECHS (not exported — canResearch is
// the source of truth for the actual gate), purely for the disabled-reason
// text and the prerequisite checklist.
const COMMAND_2_MIN_OTHER_TECHS_UI = 2;

// Glyphs for techs that don't unlock a unit (no thumbnail to show).
const TECH_GLYPH: Partial<Record<TechId, string>> = {
  command_1: '⚑', command_2: '⚑', agrar_heavy_armor: '🛡', temple_warrior_rite: '🔥',
  agrar_siegecraft_splash: '💥', temple_mobile_siege_splash: '💥', longrange_hp: '🏹', horse_sight: '👁',
};

let selectedTechId: TechId | null = null;
let techStatusMap: Map<TechId, TechStatus> = new Map();

function techLanes(faction: FactionId | null): TechLane[] {
  const own = (n: typeof TECH_NODES[number]) => !n.faction || n.faction === faction;
  const pick = (...ids: string[]) => TECH_NODES.filter(n => own(n) && ids.includes(n.id));
  return [
    { title: 'Siege', nodes: pick('agrar_siegecraft', 'agrar_siegecraft_splash', 'temple_mobile_siege_tech', 'temple_mobile_siege_splash') },
    { title: 'Heavy Unit', nodes: pick('agrar_heavy_armor', 'agrar_heavy_knight_tech', 'temple_warrior_rite', 'temple_champion_rite') },
    { title: 'Command', nodes: pick('command_1', 'command_2') },
    { title: 'Stat bonus', branch: 'stat_bonus', nodes: TECH_NODES.filter(n => n.branch === 'stat_bonus') },
    { title: 'Support', branch: 'support', nodes: TECH_NODES.filter(n => n.branch === 'support') },
  ];
}

function techStatus(node: typeof TECH_NODES[number], tech: PlayerTech, aura: number, lane: typeof TECH_NODES): TechStatus {
  if (tech.researching?.techId === node.id) return 'researching';
  if (tech.researched.has(node.id)) return 'researched';
  if (tech.researching) return 'slot';
  const prereqsMet = node.prereqs.every(p => tech.researched.has(p));
  const branchBlocked = !!node.branch && lane.some(n => n.id !== node.id && tech.researched.has(n.id));
  const command2Blocked = node.id === 'command_2' && prereqsMet &&
    [...tech.researched].filter(id => id !== 'command_1' && id !== 'command_2').length < COMMAND_2_MIN_OTHER_TECHS_UI;
  if (branchBlocked) return 'branch';
  if (command2Blocked) return 'command2';
  if (!prereqsMet) return 'locked';
  if (aura < node.cost) return 'poor';
  return 'available';
}

// The art a tech card "stands for": the unlocked unit, or the Catapult/Mobile
// Siege model for its splash sub-upgrade. Rendered (team-coloured) the same
// way as the build-card thumbnails, so the tech tree shows the actual model.
function techNodeArt(node: typeof TECH_NODES[number], color: string): string | null {
  if (node.unitUnlock) return getUnitThumbnail(node.unitUnlock, color, node.faction);
  if (node.id === 'agrar_siegecraft_splash' || node.id === 'temple_mobile_siege_splash') return getUnitThumbnail('catapult', color, node.faction);
  return null;
}

function techMedallion(node: typeof TECH_NODES[number], color: string): string {
  const art = techNodeArt(node, color);
  return art ? `<img src="${art}" alt="" draggable="false">` : `<span>${TECH_GLYPH[node.id] ?? '✦'}</span>`;
}

const techName = (id: TechId): string => TECH_NODES.find(n => n.id === id)?.name ?? id;

function renderTechTree(): void {
  const player = getCurrentPlayer(state);
  const tech = state.playerTech[player.id]!;
  techAuraInfo.textContent = `⚡ ${player.aura} aura`;

  const lanes = techLanes(player.faction);
  techStatusMap = new Map();
  for (const lane of lanes) for (const n of lane.nodes) techStatusMap.set(n.id, techStatus(n, tech, player.aura, lane.nodes));
  if (!selectedTechId || !techStatusMap.has(selectedTechId)) {
    selectedTechId = tech.researching?.techId
      ?? [...techStatusMap.entries()].find(([, st]) => st === 'available')?.[0]
      ?? lanes[0]!.nodes[0]!.id;
  }
  const remaining = tech.researching ? Math.max(1, tech.researching.completesRound - state.turnNumber) : 0;

  // one research slot — status bar up top
  let slot: string;
  if (tech.researching) {
    const n = TECH_NODES.find(x => x.id === tech.researching!.techId)!;
    const pct = Math.round(((n.researchTime - remaining) / n.researchTime) * 100);
    slot = `<div class="tt-slot">Research slot: <b>${n.name}</b> · ${remaining} round${remaining === 1 ? '' : 's'} left <div class="bar"><i style="width:${Math.max(8, pct)}%"></i></div></div>`;
  } else {
    slot = `<div class="tt-slot idle">Research slot: <b>idle</b> — pick a glowing node <div class="bar"><i style="width:100%"></i></div></div>`;
  }

  // lane × tier grid
  let grid = `<div class="tt-tiers"><div></div><div class="tt-tier">Foundation</div><div class="tt-tier">Advanced</div><div class="tt-tier">Elite</div></div>`;
  for (const lane of lanes) {
    grid += `<div class="tt-lane"><div class="tt-lane-label">${lane.title}${lane.branch ? '<small>pick one</small>' : ''}</div>`;
    for (let tier = 0; tier < 3; tier++) {
      const cell = lane.nodes.filter(n => n.prereqs.length === tier);
      const isPick = !!lane.branch && tier === 0;
      const made = isPick && lane.nodes.some(n => tech.researched.has(n.id));
      grid += `<div class="tt-cell${isPick ? ' pick' : ''}${made ? ' locked-branch' : ''}">`;
      for (const n of cell) {
        const st = techStatusMap.get(n.id)!;
        const cls = st === 'researching' || st === 'researched' || st === 'available' || st === 'poor' ? st : 'locked';
        const badge = st === 'researched' ? '✓' : st === 'researching' ? String(remaining) : cls === 'locked' ? '🔒' : '';
        const prog = st === 'researching' ? ` style="--p:${Math.round(((n.researchTime - remaining) / n.researchTime) * 100)}%"` : '';
        grid += `<div class="tt-node ${cls}${selectedTechId === n.id ? ' sel' : ''}" data-id="${n.id}" role="button" tabindex="0">
          <div class="tt-med">${techMedallion(n, player.color)}<div class="tt-ring"${prog}></div>${badge ? `<div class="tt-badge">${badge}</div>` : ''}</div>
          <div class="tt-txt"><div class="tt-name">${n.name}</div><div class="tt-meta"><span class="tt-cost">${n.cost} ⚡</span><span class="tt-time">${n.researchTime} rd</span></div></div>
        </div>`;
      }
      grid += `</div>`;
    }
    grid += `</div>`;
  }

  // detail pane (pinned to the panel bottom — always visible, never scrolls away)
  const sel = TECH_NODES.find(n => n.id === selectedTechId)!;
  const selStatus = techStatusMap.get(sel.id)!;
  const reqs = sel.prereqs.map(p => `${tech.researched.has(p) ? '<b>✓</b>' : '<s>✗</s>'} ${techName(p)}`);
  if (sel.id === 'command_2') {
    const others = [...tech.researched].filter(id => id !== 'command_1' && id !== 'command_2').length;
    reqs.push(`${others >= COMMAND_2_MIN_OTHER_TECHS_UI ? '<b>✓</b>' : '<s>✗</s>'} any ${COMMAND_2_MIN_OTHER_TECHS_UI} other techs`);
  }
  const researchable = selStatus === 'available' && canResearch(state, sel.id);
  const myTurn = localHasTurn();
  const btnText =
    selStatus === 'researched' ? '✓ Researched'
    : selStatus === 'researching' ? `⏳ ${remaining} round${remaining === 1 ? '' : 's'} left`
    : selStatus === 'slot' ? 'Research slot busy'
    : selStatus === 'poor' ? `Need ${sel.cost} ⚡`
    : selStatus === 'branch' ? 'Branch already chosen'
    : selStatus === 'command2' ? `Needs ${COMMAND_2_MIN_OTHER_TECHS_UI} other techs`
    : selStatus === 'locked' ? 'Prerequisite missing'
    : !myTurn ? 'Not your turn'
    : `Research · ${sel.cost} ⚡`;
  const detail = `<div class="tt-detail">
    <div class="tt-med">${techMedallion(sel, player.color)}</div>
    <div class="tt-detail-txt"><h4>${sel.name} <span>· ${sel.cost} ⚡ · ${sel.researchTime} round${sel.researchTime === 1 ? '' : 's'}</span></h4>
      <p>${escapeHtml(sel.description)}</p>${reqs.length ? `<div class="req">Requires: ${reqs.join(' &nbsp;·&nbsp; ')}</div>` : ''}</div>
    <button class="tt-btn" id="techResearchBtn" ${researchable && myTurn ? '' : 'disabled'}>${btnText}</button>
  </div>`;

  techBody.innerHTML = `<div class="tt-scroll">${slot}<div class="tt-graph"><svg class="tt-svg"></svg>${grid}</div></div>${detail}`;

  techBody.querySelectorAll<HTMLElement>('.tt-node').forEach(el => {
    const pickIt = (): void => { selectedTechId = el.dataset.id as TechId; renderTechTree(); };
    el.addEventListener('click', pickIt);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickIt(); } });
  });

  const btn = document.getElementById('techResearchBtn') as HTMLButtonElement | null;
  if (btn && researchable && myTurn) {
    btn.addEventListener('click', () => {
      if (!localHasTurn()) return; // view-only on an opponent's turn (server rejects too)
      const node = sel;
      const applyLocal = (): void => {
        if (researchTech(state, node.id)) {
          logCombat(`Started research: ${node.name} (−${node.cost} ⚡, ${node.researchTime} round${node.researchTime === 1 ? '' : 's'})`);
          renderTechTree();
        }
      };
      if (multiplayerMode && mpClient) {
        // Optimistic: apply the purchase locally for instant feedback (aura
        // pill drops, unit unlocks appear) instead of waiting for the server
        // round-trip. Snapshot first so a (rare) server rejection can roll it
        // back; the authoritative state_update otherwise reconciles it.
        // Deep copy: serialize() shares the player objects with the live state,
        // so a shallow snapshot already contained the deducted aura and a
        // rejection never refunded it. Keep the oldest snapshot while a
        // purchase is still unanswered.
        researchRollback ??= structuredClone(serialize(state));
        applyLocal();
        render();                       // reflect deducted aura / unlocks now
        mpClient.sendAction({ type: 'action_research', techId: node.id });
      } else {
        applyLocal();
        render();
      }
    });
  }

  requestAnimationFrame(drawTechLinks);
}

// Prerequisite connectors. Orthogonal routing: leave the prereq's right edge,
// run to the gutter between its column and the next, climb/drop vertically in
// that gutter, then run horizontally into the target's left edge. Vertical
// travel only ever happens in a gutter, so a line never crosses another node.
function drawTechLinks(): void {
  const graph = techBody.querySelector<HTMLElement>('.tt-graph');
  const svg = graph?.querySelector<SVGSVGElement>('.tt-svg');
  if (!graph || !svg || techOverlay.classList.contains('hidden')) return;
  const gb = graph.getBoundingClientRect();
  if (gb.width === 0) return;
  const nodeEl = (id: string) => graph.querySelector<HTMLElement>(`[data-id="${id}"]`);
  const tiers = Array.from(graph.querySelectorAll<HTMLElement>('.tt-tier')).map(t => t.getBoundingClientRect());
  const gutterAfter = (colRight: number): number => {
    const next = tiers.find(t => t.left - gb.left > colRight + 1);
    return next ? (colRight + (next.left - gb.left)) / 2 : colRight + 10;
  };
  const r = 6;
  let d = '';
  for (const [id] of techStatusMap) {
    const n = TECH_NODES.find(x => x.id === id)!;
    const to = nodeEl(id)?.getBoundingClientRect(); if (!to) continue;
    n.prereqs.forEach((p, i) => {
      const from = nodeEl(p)?.getBoundingClientRect(); if (!from) return;
      const x1 = from.right - gb.left, y1 = from.top + from.height / 2 - gb.top;
      const x2 = to.left - gb.left, y2 = to.top + to.height / 2 - gb.top;
      const done = techStatusMap.get(p) === 'researched';
      const col = done ? '#33e0a0' : '#4a5670';
      const straight = Math.abs(y1 - y2) < 2;
      const yIn = straight || n.prereqs.length < 2 ? y2 : y2 + (i - (n.prereqs.length - 1) / 2) * 8;
      let path: string;
      if (straight) path = `M${x1},${y1} L${x2},${yIn}`;
      else {
        const gx = gutterAfter(from.right - gb.left);
        const dir = yIn > y1 ? 1 : -1;
        path = `M${x1},${y1} L${gx - r},${y1} Q${gx},${y1} ${gx},${y1 + dir * r} L${gx},${yIn - dir * r} Q${gx},${yIn} ${gx + r},${yIn} L${x2},${yIn}`;
      }
      d += `<path d="${path}" fill="none" stroke="${col}" stroke-width="2" ${done ? '' : 'stroke-dasharray="5 4"'} stroke-linecap="round" opacity=".95"/>`;
      d += `<circle cx="${x1}" cy="${y1}" r="3" fill="${col}"/><circle cx="${x2}" cy="${yIn}" r="3" fill="${col}"/>`;
    });
  }
  svg.innerHTML = d;
}
// Connectors are position-derived, so redraw whenever the panel reflows
// (orientation change, keyboard, column collapse on phones).
new ResizeObserver(() => drawTechLinks()).observe(techBody);

function openTechTree(): void {
  if (!gameStarted) return;
  if (spectatorMode) return;
  // The tech tree stays openable and browsable even when it's NOT your turn
  // (view-only) — buying a tech is gated to your own turn in renderTechTree.
  techOverlay.classList.remove('hidden'); // unhide first — connector geometry needs real layout
  renderTechTree();
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

// ── Found/reconstruct (3rd HUD slab) ──
// Starts founding/reconstruction at the neutral or ruined site the selected
// Acolyte is standing on (§7-10, v13 — an active enemy Temple must be
// destroyed first; standing on it never changes ownership).
// The same slab does double duty for the Builder: found a site if it's
// standing on a neutral/ruined one, otherwise enter Build Road ring-pick
// mode if that's available (Agrar only, §23-25) — mutually exclusive
// per-selection states, so there's no ambiguity about which one fires.
function doFound(): void {
  // Pressing the same slab again while mid-selection confirms whatever's
  // picked so far (1 tile is a completely valid, deliberate choice — see
  // §3's "allow building only one Road if the player chooses only one");
  // with nothing selected yet it's still a plain cancel.
  if (buildingRoad) {
    if (buildingRoad.selected.length > 0) confirmBuildRoad(); else cancelBuildRoad();
    return;
  }
  if (state.selectionMode !== 'unit' || !state.selectedUnitId) return;
  const unit = state.units.find(u => u.id === state.selectedUnitId);
  if (!unit) return;
  const check = canStartFounding(state, unit);
  if (check) {
    sendOrCall({ type: 'action', action: 'found', params: { unitId: unit.id } }, () => {
      if (startFounding(state, unit.id)) {
        logCombat(`Began founding a ${check.targetState} at (${unit.pos.q},${unit.pos.r})`);
        selectUnit(state, unit.id); // refresh move/attack highlights — the unit just spent its activation
      }
    });
    return;
  }
  // v14 — same priority order as the button's own display logic: Claim
  // Fertile Site (if standing on one) beats Build Road for a Builder.
  if (canClaimFertileSite(state, unit)) {
    sendOrCall({ type: 'action', action: 'claim-fertile-site', params: { unitId: unit.id } }, () => {
      if (claimFertileSite(state, unit.id)) {
        logCombat(`Claimed a Fertile Site at (${unit.pos.q},${unit.pos.r})`);
        selectUnit(state, unit.id);
      }
    });
    return;
  }
  if (canPillageRoad(state, unit)) {
    sendOrCall({ type: 'action', action: 'pillage-road', params: { unitId: unit.id } }, () => {
      if (pillageRoad(state, unit.id)) {
        logCombat(`Pillaged a Road at (${unit.pos.q},${unit.pos.r})`);
        selectUnit(state, unit.id);
      }
    });
    return;
  }
  if (getValidRoadHexes(state, unit).some(h => canBuildRoad(state, unit, h))) {
    enterBuildRoad(unit.id);
  }
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

  // ── Build Farm mode: select a Farm hex, then Confirm (UI is always local,
  // only the final confirmed action is sent). Tapping the tile already
  // selected confirms immediately — a tap-tap gesture works with no hover,
  // no separate Confirm press required, on both desktop and touch. Tapping
  // any OTHER illegal tile always explains why and stays in placement mode
  // (see farmHexIllegalReason — reads the same canonical engine result
  // actual construction uses, never a UI-only re-derivation of the rules). ──
  if (buildingFarm) {
    const bf = buildingFarm;
    const builder = state.units.find(u => u.id === bf.unitId);
    if (builder && state.buildHexes.some(h => hexEqual(h, hex))) {
      if (bf.selected && hexEqual(bf.selected, hex)) {
        confirmBuildFarm();
        return;
      }
      bf.selected = hex;
      renderer.setFarmSelectionPreview(hex, state.players.find(p => p.id === builder.playerId)?.color, state);
      showToast(`Farm selected at (${hex.q},${hex.r}) — tap it again or press Confirm to build (⚡${AGRAR_FARM_COST})`, 'neutral');
      render();
      return;
    } else {
      const reason = builder ? farmHexIllegalReason(state, builder, hex) : null;
      if (reason) { showToast(`Can't build a Farm here — ${reason}`, 'bad'); return; }
      cancelBuildFarm();
      render();
      return;
    }
  }

  // ── Build Road mode: accumulate up to ROAD_SEGMENTS_PER_ACTIVATION Road
  // tiles, then confirm as one Builder activation (UI is always local, only
  // the final confirmed action is sent). Tapping an illegal tile always
  // explains why and stays in placement mode — same principle as Farm above,
  // via roadHexIllegalReason (the same canonical engine result). ──
  if (buildingRoad) {
    const br = buildingRoad;
    const unit = state.units.find(u => u.id === br.unitId);
    if (unit && state.buildHexes.some(h => hexEqual(h, hex))) {
      br.selected.push(hex);
      const nextCandidates = roadCandidatesFor(unit, br.selected);
      state.buildHexes = nextCandidates;
      renderer.setRoadSelectionPreview([...br.selected], state);
      if (br.selected.length >= ROAD_SEGMENTS_PER_ACTIVATION || nextCandidates.length === 0) {
        // Maxed out, or nothing legal/affordable left to extend with.
        confirmBuildRoad();
        return;
      }
      showToast(
        `Road ${br.selected.length}/${ROAD_SEGMENTS_PER_ACTIVATION} selected (${roadSelectionTotalCost(br.selected)}⚡ so far) — pick another tile or press Confirm`,
        'neutral',
      );
      render();
      return;
    } else {
      const reason = unit ? roadHexIllegalReason(state, unit, hex, br.selected) : null;
      if (reason) { showToast(`Can't lay a Road here — ${reason}`, 'bad'); return; }
      cancelBuildRoad();
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
        const fertileSite = state.fertileSites.find(f => hexEqual(f.pos, hex));
        const movingPlayer = movingUnit ? state.players.find(p => p.id === movingUnit.playerId) : undefined;
        if (movingPlayer?.faction === 'temple' && site && (site.state === 'neutral' || site.state === 'ruins')) {
          logCombat(`Moved onto a foundable site at (${hex.q},${hex.r}) — Found available!`);
        } else if (fertileSite && movingUnit && fertileSite.ownerId !== movingUnit.playerId) {
          logCombat(`Moved onto a Fertile Site at (${hex.q},${hex.r}) — Claim available!`);
        } else {
          logCombat(`Moved to (${hex.q}, ${hex.r})`);
        }
      } else if (moveResult.blocked) {
        showToast('Something blocks the way — an unseen unit stands there.', 'bad');
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
  // while occupied. First tap controls the unit (moving/attacking is by far
  // the more common action, and a unit that looks selected but shows no move
  // highlights reads as "stuck"/broken); tap again surfaces the structure's
  // recruit tray.
  if (myStructureHere && myUnitHere) {
    const unitSelected = state.selectionMode === 'unit' && state.selectedUnitId === unit!.id;
    if (unitSelected) {
      sendOrCall({ type: 'action_select_temple', templeId: structureId! }, () => selectSite(state, structureId!));
    } else {
      sendOrCall({ type: 'action_select_unit', unitId: unit!.id }, () => selectUnit(state, unit!.id));
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

  // v14 §11 — Fertile Sites aren't a recruit-eligible "owned structure" (no
  // selectSite support), so surface their status as a toast on click instead
  // of silently falling through to deselect.
  if (!unit && !structureRef) {
    const fertileSite = state.fertileSites.find(f => hexEqual(f.pos, hex));
    if (fertileSite) {
      const owner = fertileSite.ownerId !== null ? state.players.find(p => p.id === fertileSite.ownerId)?.name : null;
      const status = owner ? `Controlled by ${owner}` : 'Unclaimed';
      showToast(`Fertile Site — ${status} — Income when controlled: +${FERTILE_SITE_INCOME}⚡/round`);
    }
  }

  // Deselect
  if (buildingTeleport) cancelBuildTeleport();
  if (buildingFarm) cancelBuildFarm();
  if (buildingRoad) cancelBuildRoad();
  sendOrCall({ type: 'action_deselect' }, () => deselectAll(state));
}

// ── Spawn buttons ──
// `card` is the exact DOM element clicked — used purely for the transient
// "just queued this" flash (§ activation-indicator pass), never for logic.
function handleSpawnBtn(type: UnitType, card?: HTMLElement): void {
  if (!localHasTurn()) return; // no recruiting on an opponent's turn (online)
  if (state.selectionMode !== 'site' || !state.selectedSiteId) return;
  if (!canAfford(state, type)) return;
  const structureId = state.selectedSiteId;
  // §5 (phase 11) — recruiting only QUEUES a TrainingOrder now; it does NOT
  // require (or create) a unit on the structure's tile immediately, so there
  // is nothing to block here even if the tile is currently occupied.
  sendOrCall({ type: 'action_spawn', templeId: structureId, unitType: type }, () => {
    try {
      if (spawnUnit(state, structureId, type)) {
        const spawnPlayer = getCurrentPlayer(state);
        logCombat(`Queued ${unitDisplayName(type, spawnPlayer.faction)} for ⚡${getUnitCost(type, spawnPlayer.faction)} + 👥${getUnitCommandCost(type, spawnPlayer.faction)} — deploys next round`);
        // A brief flash on the card itself — immediate confirmation the click
        // actually registered as "now training", separate from (and faster
        // to notice than) the combat-log line or the queued-count badge.
        if (card) {
          card.classList.remove('unit-card-flash');
          void card.offsetWidth; // restart the CSS animation even on rapid repeat clicks
          card.classList.add('unit-card-flash');
        }
      }
    } catch (e: unknown) {
      logCombat(e instanceof Error ? e.message : 'Cannot recruit unit');
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
  // §23 — two-tap confirm (mirrors the destroy slab) when units remain
  // unacted: first tap arms the button and names how many are left instead
  // of ending the round; a second tap while still armed proceeds anyway.
  if (!buildingFarm && !buildingRoad && !buildingTeleport) {
    const remaining = unactedUnitCount(state, getCurrentPlayer(state).id);
    if (remaining > 0 && !endTurnArmed) {
      endTurnArmed = true;
      renderer.setHudButtonArmed('endTurn', true);
      renderer.setHudButtonPrice('endTurn', `${remaining} unit${remaining > 1 ? 's' : ''} left — Sure?`);
      return;
    }
  }
  endTurnArmed = false;
  announcedAllActedThisTurn = false;
  renderer.setHudButtonArmed('endTurn', false);
  if (buildingTeleport) cancelBuildTeleport();
  if (buildingFarm) cancelBuildFarm();
  if (buildingRoad) cancelBuildRoad();
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

  // Each AI seat runs at its own difficulty — runAiTurn defaults the acting
  // player to the current slot, so this drives any AI in an N-player game.
  const seatDifficulty = controllers[state.currentPlayerIndex] as AiDifficulty;
  const actions = runAiTurn(state, seatDifficulty);
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

// The menu is up on first load — bring the living board with it.
if (!menuOverlay.classList.contains('hidden')) ensureMenuScene();
