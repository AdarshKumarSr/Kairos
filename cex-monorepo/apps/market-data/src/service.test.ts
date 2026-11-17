import {
  Book,
  Engine,
  type EngineContext,
  type MarketConfig,
  MarketStatus,
  OrderType,
  Side,
} from '@cex/engine';
import type { Event } from '@cex/types';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BookMirror } from './book-mirror.js';
import { CandleManager } from './candle-manager.js';
import { DepthThrottler } from './depth-throttler.js';
import { Rolling24hStats } from './rolling-stats.js';
import { MarketDataService } from './service.js';

const REDIS_URL =
  process.env.REDIS_URL ?? 'redis://:cex_dev_redis@localhost:6379';

const SOL_USDT: MarketConfig = {
  symbol: 'SOL_USDT',
  baseAsset: 'SOL',
  quoteAsset: 'USDT',
  tickSize: '1000000', // 0.01 (1e8)
  lotSize: '1000000', // 0.01 (1e8)
  minNotional: '500000000', // 5.00 USDT (1e8)
  makerFeeBps: 8,
  takerFeeBps: 10,
  status: MarketStatus.ACTIVE,
};

function ctx(seq: bigint, now = 1700000000000): EngineContext {
  return { engineSeq: seq, now };
}

describe('Phase 12: Market Data Service', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    redis.disconnect();
  });

  describe('1. Known trade sequence yields hand-computed OHLC (Acceptance Criteria)', () => {
    it('accurately computes 1m and 15m OHLCV across intra-bucket and boundary trades', () => {
      const candleMgr = new CandleManager();
      const market = 'SOL_USDT';

      // Base time: 2026-11-17 12:00:00 UTC (1763380800000 ms)
      const t0 = 1763380800000;

      // Trade 1: at t0 + 10s, price 100.00 (100 * 1e8), qty 2.50 SOL (2.5 * 1e8)
      // quoteAmount = 100 * 2.5 = 250 USDT (250 * 1e8)
      const msgs1 = candleMgr.onTrade(
        market,
        '10000000000',
        '250000000',
        t0 + 10000
      );
      const c1 = msgs1.find((m) => m.i === '1m')!.k;
      expect(c1.t).toBe(t0);
      expect(c1.T).toBe(t0 + 60000);
      expect(c1.o).toBe('10000000000');
      expect(c1.h).toBe('10000000000');
      expect(c1.l).toBe('10000000000');
      expect(c1.c).toBe('10000000000');
      expect(c1.v).toBe('250000000');
      expect(c1.q).toBe('25000000000');
      expect(c1.n).toBe(1);
      expect(c1.x).toBe(false);

      // Trade 2: at t0 + 20s, price 110.00, qty 1.00 SOL
      // quoteAmount = 110 * 1 = 110 USDT (110 * 1e8)
      const msgs2 = candleMgr.onTrade(
        market,
        '11000000000',
        '100000000',
        t0 + 20000
      );
      const c2 = msgs2.find((m) => m.i === '1m')!.k;
      expect(c2.o).toBe('10000000000');
      expect(c2.h).toBe('11000000000');
      expect(c2.l).toBe('10000000000');
      expect(c2.c).toBe('11000000000');
      expect(c2.v).toBe('350000000'); // 2.5 + 1.0 = 3.5 SOL
      expect(c2.q).toBe('36000000000'); // 250 + 110 = 360 USDT
      expect(c2.n).toBe(2);
      expect(c2.x).toBe(false);

      // Trade 3: at t0 + 35s, price 95.00, qty 3.00 SOL
      // quoteAmount = 95 * 3 = 285 USDT
      const msgs3 = candleMgr.onTrade(
        market,
        '9500000000',
        '300000000',
        t0 + 35000
      );
      const c3 = msgs3.find((m) => m.i === '1m')!.k;
      expect(c3.o).toBe('10000000000');
      expect(c3.h).toBe('11000000000');
      expect(c3.l).toBe('9500000000');
      expect(c3.c).toBe('9500000000');
      expect(c3.v).toBe('650000000'); // 3.5 + 3.0 = 6.5 SOL
      expect(c3.q).toBe('64500000000'); // 360 + 285 = 645 USDT
      expect(c3.n).toBe(3);
      expect(c3.x).toBe(false);

      // Trade 4: at t0 + 50s, price 105.00, qty 4.00 SOL
      // quoteAmount = 105 * 4 = 420 USDT
      const msgs4 = candleMgr.onTrade(
        market,
        '10500000000',
        '400000000',
        t0 + 50000
      );
      const c4 = msgs4.find((m) => m.i === '1m')!.k;
      expect(c4.o).toBe('10000000000');
      expect(c4.h).toBe('11000000000');
      expect(c4.l).toBe('9500000000');
      expect(c4.c).toBe('10500000000');
      expect(c4.v).toBe('1050000000'); // 6.5 + 4.0 = 10.5 SOL
      expect(c4.q).toBe('106500000000'); // 645 + 420 = 1065 USDT
      expect(c4.n).toBe(4);
      expect(c4.x).toBe(false);

      // Trade 5: at t0 + 65s (minute boundary crossed!) -> price 108.00, qty 1.00 SOL
      const msgs5 = candleMgr.onTrade(
        market,
        '10800000000',
        '100000000',
        t0 + 65000
      );
      const m1m = msgs5.filter((m) => m.i === '1m');
      expect(m1m.length).toBe(2);

      // First 1m message is the closed candle for [t0, t0 + 60s]
      const closedCandle = m1m[0]!.k;
      expect(closedCandle.t).toBe(t0);
      expect(closedCandle.o).toBe('10000000000');
      expect(closedCandle.h).toBe('11000000000');
      expect(closedCandle.l).toBe('9500000000');
      expect(closedCandle.c).toBe('10500000000');
      expect(closedCandle.v).toBe('1050000000');
      expect(closedCandle.q).toBe('106500000000');
      expect(closedCandle.n).toBe(4);
      expect(closedCandle.x).toBe(true); // Closed!

      // Second 1m message is the new active candle for [t0 + 60s, t0 + 120s]
      const newCandle = m1m[1]!.k;
      expect(newCandle.t).toBe(t0 + 60000);
      expect(newCandle.o).toBe('10800000000');
      expect(newCandle.h).toBe('10800000000');
      expect(newCandle.l).toBe('10800000000');
      expect(newCandle.c).toBe('10800000000');
      expect(newCandle.v).toBe('100000000');
      expect(newCandle.n).toBe(1);
      expect(newCandle.x).toBe(false);

      // 15m candle is still open and contains all 5 trades!
      const c15m = msgs5.find((m) => m.i === '15m')!.k;
      expect(c15m.t).toBe(t0);
      expect(c15m.T).toBe(t0 + 15 * 60000);
      expect(c15m.o).toBe('10000000000');
      expect(c15m.h).toBe('11000000000');
      expect(c15m.l).toBe('9500000000');
      expect(c15m.c).toBe('10800000000');
      expect(c15m.v).toBe('1150000000'); // 10.5 + 1.0 = 11.5 SOL
      expect(c15m.n).toBe(5);
      expect(c15m.x).toBe(false);
    });
  });

  describe('2. 24h rolling window correct across the boundary', () => {
    it('discards trades older than 24 hours and updates high, low, volume, and percentage', () => {
      const stats = new Rolling24hStats('SOL_USDT');
      const now = 1763380800000; // Reference timestamp
      const oneHour = 60 * 60 * 1000;

      // Trade 1: 25 hours ago (price 100, qty 10 SOL) -> EXPIRED
      stats.recordTrade('10000000000', '1000000000', now - 25 * oneHour);

      // Trade 2: 23 hours ago (price 110, qty 5 SOL) -> INCLUDED
      stats.recordTrade('11000000000', '500000000', now - 23 * oneHour);

      // Trade 3: 5 hours ago (price 130, qty 2 SOL) -> INCLUDED (24h high)
      stats.recordTrade('13000000000', '200000000', now - 5 * oneHour);

      // Trade 4: 2 hours ago (price 105, qty 3 SOL) -> INCLUDED (24h low)
      stats.recordTrade('10500000000', '300000000', now - 2 * oneHour);

      // Trade 5: now (price 120, qty 1 SOL) -> INCLUDED (latest close)
      stats.recordTrade('12000000000', '100000000', now);

      const ticker = stats.getStats(now, '11900000000', '12050000000');

      // Trade 1 (25h ago) must NOT be in the window:
      // Volume = 5 + 2 + 3 + 1 = 11 SOL (1,100,000,000)
      expect(ticker.volume24h).toBe('1100000000');
      expect(ticker.tradeCount24h).toBe(4);

      // Open price should be Trade 2 (110.00), not Trade 1 (100.00)
      expect(ticker.lastPrice).toBe('12000000000');
      expect(ticker.high24h).toBe('13000000000');
      expect(ticker.low24h).toBe('10500000000');

      // Price change = 120 - 110 = +10.00 (1,000,000,000)
      expect(ticker.priceChange24h).toBe('1000000000');
      // Price change pct = (10 / 110) * 100 = 9.09%
      expect(ticker.priceChangePercent24h).toBe('9.09');

      expect(ticker.bestBid).toBe('11900000000');
      expect(ticker.bestAsk).toBe('12050000000');
    });
  });

  describe('3. Depth Throttling Never Reorders Sequence Numbers', () => {
    it('batches deltas and guarantees strictly increasing seq across flushes', () => {
      const throttler = new DepthThrottler('SOL_USDT');

      // Burst 1: seq 1, 2, 3
      throttler.addDelta(Side.BUY, '10000000000', '500000000', 1n);
      throttler.addDelta(Side.SELL, '10500000000', '300000000', 2n);
      throttler.addDelta(Side.BUY, '10000000000', '800000000', 3n); // update same price

      const flush1 = throttler.flush(1000);
      expect(flush1).toBeDefined();
      expect(flush1?.seq).toBe('3');
      expect(flush1?.b).toEqual([['10000000000', '800000000']]); // latest quantity for price wins
      expect(flush1?.a).toEqual([['10500000000', '300000000']]);

      // Burst 2: seq 4, 5, 6
      throttler.addDelta(Side.BUY, '10100000000', '200000000', 4n);
      throttler.addDelta(Side.SELL, '10600000000', '400000000', 5n);
      throttler.addDelta(Side.SELL, '10500000000', '0', 6n); // removal

      const flush2 = throttler.flush(2000);
      expect(flush2).toBeDefined();
      expect(flush2?.seq).toBe('6');
      expect(BigInt(flush2!.seq)).toBeGreaterThan(BigInt(flush1!.seq)); // Strict ordering
      expect(flush2?.a).toContainEqual(['10500000000', '0']);

      // Burst 3: empty -> flush returns null
      const flush3 = throttler.flush(3000);
      expect(flush3).toBeNull();

      // Burst 4: late out-of-order delta with seq 5 (<= 6) should be discarded
      throttler.addDelta(Side.BUY, '9900000000', '100000000', 5n);
      expect(throttler.hasPendingDeltas()).toBe(false); // Discarded!
    });
  });

  describe('4. Depth Snapshot + Delta Reconstruction Equality (Acceptance Criteria)', () => {
    it(
      'reconstructed in-memory BookMirror matches pure Engine book exactly across 10,000 random events',
      () => {
        const state = Engine.createInitialState([SOL_USDT]);
        const mirror = new BookMirror('SOL_USDT');
        let seq = 1n;

        // Seed users with ample funds
        const users = ['user_1', 'user_2', 'user_3', 'user_4'];
        for (const u of users) {
          Engine.process(
            state,
            {
              commandId: `dep-u-${u}`,
              type: 'DEPOSIT',
              userId: u,
              ts: 1000,
              payload: { asset: 'USDT', amount: '100000000000000' },
            },
            ctx(seq++)
          );
          Engine.process(
            state,
            {
              commandId: `dep-s-${u}`,
              type: 'DEPOSIT',
              userId: u,
              ts: 1001,
              payload: { asset: 'SOL', amount: '1000000000000' },
            },
            ctx(seq++)
          );
        }

        // Generate 10,000 random operations (Limit orders, market orders, cancels)
        const openOrders: string[] = [];
        let randomSeed = 42;
        const rand = () => {
          randomSeed = (randomSeed * 1664525 + 1013904223) % 4294967296;
          return randomSeed / 4294967296;
        };

        for (let i = 0; i < 10000; i++) {
          const u = users[Math.floor(rand() * users.length)]!;
          const isCancel = openOrders.length > 50 && rand() < 0.25;

          if (isCancel) {
            const idx = Math.floor(rand() * openOrders.length);
            const orderIdToCancel = openOrders[idx]!;
            openOrders.splice(idx, 1);

            const res = Engine.process(
              state,
              {
                commandId: `cancel-${i}`,
                type: 'CANCEL_ORDER',
                userId: u,
                ts: 2000 + i,
                payload: { orderId: orderIdToCancel, market: 'SOL_USDT' },
              },
              ctx(seq++)
            );

            // Feed deltas into mirror
            for (const ev of res.events) {
              if (ev.type === 'DEPTH_DELTA') {
                const d = ev.data as { side: Side; price: string; quantity: string };
                mirror.applyDelta(d.side, d.price, d.quantity, BigInt(ev.engineSeq));
              }
            }
          } else {
            const side = rand() < 0.5 ? Side.BUY : Side.SELL;
            const priceNum = 90 + Math.floor(rand() * 20); // 90 to 110
            const price = (BigInt(priceNum) * 100000000n).toString();
            const qtyNum = 1 + Math.floor(rand() * 5); // 1 to 5
            const qty = (BigInt(qtyNum) * 100000000n).toString();
            const orderId = `o-${i}`;

            const res = Engine.process(
              state,
              {
                commandId: `place-${i}`,
                type: 'PLACE_ORDER',
                userId: u,
                ts: 2000 + i,
                payload: {
                  orderId,
                  market: 'SOL_USDT',
                  side,
                  type: OrderType.LIMIT,
                  price,
                  quantity: qty,
                },
              },
              ctx(seq++)
            );

            if (res.events.some((e) => e.type === 'ORDER_PLACED')) {
              openOrders.push(orderId);
            }

            // Feed deltas into mirror
            for (const ev of res.events) {
              if (ev.type === 'DEPTH_DELTA') {
                const d = ev.data as { side: Side; price: string; quantity: string };
                mirror.applyDelta(d.side, d.price, d.quantity, BigInt(ev.engineSeq));
              }
            }
          }
        }

        // Extract engine book ladder
        const engineMarket = state.markets.get('SOL_USDT')!;
        const engineDepth = engineMarket.book.depth(50);
        const mirrorSnapshot = mirror.getSnapshot(50);

        // Assert 100% exact equality of bids and asks ladders!
        const engineBids = engineDepth.bids.map((b) => [b.price.toString(), b.quantity.toString()]);
        const engineAsks = engineDepth.asks.map((a) => [a.price.toString(), a.quantity.toString()]);

        expect(mirrorSnapshot.bids).toEqual(engineBids);
        expect(mirrorSnapshot.asks).toEqual(engineAsks);
        expect(mirror.getBestBid()).toBe(
          engineBids.length > 0 ? engineBids[0]![0] : null
        );
        expect(mirror.getBestAsk()).toBe(
          engineAsks.length > 0 ? engineAsks[0]![0] : null
        );
      },
      30000
    );
  });

  describe('5. MarketDataService Live Redis Streams & Pub/Sub Integration', () => {
    let testStream: string;
    let groupName: string;
    let consumerName: string;
    let service: MarketDataService;
    let subscriber: Redis;

    beforeEach(async () => {
      const id = Math.random().toString(36).substring(2, 9);
      testStream = `test.md.events.${Date.now()}.${id}`;
      groupName = `test-md-group-${id}`;
      consumerName = `test-md-1-${id}`;

      subscriber = new Redis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });

      await redis.del(testStream);
      service = new MarketDataService({
        redis,
        streamEvents: testStream,
        groupName,
        consumerName,
        throttleMs: 50,
      });
      await service.start();
    });

    afterEach(async () => {
      await service.stop();
      subscriber.disconnect();
      await redis.del(testStream);
    });

    it('processes TRADE, updates ticker and candles, and publishes on md:trade and md:ticker', async () => {
      const tradeReceived: unknown[] = [];
      const tickerReceived: unknown[] = [];

      subscriber.on('message', (ch, msg) => {
        if (ch === 'md:trade:SOL_USDT') tradeReceived.push(JSON.parse(msg));
        if (ch === 'md:ticker:SOL_USDT') tickerReceived.push(JSON.parse(msg));
      });
      await subscriber.subscribe('md:trade:SOL_USDT', 'md:ticker:SOL_USDT');

      const tradeEvent: Event = {
        engineSeq: '501',
        commandId: 'cmd-tr-1',
        type: 'TRADE',
        ts: Date.now(),
        data: {
          tradeId: 't-live-1',
          market: 'SOL_USDT',
          price: '14250000000',
          quantity: '500000000',
          takerSide: Side.SELL,
          makerUserId: 'maker-1',
          takerUserId: 'taker-1',
        },
      };

      await redis.xadd(testStream, '*', 'event', JSON.stringify(tradeEvent));

      // Wait for pub/sub reception
      for (let i = 0; i < 20; i++) {
        if (tradeReceived.length > 0 && tickerReceived.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(tradeReceived.length).toBeGreaterThan(0);
      const t = tradeReceived[0] as Record<string, unknown>;
      expect(t.e).toBe('trade');
      expect(t.s).toBe('SOL_USDT');
      expect(t.p).toBe('14250000000');
      expect(t.q).toBe('500000000');
      expect(t.m).toBe(true); // maker was buyer because taker was seller

      expect(tickerReceived.length).toBeGreaterThan(0);
      const tick = tickerReceived[0] as Record<string, unknown>;
      expect(tick.lastPrice).toBe('14250000000');

      // Verify Redis key ticker:SOL_USDT was set
      const tickerKey = await redis.get('ticker:SOL_USDT');
      expect(tickerKey).toBeDefined();
      expect(JSON.parse(tickerKey!).lastPrice).toBe('14250000000');
    });

    it('transforms private user events and publishes to user:{userId}', async () => {
      const userUpdates: unknown[] = [];
      const targetUserId = 'private-user-123';

      subscriber.on('message', (ch, msg) => {
        if (ch === `user:${targetUserId}`) userUpdates.push(JSON.parse(msg));
      });
      await subscriber.subscribe(`user:${targetUserId}`);

      // 1. ORDER_PLACED
      const orderPlacedEvt: Event = {
        engineSeq: '601',
        commandId: 'cmd-ord-1',
        type: 'ORDER_PLACED',
        ts: Date.now(),
        data: {
          orderId: 'ord-p-1',
          clientOrderId: 'cl-1',
          userId: targetUserId,
          market: 'SOL_USDT',
          side: Side.BUY,
          price: '14000000000',
          quantity: '1000000000',
          filledQuantity: '0',
          status: 'OPEN',
        },
      };

      // 2. BALANCE_UPDATED
      const balEvt: Event = {
        engineSeq: '602',
        commandId: 'cmd-bal-1',
        type: 'BALANCE_UPDATED',
        ts: Date.now(),
        data: {
          userId: targetUserId,
          asset: 'USDT',
          available: '50000000000',
          locked: '14000000000',
          reason: 'LOCK',
        },
      };

      await redis.xadd(testStream, '*', 'event', JSON.stringify(orderPlacedEvt));
      await redis.xadd(testStream, '*', 'event', JSON.stringify(balEvt));

      for (let i = 0; i < 40; i++) {
        if (userUpdates.length >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(userUpdates.length).toBe(2);
      const oMsg = userUpdates[0] as Record<string, unknown>;
      expect(oMsg.e).toBe('orderUpdate');
      expect(oMsg.orderId).toBe('ord-p-1');
      expect(oMsg.status).toBe('OPEN');

      const bMsg = userUpdates[1] as Record<string, unknown>;
      expect(bMsg.e).toBe('balanceUpdate');
      expect(bMsg.asset).toBe('USDT');
      expect(bMsg.available).toBe('50000000000');
    });

    it('throttles depth deltas into 100ms batches and publishes on md:depth:{market}', async () => {
      const depthUpdates: unknown[] = [];
      subscriber.on('message', (ch, msg) => {
        if (ch === 'md:depth:SOL_USDT') depthUpdates.push(JSON.parse(msg));
      });
      await subscriber.subscribe('md:depth:SOL_USDT');

      // Send 3 depth deltas
      for (let i = 1; i <= 3; i++) {
        const deltaEvt: Event = {
          engineSeq: i.toString(),
          commandId: `cmd-d-${i}`,
          type: 'DEPTH_DELTA',
          ts: Date.now(),
          data: {
            market: 'SOL_USDT',
            side: Side.BUY,
            price: (10000000000 + i * 1000000).toString(),
            quantity: (i * 100000000).toString(),
          },
        };
        await redis.xadd(testStream, '*', 'event', JSON.stringify(deltaEvt));
      }

      // Wait for throttler to flush to Pub/Sub
      for (let i = 0; i < 40; i++) {
        if (depthUpdates.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(depthUpdates.length).toBeGreaterThan(0);
      const d = depthUpdates[0] as Record<string, unknown>;
      expect(d.e).toBe('depthUpdate');
      expect(d.s).toBe('SOL_USDT');
      expect(BigInt(d.seq as string)).toBeGreaterThanOrEqual(1n);

      // Verify Redis depth snapshot was saved
      const snapshotRaw = await redis.get('depth:SOL_USDT');
      expect(snapshotRaw).toBeDefined();
      const snapshot = JSON.parse(snapshotRaw!);
      expect(snapshot.market).toBe('SOL_USDT');
      expect(snapshot.bids.length).toBeGreaterThan(0);
    });
  });
});
