import { prisma } from '@cex/db';
import {
  Engine,
  type EngineContext,
  type MarketConfig,
  MarketStatus,
  OrderType,
  Side,
} from '@cex/engine';
import type { Event } from '@cex/types';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rebuildDatabase } from './cli/rebuild.js';
import { EventProjector } from './projector.js';
import { DbWorker } from './worker.js';

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

describe('Phase 11: DB Worker (Idempotent PostgreSQL Projection)', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    // Ensure test assets exist in DB
    await prisma.asset.upsert({
      where: { symbol: 'USDT' },
      update: {},
      create: { symbol: 'USDT', name: 'Tether', decimals: 6 },
    });
    await prisma.asset.upsert({
      where: { symbol: 'SOL' },
      update: {},
      create: { symbol: 'SOL', name: 'Solana', decimals: 9 },
    });
    await prisma.asset.upsert({
      where: { symbol: 'BTC' },
      update: {},
      create: { symbol: 'BTC', name: 'Bitcoin', decimals: 8 },
    });
  });

  afterAll(async () => {
    redis.disconnect();
    await prisma.$disconnect();
  });

  describe('1. EventProjector Unit & Integration Projection', () => {
    const userA = 'user-proj-a';
    const userB = 'user-proj-b';

    beforeEach(async () => {
      // Clean test user data
      await prisma.order.deleteMany({
        where: { userId: { in: [userA, userB] } },
      });
      await prisma.balance.deleteMany({
        where: { userId: { in: [userA, userB] } },
      });
      await prisma.ledgerEntry.deleteMany({
        where: { userId: { in: [userA, userB] } },
      });
      await prisma.deposit.deleteMany({
        where: { userId: { in: [userA, userB] } },
      });
      await prisma.withdrawal.deleteMany({
        where: { userId: { in: [userA, userB] } },
      });
    });

    it('projects DEPOSIT, ORDER lifecycle, TRADE, and WITHDRAWAL accurately', async () => {
      const projector = new EventProjector({
        autoCreateUsers: true,
        autoCreateAssets: true,
      });
      await projector.init(prisma);

      const events: Event[] = [
        // 1. User A deposits 10,000 USDT
        {
          engineSeq: '1',
          commandId: 'cmd-dep-1',
          type: 'BALANCE_UPDATED',
          ts: 1700000001000,
          data: {
            userId: userA,
            asset: 'USDT',
            available: '1000000000000', // 10,000 * 1e8
            locked: '0',
            delta: '1000000000000',
            reason: 'DEPOSIT',
            refId: 'dep-ref-001',
          },
        },
        // 2. User B deposits 100 SOL
        {
          engineSeq: '2',
          commandId: 'cmd-dep-2',
          type: 'BALANCE_UPDATED',
          ts: 1700000002000,
          data: {
            userId: userB,
            asset: 'SOL',
            available: '10000000000', // 100 * 1e8
            locked: '0',
            delta: '10000000000',
            reason: 'DEPOSIT',
            refId: 'dep-ref-002',
          },
        },
        // 3. User A places Limit Buy: 10 SOL @ 100 USDT (order accepted)
        {
          engineSeq: '3',
          commandId: 'cmd-order-1',
          type: 'ORDER_ACCEPTED',
          ts: 1700000003000,
          data: {
            orderId: 'order-a-1',
            clientOrderId: 'client-order-1',
            userId: userA,
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.LIMIT,
            price: '10000000000', // 100 * 1e8
            quantity: '1000000000', // 10 * 1e8
            quoteQuantity: '100000000000',
            status: 'NEW',
            filledQuantity: '0',
          },
        },
        // 4. Lock USDT for order
        {
          engineSeq: '4',
          commandId: 'cmd-order-1',
          type: 'BALANCE_UPDATED',
          ts: 1700000004000,
          data: {
            userId: userA,
            asset: 'USDT',
            available: '900000000000', // 9,000 * 1e8
            locked: '100000000000', // 1,000 * 1e8
            reason: 'LOCK',
          },
        },
        // 5. Order rests on book (ORDER_PLACED)
        {
          engineSeq: '5',
          commandId: 'cmd-order-1',
          type: 'ORDER_PLACED',
          ts: 1700000005000,
          data: {
            orderId: 'order-a-1',
            clientOrderId: 'client-order-1',
            userId: userA,
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.LIMIT,
            price: '10000000000',
            quantity: '1000000000',
            filledQuantity: '0',
            status: 'OPEN',
          },
        },
        // 6. User B places Limit Sell: 10 SOL @ 100 USDT -> Matches with A!
        {
          engineSeq: '6',
          commandId: 'cmd-order-2',
          type: 'TRADE',
          ts: 1700000006000,
          data: {
            tradeId: 'trade-001',
            market: 'SOL_USDT',
            price: '10000000000',
            quantity: '1000000000',
            quoteQuantity: '100000000000',
            makerOrderId: 'order-a-1',
            takerOrderId: 'order-b-1',
            makerUserId: userA,
            takerUserId: userB,
            takerSide: Side.SELL,
            makerFee: '800000', // 0.08%
            takerFee: '1000000', // 0.10%
          },
        },
        // 7. Order A is fully filled
        {
          engineSeq: '7',
          commandId: 'cmd-order-2',
          type: 'ORDER_UPDATED',
          ts: 1700000007000,
          data: {
            orderId: 'order-a-1',
            userId: userA,
            market: 'SOL_USDT',
            side: Side.BUY,
            price: '10000000000',
            quantity: '1000000000',
            filledQuantity: '1000000000',
            status: 'FILLED',
          },
        },
        // 8. User A withdraw request
        {
          engineSeq: '8',
          commandId: 'cmd-wd-1',
          type: 'BALANCE_UPDATED',
          ts: 1700000008000,
          data: {
            userId: userA,
            asset: 'SOL',
            available: '0',
            locked: '999200000',
            delta: '-999200000',
            reason: 'WITHDRAW_REQUEST',
            withdrawalId: 'wd-001',
          },
        },
        // 9. User A withdraw completed
        {
          engineSeq: '9',
          commandId: 'cmd-wd-comp',
          type: 'BALANCE_UPDATED',
          ts: 1700000009000,
          data: {
            userId: userA,
            asset: 'SOL',
            available: '0',
            locked: '0',
            delta: '-999200000',
            reason: 'WITHDRAWAL',
            withdrawalId: 'wd-001',
          },
        },
      ];

      // Execute in one transaction
      const summary = await prisma.$transaction(async (tx) => {
        return projector.projectBatch(tx, events);
      });

      expect(summary.eventsProcessed).toBe(9);
      expect(summary.ordersUpserted).toBe(3);
      expect(summary.tradesInserted).toBe(1);
      expect(summary.balancesUpserted).toBe(5);

      // Verify Order
      const order = await prisma.order.findUnique({
        where: { id: 'order-a-1' },
      });
      expect(order).toBeDefined();
      expect(order?.status).toBe('FILLED');
      expect(order?.filledQuantity).toBe(1000000000n);
      expect(order?.engineSeq).toBe(7n);

      // Verify Trade
      const trade = await prisma.trade.findFirst({
        where: { id: 'trade-001' },
      });
      expect(trade).toBeDefined();
      expect(trade?.price).toBe(10000000000n);
      expect(trade?.quantity).toBe(1000000000n);
      expect(trade?.makerUserId).toBe(userA);
      expect(trade?.takerUserId).toBe(userB);

      // Verify Deposits
      const dep1 = await prisma.deposit.findUnique({
        where: { id: 'dep-ref-001' },
      });
      expect(dep1).toBeDefined();
      expect(dep1?.amount).toBe(1000000000000n);

      // Verify Withdrawal
      const wd = await prisma.withdrawal.findUnique({
        where: { id: 'wd-001' },
      });
      expect(wd).toBeDefined();
      expect(wd?.status).toBe('COMPLETED');
      expect(wd?.decidedAt).toBeDefined();

      // Verify Ledger
      const ledgers = await prisma.ledgerEntry.findMany({
        where: { userId: userA },
      });
      expect(ledgers.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('2. Invariant 8: Idempotency (Double Replay Test)', () => {
    const userA = 'user-replay-a';
    const userB = 'user-replay-b';

    beforeEach(async () => {
      await prisma.order.deleteMany({
        where: { userId: { in: [userA, userB] } },
      });
      await prisma.balance.deleteMany({
        where: { userId: { in: [userA, userB] } },
      });
      await prisma.ledgerEntry.deleteMany({
        where: { userId: { in: [userA, userB] } },
      });
      await prisma.deposit.deleteMany({
        where: { userId: { in: [userA, userB] } },
      });
    });

    it('replay the same event stream twice yields byte-identical rows and counts', async () => {
      const projector = new EventProjector({
        autoCreateUsers: true,
        autoCreateAssets: true,
      });
      await projector.init(prisma);

      const events: Event[] = [
        {
          engineSeq: '101',
          commandId: 'c-rep-1',
          type: 'BALANCE_UPDATED',
          ts: 1700000100000,
          data: {
            userId: userA,
            asset: 'USDT',
            available: '500000000000',
            locked: '0',
            delta: '500000000000',
            reason: 'DEPOSIT',
            refId: 'rep-dep-1',
          },
        },
        {
          engineSeq: '102',
          commandId: 'c-rep-2',
          type: 'ORDER_ACCEPTED',
          ts: 1700000101000,
          data: {
            orderId: 'rep-order-1',
            clientOrderId: 'rep-client-1',
            userId: userA,
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.LIMIT,
            price: '10000000000',
            quantity: '5000000000',
            quoteQuantity: '50000000000',
            status: 'NEW',
            filledQuantity: '0',
          },
        },
        {
          engineSeq: '103',
          commandId: 'c-rep-3',
          type: 'TRADE',
          ts: 1700000102000,
          data: {
            tradeId: 'rep-trade-1',
            market: 'SOL_USDT',
            price: '10000000000',
            quantity: '5000000000',
            quoteQuantity: '50000000000',
            makerOrderId: 'rep-order-1',
            takerOrderId: 'rep-order-2',
            makerUserId: userA,
            takerUserId: userB,
            takerSide: Side.SELL,
            makerFee: '400000',
            takerFee: '500000',
          },
        },
      ];

      // First run
      await prisma.$transaction(async (tx) => {
        await projector.projectBatch(tx, events);
      });

      const orders1 = await prisma.order.findMany({
        where: { userId: userA },
      });
      const trades1 = await prisma.trade.findMany({
        where: { engineSeq: 103n },
      });
      const balances1 = await prisma.balance.findMany({
        where: { userId: userA },
      });
      const ledgers1 = await prisma.ledgerEntry.findMany({
        where: { userId: userA },
      });

      // Second run (Replay)
      await prisma.$transaction(async (tx) => {
        await projector.projectBatch(tx, events);
      });

      const orders2 = await prisma.order.findMany({
        where: { userId: userA },
      });
      const trades2 = await prisma.trade.findMany({
        where: { engineSeq: 103n },
      });
      const balances2 = await prisma.balance.findMany({
        where: { userId: userA },
      });
      const ledgers2 = await prisma.ledgerEntry.findMany({
        where: { userId: userA },
      });

      // Assert zero duplicate rows created and identical values
      expect(orders2.length).toBe(orders1.length);
      expect(trades2.length).toBe(trades1.length);
      expect(balances2.length).toBe(balances1.length);
      expect(ledgers2.length).toBe(ledgers1.length);

      expect(orders2[0]?.id).toBe(orders1[0]?.id);
      expect(orders2[0]?.engineSeq).toBe(orders1[0]?.engineSeq);
      expect(trades2[0]?.id).toBe(trades1[0]?.id);
      expect(balances2[0]?.available).toBe(balances1[0]?.available);
    });
  });

  describe('3. Out-of-Order Delivery Protection', () => {
    const user = 'user-ooo';

    beforeEach(async () => {
      await prisma.order.deleteMany({ where: { userId: user } });
      await prisma.balance.deleteMany({ where: { userId: user } });
    });

    it('out-of-order delivery of older events does not overwrite newer balances or orders', async () => {
      const projector = new EventProjector({
        autoCreateUsers: true,
        autoCreateAssets: true,
      });
      await projector.init(prisma);

      // Step 1: Newer event arrives first (engineSeq: 200, balance: 8000 USDT)
      await prisma.$transaction(async (tx) => {
        await projector.projectBatch(tx, [
          {
            engineSeq: '200',
            commandId: 'cmd-newer-bal',
            type: 'BALANCE_UPDATED',
            ts: 1700000200000,
            data: {
              userId: user,
              asset: 'USDT',
              available: '800000000000', // 8,000 USDT
              locked: '0',
              reason: 'TRADE',
            },
          },
          {
            engineSeq: '200',
            commandId: 'cmd-newer-order',
            type: 'ORDER_UPDATED',
            ts: 1700000200000,
            data: {
              orderId: 'order-ooo-1',
              userId: user,
              market: 'SOL_USDT',
              side: Side.BUY,
              price: '10000000000',
              quantity: '1000000000',
              filledQuantity: '1000000000',
              status: 'FILLED',
            },
          },
        ]);
      });

      // Step 2: Older event arrives later (engineSeq: 100, balance: 1000 USDT, order OPEN)
      await prisma.$transaction(async (tx) => {
        await projector.projectBatch(tx, [
          {
            engineSeq: '100',
            commandId: 'cmd-older-bal',
            type: 'BALANCE_UPDATED',
            ts: 1700000100000,
            data: {
              userId: user,
              asset: 'USDT',
              available: '100000000000', // 1,000 USDT (older!)
              locked: '0',
              reason: 'DEPOSIT',
            },
          },
          {
            engineSeq: '100',
            commandId: 'cmd-older-order',
            type: 'ORDER_PLACED',
            ts: 1700000100000,
            data: {
              orderId: 'order-ooo-1',
              userId: user,
              market: 'SOL_USDT',
              side: Side.BUY,
              price: '10000000000',
              quantity: '1000000000',
              filledQuantity: '0',
              status: 'OPEN', // older!
            },
          },
        ]);
      });

      // Step 3: Verify the newer balance and order status were preserved!
      const balance = await prisma.balance.findFirst({
        where: { userId: user },
      });
      expect(balance?.available).toBe(800000000000n);
      expect(balance?.lastEngineSeq).toBe(200n);

      const order = await prisma.order.findUnique({
        where: { id: 'order-ooo-1' },
      });
      expect(order?.status).toBe('FILLED');
      expect(order?.filledQuantity).toBe(1000000000n);
      expect(order?.engineSeq).toBe(200n);
    });
  });

  describe('4. DbWorker Stream Consumer, Recovery & Poison Queue', () => {
    const testStream = `test.events.${Date.now()}`;
    const deadStream = `${testStream}.dead`;
    const groupName = 'test-dbw-group';
    const consumerName = 'test-dbw-1';
    const testUser = 'user-stream-test';

    beforeEach(async () => {
      await redis.del(testStream, deadStream);
      await prisma.balance.deleteMany({ where: { userId: testUser } });
      await prisma.order.deleteMany({ where: { userId: testUser } });
    });

    afterAll(async () => {
      await redis.del(testStream, deadStream);
    });

    it('recovers pending messages if worker crashes before XACK', async () => {
      // 1. Create stream and group
      await redis.xgroup('CREATE', testStream, groupName, '0', 'MKSTREAM');

      // 2. Publish 3 events to stream
      for (let i = 1; i <= 3; i++) {
        const ev: Event = {
          engineSeq: i.toString(),
          commandId: `cmd-crash-${i}`,
          type: 'BALANCE_UPDATED',
          ts: 1700000300000 + i * 1000,
          data: {
            userId: testUser,
            asset: 'USDT',
            available: (i * 100000000).toString(),
            locked: '0',
            reason: 'DEPOSIT',
          },
        };
        await redis.xadd(testStream, '*', 'event', JSON.stringify(ev), 'engineSeq', i.toString());
      }

      // 3. Read them with the consumer without XACKing (leaving them pending on crash)
      await redis.xreadgroup(
        'GROUP',
        groupName,
        consumerName,
        'COUNT',
        10,
        'STREAMS',
        testStream,
        '>'
      );

      // Verify pending count is 3
      const pendingBefore = await redis.xpending(testStream, groupName);
      expect(pendingBefore[0]).toBe(3);

      // 4. Start DbWorker: on startup it should recover pending entries
      const worker = new DbWorker({
        redis,
        prisma,
        streamEvents: testStream,
        deadStreamEvents: deadStream,
        groupName,
        consumerName,
        autoCreateUsers: true,
        autoCreateAssets: true,
      });

      await worker.start();

      // Give worker a moment to process pending
      await new Promise((r) => setTimeout(r, 200));
      await worker.stop();

      // Verify pending count is now 0
      const pendingAfter = await redis.xpending(testStream, groupName);
      expect(pendingAfter[0]).toBe(0);

      // Verify DB balance updated to latest sequence (3)
      const bal = await prisma.balance.findFirst({
        where: { userId: testUser },
      });
      expect(bal?.available).toBe(300000000n);
      expect(bal?.lastEngineSeq).toBe(3n);
    });

    it('moves poison event to engine.events.dead after 3 failed attempts and alerts metric', async () => {
      const worker = new DbWorker({
        redis,
        prisma,
        streamEvents: testStream,
        deadStreamEvents: deadStream,
        groupName,
        consumerName,
        maxAttempts: 3,
        autoCreateUsers: true,
        autoCreateAssets: true,
      });

      await worker.start();

      // Push 1 poison event (malformed JSON)
      const poisonId = await redis.xadd(
        testStream,
        '*',
        'event',
        '{ bad-json: true ',
        'type',
        'CORRUPT'
      );

      // Push 1 valid event after it
      const validEvent: Event = {
        engineSeq: '99',
        commandId: 'cmd-valid-after-poison',
        type: 'BALANCE_UPDATED',
        ts: Date.now(),
        data: {
          userId: testUser,
          asset: 'SOL',
          available: '500000000',
          locked: '0',
          reason: 'DEPOSIT',
        },
      };
      await redis.xadd(
        testStream,
        '*',
        'event',
        JSON.stringify(validEvent),
        'type',
        'BALANCE_UPDATED',
        'engineSeq',
        '99'
      );

      // Wait for worker to retry poison event and move to dead stream
      for (let i = 0; i < 20; i++) {
        const metrics = worker.getMetrics();
        if (metrics.deadEventsTotal >= 1) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await worker.stop();

      const metrics = worker.getMetrics();
      expect(metrics.deadEventsTotal).toBe(1);

      // Verify dead stream contains the poison event
      const deadEntries = (await redis.xread('COUNT', 10, 'STREAMS', deadStream, '0-0')) as [
        string,
        [string, string[]][]
      ][] | null;
      expect(deadEntries).toBeDefined();
      expect(deadEntries![0]![1].length).toBe(1);
      const deadFields = deadEntries![0]![1][0]![1];
      expect(deadFields).toContain('streamId');
      expect(deadFields).toContain(poisonId);

      // Verify the valid event was processed into DB despite the poison event!
      const solBal = await prisma.balance.findFirst({
        where: { userId: testUser, asset: { symbol: 'SOL' } },
      });
      expect(solBal).toBeDefined();
      expect(solBal?.available).toBe(500000000n);
    });
  });

  describe('5. Disaster Recovery Rebuild CLI Tool (dbw:rebuild)', () => {
    const rebuildStream = `test.rebuild.${Date.now()}`;
    const userR = 'user-rebuild';

    beforeAll(async () => {
      await redis.del(rebuildStream);
      await prisma.balance.deleteMany({ where: { userId: userR } });
      await prisma.order.deleteMany({ where: { userId: userR } });
    });

    afterAll(async () => {
      await redis.del(rebuildStream);
    });

    it('truncates projection tables and replays entire stream from 0-0', async () => {
      // Produce 5 events on rebuildStream
      for (let i = 1; i <= 5; i++) {
        const ev: Event = {
          engineSeq: i.toString(),
          commandId: `cmd-reb-${i}`,
          type: 'BALANCE_UPDATED',
          ts: 1700000500000 + i * 1000,
          data: {
            userId: userR,
            asset: 'USDT',
            available: (i * 200000000).toString(),
            locked: '0',
            reason: 'DEPOSIT',
          },
        };
        await redis.xadd(rebuildStream, '*', 'event', JSON.stringify(ev));
      }

      const res = await rebuildDatabase({
        redis,
        prisma,
        streamEvents: rebuildStream,
        autoCreateUsers: true,
        autoCreateAssets: true,
      });

      expect(res.totalEventsReplayed).toBe(5);

      const bal = await prisma.balance.findFirst({
        where: { userId: userR },
      });
      expect(bal?.available).toBe(1000000000n); // 5 * 200,000,000 = 1,000,000,000
      expect(bal?.lastEngineSeq).toBe(5n);
    });
  });

  describe('6. Acceptance Criterion: Engine Simulation Balance Reconciliation', () => {
    it(
      'DB balances equal engine balances for every user and asset after simulation',
      async () => {
      const state = Engine.createInitialState([SOL_USDT]);
      let seq = 1n;

      const simUsers = ['sim-user-1', 'sim-user-2', 'sim-user-3'];

      // Clear any previous records for sim users
      await prisma.balance.deleteMany({
        where: { userId: { in: simUsers } },
      });
      await prisma.order.deleteMany({
        where: { userId: { in: simUsers } },
      });

      const allEvents: Event[] = [];

      // 1. Seed deposits
      for (const u of simUsers) {
        const r1 = Engine.process(
          state,
          {
            commandId: `sim-dep-usdt-${u}`,
            type: 'DEPOSIT',
            userId: u,
            ts: 1000,
            payload: { asset: 'USDT', amount: '10000000000000' }, // 100,000 USDT
          },
          ctx(seq++)
        );
        allEvents.push(...r1.events);

        const r2 = Engine.process(
          state,
          {
            commandId: `sim-dep-sol-${u}`,
            type: 'DEPOSIT',
            userId: u,
            ts: 1001,
            payload: { asset: 'SOL', amount: '100000000000' }, // 1,000 SOL
          },
          ctx(seq++)
        );
        allEvents.push(...r2.events);
      }

      // 2. Generate series of limit orders and trades
      let orderIndex = 0;
      for (let i = 0; i < 200; i++) {
        const buyer = simUsers[i % simUsers.length]!;
        const seller = simUsers[(i + 1) % simUsers.length]!;

        // Place Buy
        const buyRes = Engine.process(
          state,
          {
            commandId: `sim-buy-${orderIndex}`,
            type: 'PLACE_ORDER',
            userId: buyer,
            ts: 2000 + i,
            payload: {
              orderId: `sim-o-b-${orderIndex}`,
              market: 'SOL_USDT',
              side: Side.BUY,
              type: OrderType.LIMIT,
              price: '10000000000', // 100 USDT
              quantity: '100000000', // 1 SOL
            },
          },
          ctx(seq++)
        );
        allEvents.push(...buyRes.events);

        // Place matching Sell
        const sellRes = Engine.process(
          state,
          {
            commandId: `sim-sell-${orderIndex}`,
            type: 'PLACE_ORDER',
            userId: seller,
            ts: 2000 + i,
            payload: {
              orderId: `sim-o-s-${orderIndex}`,
              market: 'SOL_USDT',
              side: Side.SELL,
              type: OrderType.LIMIT,
              price: '10000000000', // 100 USDT
              quantity: '100000000', // 1 SOL
            },
          },
          ctx(seq++)
        );
        allEvents.push(...sellRes.events);

        orderIndex++;
      }

      // 3. Project all events into PostgreSQL via EventProjector in batches of 500
      const projector = new EventProjector({
        autoCreateUsers: true,
        autoCreateAssets: true,
      });
      await projector.init(prisma);

      const batchSize = 500;
      for (let i = 0; i < allEvents.length; i += batchSize) {
        const batch = allEvents.slice(i, i + batchSize);
        await prisma.$transaction(async (tx) => {
          await projector.projectBatch(tx, batch);
        });
      }

      // 4. Assert: DB balances equal Engine balances for EVERY user and asset!
      for (const u of simUsers) {
        for (const asset of ['USDT', 'SOL']) {
          const engineBal = state.balanceManager.get(u, asset);

          const dbBal = await prisma.balance.findFirst({
            where: { userId: u, asset: { symbol: asset } },
          });

          expect(dbBal).toBeDefined();
          expect(dbBal?.available).toBe(engineBal.available);
          expect(dbBal?.locked).toBe(engineBal.locked);
        }
      }
    },
    30000
  );
  });
});
