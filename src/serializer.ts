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
  phase: GameState['phase'];
  mapRadius: number;
  winner: GameState['winner'];
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
    hills:            new Set<string>(data.hills),
    walls:            new Set<string>(data.walls),
    forests:          new Set<string>(data.forests),
    explored:         data.explored.map(arr => new Set<string>(arr)),
    spawnedTempleIds: new Set<string>(data.spawnedTempleIds),
    playerTech:       data.playerTech.map(pt => ({ researched: new Set<TechId>(pt.researched as TechId[]) })),
  };
}
