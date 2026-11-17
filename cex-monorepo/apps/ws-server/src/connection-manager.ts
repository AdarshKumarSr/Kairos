import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { ConnectionState, WsServerMetrics } from './types.js';

export class ConnectionManager {
  private connections = new Map<WebSocket, ConnectionState>();
  private topicToSockets = new Map<string, Set<WebSocket>>();
  private userToSockets = new Map<string, Set<WebSocket>>();
  private messagesOutTotal = 0;
  private readonly maxBufferedAmount: number;

  constructor(maxBufferedAmount = 1024 * 1024) {
    this.maxBufferedAmount = maxBufferedAmount;
  }

  public addConnection(ws: WebSocket): ConnectionState {
    const state: ConnectionState = {
      id: randomUUID(),
      socket: ws,
      userId: null,
      subscriptions: new Set(),
      depthLastSeq: new Map(),
      depthPendingSnapshot: new Set(),
      isAlive: true,
      missedPongs: 0,
      messageCount: 0,
      rateLimitWindowStart: Date.now(),
    };
    this.connections.set(ws, state);
    return state;
  }

  public getConnection(ws: WebSocket): ConnectionState | undefined {
    return this.connections.get(ws);
  }

  public getAllConnections(): IterableIterator<ConnectionState> {
    return this.connections.values();
  }

  public removeConnection(ws: WebSocket): void {
    const state = this.connections.get(ws);
    if (!state) return;

    for (const topic of state.subscriptions) {
      const set = this.topicToSockets.get(topic);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          this.topicToSockets.delete(topic);
        }
      }
    }

    if (state.userId) {
      const userSockets = this.userToSockets.get(state.userId);
      if (userSockets) {
        userSockets.delete(ws);
        if (userSockets.size === 0) {
          this.userToSockets.delete(state.userId);
        }
      }
    }

    this.connections.delete(ws);
  }

  public subscribe(ws: WebSocket, topic: string): boolean {
    const state = this.connections.get(ws);
    if (!state) return false;

    state.subscriptions.add(topic);
    let set = this.topicToSockets.get(topic);
    if (!set) {
      set = new Set();
      this.topicToSockets.set(topic, set);
    }
    set.add(ws);
    return true;
  }

  public unsubscribe(ws: WebSocket, topic: string): boolean {
    const state = this.connections.get(ws);
    if (!state) return false;

    state.subscriptions.delete(topic);
    state.depthLastSeq.delete(topic.replace('depth@', ''));
    state.depthPendingSnapshot.delete(topic.replace('depth@', ''));

    const set = this.topicToSockets.get(topic);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        this.topicToSockets.delete(topic);
      }
    }
    return true;
  }

  public authenticate(ws: WebSocket, userId: string): boolean {
    const state = this.connections.get(ws);
    if (!state) return false;

    // If previously authenticated as another user, clean up
    if (state.userId && state.userId !== userId) {
      const oldSet = this.userToSockets.get(state.userId);
      if (oldSet) {
        oldSet.delete(ws);
        if (oldSet.size === 0) this.userToSockets.delete(state.userId);
      }
    }

    state.userId = userId;
    let set = this.userToSockets.get(userId);
    if (!set) {
      set = new Set();
      this.userToSockets.set(userId, set);
    }
    set.add(ws);
    return true;
  }

  public sendSafe(ws: WebSocket, message: string): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (ws.bufferedAmount > this.maxBufferedAmount) {
      try {
        ws.close(1013, 'Backpressure: buffer limit exceeded');
      } catch {
        // Socket may already be closing
      }
      this.removeConnection(ws);
      return false;
    }

    ws.send(message);
    this.messagesOutTotal++;
    return true;
  }

  public broadcastToTopic(
    topic: string,
    message: string,
    filterFn?: (state: ConnectionState) => boolean
  ): number {
    const set = this.topicToSockets.get(topic);
    if (!set || set.size === 0) return 0;

    let sent = 0;
    for (const ws of set) {
      const state = this.connections.get(ws);
      if (!state) continue;

      if (filterFn && !filterFn(state)) {
        continue;
      }

      if (this.sendSafe(ws, message)) {
        sent++;
      }
    }
    return sent;
  }

  public sendToUser(userId: string, message: string): number {
    const set = this.userToSockets.get(userId);
    if (!set || set.size === 0) return 0;

    let sent = 0;
    for (const ws of set) {
      const state = this.connections.get(ws);
      if (!state) continue;

      // Only send if the connection has also subscribed to the "user" stream
      if (state.subscriptions.has('user')) {
        if (this.sendSafe(ws, message)) {
          sent++;
        }
      }
    }
    return sent;
  }

  public getSubscribers(topic: string): WebSocket[] {
    const set = this.topicToSockets.get(topic);
    return set ? Array.from(set) : [];
  }

  public getMetrics(): WsServerMetrics {
    return {
      ws_connections: this.connections.size,
      ws_messages_out_total: this.messagesOutTotal,
    };
  }

  public clear(): void {
    for (const ws of this.connections.keys()) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
    this.connections.clear();
    this.topicToSockets.clear();
    this.userToSockets.clear();
  }
}
