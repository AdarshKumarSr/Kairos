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
      // Step A: Deposit 5,000 USDT (5000 * 1e8 = 500_000_000_000n)
      const depRes = await app.inject({
        method: 'POST',
        url: '/api/v1/wallet/deposit',
        headers: { authorization: `Bearer ${token}` },
        payload: { asset: 'USDT', amount: '500000000000' },
      });
      expect(depRes.statusCode).toBe(200);
      const depBody = JSON.parse(depRes.payload);
      expect(depBody.balance.available).toBe('500000000000');

      // Step B: Place LIMIT BUY 10 SOL @ 142.50 (locks 1425 USDT)
      const placeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/order',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          market: 'SOL_USDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '14250000000',
          quantity: '1000000000',
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

      // Step E: Verify balance in engine is unlocked (all 5000 USDT available again)
      const bal = runner.getState().balanceManager.get(userId, 'USDT');
      expect(bal.locked).toBe(0n);
      expect(bal.available).toBe(500000000000n);
    }, 30000);
  });
});
