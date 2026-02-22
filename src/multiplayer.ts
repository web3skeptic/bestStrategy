import { HexCoord, UnitType, TechId } from './types';
import { ClientMessage, ServerMessage } from './protocol';

export type MultiplayerEventCallback = (event: ServerMessage) => void;

export class MultiplayerClient {
  private ws: WebSocket | null = null;
  private onEvent: MultiplayerEventCallback;
  private url: string;

  constructor(url: string, onEvent: MultiplayerEventCallback) {
    this.url = url;
    this.onEvent = onEvent;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as ServerMessage;
          this.onEvent(msg);
        } catch { /* ignore parse errors */ }
      };
      this.ws.onclose = () => {
        this.ws = null;
      };
    });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  login(username: string): void {
    this.send({ type: 'login', username });
  }

  createRoom(): void {
    this.send({ type: 'create_room' });
  }

  joinRoom(roomId: string): void {
    this.send({ type: 'join_room', roomId });
  }

  listRooms(): void {
    this.send({ type: 'list_rooms' });
  }

  rejoinRoom(roomId: string): void {
    this.send({ type: 'rejoin_room', roomId });
  }

  sendAction(action: ClientMessage): void {
    this.send(action);
  }

  selectUnit(unitId: string): void {
    this.send({ type: 'action_select_unit', unitId });
  }

  selectTemple(templeId: string): void {
    this.send({ type: 'action_select_temple', templeId });
  }

  deselect(): void {
    this.send({ type: 'action_deselect' });
  }

  move(dest: HexCoord): void {
    this.send({ type: 'action_move', dest });
  }

  attack(targetPos: HexCoord): void {
    this.send({ type: 'action_attack', targetPos });
  }

  spawn(templeId: string, unitType: UnitType): void {
    this.send({ type: 'action_spawn', templeId, unitType });
  }

  capture(): void {
    this.send({ type: 'action_capture' });
  }

  upgradeTemple(templeId: string): void {
    this.send({ type: 'action_upgrade_temple', templeId });
  }

  research(techId: TechId): void {
    this.send({ type: 'action_research', techId });
  }

  buildTeleport(templeIdA: string, posA: HexCoord, posB: HexCoord): void {
    this.send({ type: 'action_build_teleport', templeIdA, posA, posB });
  }

  endTurn(): void {
    this.send({ type: 'action_end_turn' });
  }
}
