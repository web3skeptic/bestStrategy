import { ClientMessage, ServerMessage } from './protocol';

export type MultiplayerEventCallback = (event: ServerMessage) => void;

export class MultiplayerClient {
  private ws: WebSocket | null = null;
  private onEvent: MultiplayerEventCallback;
  private url: string;

  /** Called when an open connection drops on its own (not via disconnect()). */
  onDrop: (() => void) | null = null;
  /** Called when a message could not be sent because the socket isn't open. */
  onSendFail: (() => void) | null = null;
  /** Last username sent with login(), re-used to log in again after a reconnect. */
  username: string | null = null;
  /**
   * Game actions sent but not yet answered. The server replies to each with a
   * state_update or an action_error; the UI uses this to keep an instant local
   * selection from being overwritten by a reply to an older action.
   */
  inflight = 0;

  constructor(url: string, onEvent: MultiplayerEventCallback) {
    this.url = url;
    this.onEvent = onEvent;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Detach the old socket's handlers before closing it. Its close event
      // fires later, and must not touch the new socket (it used to set
      // this.ws = null, silently killing the fresh connection).
      const old = this.ws;
      if (old) {
        old.onopen = null; old.onclose = null; old.onerror = null; old.onmessage = null;
        try { old.close(); } catch { /* ignore */ }
      }
      const ws = new WebSocket(this.url);
      this.ws = ws;
      this.inflight = 0;
      let opened = false;
      ws.onopen = () => { opened = true; resolve(); };
      ws.onerror = (e) => { if (!opened) reject(e); };
      ws.onmessage = (e) => {
        if (this.ws !== ws) return;
        try {
          const msg = JSON.parse(e.data as string) as ServerMessage;
          this.onEvent(msg);
        } catch { /* ignore parse errors */ }
      };
      ws.onclose = (e) => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (opened) this.onDrop?.();
        else reject(e);
      };
    });
  }

  /** Close on purpose. Does not trigger onDrop. */
  disconnect(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null; ws.onclose = null; ws.onerror = null; ws.onmessage = null;
      ws.close();
    }
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private send(msg: ClientMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (msg.type.startsWith('action')) this.inflight++;
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    this.onSendFail?.();
    return false;
  }

  /** Call when the server answers a game action (state_update / action_error). */
  actionAnswered(): void {
    if (this.inflight > 0) this.inflight--;
  }

  login(username: string): void {
    this.username = username;
    this.send({ type: 'login', username });
  }

  createRoom(expectedPlayers?: number): void {
    this.send({ type: 'create_room', expectedPlayers });
  }

  joinRoom(roomId: string): void {
    this.send({ type: 'join_room', roomId });
  }

  rejoinRoom(roomId: string): void {
    this.send({ type: 'rejoin_room', roomId });
  }

  leaveRoom(roomId: string): void {
    this.send({ type: 'leave_room', roomId });
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

  sendAction(action: ClientMessage): boolean {
    return this.send(action);
  }

  endTurn(): void {
    this.send({ type: 'action_end_turn' });
  }
}
