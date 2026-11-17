import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { Role } from '@cex/db';
import { Command, MarketStatus, OrderStatus, RejectCode, Side, OrderType } from '@cex/types';
import { AppError } from '../errors/app-error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  createMarketSchema,
  depositSchema,
  depthQuerySchema,
  klinesQuerySchema,
  marketSymbolParamSchema,
  openOrdersQuerySchema,
  orderIdParamSchema,
  paginationQuerySchema,
  placeOrderSchema,
  publicTradesQuerySchema,
  tickerQuerySchema,
  updateMarketSchema,
  withdrawalIdParamSchema,
  withdrawSchema,
} from '../schemas/trading.js';

export function getRejectMessage(code?: RejectCode | string): string {
  switch (code) {
    case 'INSUFFICIENT_FUNDS':
      return 'Insufficient funds for required lock';
    case 'MARKET_NOT_ACTIVE':
      return 'Market is not active';
    case 'INVALID_TICK':
      return 'Price violates market tick size';
    case 'INVALID_LOT':
      return 'Quantity violates market lot size';
    case 'BELOW_MIN_NOTIONAL':
      return 'Notional is below market minimum';
    case 'POST_ONLY_WOULD_CROSS':
      return 'Post-only order would cross the book';
    case 'SELF_TRADE':
      return 'Self-trade prevention triggered';
    case 'DUPLICATE_ORDER':
      return 'Duplicate clientOrderId with different parameters';
    case 'ORDER_NOT_FOUND':
      return 'Order not found or already filled/cancelled';
    case 'NOT_OWNER':
      return 'Cannot cancel order placed by another user';
    default:
      return 'Order was rejected by matching engine';
  }
}

export const tradingRoutes: FastifyPluginAsync = async (app) => {
  // 1. POST /order: Place order (Rate limit: 20 req/s/user)
  app.post(
    '/order',
    {
      preHandler: [requireAuth],
      config: {
        rateLimit: {
          max: 20,
          timeWindow: 1000,
          keyGenerator: (request) => request.user?.sub ?? request.ip,
        },
      },
    },
    async (request, reply) => {
      const body = placeOrderSchema.parse(request.body);

      // Validate market against MarketConfigCache
      const marketConfig = app.marketConfigCache.get(body.market);
      if (!marketConfig || marketConfig.status !== MarketStatus.ACTIVE) {
        throw new AppError('MARKET_NOT_ACTIVE', 422, 'Market is not active or unknown');
      }

      // Pre-flight checks on tick size, lot size, minNotional for LIMIT orders
      if (body.type === OrderType.LIMIT) {
        const price = BigInt(body.price!);
        const tickSize = BigInt(marketConfig.tickSize);
        if (price % tickSize !== 0n) {
          throw new AppError('INVALID_TICK', 422, 'Price violates market tick size');
        }

        const quantity = BigInt(body.quantity!);
        const lotSize = BigInt(marketConfig.lotSize);
        if (quantity % lotSize !== 0n) {
          throw new AppError('INVALID_LOT', 422, 'Quantity violates market lot size');
        }

        const minNotional = BigInt(marketConfig.minNotional);
        const notional = (price * quantity) / 100_000_000n;
        if (notional < minNotional) {
          throw new AppError('BELOW_MIN_NOTIONAL', 422, 'Order notional is below market minimum');
        }
      }

      const orderId = randomUUID();
      const commandId = randomUUID();

      const payload: Record<string, string | boolean> = {
        orderId,
        market: body.market,
        side: body.side,
        type: body.type,
        postOnly: Boolean(body.postOnly),
        ioc: Boolean(body.ioc),
      };
      if (body.price) payload.price = body.price;
      if (body.quantity) payload.quantity = body.quantity;
      if (body.quoteQuantity) payload.quoteQuantity = body.quoteQuantity;
      if (body.clientOrderId) payload.clientOrderId = body.clientOrderId;

      const cmd: Command = {
        commandId,
        type: 'PLACE_ORDER',
        userId: request.user.sub,
        ts: Date.now(),
        payload,
      };

      const engineReply = await app.engineClient.send(cmd);

      if (engineReply.status === 'OK') {
        const orderSnap = engineReply.order;
        const resOrderId = orderSnap?.orderId ?? orderId;
        const resStatus = orderSnap?.status ?? OrderStatus.OPEN;
        const filledQty = orderSnap?.filledQuantity ?? '0';

        // Project order into DB for immediate read consistency
        try {
          await app.prisma.order.upsert({
            where: { id: resOrderId },
            create: {
              id: resOrderId,
              clientOrderId: body.clientOrderId ?? null,
              userId: request.user.sub,
              market: body.market,
              side: body.side,
              type: body.type,
              price: body.price ? BigInt(body.price) : null,
              quantity: BigInt(body.quantity ?? filledQty),
              quoteQuantity: body.quoteQuantity ? BigInt(body.quoteQuantity) : null,
              filledQuantity: BigInt(filledQty),
              status: resStatus,
              postOnly: Boolean(body.postOnly),
              ioc: Boolean(body.ioc),
              engineSeq: BigInt(engineReply.engineSeq || '0'),
            },
            update: {
              status: resStatus,
              filledQuantity: BigInt(filledQty),
              updatedAt: new Date(),
            },
          });
        } catch {
          // Projection non-blocking if duplicate or DB issue
        }

        return reply.code(201).send({
          orderId: resOrderId,
          status: resStatus,
          filledQuantity: filledQty,
          avgPrice: orderSnap?.avgPrice,
        });
      }

      if (engineReply.status === 'PENDING') {
        return reply.code(202).send({
          orderId,
          status: 'PENDING',
        });
      }

      // Rejected
      throw new AppError(
        engineReply.code ?? 'ORDER_REJECTED',
        422,
        getRejectMessage(engineReply.code)
      );
    }
  );

  // 2. DELETE /order/:orderId: Cancel order
  app.delete('/order/:orderId', { preHandler: [requireAuth] }, async (request, reply) => {
    const params = orderIdParamSchema.parse(request.params);
    const commandId = randomUUID();

    const cmd: Command = {
      commandId,
      type: 'CANCEL_ORDER',
      userId: request.user.sub,
      ts: Date.now(),
      payload: {
        orderId: params.orderId,
      },
    };

    const engineReply = await app.engineClient.send(cmd);

    if (engineReply.status === 'OK') {
      try {
        await app.prisma.order.updateMany({
          where: { id: params.orderId, userId: request.user.sub },
          data: { status: OrderStatus.CANCELLED, updatedAt: new Date() },
        });
      } catch {
        // Non-blocking
      }

      return reply.code(200).send({
        orderId: params.orderId,
        status: OrderStatus.CANCELLED,
      });
    }

    if (engineReply.code === RejectCode.ORDER_NOT_FOUND) {
      throw new AppError('ORDER_NOT_FOUND', 404, 'Order not found or already filled/cancelled');
    }
    if (engineReply.code === RejectCode.NOT_OWNER) {
      throw new AppError('NOT_OWNER', 403, 'Cannot cancel order placed by another user');
    }

    throw new AppError(
      engineReply.code ?? 'CANCEL_REJECTED',
      422,
      getRejectMessage(engineReply.code)
    );
  });

  // 3. GET /order/:orderId: Order status
  app.get('/order/:orderId', { preHandler: [requireAuth] }, async (request) => {
    const params = orderIdParamSchema.parse(request.params);
    const order = await app.prisma.order.findUnique({
      where: { id: params.orderId },
    });

    if (!order || order.userId !== request.user.sub) {
      throw new AppError('ORDER_NOT_FOUND', 404, 'Order not found');
    }

    return {
      orderId: order.id,
      clientOrderId: order.clientOrderId ?? undefined,
      market: order.market,
      side: order.side,
      type: order.type,
      price: order.price?.toString(),
      quantity: order.quantity.toString(),
      quoteQuantity: order.quoteQuantity?.toString(),
      filledQuantity: order.filledQuantity.toString(),
      status: order.status,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };
  });

  // 4. GET /orders/open: List open orders
  app.get('/orders/open', { preHandler: [requireAuth] }, async (request) => {
    const query = openOrdersQuerySchema.parse(request.query);
    const where: Record<string, unknown> = {
      userId: request.user.sub,
      status: { in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED, OrderStatus.NEW] },
    };
    if (query.market) {
      where.market = query.market;
    }

    const orders = await app.prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return {
      orders: orders.map((o) => ({
        orderId: o.id,
        clientOrderId: o.clientOrderId ?? undefined,
        market: o.market,
        side: o.side,
        type: o.type,
        price: o.price?.toString(),
        quantity: o.quantity.toString(),
        quoteQuantity: o.quoteQuantity?.toString(),
        filledQuantity: o.filledQuantity.toString(),
        status: o.status,
        createdAt: o.createdAt.toISOString(),
      })),
    };
  });

  // 5. GET /orders/history: Historical closed orders (paginated)
  app.get('/orders/history', { preHandler: [requireAuth] }, async (request) => {
    const query = paginationQuerySchema.parse(request.query);
    const where: Record<string, unknown> = {
      userId: request.user.sub,
      status: { in: [OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.REJECTED] },
    };
    if (query.market) where.market = query.market;

    const limit = query.limit;
    const orders = await app.prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    let nextCursor: string | undefined;
    if (orders.length > limit) {
      const nextItem = orders.pop();
      nextCursor = nextItem?.id;
    }

    return {
      orders: orders.map((o) => ({
        orderId: o.id,
        clientOrderId: o.clientOrderId ?? undefined,
        market: o.market,
        side: o.side,
        type: o.type,
        price: o.price?.toString(),
        quantity: o.quantity.toString(),
        quoteQuantity: o.quoteQuantity?.toString(),
        filledQuantity: o.filledQuantity.toString(),
        status: o.status,
        createdAt: o.createdAt.toISOString(),
      })),
      nextCursor,
    };
  });

  // 6. GET /trades/mine: Own executed trades (paginated)
  app.get('/trades/mine', { preHandler: [requireAuth] }, async (request) => {
    const query = paginationQuerySchema.parse(request.query);
    const userId = request.user.sub;
    const where: Record<string, unknown> = {
      OR: [{ makerUserId: userId }, { takerUserId: userId }],
    };
    if (query.market) where.market = query.market;

    const limit = query.limit;
    const trades = await app.prisma.trade.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    let nextCursor: string | undefined;
    if (trades.length > limit) {
      const nextItem = trades.pop();
      nextCursor = nextItem?.id;
    }

    return {
      trades: trades.map((t) => ({
        id: t.id,
        market: t.market,
        price: t.price.toString(),
        quantity: t.quantity.toString(),
        makerOrderId: t.makerOrderId,
        takerOrderId: t.takerOrderId,
        side: t.takerUserId === userId ? t.takerSide : (t.takerSide === Side.BUY ? Side.SELL : Side.BUY),
        fee: t.takerUserId === userId ? t.takerFee.toString() : t.makerFee.toString(),
        createdAt: t.createdAt.toISOString(),
      })),
      nextCursor,
    };
  });

  // 7. GET /balances: Available and locked balance per asset
  app.get('/balances', { preHandler: [requireAuth] }, async (request) => {
    const balances = await app.prisma.balance.findMany({
      where: { userId: request.user.sub },
      include: { asset: true },
    });

    return {
      balances: balances.map((b) => ({
        asset: b.asset.symbol,
        available: b.available.toString(),
        locked: b.locked.toString(),
      })),
    };
  });

  // 8. GET /markets: Public market configs
  app.get('/markets', async () => {
    return {
      markets: app.marketConfigCache.getAll(),
    };
  });

  // 9. GET /depth: Public L2 depth snapshot
  app.get('/depth', async (request) => {
    const query = depthQuerySchema.parse(request.query);
    const raw = await app.redis.get(`depth:${query.market}`);
    if (raw) {
      try {
        const data = JSON.parse(raw) as {
          seq?: number;
          bids?: [string, string][];
          asks?: [string, string][];
        };
        return {
          market: query.market,
          seq: data.seq ?? 0,
          bids: data.bids?.slice(0, query.limit) ?? [],
          asks: data.asks?.slice(0, query.limit) ?? [],
        };
      } catch {
        // Fallback to empty
      }
    }

    return {
      market: query.market,
      seq: 0,
      bids: [],
      asks: [],
    };
  });

  // 10. POST /wallet/deposit: Simulated deposit with daily cap validation
  app.post('/wallet/deposit', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = depositSchema.parse(request.body);
    const amountBig = BigInt(body.amount);
    if (amountBig <= 0n) {
      throw new AppError('INVALID_AMOUNT', 422, 'Deposit amount must be positive');
    }

    // 1. Single request limit against DEV_DEPOSIT_MAX
    const devDepositMax = BigInt(process.env.DEV_DEPOSIT_MAX ?? '1000000000000');
    if (amountBig > devDepositMax) {
      throw new AppError(
        'DEPOSIT_LIMIT_EXCEEDED',
        422,
        `Deposit amount exceeds maximum allowed limit of ${devDepositMax}`
      );
    }

    // 2. Asset validation
    let asset = await app.prisma.asset.findUnique({
      where: { symbol: body.asset },
    });
    if (!asset) {
      asset = await app.prisma.asset.create({
        data: { symbol: body.asset, name: body.asset },
      });
    } else if (!asset.isActive) {
      throw new AppError('ASSET_NOT_ACTIVE', 422, 'Asset is not active or supported');
    }

    // 3. 24-hour daily deposit limit enforcement
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentDeposits = await app.prisma.deposit.findMany({
      where: {
        userId: request.user.sub,
        asset: body.asset,
        createdAt: { gte: oneDayAgo },
      },
    });
    const dailyTotal = recentDeposits.reduce((acc, d) => acc + d.amount, 0n);
    if (dailyTotal + amountBig > devDepositMax) {
      throw new AppError(
        'DAILY_DEPOSIT_LIMIT_EXCEEDED',
        422,
        `Deposit would exceed 24h daily limit of ${devDepositMax}`
      );
    }

    // 4. Create Deposit row
    const deposit = await app.prisma.deposit.create({
      data: {
        userId: request.user.sub,
        asset: body.asset,
        amount: amountBig,
      },
    });

    const commandId = deposit.id;
    const cmd: Command = {
      commandId,
      type: 'DEPOSIT',
      userId: request.user.sub,
      ts: Date.now(),
      payload: {
        asset: body.asset,
        amount: body.amount,
        refId: deposit.id,
      },
    };

    const engineReply = await app.engineClient.send(cmd);

    if (engineReply.status === 'OK') {
      try {
        const bal = await app.prisma.balance.upsert({
          where: {
            userId_assetId: {
              userId: request.user.sub,
              assetId: asset.id,
            },
          },
          create: {
            userId: request.user.sub,
            assetId: asset.id,
            available: amountBig,
            locked: 0n,
            lastEngineSeq: BigInt(engineReply.engineSeq || '0'),
          },
          update: {
            available: { increment: amountBig },
            lastEngineSeq: BigInt(engineReply.engineSeq || '0'),
          },
        });

        return reply.code(200).send({
          status: 'ok',
          deposit: {
            id: deposit.id,
            userId: deposit.userId,
            asset: deposit.asset,
            amount: deposit.amount.toString(),
            createdAt: deposit.createdAt,
          },
          balance: {
            asset: body.asset,
            available: bal.available.toString(),
            locked: bal.locked.toString(),
          },
        });
      } catch {
        return reply.code(200).send({
          status: 'ok',
          deposit: {
            id: deposit.id,
            userId: deposit.userId,
            asset: deposit.asset,
            amount: deposit.amount.toString(),
            createdAt: deposit.createdAt,
          },
          balance: engineReply.balance ?? {
            asset: body.asset,
            available: body.amount,
            locked: '0',
          },
        });
      }
    }

    throw new AppError(
      engineReply.code ?? 'DEPOSIT_FAILED',
      422,
      getRejectMessage(engineReply.code)
    );
  });

  // 11. GET /trades: Public recent executed trades
  app.get('/trades', async (request) => {
    const query = publicTradesQuerySchema.parse(request.query);
    const trades = await app.prisma.trade.findMany({
      where: { market: query.market },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
    return {
      market: query.market,
      trades: trades.map((t) => ({
        id: t.id,
        price: t.price.toString(),
        quantity: t.quantity.toString(),
        takerSide: t.takerSide,
        createdAt: t.createdAt.toISOString(),
        engineSeq: t.engineSeq.toString(),
      })),
    };
  });

  // 12. GET /ticker: Public 24h ticker statistics
  app.get('/ticker', async (request) => {
    const query = tickerQuerySchema.parse(request.query);
    if (query.market) {
      const raw = await app.redis.get(`ticker:${query.market}`);
      if (raw) {
        return JSON.parse(raw);
      }
      return {
        market: query.market,
        lastPrice: '0',
        priceChange24h: '0',
        priceChangePercent24h: '0.00',
        high24h: '0',
        low24h: '0',
        volume24h: '0',
        quoteVolume24h: '0',
        tradeCount24h: 0,
        bestBid: null,
        bestAsk: null,
        ts: Date.now(),
      };
    }
    const markets = app.marketConfigCache.getAll();
    const tickers = await Promise.all(
      markets.map(async (m) => {
        const raw = await app.redis.get(`ticker:${m.symbol}`);
        return raw
          ? JSON.parse(raw)
          : {
              market: m.symbol,
              lastPrice: '0',
              priceChange24h: '0',
              priceChangePercent24h: '0.00',
              high24h: '0',
              low24h: '0',
              volume24h: '0',
              quoteVolume24h: '0',
              tradeCount24h: 0,
              bestBid: null,
              bestAsk: null,
              ts: Date.now(),
            };
      })
    );
    return { tickers };
  });

  // 13. GET /klines: Public candles
  app.get('/klines', async (request) => {
    const query = klinesQuerySchema.parse(request.query);
    const viewName = `candle_${query.interval}`;

    const rows = await app.prisma.$queryRawUnsafe<
      { bucket: Date; open: bigint; high: bigint; low: bigint; close: bigint; volume: string }[]
    >(
      `SELECT bucket, open, high, low, close, volume FROM "${viewName}" WHERE market = $1 ORDER BY bucket ASC LIMIT $2`,
      query.market,
      query.limit
    ).catch(() => []);

    const candles = rows.map((r) => [
      new Date(r.bucket).getTime(),
      r.open.toString(),
      r.high.toString(),
      r.low.toString(),
      r.close.toString(),
      r.volume.toString(),
    ]);

    const inProgressRaw = await app.redis.get(`kline:${query.interval}:${query.market}`);
    if (inProgressRaw) {
      try {
        const ip = JSON.parse(inProgressRaw) as {
          t: number;
          o: string;
          h: string;
          l: string;
          c: string;
          v: string;
        };
        const lastCandle = candles[candles.length - 1];
        if (!lastCandle || ip.t > (lastCandle[0] as number)) {
          candles.push([ip.t, ip.o, ip.h, ip.l, ip.c, ip.v]);
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    return {
      market: query.market,
      interval: query.interval,
      candles,
    };
  });

  // 14. POST /wallet/withdraw: Request withdrawal
  app.post('/wallet/withdraw', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = withdrawSchema.parse(request.body);
    const amountBig = BigInt(body.amount);
    if (amountBig <= 0n) {
      throw new AppError('INVALID_AMOUNT', 422, 'Withdrawal amount must be positive');
    }

    const asset = await app.prisma.asset.findUnique({
      where: { symbol: body.asset },
    });
    if (!asset || !asset.isActive) {
      throw new AppError('ASSET_NOT_ACTIVE', 422, 'Asset is not active or unknown');
    }

    // Create Withdrawal record in PENDING status
    const withdrawal = await app.prisma.withdrawal.create({
      data: {
        userId: request.user.sub,
        asset: body.asset,
        amount: amountBig,
        status: 'PENDING',
      },
    });

    const cmd: Command = {
      commandId: withdrawal.id,
      type: 'WITHDRAW_REQUEST',
      userId: request.user.sub,
      ts: Date.now(),
      payload: {
        withdrawalId: withdrawal.id,
        asset: body.asset,
        amount: body.amount,
      },
    };

    const engineReply = await app.engineClient.send(cmd);
    if (engineReply.status === 'OK') {
      return reply.code(200).send({
        status: 'ok',
        withdrawal: {
          id: withdrawal.id,
          userId: withdrawal.userId,
          asset: withdrawal.asset,
          amount: withdrawal.amount.toString(),
          status: 'PENDING',
          createdAt: withdrawal.createdAt,
        },
        balance: engineReply.balance,
      });
    }

    // Engine rejected (e.g. INSUFFICIENT_FUNDS)
    await app.prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: { status: 'REJECTED', decidedAt: new Date() },
    });

    throw new AppError(
      engineReply.code ?? 'INSUFFICIENT_FUNDS',
      422,
      getRejectMessage(engineReply.code)
    );
  });

  // 15. GET /wallet/history: Deposit and withdrawal history
  app.get('/wallet/history', { preHandler: [requireAuth] }, async (request) => {
    const [deposits, withdrawals] = await Promise.all([
      app.prisma.deposit.findMany({
        where: { userId: request.user.sub },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      app.prisma.withdrawal.findMany({
        where: { userId: request.user.sub },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    return {
      deposits: deposits.map((d) => ({
        id: d.id,
        userId: d.userId,
        asset: d.asset,
        amount: d.amount.toString(),
        createdAt: d.createdAt,
      })),
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        userId: w.userId,
        asset: w.asset,
        amount: w.amount.toString(),
        status: w.status,
        createdAt: w.createdAt,
        decidedAt: w.decidedAt,
      })),
    };
  });

  // ==========================================
  // Admin Operations (Role.ADMIN required)
  // ==========================================

  // 16. POST /admin/markets: Create market
  app.post('/admin/markets', { preHandler: [requireRole(Role.ADMIN)] }, async (request, reply) => {
    const body = createMarketSchema.parse(request.body);

    const existing = await app.prisma.market.findUnique({
      where: { symbol: body.symbol },
    });
    if (existing) {
      throw new AppError('MARKET_ALREADY_EXISTS', 422, `Market ${body.symbol} already exists`);
    }

    const market = await app.prisma.market.create({
      data: {
        symbol: body.symbol,
        baseAsset: body.baseAsset,
        quoteAsset: body.quoteAsset,
        tickSize: BigInt(body.tickSize),
        lotSize: BigInt(body.lotSize),
        minNotional: BigInt(body.minNotional),
        makerFeeBps: body.makerFeeBps,
        takerFeeBps: body.takerFeeBps,
        status: MarketStatus.ACTIVE,
      },
    });

    const marketCfg = {
      symbol: market.symbol,
      baseAsset: market.baseAsset,
      quoteAsset: market.quoteAsset,
      tickSize: market.tickSize.toString(),
      lotSize: market.lotSize.toString(),
      minNotional: market.minNotional.toString(),
      makerFeeBps: market.makerFeeBps,
      takerFeeBps: market.takerFeeBps,
      status: MarketStatus.ACTIVE,
    };

    app.marketConfigCache.set(marketCfg);
    await app.engineClient.send({
      commandId: randomUUID(),
      type: 'MARKET_CONFIG',
      ts: Date.now(),
      payload: {
        symbol: marketCfg.symbol,
        baseAsset: marketCfg.baseAsset,
        quoteAsset: marketCfg.quoteAsset,
        tickSize: marketCfg.tickSize,
        lotSize: marketCfg.lotSize,
        minNotional: marketCfg.minNotional,
        makerFeeBps: marketCfg.makerFeeBps.toString(),
        takerFeeBps: marketCfg.takerFeeBps.toString(),
        status: marketCfg.status,
      },
    });

    await app.prisma.auditLog.create({
      data: {
        actorId: request.user.sub,
        action: 'CREATE_MARKET',
        meta: {
          targetType: 'MARKET',
          targetId: market.symbol,
          before: null,
          after: marketCfg,
        },
      },
    });

    return reply.code(201).send({ status: 'ok', market: marketCfg });
  });

  // 17. PATCH /admin/markets/:symbol: Update market parameters
  app.patch('/admin/markets/:symbol', { preHandler: [requireRole(Role.ADMIN)] }, async (request) => {
    const params = marketSymbolParamSchema.parse(request.params);
    const body = updateMarketSchema.parse(request.body);

    const existing = await app.prisma.market.findUnique({
      where: { symbol: params.symbol },
    });
    if (!existing) {
      throw new AppError('MARKET_NOT_FOUND', 404, `Market ${params.symbol} not found`);
    }

    const beforeCfg = {
      symbol: existing.symbol,
      tickSize: existing.tickSize.toString(),
      lotSize: existing.lotSize.toString(),
      minNotional: existing.minNotional.toString(),
      makerFeeBps: existing.makerFeeBps,
      takerFeeBps: existing.takerFeeBps,
      status: existing.status as MarketStatus,
    };

    const data: Record<string, unknown> = {};
    if (body.tickSize) data.tickSize = BigInt(body.tickSize);
    if (body.lotSize) data.lotSize = BigInt(body.lotSize);
    if (body.minNotional) data.minNotional = BigInt(body.minNotional);
    if (body.makerFeeBps !== undefined) data.makerFeeBps = body.makerFeeBps;
    if (body.takerFeeBps !== undefined) data.takerFeeBps = body.takerFeeBps;

    const updated = await app.prisma.market.update({
      where: { symbol: params.symbol },
      data,
    });

    const afterCfg = {
      symbol: updated.symbol,
      baseAsset: updated.baseAsset,
      quoteAsset: updated.quoteAsset,
      tickSize: updated.tickSize.toString(),
      lotSize: updated.lotSize.toString(),
      minNotional: updated.minNotional.toString(),
      makerFeeBps: updated.makerFeeBps,
      takerFeeBps: updated.takerFeeBps,
      status: updated.status as MarketStatus,
    };

    app.marketConfigCache.set(afterCfg);
    await app.engineClient.send({
      commandId: randomUUID(),
      type: 'MARKET_CONFIG',
      ts: Date.now(),
      payload: {
        symbol: afterCfg.symbol,
        baseAsset: afterCfg.baseAsset,
        quoteAsset: afterCfg.quoteAsset,
        tickSize: afterCfg.tickSize,
        lotSize: afterCfg.lotSize,
        minNotional: afterCfg.minNotional,
        makerFeeBps: afterCfg.makerFeeBps.toString(),
        takerFeeBps: afterCfg.takerFeeBps.toString(),
        status: afterCfg.status,
      },
    });

    await app.prisma.auditLog.create({
      data: {
        actorId: request.user.sub,
        action: 'UPDATE_MARKET',
        meta: {
          targetType: 'MARKET',
          targetId: updated.symbol,
          before: beforeCfg,
          after: afterCfg,
        },
      },
    });

    return { status: 'ok', market: afterCfg };
  });

  // 18. POST /admin/markets/:symbol/halt: Halt market
  app.post('/admin/markets/:symbol/halt', { preHandler: [requireRole(Role.ADMIN)] }, async (request) => {
    const params = marketSymbolParamSchema.parse(request.params);
    const existing = await app.prisma.market.findUnique({
      where: { symbol: params.symbol },
    });
    if (!existing) {
      throw new AppError('MARKET_NOT_FOUND', 404, `Market ${params.symbol} not found`);
    }

    await app.prisma.market.update({
      where: { symbol: params.symbol },
      data: { status: MarketStatus.HALTED },
    });

    const cached = app.marketConfigCache.get(params.symbol);
    if (cached) {
      cached.status = MarketStatus.HALTED;
      app.marketConfigCache.set(cached);
    }

    await app.engineClient.send({
      commandId: randomUUID(),
      type: 'HALT_MARKET',
      ts: Date.now(),
      payload: { market: params.symbol },
    });

    await app.prisma.auditLog.create({
      data: {
        actorId: request.user.sub,
        action: 'HALT_MARKET',
        meta: {
          targetType: 'MARKET',
          targetId: params.symbol,
          before: { status: existing.status },
          after: { status: MarketStatus.HALTED },
        },
      },
    });

    return { status: 'ok', symbol: params.symbol, marketStatus: MarketStatus.HALTED };
  });

  // 19. POST /admin/markets/:symbol/resume: Resume market
  app.post('/admin/markets/:symbol/resume', { preHandler: [requireRole(Role.ADMIN)] }, async (request) => {
    const params = marketSymbolParamSchema.parse(request.params);
    const existing = await app.prisma.market.findUnique({
      where: { symbol: params.symbol },
    });
    if (!existing) {
      throw new AppError('MARKET_NOT_FOUND', 404, `Market ${params.symbol} not found`);
    }

    await app.prisma.market.update({
      where: { symbol: params.symbol },
      data: { status: MarketStatus.ACTIVE },
    });

    const cached = app.marketConfigCache.get(params.symbol);
    if (cached) {
      cached.status = MarketStatus.ACTIVE;
      app.marketConfigCache.set(cached);
    }

    await app.engineClient.send({
      commandId: randomUUID(),
      type: 'RESUME_MARKET',
      ts: Date.now(),
      payload: { market: params.symbol },
    });

    await app.prisma.auditLog.create({
      data: {
        actorId: request.user.sub,
        action: 'RESUME_MARKET',
        meta: {
          targetType: 'MARKET',
          targetId: params.symbol,
          before: { status: existing.status },
          after: { status: MarketStatus.ACTIVE },
        },
      },
    });

    return { status: 'ok', symbol: params.symbol, marketStatus: MarketStatus.ACTIVE };
  });

  // 20. POST /admin/withdrawals/:id/approve: Approve withdrawal
  app.post('/admin/withdrawals/:id/approve', { preHandler: [requireRole(Role.ADMIN)] }, async (request) => {
    const params = withdrawalIdParamSchema.parse(request.params);
    const withdrawal = await app.prisma.withdrawal.findUnique({
      where: { id: params.id },
    });
    if (!withdrawal) {
      throw new AppError('WITHDRAWAL_NOT_FOUND', 404, `Withdrawal ${params.id} not found`);
    }
    if (withdrawal.status !== 'PENDING') {
      throw new AppError('INVALID_STATUS', 422, `Withdrawal is already ${withdrawal.status}`);
    }

    const engineReply = await app.engineClient.send({
      commandId: randomUUID(),
      type: 'WITHDRAW_COMPLETE',
      ts: Date.now(),
      payload: { withdrawalId: params.id },
    });

    const updated = await app.prisma.withdrawal.update({
      where: { id: params.id },
      data: { status: 'COMPLETED', decidedAt: new Date() },
    });

    await app.prisma.auditLog.create({
      data: {
        actorId: request.user.sub,
        action: 'APPROVE_WITHDRAWAL',
        meta: {
          targetType: 'WITHDRAWAL',
          targetId: params.id,
          before: { status: 'PENDING' },
          after: { status: 'COMPLETED' },
        },
      },
    });

    return {
      status: 'ok',
      withdrawal: {
        id: updated.id,
        userId: updated.userId,
        asset: updated.asset,
        amount: updated.amount.toString(),
        status: updated.status,
        decidedAt: updated.decidedAt,
      },
      balance: engineReply.balance,
    };
  });

  // 21. POST /admin/withdrawals/:id/reject: Reject withdrawal
  app.post('/admin/withdrawals/:id/reject', { preHandler: [requireRole(Role.ADMIN)] }, async (request) => {
    const params = withdrawalIdParamSchema.parse(request.params);
    const withdrawal = await app.prisma.withdrawal.findUnique({
      where: { id: params.id },
    });
    if (!withdrawal) {
      throw new AppError('WITHDRAWAL_NOT_FOUND', 404, `Withdrawal ${params.id} not found`);
    }
    if (withdrawal.status !== 'PENDING') {
      throw new AppError('INVALID_STATUS', 422, `Withdrawal is already ${withdrawal.status}`);
    }

    const engineReply = await app.engineClient.send({
      commandId: randomUUID(),
      type: 'WITHDRAW_REJECT',
      ts: Date.now(),
      payload: { withdrawalId: params.id },
    });

    const updated = await app.prisma.withdrawal.update({
      where: { id: params.id },
      data: { status: 'REJECTED', decidedAt: new Date() },
    });

    await app.prisma.auditLog.create({
      data: {
        actorId: request.user.sub,
        action: 'REJECT_WITHDRAWAL',
        meta: {
          targetType: 'WITHDRAWAL',
          targetId: params.id,
          before: { status: 'PENDING' },
          after: { status: 'REJECTED' },
        },
      },
    });

    return {
      status: 'ok',
      withdrawal: {
        id: updated.id,
        userId: updated.userId,
        asset: updated.asset,
        amount: updated.amount.toString(),
        status: updated.status,
        decidedAt: updated.decidedAt,
      },
      balance: engineReply.balance,
    };
  });

  // 22. GET /admin/fees: Fee account totals
  app.get('/admin/fees', { preHandler: [requireRole(Role.ADMIN)] }, async (request) => {
    const trades = await app.prisma.trade.findMany({
      select: {
        makerFee: true,
        takerFee: true,
        market: true,
      },
    });

    const totalsByMarket: Record<string, bigint> = {};
    for (const t of trades) {
      const prev = totalsByMarket[t.market] ?? 0n;
      totalsByMarket[t.market] = prev + t.makerFee + t.takerFee;
    }

    const fees = Object.entries(totalsByMarket).map(([market, total]) => ({
      market,
      totalFees: total.toString(),
    }));

    await app.prisma.auditLog.create({
      data: {
        actorId: request.user.sub,
        action: 'VIEW_FEES',
        meta: {
          timestamp: Date.now(),
        },
      },
    });

    return { status: 'ok', fees };
  });
};
