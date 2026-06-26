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
      if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
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

  listGames(): void {
    this.send({ type: 'list_games' });
  }

  spectateGame(gameId: string): void {
    this.send({ type: 'spectate', gameId });
  }

  sendAction(action: ClientMessage): void {
    this.send(action);
  }

  endTurn(): void {
    this.send({ type: 'action_end_turn' });
  }
}
