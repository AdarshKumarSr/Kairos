import { performance } from 'node:perf_hooks';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ConnectionManager } from './connection-manager.js';
import { WsServer } from './server.js';
import type { ConnectionState, DepthSnapshotPayload } from './types.js';

const REDIS_URL =
  process.env.REDIS_URL ?? 'redis://:cex_dev_redis@localhost:6379';
const TEST_JWT_SECRET = 'test-secret-key-for-ws-server-jwt-auth-at-least-32-chars';

function signToken(userId: string): string {
  return jwt.sign({ sub: userId, role: 'USER' }, TEST_JWT_SECRET, {
    expiresIn: '1h',
  });
}

function waitForMessage(
  ws: WebSocket,
  filter?: (msg: any) => boolean,
  timeoutMs = 5000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error(`Timeout waiting for message (${timeoutMs}ms)`));
    }, timeoutMs);

    const handler = (data: Buffer | string) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (!filter || filter(parsed)) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(parsed);
        }
      } catch {
        // ignore unparseable message
      }
    };

    ws.on('message', handler);
  });
}

describe('Phase 13: WebSocket Server', () => {
  let redisPub: Redis;

  beforeAll(async () => {
    redisPub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    redisPub.disconnect();
  });

  describe('1. Subscribe / Unsubscribe Lifecycle & Protocol Messages', () => {
    let server: WsServer;

    beforeAll(async () => {
      server = new WsServer({
        port: 0,
        jwtSecret: TEST_JWT_SECRET,
        redisUrl: REDIS_URL,
      });
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    it('subscribes to public topic, receives pub/sub broadcast, and stops on unsubscribe', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.getPort()}`);
      await new Promise((r) => ws.once('open', r));

      // 1. Subscribe to trade@SOL_USDT
      const subPromise = waitForMessage(ws, (m) => m.id === 1);
      ws.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: ['trade@SOL_USDT'],
          id: 1,
        })
      );
      const subRes = await subPromise;
      expect(subRes.result).toBeNull();
      expect(subRes.id).toBe(1);

      // 2. Publish trade to Redis Pub/Sub
      const tradePromise = waitForMessage(ws, (m) => m.e === 'trade');
      const testTrade = {
        e: 'trade',
        s: 'SOL_USDT',
        p: '14250000000',
        q: '1000000000',
        t: Date.now(),
        m: true,
      };
      await redisPub.publish('md:trade:SOL_USDT', JSON.stringify(testTrade));

      const tradeMsg = await tradePromise;
      expect(tradeMsg.e).toBe('trade');
      expect(tradeMsg.s).toBe('SOL_USDT');
      expect(tradeMsg.p).toBe('14250000000');

      // 3. Unsubscribe from trade@SOL_USDT
      const unsubPromise = waitForMessage(ws, (m) => m.id === 2);
      ws.send(
        JSON.stringify({
          method: 'UNSUBSCRIBE',
          params: ['trade@SOL_USDT'],
          id: 2,
        })
      );
      const unsubRes = await unsubPromise;
      expect(unsubRes.result).toBeNull();

      // 4. Verify no more messages received after unsubscribe
      let receivedAfterUnsub = false;
      const lateHandler = () => {
        receivedAfterUnsub = true;
      };
      ws.on('message', lateHandler);

      await redisPub.publish(
        'md:trade:SOL_USDT',
        JSON.stringify({ e: 'trade', s: 'SOL_USDT', p: '9999' })
      );
      await new Promise((r) => setTimeout(r, 150));
      ws.off('message', lateHandler);

      expect(receivedAfterUnsub).toBe(false);

      // 5. PING -> PONG
      const pingPromise = waitForMessage(ws, (m) => m.id === 3);
      ws.send(JSON.stringify({ method: 'PING', id: 3 }));
      const pingRes = await pingPromise;
      expect(pingRes.result).toBe('PONG');
      expect(pingRes.id).toBe(3);

      ws.close();
    });

    it('validates protocol frames: invalid JSON, unknown method, and rate limiting', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.getPort()}`);
      await new Promise((r) => ws.once('open', r));

      // Invalid JSON
      const err1Promise = waitForMessage(ws, (m) => m.error?.code === 400);
      ws.send('invalid non-json text');
      const err1 = await err1Promise;
      expect(err1.error.code).toBe(400);
      expect(err1.error.message).toBe('Invalid JSON');

      // Unknown method
      const err2Promise = waitForMessage(ws, (m) => m.id === 99);
      ws.send(JSON.stringify({ method: 'UNKNOWN_OP', id: 99 }));
      const err2 = await err2Promise;
      expect(err2.error.code).toBe(400);
      expect(err2.error.message).toContain('Unknown method');

      // Rate limit test (> 20 messages in 1s window)
      let rateLimitHit = false;
      ws.on('message', (d) => {
        try {
          const parsed = JSON.parse(d.toString());
          if (parsed.error?.code === 429) rateLimitHit = true;
        } catch {}
      });

      for (let i = 0; i < 30; i++) {
        ws.send(JSON.stringify({ method: 'PING', id: 100 + i }));
      }

      await new Promise((r) => setTimeout(r, 200));
      expect(rateLimitHit).toBe(true);

      ws.close();
    });
  });

  describe('2. Depth Protocol: Initial Snapshot & Sequence-Gap Resync (Section 6.2)', () => {
    let server: WsServer;

    beforeAll(async () => {
      server = new WsServer({
        port: 0,
        jwtSecret: TEST_JWT_SECRET,
        redisUrl: REDIS_URL,
      });
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    it('sends snapshot first, forwards contiguous deltas, and resyncs on sequence gap', async () => {
      const market = 'BTC_USDT';

      // 1. Seed initial snapshot in Redis
      await redisPub.set(
        `depth:${market}`,
        JSON.stringify({
          market,
          seq: '500',
          timestamp: Date.now(),
          bids: [['6500000000000', '100000000']],
          asks: [['6510000000000', '200000000']],
        })
      );

      const ws = new WebSocket(`ws://127.0.0.1:${server.getPort()}`);
      await new Promise((r) => ws.once('open', r));

      // 2. Subscribe to depth@BTC_USDT
      const snapshotPromise = waitForMessage(ws, (m) => m.e === 'depthSnapshot');
      ws.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: [`depth@${market}`],
          id: 10,
        })
      );

      // Verify client receives snapshot with seq 500
      const snapshotMsg = await snapshotPromise;
      expect(snapshotMsg.e).toBe('depthSnapshot');
      expect(snapshotMsg.s).toBe(market);
      expect(snapshotMsg.seq).toBe('500');
      expect(snapshotMsg.b).toEqual([['6500000000000', '100000000']]);

      // 3. Publish contiguous delta (seq 501 = 500 + 1)
      const deltaPromise = waitForMessage(ws, (m) => m.e === 'depthUpdate');
      await redisPub.publish(
        `md:depth:${market}`,
        JSON.stringify({
          e: 'depthUpdate',
          s: market,
          seq: '501',
          b: [['6500000000000', '150000000']],
          a: [],
        })
      );

      const deltaMsg = await deltaPromise;
      expect(deltaMsg.e).toBe('depthUpdate');
      expect(deltaMsg.seq).toBe('501');

      // 4. Simulate sequence gap: update Redis snapshot to seq 550, then publish delta with seq 550
      await redisPub.set(
        `depth:${market}`,
        JSON.stringify({
          market,
          seq: '550',
          timestamp: Date.now(),
          bids: [['6505000000000', '300000000']],
          asks: [['6515000000000', '400000000']],
        })
      );

      // Publish delta 550 (> 501 + 1n): gap detected!
      const resyncSnapshotPromise = waitForMessage(
        ws,
        (m) => m.e === 'depthSnapshot' && m.seq === '550'
      );
      await redisPub.publish(
        `md:depth:${market}`,
        JSON.stringify({
          e: 'depthUpdate',
          s: market,
          seq: '550',
          b: [['6505000000000', '300000000']],
          a: [],
        })
      );

      // Verify server detected gap and pushed fresh snapshot seq 550
      const resyncSnapshot = await resyncSnapshotPromise;
      expect(resyncSnapshot.e).toBe('depthSnapshot');
      expect(resyncSnapshot.seq).toBe('550');
      expect(resyncSnapshot.b).toEqual([['6505000000000', '300000000']]);

      ws.close();
    });
  });

  describe('3. Private Stream & User Isolation (Negative Test)', () => {
    let server: WsServer;

    beforeAll(async () => {
      server = new WsServer({
        port: 0,
        jwtSecret: TEST_JWT_SECRET,
        redisUrl: REDIS_URL,
      });
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    it('enforces AUTH for user stream, and User A never receives User B events', async () => {
      const userAlice = 'user-alice-uuid-111';
      const userBob = 'user-bob-uuid-222';
      const tokenAlice = signToken(userAlice);
      const tokenBob = signToken(userBob);

      // Connection 1: Alice
      const wsAlice = new WebSocket(`ws://127.0.0.1:${server.getPort()}`);
      await new Promise((r) => wsAlice.once('open', r));

      // Attempting to subscribe to "user" without AUTH must fail with 401
      const unauthPromise = waitForMessage(wsAlice, (m) => m.id === 'unauth-sub');
      wsAlice.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: ['user'],
          id: 'unauth-sub',
        })
      );
      const unauthRes = await unauthPromise;
      expect(unauthRes.error.code).toBe(401);

      // Now authenticate Alice
      const authAlicePromise = waitForMessage(wsAlice, (m) => m.id === 'auth-alice');
      wsAlice.send(
        JSON.stringify({
          method: 'AUTH',
          token: tokenAlice,
          id: 'auth-alice',
        })
      );
      const authAliceRes = await authAlicePromise;
      expect(authAliceRes.result).toBe('AUTH_SUCCESS');

      // Now subscribe Alice to "user"
      const subAlicePromise = waitForMessage(wsAlice, (m) => m.id === 'sub-alice');
      wsAlice.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: ['user'],
          id: 'sub-alice',
        })
      );
      const subAliceRes = await subAlicePromise;
      expect(subAliceRes.result).toBeNull();

      // Connection 2: Bob
      const wsBob = new WebSocket(`ws://127.0.0.1:${server.getPort()}`);
      await new Promise((r) => wsBob.once('open', r));

      // Authenticate Bob
      const authBobPromise = waitForMessage(wsBob, (m) => m.id === 'auth-bob');
      wsBob.send(
        JSON.stringify({
          method: 'AUTH',
          token: tokenBob,
          id: 'auth-bob',
        })
      );
      const authBobRes = await authBobPromise;
      expect(authBobRes.result).toBe('AUTH_SUCCESS');

      // Subscribe Bob to "user"
      const subBobPromise = waitForMessage(wsBob, (m) => m.id === 'sub-bob');
      wsBob.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: ['user'],
          id: 'sub-bob',
        })
      );
      const subBobRes = await subBobPromise;
      expect(subBobRes.result).toBeNull();

      // Track received messages for both clients
      const aliceReceived: any[] = [];
      const bobReceived: any[] = [];

      wsAlice.on('message', (d) => {
        try {
          const parsed = JSON.parse(d.toString());
          if (parsed.e) aliceReceived.push(parsed);
        } catch {}
      });

      wsBob.on('message', (d) => {
        try {
          const parsed = JSON.parse(d.toString());
          if (parsed.e) bobReceived.push(parsed);
        } catch {}
      });

      // Publish event for Alice on user:user-alice-uuid-111
      const aliceEvent = {
        e: 'orderUpdate',
        orderId: 'ord-alice-1',
        status: 'FILLED',
        filledQuantity: '1000000000',
      };
      await redisPub.publish(`user:${userAlice}`, JSON.stringify(aliceEvent));

      // Publish event for Bob on user:user-bob-uuid-222
      const bobEvent = {
        e: 'balanceUpdate',
        asset: 'USDT',
        available: '500000000000',
        locked: '0',
      };
      await redisPub.publish(`user:${userBob}`, JSON.stringify(bobEvent));

      // Wait for propagation
      for (let i = 0; i < 20; i++) {
        if (aliceReceived.length > 0 && bobReceived.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // Assert strict isolation: Alice got ONLY Alice's event, Bob got ONLY Bob's event!
      expect(aliceReceived.length).toBe(1);
      expect(aliceReceived[0].orderId).toBe('ord-alice-1');

      expect(bobReceived.length).toBe(1);
      expect(bobReceived[0].asset).toBe('USDT');

      // Negative check: Alice NEVER received Bob's event, and Bob NEVER received Alice's event!
      expect(aliceReceived.some((m) => m.asset === 'USDT')).toBe(false);
      expect(bobReceived.some((m) => m.orderId === 'ord-alice-1')).toBe(false);

      wsAlice.close();
      wsBob.close();
    });
  });

  describe('4. Slow Consumer Backpressure Disconnection (Code 1013)', () => {
    it('disconnects slow consumer with close code 1013 when bufferedAmount exceeds threshold', async () => {
      const manager = new ConnectionManager(100); // 100 bytes limit

      // Mock WebSocket with bufferedAmount exceeding threshold
      let closedWithCode: number | null = null;
      let closedWithReason: string | null = null;

      const mockWs = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 500, // 500 > 100
        send: () => {},
        close: (code: number, reason: string) => {
          closedWithCode = code;
          closedWithReason = reason;
        },
      } as unknown as WebSocket;

      manager.addConnection(mockWs);
      const sent = manager.sendSafe(mockWs, JSON.stringify({ e: 'depthUpdate' }));

      expect(sent).toBe(false);
      expect(closedWithCode).toBe(1013);
      expect(closedWithReason).toContain('Backpressure');
      expect(manager.getConnection(mockWs)).toBeUndefined(); // Cleaned up
    });
  });

  describe('5. Acceptance Criteria: 5,000 Concurrent Clients Load Benchmark', () => {
    it('fans out depth updates to 5,000 concurrent connected clients with p99 latency < 250 ms', async () => {
      const manager = new ConnectionManager(10 * 1024 * 1024);
      const numClients = 5000;
      const topic = 'depth@SOL_USDT';

      const mockSockets: WebSocket[] = [];
      const latencies: number[] = [];

      for (let i = 0; i < numClients; i++) {
        const clientWs = {
          readyState: WebSocket.OPEN,
          bufferedAmount: 0,
          send: (_msg: string) => {
            // Measure delivery time per client
            latencies.push(performance.now());
          },
          close: () => {},
        } as unknown as WebSocket;

        mockSockets.push(clientWs);
        manager.addConnection(clientWs);
        manager.subscribe(clientWs, topic);
      }

      const depthMessage = JSON.stringify({
        e: 'depthUpdate',
        s: 'SOL_USDT',
        seq: '10042',
        b: [
          ['14250000000', '25000000000'],
          ['14240000000', '50000000000'],
        ],
        a: [
          ['14260000000', '15000000000'],
          ['14270000000', '30000000000'],
        ],
      });

      const startTime = performance.now();
      const sentCount = manager.broadcastToTopic(topic, depthMessage);
      const totalElapsed = performance.now() - startTime;

      expect(sentCount).toBe(numClients);

      // Calculate latency distribution relative to start
      const relativeLatencies = latencies.map((t) => t - startTime).sort((a, b) => a - b);
      const p50 = relativeLatencies[Math.floor(numClients * 0.5)]!;
      const p90 = relativeLatencies[Math.floor(numClients * 0.9)]!;
      const p95 = relativeLatencies[Math.floor(numClients * 0.95)]!;
      const p99 = relativeLatencies[Math.floor(numClients * 0.99)]!;

      console.log(`\n=== Phase 13 WebSocket Fan-Out Benchmark (5,000 Clients) ===`);
      console.log(`Total broadcast time: ${totalElapsed.toFixed(2)} ms`);
      console.log(`p50 latency: ${p50.toFixed(2)} ms`);
      console.log(`p90 latency: ${p90.toFixed(2)} ms`);
      console.log(`p95 latency: ${p95.toFixed(2)} ms`);
      console.log(`p99 latency: ${p99.toFixed(2)} ms`);
      console.log(`Throughput: ${(numClients / (totalElapsed / 1000)).toFixed(0)} messages/sec\n`);

      // Acceptance criterion: p99 under 250 ms!
      expect(p99).toBeLessThan(250);
      expect(totalElapsed).toBeLessThan(250);

      manager.clear();
    });
  });
});
