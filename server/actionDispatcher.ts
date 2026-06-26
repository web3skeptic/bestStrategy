// Shared action dispatcher used by both the WebSocket transport (gameManager.ts)
// and the REST headless transport (headlessApi.ts).
//
// The dispatcher takes a GameState, the acting player's slot, an action name
// from the unified vocabulary, and a flat params object. It validates the
// action, mutates the state, and returns a structured result. It is the single
// place that enforces game rules at the transport boundary — transports become
// thin adapters.
//
// Note on selection-side-effect: several core mutators in src/game.ts read
// `state.selectedUnitId` (e.g. moveUnit, attackUnit). The dispatcher always
// fully owns selection lifecycle — it selects the right unit before mutating
// and deselects after — so callers never need to send a separate select
// message. The UI-only "select" WS messages still exist for the legacy FE
// (they just toggle highlight state) but are not part of this dispatcher's
// contract.

import { GameState, Unit, UnitType, TechId, HexCoord } from '../src/types';
import {
  selectUnit, deselectAll,
  moveUnit, attackUnit,
  canCaptureTemple, captureTemple,
  spawnUnit, endTurn,
  upgradeTemple, researchTech,
  buildTeleportPair,
  resignGame,
  getEffectiveRange,
  getPlayerVisible, isForestUnitRevealed,
  UNIT_STATS, HEALER_HEAL_AMOUNT, DAMAGE_BOOST_AMOUNT, RANGE_BOOST_AMOUNT,
} from '../src/game';
import {
  TECH_NODES, UNIT_COSTS,
  TEMPLE_AURA_PER_LEVEL, TEMPLE_MAX_LEVEL, TEMPLE_POP_CAP_PER_LEVEL,
  templeUpgradeCost,
  HILL_DEFENSE_BONUS, HILL_VISION_BONUS, HILL_RANGE_BONUS,
  SUPPORT_RANGE,
  TELEPORT_BUILD_COST, TELEPORT_RADIUS, TELEPORT_MAX_PER_TEMPLE,
} from '../src/types';
import { hexKey, getReachableHexes, hexDistance } from '../src/hex';

// ── Unified action vocabulary ──

export type UnifiedActionName =
  | 'move'
  | 'attack'
  | 'recruit'
  | 'capture'
  | 'upgrade-temple'
  | 'research'
  | 'build-teleport'
  | 'end-turn'
  | 'resign';

export interface UnifiedAction {
  action: UnifiedActionName;
  params: Record<string, unknown>;
}

// ── Per-unit legal action descriptor ──

export type LegalAction =
  | { type: 'move'; to: HexCoord }
  | { type: 'attack'; targetId: string }
  | { type: 'capture'; templeId: string };

export type LegalMovesPerPlayer = Record<string /* unitId */, LegalAction[]>;

// ── Result shape returned by executeAction ──

export interface ExecuteSuccess {
  ok: true;
  action: UnifiedActionName;
  log: string[];
  // Whether this action mutated game-visible state (vs UI-only). All current
  // unified actions are state-mutating, but we keep the flag for future
  // selection-only actions.
  broadcastToBoth: boolean;
}

export interface ExecuteFailure {
  ok: false;
  action: UnifiedActionName | string;
  error: string;
  legalMoves: LegalMovesPerPlayer;
}

export type ExecuteResult = ExecuteSuccess | ExecuteFailure;

// ── Legal-moves helpers ──

export function computeUnitActions(state: GameState, unit: Unit): LegalAction[] {
  const actions: LegalAction[] = [];

  // Move actions — only available when the unit has not yet moved or attacked.
  if (!unit.hasMoved && !unit.hasAttacked) {
    const occupied = state.units.filter(u => u.hp > 0 && u.id !== unit.id).map(u => u.pos);
    const wallPositions: HexCoord[] = [...state.walls].map(k => {
      const [q, r] = k.split(',').map(Number);
      return { q: q!, r: r! };
    });
    const reachable = getReachableHexes(
      unit.pos,
      unit.stats.speed,
      state.mapRadius,
      [...occupied, ...wallPositions],
      state.hills,
    );
    for (const h of reachable) actions.push({ type: 'move', to: h });
  }

  // Attack actions — available unless already attacked or cantShootAfterMove+hasMoved.
  const canAttack = !unit.hasAttacked && !(unit.stats.cantShootAfterMove && unit.hasMoved);
  if (canAttack) {
    const effectiveRange = getEffectiveRange(state, unit);
    const visible = getPlayerVisible(state, unit.playerId);
    const targets = state.units
      .filter(e => e.hp > 0 && e.playerId !== unit.playerId)
      .filter(e => hexDistance(unit.pos, e.pos) <= effectiveRange)
      .filter(e => visible.has(hexKey(e.pos)))
      .filter(e => isForestUnitRevealed(state, e.pos, unit.playerId));
    for (const e of targets) actions.push({ type: 'attack', targetId: e.id });
  }

  // Capture action.
  const capturableTemple = canCaptureTemple(state, unit);
  if (capturableTemple) actions.push({ type: 'capture', templeId: capturableTemple.id });

  return actions;
}

export function computePlayerLegalMoves(state: GameState, playerId: number): LegalMovesPerPlayer {
  const legal: LegalMovesPerPlayer = {};
  for (const unit of state.units.filter(u => u.hp > 0 && u.playerId === playerId)) {
    legal[unit.id] = computeUnitActions(state, unit);
  }
  return legal;
}

// ── Hex utilities (re-exported convenience) ──

export function computeUnitMoveHexes(state: GameState, unit: Unit): HexCoord[] {
  if (unit.hasMoved || unit.hasAttacked) return [];
  const occupied = state.units.filter(u => u.hp > 0 && u.id !== unit.id).map(u => u.pos);
  const wallPositions: HexCoord[] = [...state.walls].map(k => {
    const [q, r] = k.split(',').map(Number);
    return { q: q!, r: r! };
  });
  return getReachableHexes(unit.pos, unit.stats.speed, state.mapRadius, [...occupied, ...wallPositions], state.hills);
}

export function computeUnitAttackTargets(state: GameState, unit: Unit): Unit[] {
  const canAttack = !unit.hasAttacked && !(unit.stats.cantShootAfterMove && unit.hasMoved);
  if (!canAttack) return [];
  const effectiveRange = getEffectiveRange(state, unit);
  const visible = getPlayerVisible(state, unit.playerId);
  return state.units
    .filter(e => e.hp > 0 && e.playerId !== unit.playerId)
    .filter(e => hexDistance(unit.pos, e.pos) <= effectiveRange)
    .filter(e => visible.has(hexKey(e.pos)))
    .filter(e => isForestUnitRevealed(state, e.pos, unit.playerId));
}

// ── Rules payload (used by REST /rules and WS request_rules) ──

export function buildRulesPayload(): Record<string, unknown> {
  const unitTypes: Record<string, unknown> = {};
  for (const [type, stats] of Object.entries(UNIT_STATS)) {
    const techUnlock = TECH_NODES.find(n => n.unitUnlock === type);
    unitTypes[type] = {
      cost: UNIT_COSTS[type as UnitType],
      hp: stats.maxHp,
      atk: stats.attack,
      def: stats.defense,
      spd: stats.speed,
      rng: stats.range,
      vision: stats.vision,
      splash: stats.splash,
      splashFactor: stats.splashFactor,
      canBeRevenged: stats.canBeRevenged,
      cantShootAfterMove: stats.cantShootAfterMove,
      attackBonusAgainst: stats.attackBonusAgainst ?? {},
      defenseBonusAgainst: stats.defenseBonusAgainst ?? {},
      unlockTech: techUnlock?.id ?? null,
      defaultUnlocked: !techUnlock,
    };
  }

  const techTree = TECH_NODES.map(n => ({
    id: n.id,
    name: n.name,
    description: n.description,
    cost: n.cost,
    prereqs: n.prereqs,
    branch: n.branch ?? null,
    unitUnlock: n.unitUnlock ?? null,
  }));

  return {
    units: unitTypes,
    techTree,
    templeMechanics: {
      auraPerLevel: TEMPLE_AURA_PER_LEVEL,
      popCapPerLevel: TEMPLE_POP_CAP_PER_LEVEL,
      maxLevel: TEMPLE_MAX_LEVEL,
      upgradeCosts: {
        '1_to_2': templeUpgradeCost(1),
        '2_to_3': templeUpgradeCost(2),
        '3_to_4': templeUpgradeCost(3),
        '4_to_5': templeUpgradeCost(4),
      },
      incomeFormula: 'level * TEMPLE_AURA_PER_LEVEL per owned temple per turn',
      popCapFormula: 'level * TEMPLE_POP_CAP_PER_LEVEL per owned temple',
    },
    terrain: {
      hill: {
        defenseBonusOnHill: HILL_DEFENSE_BONUS,
        visionBonusOnHill: HILL_VISION_BONUS,
        rangeBonusOnHill: HILL_RANGE_BONUS,
        note: 'Range bonus applies to ranged units only (range > 1). Moving onto/off a hill costs full movement budget.',
      },
      forest: {
        note: 'Reduces vision to 1 when standing inside. Units inside are hidden unless an adjacent enemy unit or owned temple is within 1 hex.',
      },
      wall: { note: 'Impassable.' },
    },
    support: {
      supportRange: SUPPORT_RANGE,
      healerHealAmount: HEALER_HEAL_AMOUNT,
      damageBoostAmount: DAMAGE_BOOST_AMOUNT,
      rangeBoostAmount: RANGE_BOOST_AMOUNT,
      note: 'Support units affect all allies within SUPPORT_RANGE hexes. Healer heals at start of owning player turn.',
    },
    teleports: {
      buildCost: TELEPORT_BUILD_COST,
      radius: TELEPORT_RADIUS,
      maxPerTemple: TELEPORT_MAX_PER_TEMPLE,
      note: 'Requires "teleports" tech. Each portal must be within radius of a different owned temple. Unit stepping on portal teleports to free neighbour of partner portal.',
    },
    combat: {
      formula: 'damage = round(randomMultiplier * encirclementMultiplier * typeBonus * (attackerATK - defenderDEF))',
      randomMultiplier: 'Normal(1.0, sigma=0.2), clamped [0.5, 1.5]',
      revengeAttack: 'If target survives and attacker.canBeRevenged is true, target fires back.',
      meleeStep: 'Melee units (range=1) step onto killed target\'s tile.',
      encirclement: 'Up to 2x damage multiplier based on surrounding enemies and map edges.',
    },
    turnStructure: {
      startOfTurn: [
        'Receive aura income from owned temples (level * 2 per temple)',
        'Healers restore HP to nearby allies (within support range)',
      ],
      availableActions: [
        'move — move a unit to a reachable hex (does NOT auto-capture; use a separate capture action)',
        'attack — attack an enemy unit within range',
        'recruit — spawn a unit at an owned temple',
        'capture — capture the enemy/neutral temple the unit is currently standing on',
        'upgrade-temple — upgrade an owned temple level',
        'research — research a tech',
        'build-teleport — build a teleport portal pair',
        'end-turn — end the current player\'s turn',
        'resign — concede the game, opponent wins',
      ],
      constraints: [
        'A unit can move then attack, or just attack, or just move — but not attack then move.',
        'Attacking also sets hasMoved=true.',
        'Each temple can spawn at most one unit per turn.',
        'Capture is a separate action — it does NOT consume hasMoved/hasAttacked, but each unit can capture at most once per turn (hasCaptured).',
      ],
    },
    winConditions: [
      'Own ALL temples → win',
      'Opponent has no units AND no temples → win',
    ],
    startingConditions: {
      startingAura: 2,
      startingUnits: '2 warriors each',
      templeLayout: '2 owned temples (one per player), 2 neutral temples',
      mapRadius: 6,
    },
  };
}

// ── Main dispatcher ──

function fail(state: GameState, playerSlot: 0 | 1, actionName: UnifiedActionName | string, error: string): ExecuteFailure {
  return {
    ok: false,
    action: actionName,
    error,
    legalMoves: computePlayerLegalMoves(state, playerSlot),
  };
}

/**
 * Execute a unified action against the game state. The state is mutated in
 * place on success. The caller is responsible for persistence (DB save),
 * broadcast (WS push to opponents/spectators), and replay logging.
 *
 * Rules enforced here (transport-independent):
 *   - The game must not be in gameOver phase (except for resign, which is a
 *     no-op in that case anyway).
 *   - It must be the acting player's turn (except for resign, which can fire
 *     at any time on the acting player's own slot).
 *   - All per-action invariants delegated to src/game.ts mutators.
 */
export function executeAction(
  state: GameState,
  playerSlot: 0 | 1,
  action: UnifiedActionName,
  params: Record<string, unknown>,
): ExecuteResult {
  // Game-over guard. Resign on a finished game is also rejected for clarity.
  if (state.phase === 'gameOver') {
    return fail(state, playerSlot, action, 'Game is already over');
  }

  // Turn guard — resign is allowed even on the opponent's turn (concede early).
  if (action !== 'resign' && state.currentPlayerIndex !== playerSlot) {
    return fail(
      state,
      playerSlot,
      action,
      `Not player ${playerSlot}'s turn (current turn: player ${state.currentPlayerIndex})`,
    );
  }

  const log: string[] = [];

  try {
    switch (action) {
      case 'move': {
        const { unitId, to } = params as { unitId?: string; to?: HexCoord };
        if (!unitId || !to) return fail(state, playerSlot, action, 'Missing unitId or to');

        selectUnit(state, unitId);
        if (state.selectedUnitId !== unitId) {
          return fail(state, playerSlot, action, `Cannot select unit ${unitId} (not owned by player ${playerSlot} or not found)`);
        }
        const result = moveUnit(state, to);
        if (!result.moved) {
          deselectAll(state);
          return fail(state, playerSlot, action, `Invalid move for unit ${unitId} to (${to.q},${to.r})`);
        }
        log.push(`Unit ${unitId} moved to (${to.q},${to.r})`);
        deselectAll(state);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'attack': {
        const { unitId, targetId } = params as { unitId?: string; targetId?: string };
        if (!unitId || !targetId) return fail(state, playerSlot, action, 'Missing unitId or targetId');

        const target = state.units.find(u => u.id === targetId && u.hp > 0);
        if (!target) return fail(state, playerSlot, action, `Target ${targetId} not found or already dead`);

        selectUnit(state, unitId);
        if (state.selectedUnitId !== unitId) {
          return fail(state, playerSlot, action, `Cannot select unit ${unitId}`);
        }

        const combat = attackUnit(state, target.pos);
        if (!combat) {
          deselectAll(state);
          return fail(state, playerSlot, action, `Invalid attack from ${unitId} to ${targetId}`);
        }
        log.push(`Unit ${unitId} attacked ${targetId}: ${combat.damageDealt} dmg dealt, ${combat.damageReceived} dmg received`);
        if (combat.targetKilled) log.push(`${targetId} was killed`);
        if (combat.attackerKilled) log.push(`${unitId} was killed (revenge)`);
        for (const splash of combat.splashHits) {
          log.push(`Splash: ${splash.unitId} took ${splash.damage} dmg${splash.killed ? ' (killed)' : ''}`);
        }
        deselectAll(state);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'capture': {
        // unitId is optional — if omitted, the dispatcher uses state.selectedUnitId
        // (legacy WS path: the FE has already selected the unit via action_select_unit).
        const { unitId: unitIdParam } = params as { unitId?: string };
        const unitId = unitIdParam ?? state.selectedUnitId ?? null;
        if (!unitId) return fail(state, playerSlot, action, 'Missing unitId (and no current selection)');

        const unit = state.units.find(u => u.id === unitId && u.hp > 0);
        if (!unit) return fail(state, playerSlot, action, `Unit ${unitId} not found or dead`);
        if (unit.playerId !== playerSlot) return fail(state, playerSlot, action, `Unit ${unitId} is not owned by player ${playerSlot}`);

        const temple = canCaptureTemple(state, unit);
        if (!temple) {
          return fail(state, playerSlot, action, `Unit ${unitId} cannot capture (no enemy/neutral temple on tile, or already captured this turn)`);
        }
        captureTemple(state, unit, temple);
        log.push(`Unit ${unitId} captured temple ${temple.id}`);
        // Capture doesn't manipulate selection; leave it as-is.
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'upgrade-temple': {
        const { templeId } = params as { templeId?: string };
        if (!templeId) return fail(state, playerSlot, action, 'Missing templeId');
        const ok = upgradeTemple(state, templeId);
        if (!ok) return fail(state, playerSlot, action, `Cannot upgrade temple ${templeId} (not owned, max level, or insufficient aura)`);
        const temple = state.temples.find(t => t.id === templeId);
        log.push(`Temple ${templeId} upgraded to level ${temple?.level}`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'research': {
        const { techId } = params as { techId?: TechId };
        if (!techId) return fail(state, playerSlot, action, 'Missing techId');
        const ok = researchTech(state, techId);
        if (!ok) return fail(state, playerSlot, action, `Cannot research ${techId} (already researched, missing prereqs, branch conflict, or insufficient aura)`);
        log.push(`Player ${playerSlot} researched ${techId}`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'recruit': {
        const { unitType, templeId } = params as { unitType?: UnitType; templeId?: string };
        if (!unitType || !templeId) return fail(state, playerSlot, action, 'Missing unitType or templeId');
        const ok = spawnUnit(state, templeId, unitType);
        if (!ok) return fail(state, playerSlot, action, `Cannot recruit ${unitType} at temple ${templeId} (not owned, can't afford, pop cap, tile occupied, or unit locked)`);
        log.push(`Player ${playerSlot} recruited ${unitType} at temple ${templeId}`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'build-teleport': {
        const { templeId, pos, targetPos } = params as { templeId?: string; pos?: HexCoord; targetPos?: HexCoord };
        if (!templeId || !pos || !targetPos) return fail(state, playerSlot, action, 'Missing templeId, pos, or targetPos for teleport build');
        const ok = buildTeleportPair(state, templeId, pos, targetPos);
        if (!ok) return fail(state, playerSlot, action, `Cannot build teleport pair from temple ${templeId}`);
        log.push(`Player ${playerSlot} built teleport pair near temple ${templeId}`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'end-turn': {
        const prevPlayer = state.currentPlayerIndex;
        endTurn(state);
        log.push(`Player ${prevPlayer} ended their turn. Now player ${state.currentPlayerIndex}'s turn.`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      case 'resign': {
        const ok = resignGame(state, playerSlot);
        if (!ok) return fail(state, playerSlot, action, 'Cannot resign (game already over)');
        log.push(`Player ${playerSlot} resigned. Player ${state.winner?.id} wins.`);
        return { ok: true, action, log, broadcastToBoth: true };
      }

      default:
        return fail(state, playerSlot, action, `Unknown action: ${String(action)}`);
    }
  } catch (e: unknown) {
    return fail(state, playerSlot, action, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
