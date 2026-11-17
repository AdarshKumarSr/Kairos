import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { Command, MarketStatus, OrderStatus, RejectCode, Side, OrderType } from '@cex/types';
import { AppError } from '../errors/app-error.js';
import { requireAuth } from '../middleware/auth.js';
import {
  depositSchema,
  depthQuerySchema,
  openOrdersQuerySchema,
  orderIdParamSchema,
  paginationQuerySchema,
  placeOrderSchema,
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

  // 10. POST /wallet/deposit: Simulated deposit for testing and wallet funding
  app.post('/wallet/deposit', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = depositSchema.parse(request.body);
    const commandId = randomUUID();

    const cmd: Command = {
      commandId,
      type: 'DEPOSIT',
      userId: request.user.sub,
      ts: Date.now(),
      payload: {
        asset: body.asset,
        amount: body.amount,
      },
    };

    const engineReply = await app.engineClient.send(cmd);

    if (engineReply.status === 'OK') {
      // Update Prisma balance for read consistency
      try {
        let asset = await app.prisma.asset.findUnique({
          where: { symbol: body.asset },
        });
        if (!asset) {
          asset = await app.prisma.asset.create({
            data: { symbol: body.asset, name: body.asset },
          });
        }

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
            available: BigInt(body.amount),
            locked: 0n,
            lastEngineSeq: BigInt(engineReply.engineSeq || '0'),
          },
          update: {
            available: { increment: BigInt(body.amount) },
            lastEngineSeq: BigInt(engineReply.engineSeq || '0'),
          },
        });

        return reply.code(200).send({
          status: 'ok',
          balance: {
            asset: body.asset,
            available: bal.available.toString(),
            locked: bal.locked.toString(),
          },
        });
      } catch {
        return reply.code(200).send({
          status: 'ok',
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
};
