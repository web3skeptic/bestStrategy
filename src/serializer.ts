import { GameState, TechId } from './types';

// Serialized form: Sets become arrays for JSON transport
export interface SerializedGameState {
  players: GameState['players'];
  units: GameState['units'];
  temples: GameState['temples'];
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
  selectedTempleId: string | null;
  selectionMode: GameState['selectionMode'];
  moveHexes: GameState['moveHexes'];
  attackHexes: GameState['attackHexes'];
  supportHexes: GameState['supportHexes'];
  spawnedTempleIds: string[];
  playerTech: { researched: string[] }[];
  teleportBuildings: GameState['teleportBuildings'];
  buildHexes: GameState['buildHexes'];
}

export function serialize(state: GameState): SerializedGameState {
  return {
    ...state,
    hills:            Array.from(state.hills),
    walls:            Array.from(state.walls),
    forests:          Array.from(state.forests),
    explored:         state.explored.map(s => Array.from(s)),
    spawnedTempleIds: Array.from(state.spawnedTempleIds),
    playerTech:       state.playerTech.map(pt => ({ researched: Array.from(pt.researched) })),
  };
}

export function deserialize(data: SerializedGameState): GameState {
  return {
    ...(data as unknown as GameState),
    // Backwards-compatibility: older saved states may pre-date `turnNumber`.
    turnNumber:       data.turnNumber ?? 1,
    // Backwards-compatibility: replays pre-v2.2 always started P0 first.
    firstPlayerIndex: data.firstPlayerIndex ?? 0,
    hills:            new Set<string>(data.hills),
    walls:            new Set<string>(data.walls),
    forests:          new Set<string>(data.forests),
    explored:         data.explored.map(arr => new Set<string>(arr)),
    spawnedTempleIds: new Set<string>(data.spawnedTempleIds),
    playerTech:       data.playerTech.map(pt => ({ researched: new Set<TechId>(pt.researched as TechId[]) })),
    // Backwards-compatibility: units saved before `hasCaptured` existed default to false.
    units:            data.units.map(u => ({ ...u, hasCaptured: u.hasCaptured ?? false })),
    // Live multiplayer is authoritative for selection: the server sends the
    // acting player their current selection + highlight hexes in every
    // state_update (and strips them for the opponent/spectators). Honour
    // whatever the payload carries so the actor's move/attack highlights are
    // actually usable — defaulting to safe empties for older payloads that
    // pre-date these fields.
    selectedUnitId:   data.selectedUnitId ?? null,
    selectedTempleId: data.selectedTempleId ?? null,
    selectionMode:    data.selectionMode ?? null,
    moveHexes:        data.moveHexes ?? [],
    attackHexes:      data.attackHexes ?? [],
    supportHexes:     data.supportHexes ?? [],
    buildHexes:       data.buildHexes ?? [],
  };
}
