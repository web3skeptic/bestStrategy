import { GameState, TechId, ResearchProgress, RULES_VERSION } from './types';

// Serialized form: Sets become arrays for JSON transport
export interface SerializedGameState {
  /** Stamped by serialize() from RULES_VERSION. See assertCompatibleRulesVersion. */
  rulesVersion: number;
  players: GameState['players'];
  units: GameState['units'];
  strategicSites: GameState['strategicSites'];
  fertileSites: GameState['fertileSites'];
  capitals: GameState['capitals'];
  farms: GameState['farms'];
  trainingQueue: GameState['trainingQueue'];
  roads: GameState['roads'];
  pillagedRoadHexes: string[];
  hills: string[];
  walls: string[];
  forests: string[];
  explored: string[][];
  currentPlayerIndex: number;
  /** Optional for backwards-compat with replays saved before balance-v2.2. */
  firstPlayerIndex?: number;
  phase: GameState['phase'];
  mapRadius: number;
  winner: GameState['winner'];
  turnNumber: number;
  selectedUnitId: string | null;
  selectedSiteId: string | null;
  selectionMode: GameState['selectionMode'];
  moveHexes: GameState['moveHexes'];
  attackHexes: GameState['attackHexes'];
  structureAttackHexes: GameState['structureAttackHexes'];
  supportHexes: GameState['supportHexes'];
  spawnedSiteIds: string[];
  playerTech: { researched: string[]; researching: ResearchProgress | null }[];
  teleportBuildings: GameState['teleportBuildings'];
  buildHexes: GameState['buildHexes'];
}

export function serialize(state: GameState): SerializedGameState {
  return {
    ...state,
    rulesVersion:   RULES_VERSION,
    pillagedRoadHexes: Array.from(state.pillagedRoadHexes),
    hills:          Array.from(state.hills),
    walls:          Array.from(state.walls),
    forests:        Array.from(state.forests),
    explored:       state.explored.map(s => Array.from(s)),
    spawnedSiteIds: Array.from(state.spawnedSiteIds),
    playerTech:     state.playerTech.map(pt => ({ researched: Array.from(pt.researched), researching: pt.researching })),
  };
}

// Thrown by deserialize() when a saved/replayed blob predates the current
// rules. Every load site (server/db.ts rejoin, server/gameLogger.ts replay
// read, server/headlessApi.ts replay load) must catch this specifically and
// fail cleanly — never silently reinterpret older state under the new rules.
export class IncompatibleRulesVersionError extends Error {
  constructor(public readonly foundVersion: number | undefined) {
    super(
      `This match was created with an older, incompatible ruleset ` +
      `(rulesVersion=${foundVersion ?? 'none'}, current=${RULES_VERSION}). ` +
      `It can no longer be loaded.`,
    );
    this.name = 'IncompatibleRulesVersionError';
  }
}

export function assertCompatibleRulesVersion(data: { rulesVersion?: number }): void {
  if (data.rulesVersion !== RULES_VERSION) {
    throw new IncompatibleRulesVersionError(data.rulesVersion);
  }
}

export function deserialize(data: SerializedGameState): GameState {
  assertCompatibleRulesVersion(data);
  return {
    ...(data as unknown as GameState),
    // Backwards-compatibility: older saved states may pre-date `turnNumber`.
    turnNumber:       data.turnNumber ?? 1,
    // Backwards-compatibility: replays pre-v2.2 always started P0 first.
    firstPlayerIndex: data.firstPlayerIndex ?? 0,
    pillagedRoadHexes: new Set<string>(data.pillagedRoadHexes),
    hills:            new Set<string>(data.hills),
    walls:            new Set<string>(data.walls),
    forests:          new Set<string>(data.forests),
    explored:         data.explored.map(arr => new Set<string>(arr)),
    spawnedSiteIds:   new Set<string>(data.spawnedSiteIds),
    playerTech:       data.playerTech.map(pt => ({ researched: new Set<TechId>(pt.researched as TechId[]), researching: pt.researching ?? null })),
    units:            data.units,
    // Live multiplayer is authoritative for selection: the server sends the
    // acting player their current selection + highlight hexes in every
    // state_update (and strips them for the opponent/spectators). Honour
    // whatever the payload carries so the actor's move/attack highlights are
    // actually usable — defaulting to safe empties for older payloads that
    // pre-date these fields.
    selectedUnitId:   data.selectedUnitId ?? null,
    selectedSiteId:   data.selectedSiteId ?? null,
    selectionMode:    data.selectionMode ?? null,
    moveHexes:        data.moveHexes ?? [],
    attackHexes:      data.attackHexes ?? [],
    structureAttackHexes: data.structureAttackHexes ?? [],
    supportHexes:     data.supportHexes ?? [],
    buildHexes:       data.buildHexes ?? [],
  };
}
