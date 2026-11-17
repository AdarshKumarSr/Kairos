import { Redis } from 'ioredis';
import type { ConnectionManager } from './connection-manager.js';
import type { DepthSnapshotPayload } from './types.js';

export interface RedisSubscriberOptions {
  redisClient: Redis;
  connectionManager: ConnectionManager;
  onResyncRequired?: (market: string) => Promise<void>;
}

export class RedisSubscriber {
  private subRedis: Redis;
  private cmdRedis: Redis;
  private connectionManager: ConnectionManager;

  constructor(options: {
    subRedis: Redis;
    cmdRedis: Redis;
    connectionManager: ConnectionManager;
  }) {
    this.subRedis = options.subRedis;
    this.cmdRedis = options.cmdRedis;
    this.connectionManager = options.connectionManager;
  }

  public async start(): Promise<void> {
    this.subRedis.on('pmessage', (_pattern: string, channel: string, message: string) => {
      this.handlePMessage(channel, message);
    });

    await this.subRedis.psubscribe('md:*', 'user:*');
  }

  public async stop(): Promise<void> {
    await this.subRedis.punsubscribe('md:*', 'user:*');
  }

  public async fetchAndSendSnapshot(ws: import('ws').WebSocket, market: string): Promise<void> {
    const state = this.connectionManager.getConnection(ws);
    if (!state) return;

    state.depthPendingSnapshot.add(market);

    try {
      const raw = await this.cmdRedis.get(`depth:${market}`);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          market: string;
          seq: string;
          bids: [string, string][];
          asks: [string, string][];
        };

        const snapshotMsg: DepthSnapshotPayload = {
          e: 'depthSnapshot',
          s: market,
          seq: parsed.seq,
          b: parsed.bids,
          a: parsed.asks,
        };

        this.connectionManager.sendSafe(ws, JSON.stringify(snapshotMsg));
        state.depthLastSeq.set(market, BigInt(parsed.seq));
      } else {
        const emptyMsg: DepthSnapshotPayload = {
          e: 'depthSnapshot',
          s: market,
          seq: '0',
          b: [],
          a: [],
        };
        this.connectionManager.sendSafe(ws, JSON.stringify(emptyMsg));
        state.depthLastSeq.set(market, 0n);
      }
    } catch {
      // Ignore errors fetching snapshot
    } finally {
      state.depthPendingSnapshot.delete(market);
    }
  }

  private handlePMessage(channel: string, message: string): void {
    if (channel.startsWith('md:depth:')) {
      const market = channel.slice('md:depth:'.length);
      this.handleDepthDelta(market, message);
    } else if (channel.startsWith('md:trade:')) {
      const market = channel.slice('md:trade:'.length);
      this.connectionManager.broadcastToTopic(`trade@${market}`, message);
    } else if (channel.startsWith('md:ticker:')) {
      const market = channel.slice('md:ticker:'.length);
      this.connectionManager.broadcastToTopic(`ticker@${market}`, message);
    } else if (channel.startsWith('md:kline:')) {
      const parts = channel.slice('md:kline:'.length).split(':');
      if (parts.length === 2) {
        const [interval, market] = parts;
        this.connectionManager.broadcastToTopic(`kline_${interval}@${market}`, message);
      }
    } else if (channel.startsWith('user:')) {
      const userId = channel.slice('user:'.length);
      this.connectionManager.sendToUser(userId, message);
    }
  }

  private handleDepthDelta(market: string, message: string): void {
    let deltaSeq: bigint;
    try {
      const parsed = JSON.parse(message) as { seq: string };
      deltaSeq = BigInt(parsed.seq);
    } catch {
      return;
    }

    const topic = `depth@${market}`;
    const sockets = this.connectionManager.getSubscribers(topic);

    for (const ws of sockets) {
      const state = this.connectionManager.getConnection(ws);
      if (!state) continue;

      // If waiting for snapshot, do not deliver deltas yet
      if (state.depthPendingSnapshot.has(market)) {
        continue;
      }

      const lastSeq = state.depthLastSeq.get(market);
      if (lastSeq === undefined) {
        // Socket subscribed but snapshot not loaded yet: trigger fetch
        void this.fetchAndSendSnapshot(ws, market);
        continue;
      }

      if (deltaSeq <= lastSeq) {
        // Delta already covered by snapshot or earlier delta
        continue;
      }

      // Check for sequence gap: deltaSeq > lastSeq + 1n
      // Note: In matching engine, each throttled depth flush can jump seq
      // if multiple commands executed in the 100ms window.
      // But Section 6.2 states: if the first delta seq does not follow snapshot,
      // resend snapshot. If gap is detected, resend snapshot.
      if (deltaSeq > lastSeq + 1n && lastSeq > 0n) {
        // Gap detected! Trigger snapshot resync for this socket
        void this.fetchAndSendSnapshot(ws, market);
        continue;
      }

      // Delta follows seamlessly
      state.depthLastSeq.set(market, deltaSeq);
      this.connectionManager.sendSafe(ws, message);
    }
  }
}
