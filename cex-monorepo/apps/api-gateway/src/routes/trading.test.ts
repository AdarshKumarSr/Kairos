import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import {
  Command,
  EngineReply,
  MarketStatus,
  OrderStatus,
  RejectCode,
  Side,
  OrderType,
} from '@cex/types';
import { Engine } from '../../../engine/src/index.js';
import { EngineRunner } from '../../../engine/src/runner/runner.js';
import { buildApp } from '../index.js';
import { EngineClient } from '../engine/engine-client.js';
import { DEFAULT_MARKETS } from '../services/market-config-cache.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://:cex_dev_redis@127.0.0.1:6379';

describe('Phase 9: API Gateway Trading Routes', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    redis.disconnect();
  });

  describe('Validation & Error Mapping', () => {
    let app: FastifyInstance;
    let userToken: string;
    let otherUserToken: string;

    beforeAll(async () => {
      // Mock engine client for unit validation tests
      const mockEngineClient = {
        send: async (cmd: Command): Promise<EngineReply> => {
          if (cmd.type === 'PLACE_ORDER') {
            if (cmd.payload.clientOrderId === 'dup-1') {
              return {
                commandId: cmd.commandId,
                engineSeq: '10',
                status: 'OK',
                order: {
                  orderId: 'fixed-order-id',
                  userId: cmd.userId ?? 'user-1',
                  market: String(cmd.payload.market),
                  side: cmd.payload.side as Side,
                  type: cmd.payload.type as OrderType,
                  price: String(cmd.payload.price),
                  quantity: String(cmd.payload.quantity),
                  status: OrderStatus.OPEN,
                  filledQuantity: '0',
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                },
              };
            }
            if (cmd.payload.quantity === '999999000000') {
              return {
                commandId: cmd.commandId,
                engineSeq: '11',
                status: 'REJECTED',
                code: RejectCode.INSUFFICIENT_FUNDS,
              };
            }
            return {
              commandId: cmd.commandId,
              engineSeq: '12',
              status: 'OK',
              order: {
                orderId: String(cmd.payload.orderId),
                userId: cmd.userId ?? 'user-1',
                market: String(cmd.payload.market),
                side: cmd.payload.side as Side,
                type: cmd.payload.type as OrderType,
                price: String(cmd.payload.price),
                quantity: String(cmd.payload.quantity),
                status: OrderStatus.OPEN,
                filledQuantity: '0',
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            };
          }

          if (cmd.type === 'CANCEL_ORDER') {
            if (cmd.payload.orderId === 'other-order') {
              return {
                commandId: cmd.commandId,
                engineSeq: '13',
                status: 'REJECTED',
                code: RejectCode.NOT_OWNER,
              };
            }
            if (cmd.payload.orderId === 'non-existent') {
              return {
                commandId: cmd.commandId,
                engineSeq: '14',
                status: 'REJECTED',
                code: RejectCode.ORDER_NOT_FOUND,
              };
            }
            return {
              commandId: cmd.commandId,
              engineSeq: '15',
              status: 'OK',
              order: {
                orderId: String(cmd.payload.orderId),
                userId: cmd.userId ?? 'user-1',
                market: 'SOL_USDT',
                side: Side.BUY,
                type: OrderType.LIMIT,
                quantity: '100000000',
                status: OrderStatus.CANCELLED,
                filledQuantity: '0',
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
            };
          }

          return { commandId: cmd.commandId, engineSeq: '1', status: 'OK' };
        },
      } as unknown as EngineClient;

      app = await buildApp(undefined, {
        redis,
        engineClient: mockEngineClient,
      });

      userToken = app.jwt.sign({ sub: 'user-1', role: 'USER' });
      otherUserToken = app.jwt.sign({ sub: 'user-2', role: 'USER' });
    });

    afterAll(async () => {
      await app.close();
    });

    it('1. Unauthenticated request returns 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/order',
        payload: {
          market: 'SOL_USDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '14000000000',
          quantity: '100000000',
        },
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('2. Invalid payload returns 400 with field errors', async () => {
      // postOnly and ioc together is invalid
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/order',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          market: 'SOL_USDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '14000000000',
          quantity: '100000000',
          postOnly: true,
          ioc: true,
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('3. Tick size violation returns 422 INVALID_TICK', async () => {
      // SOL_USDT tick size is 1000000 (0.01). 14000000005 is not divisible by 1000000.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/order',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          market: 'SOL_USDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '14000000005',
          quantity: '100000000',
        },
      });
      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('INVALID_TICK');
    });

    it('4. Lot size violation returns 422 INVALID_LOT', async () => {
      // SOL_USDT lot size is 1000000 (0.01). 100000005 is not divisible by 1000000.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/order',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          market: 'SOL_USDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '14000000000',
          quantity: '100000005',
        },
      });
      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('INVALID_LOT');
    });

    it('5. Below min notional returns 422 BELOW_MIN_NOTIONAL', async () => {
      // SOL_USDT minNotional is 500000000 (5.00 USDT).
      // Price = 1.00 USDT (100000000), Quantity = 0.01 SOL (1000000) -> Notional = 0.01 USDT < 5.00 USDT.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/order',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          market: 'SOL_USDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '100000000',
          quantity: '1000000',
        },
      });
      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('BELOW_MIN_NOTIONAL');
    });

    it('6. Insufficient funds returns 422 INSUFFICIENT_FUNDS', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/order',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          market: 'SOL_USDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '14000000000',
          quantity: '999999000000', // valid lot size, triggers mock INSUFFICIENT_FUNDS
        },
      });
      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('INSUFFICIENT_FUNDS');
    });

    it('7. Duplicate clientOrderId returns original order response', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/order',
        headers: { authorization: `Bearer ${userToken}` },
        payload: {
          market: 'SOL_USDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '14000000000',
          quantity: '100000000',
          clientOrderId: 'dup-1',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.orderId).toBe('fixed-order-id');
    });

    it('8. Cancel by another user returns 403 NOT_OWNER', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/order/other-order',
        headers: { authorization: `Bearer ${otherUserToken}` },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('NOT_OWNER');
    });

    it('9. Cancel unknown order returns 404 ORDER_NOT_FOUND', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/order/non-existent',
        headers: { authorization: `Bearer ${userToken}` },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe('ORDER_NOT_FOUND');
    });

    it('10. Public endpoints: /markets and /depth', async () => {
      const resMarkets = await app.inject({ method: 'GET', url: '/api/v1/markets' });
      expect(resMarkets.statusCode).toBe(200);
      const mBody = JSON.parse(resMarkets.payload);
      expect(mBody.markets.length).toBeGreaterThanOrEqual(1);

      const resDepth = await app.inject({ method: 'GET', url: '/api/v1/depth?market=SOL_USDT' });
      expect(resDepth.statusCode).toBe(200);
      const dBody = JSON.parse(resDepth.payload);
      expect(dBody.market).toBe('SOL_USDT');
    });

    it('11. OpenAPI documentation served at /docs and /docs/openapi.json', async () => {
      const resJson = await app.inject({ method: 'GET', url: '/docs/openapi.json' });
      expect(resJson.statusCode).toBe(200);
      const schema = JSON.parse(resJson.payload);
      expect(schema.openapi).toBe('3.1.0');
      expect(schema.paths['/order']).toBeDefined();

      const resHtml = await app.inject({ method: 'GET', url: '/docs' });
      expect(resHtml.statusCode).toBe(200);
      expect(resHtml.headers['content-type']).toContain('text/html');
      expect(resHtml.payload).toContain('SwaggerUIBundle');
    });
  });

  describe('Full End-to-End Trading Lifecycle (Live EngineRunner + API Gateway)', () => {
    let app: FastifyInstance;
    let runner: EngineRunner;
    let client: EngineClient;
    let token: string;
    const testId = `e2e_${Date.now()}`;
    const streamCmd = `test.cmd.${testId}`;
    const streamRep = `test.rep.${testId}`;
    const streamEvt = `test.evt.${testId}`;
    const group = `group_${testId}`;
    const userId = `trader_${testId}`;

    beforeAll(async () => {
      // 1. Setup real Engine
      const engineState = Engine.createInitialState(DEFAULT_MARKETS);
      runner = new EngineRunner(engineState, {
        redis,
        streamCommands: streamCmd,
        streamReplies: streamRep,
        streamEvents: streamEvt,
        groupName: group,
        consumerName: 'runner-e2e',
        blockMs: 100,
      });
      await runner.start();

      // 2. Setup real Gateway EngineClient
      client = new EngineClient({
        pubRedis: redis,
        subRedis: new Redis(REDIS_URL, { maxRetriesPerRequest: null }),
        streamCommands: streamCmd,
        streamReplies: streamRep,
      });
      await client.start();

      // 3. Build Gateway
      app = await buildApp(undefined, {
        redis,
        engineClient: client,
      });

      // Ensure user exists in Postgres so foreign key relations succeed
      await app.prisma.user.upsert({
        where: { id: userId },
        create: {
          id: userId,
          email: `${userId}@test.com`,
          passwordHash: 'test-hash',
          role: 'USER',
        },
        update: {},
      });

      token = app.jwt.sign({ sub: userId, role: 'USER' });
    });

    afterAll(async () => {
      await app.prisma.order.deleteMany({ where: { userId } }).catch(() => {});
      await app.prisma.balance.deleteMany({ where: { userId } }).catch(() => {});
      await app.prisma.user.delete({ where: { id: userId } }).catch(() => {});

      await app.close();
      await client.close();
      await runner.stop();
      await redis.del(streamCmd, streamRep, streamEvt);
    });

    it(
      'End-to-End: deposit -> place order -> check open orders -> cancel -> verify unlock',
      async () => {
      // Step A: Deposit 1,000 USDT (1000 * 1e8 = 100_000_000_000n)
      const depRes = await app.inject({
        method: 'POST',
        url: '/api/v1/wallet/deposit',
        headers: { authorization: `Bearer ${token}` },
        payload: { asset: 'USDT', amount: '100000000000' },
      });
      expect(depRes.statusCode).toBe(200);
      const depBody = JSON.parse(depRes.payload);
      expect(depBody.balance.available).toBe('100000000000');

      // Step B: Place LIMIT BUY 5 SOL @ 142.50 (locks 712.50 USDT)
      const placeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/order',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          market: 'SOL_USDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '14250000000',
          quantity: '500000000',
        },
      });
      if (placeRes.statusCode !== 201) {
        console.error('PLACE ORDER ERROR:', placeRes.payload);
      }
      expect(placeRes.statusCode).toBe(201);
      const placeBody = JSON.parse(placeRes.payload);
      expect(placeBody.orderId).toBeDefined();
      expect(placeBody.status).toBe(OrderStatus.OPEN);
      const orderId = placeBody.orderId;

      // Step C: Verify order appears in GET /api/v1/orders/open
      const openRes = await app.inject({
        method: 'GET',
        url: '/api/v1/orders/open?market=SOL_USDT',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(openRes.statusCode).toBe(200);
      const openBody = JSON.parse(openRes.payload);
      const found = openBody.orders.find((o: any) => o.orderId === orderId);
      expect(found).toBeDefined();
      expect(found.status).toBe(OrderStatus.OPEN);

      // Step D: Cancel order via DELETE /api/v1/order/:orderId
      const cancelRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/order/${orderId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(cancelRes.statusCode).toBe(200);
      const cancelBody = JSON.parse(cancelRes.payload);
      expect(cancelBody.status).toBe(OrderStatus.CANCELLED);

      // Step E: Verify balance in engine is unlocked (all 1000 USDT available again)
      const bal = runner.getState().balanceManager.get(userId, 'USDT');
      expect(bal.locked).toBe(0n);
      expect(bal.available).toBe(100000000000n);
    }, 30000);

    it('Public Market Data Endpoints: /depth, /ticker, /trades, /klines', async () => {
      // 1. Seed depth in Redis
      await redis.set(
        'depth:SOL_USDT',
        JSON.stringify({
          market: 'SOL_USDT',
          seq: '100',
          timestamp: Date.now(),
          bids: [['14000000000', '500000000']],
          asks: [['14500000000', '200000000']],
        })
      );

      const depthRes = await app.inject({
        method: 'GET',
        url: '/api/v1/depth?market=SOL_USDT&limit=10',
      });
      expect(depthRes.statusCode).toBe(200);
      const depthBody = JSON.parse(depthRes.payload);
      expect(depthBody.market).toBe('SOL_USDT');
      expect(depthBody.seq).toBe('100');
      expect(depthBody.bids).toEqual([['14000000000', '500000000']]);
      expect(depthBody.asks).toEqual([['14500000000', '200000000']]);

      // 2. Seed ticker in Redis
      await redis.set(
        'ticker:SOL_USDT',
        JSON.stringify({
          market: 'SOL_USDT',
          lastPrice: '14250000000',
          priceChange24h: '250000000',
          priceChangePercent24h: '1.78',
          high24h: '14500000000',
          low24h: '14000000000',
          volume24h: '1000000000',
          quoteVolume24h: '142500000000',
          tradeCount24h: 12,
          bestBid: '14000000000',
          bestAsk: '14500000000',
          timestamp: Date.now(),
        })
      );

      const tickerRes = await app.inject({
        method: 'GET',
        url: '/api/v1/ticker?market=SOL_USDT',
      });
      expect(tickerRes.statusCode).toBe(200);
      const tickerBody = JSON.parse(tickerRes.payload);
      expect(tickerBody.market).toBe('SOL_USDT');
      expect(tickerBody.lastPrice).toBe('14250000000');
      expect(tickerBody.tradeCount24h).toBe(12);

      // 3. Test public trades endpoint
      const tradesRes = await app.inject({
        method: 'GET',
        url: '/api/v1/trades?market=SOL_USDT&limit=20',
      });
      expect(tradesRes.statusCode).toBe(200);
      const tradesBody = JSON.parse(tradesRes.payload);
      expect(tradesBody.market).toBe('SOL_USDT');
      expect(Array.isArray(tradesBody.trades)).toBe(true);

      // 4. Test klines endpoint (with in-progress candle seeded in Redis)
      await redis.set(
        'kline:1m:SOL_USDT',
        JSON.stringify({
          t: 1700000000000,
          T: 1700000060000,
          s: 'SOL_USDT',
          i: '1m',
          o: '14000000000',
          c: '14250000000',
          h: '14300000000',
          l: '13900000000',
          v: '500000000',
          q: '71250000000',
          n: 5,
          x: false,
        })
      );

      const klinesRes = await app.inject({
        method: 'GET',
        url: '/api/v1/klines?market=SOL_USDT&interval=1m&limit=10',
      });
      expect(klinesRes.statusCode).toBe(200);
      const klinesBody = JSON.parse(klinesRes.payload);
      expect(klinesBody.market).toBe('SOL_USDT');
      expect(klinesBody.interval).toBe('1m');
      expect(Array.isArray(klinesBody.candles)).toBe(true);
      expect(klinesBody.candles.length).toBeGreaterThan(0);
      const latestCandle = klinesBody.candles[klinesBody.candles.length - 1];
      expect(latestCandle[0]).toBe(1700000000000);
      expect(latestCandle[1]).toBe('14000000000');
      expect(latestCandle[4]).toBe('14250000000');
    });
  });

  describe('Phase 14: Wallet, Admin & Operational Controls', () => {
    let app: FastifyInstance;
    let runner: EngineRunner;
    let client: EngineClient;

    const streamCmd = `test.p14.cmd.${Date.now()}`;
    const streamRep = `test.p14.rep.${Date.now()}`;
    const streamEvt = `test.p14.evt.${Date.now()}`;
    const group = `group-p14-${Date.now()}`;

    const normalUserId = `user-p14-norm-${Date.now()}`;
    const adminUserId = `user-p14-admin-${Date.now()}`;
    const trader2Id = `user-p14-t2-${Date.now()}`;

    let normalToken: string;
    let adminToken: string;
    let trader2Token: string;

    beforeAll(async () => {
      // 1. Setup Engine Runner
      const engineState = Engine.createInitialState(DEFAULT_MARKETS);
      runner = new EngineRunner(engineState, {
        redis,
        streamCommands: streamCmd,
        streamReplies: streamRep,
        streamEvents: streamEvt,
        groupName: group,
        consumerName: 'runner-p14',
        blockMs: 50,
      });
      await runner.start();

      // 2. Setup Gateway EngineClient
      client = new EngineClient({
        pubRedis: redis,
        subRedis: new Redis(REDIS_URL, { maxRetriesPerRequest: null }),
        streamCommands: streamCmd,
        streamReplies: streamRep,
      });
      await client.start();

      // 3. Build Gateway
      app = await buildApp(undefined, {
        redis,
        engineClient: client,
      });

      // 4. Seed Assets in DB
      for (const symbol of ['USDT', 'SOL', 'BTC', 'ETH']) {
        await app.prisma.asset.upsert({
          where: { symbol },
          create: { symbol, name: symbol, decimals: 8, isActive: true },
          update: { isActive: true },
        });
      }

      // 5. Create users in DB
      await app.prisma.user.upsert({
        where: { id: normalUserId },
        create: {
          id: normalUserId,
          email: `${normalUserId}@test.com`,
          passwordHash: 'hash',
          role: 'USER',
        },
        update: {},
      });

      await app.prisma.user.upsert({
        where: { id: adminUserId },
        create: {
          id: adminUserId,
          email: `${adminUserId}@test.com`,
          passwordHash: 'hash',
          role: 'ADMIN',
        },
        update: { role: 'ADMIN' },
      });

      await app.prisma.user.upsert({
        where: { id: trader2Id },
        create: {
          id: trader2Id,
          email: `${trader2Id}@test.com`,
          passwordHash: 'hash',
          role: 'USER',
        },
        update: {},
      });

      normalToken = app.jwt.sign({ sub: normalUserId, role: 'USER' });
      adminToken = app.jwt.sign({ sub: adminUserId, role: 'ADMIN' });
      trader2Token = app.jwt.sign({ sub: trader2Id, role: 'USER' });
    });

    afterAll(async () => {
      await app.prisma.auditLog.deleteMany({}).catch(() => {});
      await app.prisma.deposit.deleteMany({}).catch(() => {});
      await app.prisma.withdrawal.deleteMany({}).catch(() => {});
      await app.prisma.order.deleteMany({}).catch(() => {});
      await app.prisma.balance.deleteMany({}).catch(() => {});
      await app.prisma.user.deleteMany({
        where: { id: { in: [normalUserId, adminUserId, trader2Id] } },
      }).catch(() => {});

      await app.close();
      await client.close();
      await runner.stop();
      await redis.del(streamCmd, streamRep, streamEvt);
    });

    it('1. Daily deposit cap & single request limit (DEV_DEPOSIT_MAX)', async () => {
      // DEV_DEPOSIT_MAX = 1,000 USDT (100,000,000,000 scaled)
      // A. Single deposit exceeding 1,000 USDT fails with 422
      const overRes = await app.inject({
        method: 'POST',
        url: '/api/v1/wallet/deposit',
        headers: { authorization: `Bearer ${normalToken}` },
        payload: { asset: 'USDT', amount: '200000000000' }, // 2,000 USDT
      });
      expect(overRes.statusCode).toBe(422);
      expect(JSON.parse(overRes.payload).error.code).toBe('DEPOSIT_LIMIT_EXCEEDED');

      // B. Deposit 600 USDT succeeds
      const dep1Res = await app.inject({
        method: 'POST',
        url: '/api/v1/wallet/deposit',
        headers: { authorization: `Bearer ${normalToken}` },
        payload: { asset: 'USDT', amount: '60000000000' }, // 600 USDT
      });
      expect(dep1Res.statusCode).toBe(200);
      const dep1Body = JSON.parse(dep1Res.payload);
      expect(dep1Body.status).toBe('ok');
      expect(dep1Body.deposit.amount).toBe('60000000000');
      expect(dep1Body.balance.available).toBe('60000000000');

      // C. Another deposit of 500 USDT brings 24h total to 1,100 USDT > 1,000 USDT cap -> 422
      const dep2Res = await app.inject({
        method: 'POST',
        url: '/api/v1/wallet/deposit',
        headers: { authorization: `Bearer ${normalToken}` },
        payload: { asset: 'USDT', amount: '50000000000' }, // 500 USDT
      });
      expect(dep2Res.statusCode).toBe(422);
      expect(JSON.parse(dep2Res.payload).error.code).toBe('DAILY_DEPOSIT_LIMIT_EXCEEDED');
    });

    it('2. Withdrawal lifecycle: request locks funds, rejection restores available balance', async () => {
      // User currently has 600 USDT available
      // A. Request withdrawal of 200 USDT (20,000,000,000)
      const wReqRes = await app.inject({
        method: 'POST',
        url: '/api/v1/wallet/withdraw',
        headers: { authorization: `Bearer ${normalToken}` },
        payload: { asset: 'USDT', amount: '20000000000' },
      });
      expect(wReqRes.statusCode).toBe(200);
      const wReqBody = JSON.parse(wReqRes.payload);
      expect(wReqBody.status).toBe('ok');
      expect(wReqBody.withdrawal.status).toBe('PENDING');
      const withdrawalId = wReqBody.withdrawal.id;

      // Verify balance in engine: 400 available, 200 locked
      const balDuring = runner.getState().balanceManager.get(normalUserId, 'USDT');
      expect(balDuring.available).toBe(40000000000n);
      expect(balDuring.locked).toBe(20000000000n);

      // B. Admin rejects withdrawal
      const rejectRes = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/withdrawals/${withdrawalId}/reject`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(rejectRes.statusCode).toBe(200);
      const rejectBody = JSON.parse(rejectRes.payload);
      expect(rejectBody.withdrawal.status).toBe('REJECTED');

      // Verify available balance in engine is fully restored!
      const balAfter = runner.getState().balanceManager.get(normalUserId, 'USDT');
      expect(balAfter.available).toBe(60000000000n); // Restored!
      expect(balAfter.locked).toBe(0n);

      // C. Verify GET /api/v1/wallet/history returns the deposit and withdrawal
      const histRes = await app.inject({
        method: 'GET',
        url: '/api/v1/wallet/history',
        headers: { authorization: `Bearer ${normalToken}` },
      });
      expect(histRes.statusCode).toBe(200);
      const histBody = JSON.parse(histRes.payload);
      expect(histBody.deposits.length).toBeGreaterThan(0);
      expect(histBody.withdrawals.length).toBeGreaterThan(0);
      expect(histBody.withdrawals[0].id).toBe(withdrawalId);
      expect(histBody.withdrawals[0].status).toBe('REJECTED');
    });

    it('3. Withdrawal approval: debits locked funds', async () => {
      // User requests withdrawal of 100 USDT (10,000,000,000)
      const wReqRes = await app.inject({
        method: 'POST',
        url: '/api/v1/wallet/withdraw',
        headers: { authorization: `Bearer ${normalToken}` },
        payload: { asset: 'USDT', amount: '10000000000' },
      });
      expect(wReqRes.statusCode).toBe(200);
      const wId = JSON.parse(wReqRes.payload).withdrawal.id;

      // Admin approves withdrawal
      const approveRes = await app.inject({
        method: 'POST',
        url: `/api/v1/admin/withdrawals/${wId}/approve`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(approveRes.statusCode).toBe(200);
      const approveBody = JSON.parse(approveRes.payload);
      expect(approveBody.withdrawal.status).toBe('COMPLETED');

      // Verify in engine: locked balance debited to 0
      const bal = runner.getState().balanceManager.get(normalUserId, 'USDT');
      expect(bal.locked).toBe(0n);
      expect(bal.available).toBe(50000000000n); // 600 - 100 = 500 USDT
    });

    it('4. RBAC: non-admin gets 403 on all admin routes', async () => {
      const routes: Array<{ method: 'GET' | 'POST' | 'PATCH'; url: string; payload?: Record<string, unknown> }> = [
        { method: 'POST', url: '/api/v1/admin/markets', payload: {} },
        { method: 'PATCH', url: '/api/v1/admin/markets/SOL_USDT', payload: {} },
        { method: 'POST', url: '/api/v1/admin/markets/SOL_USDT/halt' },
        { method: 'POST', url: '/api/v1/admin/markets/SOL_USDT/resume' },
        { method: 'POST', url: '/api/v1/admin/withdrawals/test-id/approve' },
        { method: 'POST', url: '/api/v1/admin/withdrawals/test-id/reject' },
        { method: 'GET', url: '/api/v1/admin/fees' },
      ];

      for (const r of routes) {
        const injectOpts: any = {
          method: r.method,
          url: r.url,
          headers: { authorization: `Bearer ${normalToken}` },
        };
        if (r.payload) {
          injectOpts.payload = r.payload;
        }
        const res = await app.inject(injectOpts);
        expect(res.statusCode).toBe(403);
        const body = JSON.parse(res.payload);
        expect(body.error.code).toBe('FORBIDDEN');
      }
    });

    it('5. Halted market rejects new orders but still accepts cancellations', async () => {
      // A. User places order on active SOL_USDT (1 SOL @ 140 = 140 USDT <= 500 USDT available)
      const place1 = await app.inject({
        method: 'POST',
        url: '/api/v1/order',
        headers: { authorization: `Bearer ${normalToken}` },
        payload: {
          market: 'SOL_USDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '14000000000',
          quantity: '100000000',
        },
      });
      expect(place1.statusCode).toBe(201);
      const orderId = JSON.parse(place1.payload).orderId;

      // B. Admin halts SOL_USDT
      const haltRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/markets/SOL_USDT/halt',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(haltRes.statusCode).toBe(200);
      expect(JSON.parse(haltRes.payload).marketStatus).toBe('HALTED');

      // C. User attempts to place a new order on halted market -> 422
      const place2 = await app.inject({
        method: 'POST',
        url: '/api/v1/order',
        headers: { authorization: `Bearer ${normalToken}` },
        payload: {
          market: 'SOL_USDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '14000000000',
          quantity: '100000000',
        },
      });
      expect(place2.statusCode).toBe(422);
      expect(JSON.parse(place2.payload).error.code).toBe('MARKET_NOT_ACTIVE');

      // D. User cancels existing resting order on halted market -> 200 OK!
      const cancelRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/order/${orderId}`,
        headers: { authorization: `Bearer ${normalToken}` },
      });
      expect(cancelRes.statusCode).toBe(200);
      expect(JSON.parse(cancelRes.payload).status).toBe(OrderStatus.CANCELLED);

      // E. Admin resumes SOL_USDT
      const resumeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/markets/SOL_USDT/resume',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(resumeRes.statusCode).toBe(200);
      expect(JSON.parse(resumeRes.payload).marketStatus).toBe('ACTIVE');

      // F. Now placing order succeeds again
      const place3 = await app.inject({
        method: 'POST',
        url: '/api/v1/order',
        headers: { authorization: `Bearer ${normalToken}` },
        payload: {
          market: 'SOL_USDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '14000000000',
          quantity: '100000000',
        },
      });
      expect(place3.statusCode).toBe(201);
    });

    it('6. Market management: create new market and patch parameters', async () => {
      // Clean up previous runs if any
      await app.prisma.market.deleteMany({ where: { symbol: 'AVAX_USDT' } });
      (app.marketConfigCache as any).cache.delete('AVAX_USDT');
      runner.getState().markets.delete('AVAX_USDT');

      // A. Create new market AVAX_USDT
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/markets',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          symbol: 'AVAX_USDT',
          baseAsset: 'AVAX',
          quoteAsset: 'USDT',
          tickSize: '1000000',
          lotSize: '1000000',
          minNotional: '500000000',
          makerFeeBps: 8,
          takerFeeBps: 10,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.payload).market;
      expect(created.symbol).toBe('AVAX_USDT');

      // Verify in MarketConfigCache and in Engine
      expect(app.marketConfigCache.get('AVAX_USDT')).toBeDefined();
      expect(runner.getState().markets.get('AVAX_USDT')).toBeDefined();

      // B. Patch parameters
      const patchRes = await app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/markets/AVAX_USDT',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {
          tickSize: '2000000',
          takerFeeBps: 12,
        },
      });
      expect(patchRes.statusCode).toBe(200);
      const patched = JSON.parse(patchRes.payload).market;
      expect(patched.tickSize).toBe('2000000');
      expect(patched.takerFeeBps).toBe(12);
    });

    it('7. Admin fees endpoint returns fee totals', async () => {
      const feesRes = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/fees',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(feesRes.statusCode).toBe(200);
      const feesBody = JSON.parse(feesRes.payload);
      expect(feesBody.status).toBe('ok');
      expect(Array.isArray(feesBody.fees)).toBe(true);
    });

    it('8. Acceptance Criterion: Audit rows exist for every admin test action', async () => {
      const auditRows = await app.prisma.auditLog.findMany();
      expect(auditRows.length).toBeGreaterThan(0);

      const actions = auditRows.map((a) => a.action);
      expect(actions).toContain('HALT_MARKET');
      expect(actions).toContain('RESUME_MARKET');
      expect(actions).toContain('REJECT_WITHDRAWAL');
      expect(actions).toContain('APPROVE_WITHDRAWAL');
      expect(actions).toContain('CREATE_MARKET');
      expect(actions).toContain('UPDATE_MARKET');
      expect(actions).toContain('VIEW_FEES');

      // Verify every row recorded actorId as adminUserId
      for (const row of auditRows) {
        expect(row.actorId).toBe(adminUserId);
        expect(row.meta).toBeDefined();
      }
    });

    it('9. Acceptance Criterion: Invariant 2 (Conservation) holds across mixed deposit/withdraw/trade simulation', async () => {
      // Seed Trader 2 with SOL
      await app.inject({
        method: 'POST',
        url: '/api/v1/wallet/deposit',
        headers: { authorization: `Bearer ${trader2Token}` },
        payload: { asset: 'SOL', amount: '50000000000' }, // 500 SOL
      });

      // Trader 2 places SELL 1 SOL @ 140.00
      await app.inject({
        method: 'POST',
        url: '/api/v1/order',
        headers: { authorization: `Bearer ${trader2Token}` },
        payload: {
          market: 'SOL_USDT',
          side: 'SELL',
          type: 'LIMIT',
          price: '14000000000',
          quantity: '100000000', // 1 SOL
        },
      });

      // Verify pure Invariants on the engine state!
      const finalState = runner.getState();
      expect(() => Engine.checkInvariants(finalState)).not.toThrow();

      // Invariant 2: totalDeposited - totalWithdrawn === totalAvailable + totalLocked + exchangeFee
      const bm = finalState.balanceManager;
      for (const asset of ['USDT', 'SOL']) {
        let userTotal = 0n;
        const suffix = `:${asset}`;
        for (const [key, bal] of (bm as any).balances.entries()) {
          if (key.endsWith(suffix)) {
            userTotal += bal.available + bal.locked;
          }
        }
        const totalDep = bm.getTotalDeposited(asset);
        const totalWith = bm.getTotalWithdrawn(asset);
        const fee = bm.getFee(asset);

        expect(totalDep - totalWith).toBe(userTotal + fee);
      }
    });
  });
});
