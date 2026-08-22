import { Router, Request, Response } from 'express';
import {
  createGameState,
  getPopulationCap, getPopulationCount,
  getEffectiveRange,
  getPlayerVisible, isForestUnitRevealed,
  PlayerConfig,
} from '../src/game';
import { runAITurn, runHardAITurn } from '../src/ai';
import { resyncCounters } from './stateUtils';
import {
  GameState, UnitType, TechId,
  HexCoord, PLAYER_COLORS, MAX_PLAYERS,
} from '../src/types';
import { serialize } from '../src/serializer';
import { hexKey, getReachableHexes, hexDistance } from '../src/hex';
import { initReplay, appendEvent, finalizeReplay, readReplayFile, listReplays } from './gameLogger';
import {
  executeAction,
  UnifiedActionName,
  computeUnitActions,
  computePlayerLegalMoves,
  buildRulesPayload,
} from './actionDispatcher';

// ── Headless action discriminated union ──
// Mirrors src/protocol.ts ClientMessage for the REST transport.

export type HeadlessAction =
  | { action: 'move';            params: { unitId: string; to: HexCoord } }
  | { action: 'attack';          params: { unitId: string; targetId: string } }
  | { action: 'attack-structure'; params: { unitId: string; targetPos: HexCoord } }
  | { action: 'recruit';         params: { unitType: UnitType; templeId: string } }
  | { action: 'found';           params: { unitId: string } }
  | { action: 'destroy';         params: { unitId: string } }
  | { action: 'research';        params: { techId: TechId } }
  | { action: 'build-teleport';  params: { templeId: string; pos: HexCoord; targetPos: HexCoord } }
  | { action: 'end-turn';        params?: Record<string, never> }
  | { action: 'resign';          params?: Record<string, never> }
  | { action: 'choose-faction';  params: { faction: 'agrar' | 'temple' } }
  ;

export type HeadlessActionType = HeadlessAction['action'];

// Per-seat controller for headless auto-play. 'human' seats are driven by
// external POST /action calls; 'normal' / 'hard' seats can be auto-played by the
// built-in AI (POST /ai-turn, POST /auto-play).
export type HeadlessController = 'human' | 'normal' | 'hard';

interface HeadlessActionRequestBody {
  playerId: number;
  action: HeadlessActionType;
  params?: Record<string, unknown>;
}

// ── Types ──

interface ActionLogEntry {
  tick: number;
  playerId: number;
  action: string;
  params: Record<string, unknown>;
  result: string;
  timestamp: number;
}

export interface HeadlessSession {
  gameState: GameState;
  log: ActionLogEntry[];
  createdAt: number;
  tick: number;
  // Per-seat controller (index === player slot). Used by the AI auto-play
  // endpoints; external clients can still drive any seat via POST /action.
  controllers: HeadlessController[];
}

// ── Session storage ──

export const headlessSessions = new Map<string, HeadlessSession>();

// ── Spectator push hook (set by gameManager to avoid circular deps) ──

let _pushUpdate: ((gameId: string) => void) | null = null;
export function setHeadlessSpectatorPush(fn: (gameId: string) => void): void {
  _pushUpdate = fn;
}

let idCounter = 0;
function generateGameId(): string {
  return `hl_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

// ── State serialization for API responses ──
// Note: explicitly strips all UI-only fields (see @uiOnly in src/types.ts):
// selectedUnitId, selectedSiteId, selectionMode, moveHexes, attackHexes,
// structureAttackHexes, supportHexes, buildHexes — these never appear in REST responses.

export function serializeStateForApi(session: HeadlessSession, viewerId?: number): Record<string, unknown> {
  const state = session.gameState;
  const s = serialize(state);

  // Build terrain map: "q,r" → terrainType
  const terrain: Record<string, string> = {};
  for (const key of s.hills) terrain[key] = 'hill';
  for (const key of s.walls) terrain[key] = 'wall';
  for (const key of s.forests) terrain[key] = 'forest';

  // Fog-of-war: when viewerId is supplied, hide enemy units the viewer can't see.
  // Own units are always visible. Enemy units are visible only if:
  //   1. They currently sit in a hex covered by viewer's vision (getPlayerVisible), AND
  //   2. If standing in a forest, an adjacent friendly unit or owned temple reveals them.
  const validViewer = viewerId !== undefined && viewerId >= 0 && viewerId < state.players.length;
  let visibleUnits = s.units.filter(u => u.hp > 0);
  if (validViewer) {
    const visible = getPlayerVisible(state, viewerId!);
    visibleUnits = visibleUnits.filter(u => {
      if (u.playerId === viewerId) return true;
      if (!visible.has(hexKey(u.pos))) return false;
      if (!isForestUnitRevealed(state, u.pos, viewerId!)) return false;
      return true;
    });
  }

  // Faction picks stay hidden from a non-owning viewer until both players
  // have chosen (mirrors the WS path's stripHiddenFaction — see gameManager.ts).
  const bothFactionsChosen = state.players.every(p => p.faction !== null);
  const result: Record<string, unknown> = {
    gameId: null, // filled in by caller
    rulesVersion: s.rulesVersion,
    phase: s.phase,
    currentPlayer: s.currentPlayerIndex,
    turnNumber: s.turnNumber,
    tick: session.tick,
    players: s.players.map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      aura: p.aura,
      faction: (!validViewer || p.id === viewerId || bothFactionsChosen) ? p.faction : null,
      popCap: getPopulationCap(state, p.id),
      currentPop: getPopulationCount(state, p.id),
    })),
    map: {
      radius: s.mapRadius,
      terrain,
      capitals: s.capitals.map(c => ({
        id: c.id, pos: c.pos, playerId: c.playerId, hp: c.hp, maxHp: c.maxHp, defense: c.defense,
      })),
      strategicSites: s.strategicSites.map(site => ({
        id: site.id,
        pos: site.pos,
        state: site.state,
        ownerId: site.ownerId,
        founding: site.founding,
        hp: site.hp, maxHp: site.maxHp, defense: site.defense,
        investmentOwnerId: site.investmentOwnerId,
        devotionLevel: site.devotionLevel,
      })),
      farms: s.farms.map(f => ({
        id: f.id, pos: f.pos, citySiteId: f.citySiteId, ownerId: f.ownerId,
        hp: f.hp, maxHp: f.maxHp, defense: f.defense,
      })),
      teleportBuildings: s.teleportBuildings.map(tp => ({
        id: tp.id,
        pos: tp.pos,
        builtByPlayerId: tp.builtByPlayerId,
        templeId: tp.templeId,
        pairedId: tp.pairedId,
      })),
    },
    units: visibleUnits.map(u => ({
      id: u.id,
      type: u.type,
      playerId: u.playerId,
      pos: u.pos,
      hp: u.hp,
      maxHp: u.stats.maxHp,
      hasMoved: u.hasMoved,
      hasAttacked: u.hasAttacked,
      stats: {
        atk: u.stats.attack,
        def: u.stats.defense,
        spd: u.stats.speed,
        rng: u.stats.range,
        vision: u.stats.vision,
        splash: u.stats.splash,
        splashFactor: u.stats.splashFactor,
        canBeRevenged: u.stats.canBeRevenged,
      },
    })),
    tech: s.playerTech.map((pt, i) => ({
      playerId: i,
      researched: pt.researched,
    })),
    winner: s.winner ? { id: s.winner.id, name: s.winner.name } : null,
  };

  if (validViewer) {
    result.viewerId = viewerId;
    result.explored = Array.from(state.explored[viewerId!] ?? new Set<string>());
  }

  return result;
}

function getSession(gameId: string): HeadlessSession | null {
  return headlessSessions.get(gameId) ?? null;
}

function addLog(session: HeadlessSession, playerId: number, action: string, params: Record<string, unknown>, result: string): void {
  session.log.push({
    tick: session.tick,
    playerId,
    action,
    params,
    result,
    timestamp: Date.now(),
  });
}

// ── Router ──

export const headlessRouter = Router();

// POST /api/headless/new-game
// Body (all optional, backward compatible):
//   { player1Name, player2Name }                        — classic 2-player game
//   { numPlayers: 2..6 }                                 — N players, generated names
//   { players: [{ name?, controller? }, ...] }           — full per-seat control
// `controller` ('human' | 'normal' | 'hard', default 'hard') is only used by the
// AI auto-play endpoints; any seat can still be driven directly via POST /action.
function normalizeController(c: unknown): HeadlessController {
  return c === 'human' || c === 'normal' || c === 'hard' ? c : 'hard';
}

headlessRouter.post('/new-game', (req: Request, res: Response) => {
  const body = req.body ?? {};

  let specs: { name: string; controller: HeadlessController }[];
  if (Array.isArray(body.players) && body.players.length >= 2) {
    specs = body.players.slice(0, MAX_PLAYERS).map((p: Record<string, unknown>, i: number) => ({
      name: typeof p?.name === 'string' ? p.name : `Player ${i + 1}`,
      controller: normalizeController(p?.controller),
    }));
  } else {
    const requested = Number(body.numPlayers);
    const n = Number.isFinite(requested) ? Math.min(MAX_PLAYERS, Math.max(2, Math.floor(requested))) : 2;
    specs = Array.from({ length: n }, (_, i) => ({
      name: i === 0 ? (body.player1Name ?? 'Player 1')
        : i === 1 ? (body.player2Name ?? 'Player 2')
          : (body[`player${i + 1}Name`] ?? `Player ${i + 1}`),
      controller: 'hard' as HeadlessController,
    }));
  }

  const configs: PlayerConfig[] = specs.map((s, i) => ({
    name: s.name,
    color: PLAYER_COLORS[i % PLAYER_COLORS.length]!,
  }));

  const gameState = createGameState(configs);
  resyncCounters(gameState);

  const gameId = generateGameId();
  const session: HeadlessSession = {
    gameState,
    log: [],
    createdAt: Date.now(),
    tick: 0,
    controllers: specs.map(s => s.controller),
  };
  headlessSessions.set(gameId, session);

  const apiState = serializeStateForApi(session);
  apiState.gameId = gameId;

  addLog(session, -1, 'new-game', { players: specs }, `Game created (${specs.length} players)`);

  // Persistent replay log
  initReplay(gameId, session);

  res.json({ gameId, state: apiState });
});

// GET /api/headless/:gameId/state
// Optional ?viewerId=0|1 — apply per-player fog-of-war: enemy units the viewer
// cannot currently see are stripped from the response. Without the param the
// omniscient (god view) state is returned (backwards-compatible default).
headlessRouter.get('/:gameId/state', (req: Request, res: Response) => {
  const gameId = req.params.gameId as string;
  const session = getSession(gameId);
  if (!session) {
    res.status(404).json({ ok: false, error: 'Game not found' });
    return;
  }
  const viewerRaw = req.query.viewerId;
  let viewerId: number | undefined = undefined;
  if (viewerRaw !== undefined) {
    const n = Number(viewerRaw);
    const numPlayers = session.gameState.players.length;
    if (!Number.isInteger(n) || n < 0 || n >= numPlayers) {
      res.status(400).json({ ok: false, error: `Invalid viewerId (must be 0..${numPlayers - 1})` });
      return;
    }
    viewerId = n;
  }
  const apiState = serializeStateForApi(session, viewerId);
  apiState.gameId = gameId;
  res.json({ ok: true, state: apiState });
});

// GET /api/headless/:gameId/legal-moves?unitId=<id>
// Returns legal destinations and attack targets for a unit. Uses the shared
// dispatcher's `computeUnitActions` so the action shape exactly matches what
// POST /action accepts: { type: 'move', to: HexCoord } / { type: 'attack',
// targetId: string } / { type: 'attack-structure', targetPos: HexCoord } /
// { type: 'found', siteId: string, targetState: 'city' | 'temple' }.
//
// `moveHexes` and `attackHexes` (string "q,r" arrays) are kept for backwards
// compatibility with callers that just want hex keys, but new agents should
// iterate `actions` and pass each entry straight to POST /action.
headlessRouter.get('/:gameId/legal-moves', (req: Request, res: Response) => {
  const gameId = req.params.gameId as string;
  const session = getSession(gameId);
  if (!session) {
    res.status(404).json({ ok: false, error: 'Game not found' });
    return;
  }
  const unitId = req.query.unitId as string | undefined;
  if (!unitId) {
    res.status(400).json({ ok: false, error: 'Missing unitId query param' });
    return;
  }
  const state = session.gameState;
  const unit = state.units.find(u => u.id === unitId && u.hp > 0);
  if (!unit) {
    res.status(404).json({ ok: false, error: `Unit ${unitId} not found or dead` });
    return;
  }

  const actions = computeUnitActions(state, unit);
  const moveHexes: string[] = [];
  const attackHexes: string[] = [];
  let foundableSiteId: string | null = null;
  for (const a of actions) {
    if (a.type === 'move') moveHexes.push(hexKey(a.to));
    else if (a.type === 'attack') {
      const target = state.units.find(u => u.id === a.targetId);
      if (target) attackHexes.push(hexKey(target.pos));
    } else if (a.type === 'attack-structure') {
      attackHexes.push(hexKey(a.targetPos));
    } else if (a.type === 'found') {
      foundableSiteId = a.siteId;
    }
  }

  res.json({
    ok: true,
    unitId,
    moveHexes,
    attackHexes,
    canFound: foundableSiteId !== null,
    foundableSiteId,
    actions,
  });
});

// GET /api/headless/replays
// Returns a list of all recorded replays (header rows from game_replays).
// NOTE: this handler is registered PUBLICLY (read-only) in server.ts, ahead of
// the JWT-guarded headlessRouter mount, so it is NOT registered on the router
// here (that copy was dead — the public route matched first).
export function handleListReplays(_req: Request, res: Response) {
  const replays = listReplays();
  res.json({ ok: true, replays });
}

// GET /api/headless/:gameId/replay
// Returns the full replay (header + all events) reconstituted from SQLite.
// Available even after the in-memory session is gone.
// NOTE: registered PUBLICLY in server.ts (see handleListReplays above); not
// registered on the router here.
export function handleGetReplay(req: Request, res: Response) {
  const gameId = req.params.gameId as string;
  const replay = readReplayFile(gameId);
  if (!replay) {
    res.status(404).json({ ok: false, error: 'Replay not found' });
    return;
  }
  res.json({ ok: true, replay });
}

// GET /api/headless/:gameId/log
headlessRouter.get('/:gameId/log', (req: Request, res: Response) => {
  const gameId = req.params.gameId as string;
  const session = getSession(gameId);
  if (!session) {
    res.status(404).json({ ok: false, error: 'Game not found' });
    return;
  }
  res.json({ ok: true, log: session.log });
});

// GET /api/headless/:gameId/rules
headlessRouter.get('/:gameId/rules', (req: Request, res: Response) => {
  const gameId = req.params.gameId as string;
  const session = getSession(gameId);
  if (!session) {
    res.status(404).json({ ok: false, error: 'Game not found' });
    return;
  }
  res.json({ ok: true, rules: buildRulesPayload() });
});

// POST /api/headless/:gameId/action
headlessRouter.post('/:gameId/action', (req: Request, res: Response) => {
  const gameId = req.params.gameId as string;
  const session = getSession(gameId);
  if (!session) {
    res.status(404).json({ ok: false, error: 'Game not found', state: null, log: [], lastAction: null });
    return;
  }

  const state = session.gameState;
  const body = (req.body ?? {}) as HeadlessActionRequestBody;
  const { playerId, action } = body;
  const params = (body.params ?? {}) as Record<string, unknown>;

  // Validate playerId (the only check we keep outside the dispatcher — turn /
  // phase / per-action validation all live in executeAction now).
  const numPlayers = state.players.length;
  if (!Number.isInteger(playerId) || playerId < 0 || playerId >= numPlayers) {
    res.status(400).json({ ok: false, error: `Invalid playerId (must be 0..${numPlayers - 1})`, state: null, log: [], lastAction: null });
    return;
  }

  // Snapshot full state BEFORE we mutate. Used for replay event records.
  const stateBefore = serializeStateForApi(session) as Record<string, unknown>;

  const result = executeAction(state, playerId, action as UnifiedActionName, params);

  if (!result.ok) {
    // Failed actions are NOT recorded to the in-memory log or persistent replay
    // — replays stay clean of "almost did X" noise. The dispatcher already
    // attached legalMoves for the acting player so the caller can recover.
    res.status(400).json({
      ok: false,
      error: result.error,
      legalMoves: result.legalMoves,
      state: null,
      log: [],
      lastAction: session.log.at(-1) ?? null,
    });
    return;
  }

  // Increment session tick on turn boundary (matches pre-refactor behavior).
  if (action === 'end-turn') session.tick++;

  addLog(session, playerId, action, params, result.log.join('; '));

  // Notify spectators
  if (_pushUpdate) _pushUpdate(gameId);

  const apiState = serializeStateForApi(session);
  apiState.gameId = gameId;

  // Persist successful event to replay file
  appendEvent(gameId, {
    tick: session.tick,
    turnNumber: state.turnNumber,
    currentPlayer: state.currentPlayerIndex,
    playerId,
    action,
    params,
    stateBefore,
    stateAfter: apiState as Record<string, unknown>,
    actionLog: result.log,
    ok: true,
    error: null,
    timestamp: Date.now(),
  });

  if ((state.phase as string) === 'gameOver') {
    finalizeReplay(gameId);
  }

  res.json({
    ok: true,
    error: null,
    state: apiState,
    log: result.log,
    lastAction: session.log.at(-1) ?? null,
  });
});

// ── Server-side AI auto-play ──────────────────────────────────────────────────
// Wires the SAME src/ai.ts the interactive game uses into the headless transport
// so headless games actually play well. The AI mutates state through the exact
// src/game.ts engine mutators the action dispatcher uses (selectUnit → moveUnit/
// attackUnit/attackStructure, spawnUnit, startFounding, researchTech,
// buildTeleportPair) — no forked logic — and the turn is advanced via the shared
// executeAction('end-turn') dispatcher, so rules are identical to real play.

function playAiSeat(session: HeadlessSession): { seat: number; difficulty: HeadlessController; actions: number } {
  const state = session.gameState;
  const seat = state.currentPlayerIndex;
  const difficulty = session.controllers[seat] ?? 'hard';
  // 'hard' (and any auto-played 'human') seats use the strong AI; 'normal' uses the light one.
  const actions = difficulty === 'normal' ? runAITurn(state, seat) : runHardAITurn(state, seat);
  executeAction(state, seat, 'end-turn', {});
  session.tick++;
  return { seat, difficulty, actions: actions.length };
}

// POST /api/headless/:gameId/ai-turn — play the current seat's full turn with the
// built-in AI, then end the turn. Lets external clients drive some seats manually
// while the AI handles the rest.
headlessRouter.post('/:gameId/ai-turn', (req: Request, res: Response) => {
  const gameId = req.params.gameId as string;
  const session = getSession(gameId);
  if (!session) { res.status(404).json({ ok: false, error: 'Game not found' }); return; }
  if (session.gameState.phase === 'gameOver') {
    res.status(400).json({ ok: false, error: 'Game is already over' });
    return;
  }
  const played = playAiSeat(session);
  addLog(session, played.seat, 'ai-turn', { difficulty: played.difficulty },
    `AI (${played.difficulty}) took ${played.actions} actions and ended turn`);
  if ((session.gameState.phase as string) === 'gameOver') finalizeReplay(gameId);
  if (_pushUpdate) _pushUpdate(gameId);
  const apiState = serializeStateForApi(session);
  apiState.gameId = gameId;
  res.json({ ok: true, played, state: apiState });
});

// POST /api/headless/:gameId/auto-play — play all seats with the built-in AI until
// the game ends (or maxHalfTurns, default 1000, is hit). Returns the final state,
// winner and a per-seat summary.
headlessRouter.post('/:gameId/auto-play', (req: Request, res: Response) => {
  const gameId = req.params.gameId as string;
  const session = getSession(gameId);
  if (!session) { res.status(404).json({ ok: false, error: 'Game not found' }); return; }
  const state = session.gameState;
  const cap = Math.min(5000, Math.max(1, Number((req.body ?? {}).maxHalfTurns) || 1000));
  let half = 0;
  while (state.phase === 'playing' && half < cap) {
    playAiSeat(session);
    half++;
  }
  if ((state.phase as string) === 'gameOver') finalizeReplay(gameId);
  if (_pushUpdate) _pushUpdate(gameId);
  const apiState = serializeStateForApi(session);
  apiState.gameId = gameId;
  const summary = state.players.map(p => ({
    id: p.id,
    name: p.name,
    aura: p.aura,
    units: state.units.filter(u => u.hp > 0 && u.playerId === p.id).length,
    sites: state.strategicSites.filter(s => (s.state === 'city' || s.state === 'temple') && s.ownerId === p.id).length,
    capitalHp: state.capitals.find(c => c.playerId === p.id)?.hp ?? 0,
    tech: state.playerTech[p.id]!.researched.size,
  }));
  addLog(session, -1, 'auto-play', { maxHalfTurns: cap }, `Auto-played ${half} half-turns; phase=${state.phase}`);
  res.json({
    ok: true,
    finished: (state.phase as string) === 'gameOver',
    halfTurns: half,
    rounds: state.turnNumber,
    winner: state.winner ? { id: state.winner.id, name: state.winner.name } : null,
    summary,
    state: apiState,
  });
});
