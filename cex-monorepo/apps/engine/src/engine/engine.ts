import { BalanceManager, StubBalanceManager } from '../balance/balance-manager.js';
import { Book } from '../book/book.js';
import { matchOrder } from './matcher.js';
import {
  Command,
  EngineContext,
  EngineReply,
  EngineState,
  Event,
  IdempotencyRecord,
  MarketConfig,
  MarketState,
  MarketStatus,
  OrderSnapshot,
  OrderStatus,
  OrderType,
  ParsedMarketConfig,
  ProcessResult,
  RejectCode,
  Side,
} from './types.js';
import { validatePlaceOrder } from './validation.js';

export class Engine {
  static createInitialState(
    configs?: MarketConfig[],
    options?: { stubBalances?: boolean } | BalanceManager
  ): EngineState {
    let bm: BalanceManager;
    if (options instanceof BalanceManager || (options && 'checkAndLock' in options && 'settleTrade' in options)) {
      bm = options as BalanceManager;
    } else if (options && 'stubBalances' in options && options.stubBalances) {
      bm = new StubBalanceManager();
    } else {
      bm = new BalanceManager();
    }

    const state: EngineState = {
      markets: new Map<string, MarketState>(),
      idempotency: new Map<string, IdempotencyRecord>(),
      clientOrderMap: new Map<string, string>(),
      balanceManager: bm,
    };

    if (configs) {
      for (const cfg of configs) {
        Engine.registerMarket(state, cfg);
      }
    }

    return state;
  }

  static parseMarketConfig(cfg: MarketConfig): ParsedMarketConfig {
    return {
      symbol: cfg.symbol,
      baseAsset: cfg.baseAsset,
      quoteAsset: cfg.quoteAsset,
      tickSize: BigInt(cfg.tickSize),
      lotSize: BigInt(cfg.lotSize),
      minNotional: BigInt(cfg.minNotional),
      makerFeeBps: cfg.makerFeeBps,
      takerFeeBps: cfg.takerFeeBps,
      status: cfg.status,
    };
  }

  static registerMarket(state: EngineState, config: MarketConfig | ParsedMarketConfig): void {
    const parsed: ParsedMarketConfig =
      typeof config.tickSize === 'string'
        ? Engine.parseMarketConfig(config as MarketConfig)
        : (config as ParsedMarketConfig);

    const existing = state.markets.get(parsed.symbol);
    if (existing) {
      existing.config = parsed;
    } else {
      state.markets.set(parsed.symbol, {
        config: parsed,
        book: new Book(parsed.symbol),
      });
    }
  }

  /**
   * Pure synchronous matching engine processor.
   * Invariant: No I/O, no Date.now(), no Math.random().
   */
  static process(state: EngineState, command: Command, ctx: EngineContext): ProcessResult {
    // 1. Idempotency check: commandId
    const cached = state.idempotency.get(command.commandId);
    if (cached) {
      return { events: cached.events, reply: cached.reply };
    }

    // Idempotency check: (userId, clientOrderId)
    const clientOrderId = command.payload?.clientOrderId;
    if (command.userId && clientOrderId) {
      const clientKey = `${command.userId}:${String(clientOrderId)}`;
      const prevCmdId = state.clientOrderMap.get(clientKey);
      if (prevCmdId) {
        const prev = state.idempotency.get(prevCmdId);
        if (prev) {
          return { events: prev.events, reply: prev.reply };
        }
      }
    }

    const events: Event[] = [];

    // 2. Route command
    switch (command.type) {
      case 'PLACE_ORDER': {
        const validation = validatePlaceOrder(state, command.userId, command.payload);
        if (!validation.success) {
          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId: command.commandId,
            type: 'ORDER_REJECTED',
            ts: ctx.now,
            data: {
              orderId: String(command.payload.orderId ?? ''),
              clientOrderId: command.payload.clientOrderId !== undefined ? String(command.payload.clientOrderId) : undefined,
              userId: command.userId,
              market: String(command.payload.market ?? ''),
              side: command.payload.side,
              type: command.payload.type,
              code: validation.failure.code,
              reason: validation.failure.reason,
            },
          });
          break;
        }

        const validOrder = validation.order;

        // Emit ORDER_ACCEPTED
        events.push({
          engineSeq: ctx.engineSeq.toString(),
          commandId: command.commandId,
          type: 'ORDER_ACCEPTED',
          ts: ctx.now,
          data: {
            orderId: validOrder.orderId,
            clientOrderId: validOrder.clientOrderId,
            userId: validOrder.userId,
            market: validOrder.market.config.symbol,
            side: validOrder.side,
            type: validOrder.type,
            price: validOrder.price.toString(),
            quantity: validOrder.quantity.toString(),
            quoteQuantity: validOrder.quoteQuantity.toString(),
            postOnly: validOrder.postOnly,
            ioc: validOrder.ioc,
            status: OrderStatus.NEW,
          },
        });

        // Match order & settle balances
        const matchResult = matchOrder(state, validOrder, command.commandId, ctx);
        for (const ev of matchResult.events) {
          events.push(ev);
        }
        break;
      }

      case 'CANCEL_ORDER': {
        const orderId = String(command.payload.orderId ?? '');
        const marketSymbol = String(command.payload.market ?? '');

        // Find which market contains this order
        let targetMarket: MarketState | undefined;
        if (marketSymbol && state.markets.has(marketSymbol)) {
          targetMarket = state.markets.get(marketSymbol);
        } else {
          for (const m of state.markets.values()) {
            if (m.book.get(orderId)) {
              targetMarket = m;
              break;
            }
          }
        }

        const order = targetMarket ? targetMarket.book.get(orderId) : null;

        if (!targetMarket || !order) {
          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId: command.commandId,
            type: 'ORDER_REJECTED',
            ts: ctx.now,
            data: {
              orderId,
              userId: command.userId,
              market: marketSymbol,
              code: RejectCode.ORDER_NOT_FOUND,
              reason: 'Order not found or already filled/cancelled',
            },
          });
          break;
        }

        if (command.userId && order.userId !== command.userId) {
          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId: command.commandId,
            type: 'ORDER_REJECTED',
            ts: ctx.now,
            data: {
              orderId,
              userId: command.userId,
              market: targetMarket.config.symbol,
              code: RejectCode.NOT_OWNER,
              reason: 'Cannot cancel an order placed by another user',
            },
          });
          break;
        }

        // Cancel order: remove from book and release remaining lock
        const removed = targetMarket.book.remove(orderId);
        if (removed) {
          const remainingQty = removed.quantity - removed.filled;
          const lockAsset = removed.side === Side.BUY ? targetMarket.config.quoteAsset : targetMarket.config.baseAsset;
          state.balanceManager.unlock(removed.userId, lockAsset, removed.lockedAmount);

          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId: command.commandId,
            type: 'ORDER_CANCELLED',
            ts: ctx.now,
            data: {
              orderId: removed.orderId,
              userId: removed.userId,
              market: removed.market,
              side: removed.side,
              reason: 'USER',
              quantity: removed.quantity.toString(),
              filledQuantity: removed.filled.toString(),
              remainingQuantity: remainingQty.toString(),
              status: OrderStatus.CANCELLED,
            },
          });

          // Emit DEPTH_DELTA for that price level
          const level =
            removed.side === Side.BUY
              ? targetMarket.book.bids.getLevel(removed.price)
              : targetMarket.book.asks.getLevel(removed.price);
          const levelQty = level ? level.totalQuantity : 0n;

          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId: command.commandId,
            type: 'DEPTH_DELTA',
            ts: ctx.now,
            data: {
              market: removed.market,
              side: removed.side,
              price: removed.price.toString(),
              quantity: levelQty.toString(),
            },
          });

          // Emit BALANCE_UPDATED for released lock
          const bal = state.balanceManager.get(removed.userId, lockAsset);
          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId: command.commandId,
            type: 'BALANCE_UPDATED',
            ts: ctx.now,
            data: {
              userId: removed.userId,
              asset: lockAsset,
              available: bal.available.toString(),
              locked: bal.locked.toString(),
              reason: 'CANCEL_ORDER',
            },
          });
        }
        break;
      }

      case 'DEPOSIT': {
        const userId = String(command.userId ?? command.payload.userId ?? '');
        const asset = String(command.payload.asset ?? '');
        const amount = BigInt(String(command.payload.amount ?? '0'));
        const refId = String(command.payload.refId ?? '');

        state.balanceManager.deposit(userId, asset, amount);
        const bal = state.balanceManager.get(userId, asset);

        events.push({
          engineSeq: ctx.engineSeq.toString(),
          commandId: command.commandId,
          type: 'BALANCE_UPDATED',
          ts: ctx.now,
          data: {
            userId,
            asset,
            available: bal.available.toString(),
            locked: bal.locked.toString(),
            delta: amount.toString(),
            reason: 'DEPOSIT',
            refId,
          },
        });
        break;
      }

      case 'WITHDRAW_REQUEST': {
        const userId = String(command.userId ?? command.payload.userId ?? '');
        const asset = String(command.payload.asset ?? '');
        const amount = BigInt(String(command.payload.amount ?? '0'));
        const withdrawalId = String(command.payload.withdrawalId ?? command.payload.refId ?? command.commandId);

        const ok = state.balanceManager.withdrawRequest(userId, asset, amount, withdrawalId);
        if (!ok) {
          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId: command.commandId,
            type: 'ORDER_REJECTED',
            ts: ctx.now,
            data: {
              userId,
              asset,
              code: RejectCode.INSUFFICIENT_FUNDS,
              reason: `Insufficient available ${asset} for withdrawal request`,
            },
          });
        } else {
          const bal = state.balanceManager.get(userId, asset);
          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId: command.commandId,
            type: 'BALANCE_UPDATED',
            ts: ctx.now,
            data: {
              userId,
              asset,
              available: bal.available.toString(),
              locked: bal.locked.toString(),
              delta: (-amount).toString(),
              reason: 'WITHDRAW_REQUEST',
              withdrawalId,
            },
          });
        }
        break;
      }

      case 'WITHDRAW_COMPLETE': {
        const withdrawalId = String(command.payload.withdrawalId ?? command.payload.refId ?? command.commandId);
        const pw = state.balanceManager.withdrawComplete(withdrawalId);
        if (pw) {
          const bal = state.balanceManager.get(pw.userId, pw.asset);
          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId: command.commandId,
            type: 'BALANCE_UPDATED',
            ts: ctx.now,
            data: {
              userId: pw.userId,
              asset: pw.asset,
              available: bal.available.toString(),
              locked: bal.locked.toString(),
              delta: (-pw.amount).toString(),
              reason: 'WITHDRAWAL',
              withdrawalId,
            },
          });
        }
        break;
      }

      case 'WITHDRAW_REJECT': {
        const withdrawalId = String(command.payload.withdrawalId ?? command.payload.refId ?? command.commandId);
        const pw = state.balanceManager.withdrawReject(withdrawalId);
        if (pw) {
          const bal = state.balanceManager.get(pw.userId, pw.asset);
          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId: command.commandId,
            type: 'BALANCE_UPDATED',
            ts: ctx.now,
            data: {
              userId: pw.userId,
              asset: pw.asset,
              available: bal.available.toString(),
              locked: bal.locked.toString(),
              delta: pw.amount.toString(),
              reason: 'WITHDRAW_REJECT',
              withdrawalId,
            },
          });
        }
        break;
      }

      case 'HALT_MARKET': {
        const symbol = String(command.payload.market ?? command.payload.symbol ?? '');
        const market = state.markets.get(symbol);
        if (market) {
          market.config.status = MarketStatus.HALTED;
          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId: command.commandId,
            type: 'MARKET_STATUS',
            ts: ctx.now,
            data: {
              market: symbol,
              status: MarketStatus.HALTED,
            },
          });
        }
        break;
      }

      case 'RESUME_MARKET': {
        const symbol = String(command.payload.market ?? command.payload.symbol ?? '');
        const market = state.markets.get(symbol);
        if (market) {
          market.config.status = MarketStatus.ACTIVE;
          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId: command.commandId,
            type: 'MARKET_STATUS',
            ts: ctx.now,
            data: {
              market: symbol,
              status: MarketStatus.ACTIVE,
            },
          });
        }
        break;
      }

      case 'MARKET_CONFIG': {
        const symbol = String(command.payload.symbol ?? '');
        const cfg: ParsedMarketConfig = {
          symbol,
          baseAsset: String(command.payload.baseAsset ?? ''),
          quoteAsset: String(command.payload.quoteAsset ?? ''),
          tickSize: BigInt(String(command.payload.tickSize ?? '1000000')),
          lotSize: BigInt(String(command.payload.lotSize ?? '1000000')),
          minNotional: BigInt(String(command.payload.minNotional ?? '1000000000')),
          makerFeeBps: Number(command.payload.makerFeeBps ?? 8),
          takerFeeBps: Number(command.payload.takerFeeBps ?? 10),
          status: (command.payload.status as MarketStatus) ?? MarketStatus.ACTIVE,
        };
        Engine.registerMarket(state, cfg);

        events.push({
          engineSeq: ctx.engineSeq.toString(),
          commandId: command.commandId,
          type: 'MARKET_STATUS',
          ts: ctx.now,
          data: {
            market: symbol,
            status: cfg.status,
          },
        });
        break;
      }

      default:
        break;
    }

    // 3. Debug assertion mode (ENGINE_ASSERT=true)
    if (process.env.ENGINE_ASSERT === 'true') {
      Engine.checkInvariants(state);
    }

    // 4. Construct EngineReply
    let reply: EngineReply;
    const isRejected = events.length > 0 && events[0]?.type === 'ORDER_REJECTED';
    if (isRejected) {
      reply = {
        commandId: command.commandId,
        engineSeq: ctx.engineSeq.toString(),
        status: 'REJECTED',
        code: events[0]!.data.code as RejectCode,
      };
    } else {
      switch (command.type) {
        case 'PLACE_ORDER': {
          let orderSnap: OrderSnapshot | undefined;
          const orderId = String(command.payload.orderId ?? '');
          for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i]!;
            if (
              ev.data?.orderId === orderId &&
              (ev.type === 'ORDER_PLACED' ||
                ev.type === 'ORDER_UPDATED' ||
                ev.type === 'ORDER_CANCELLED' ||
                ev.type === 'ORDER_ACCEPTED')
            ) {
              orderSnap = {
                orderId,
                userId: command.userId ?? '',
                market: String(command.payload.market ?? ''),
                side: command.payload.side as Side,
                type: command.payload.type as OrderType,
                price: command.payload.price !== undefined ? String(command.payload.price) : undefined,
                quantity: String(command.payload.quantity ?? '0'),
                quoteQuantity: command.payload.quoteQuantity !== undefined ? String(command.payload.quoteQuantity) : undefined,
                clientOrderId: command.payload.clientOrderId !== undefined ? String(command.payload.clientOrderId) : undefined,
                status: (ev.data.status as OrderStatus) ?? OrderStatus.OPEN,
                filledQuantity: String(ev.data.filledQuantity ?? '0'),
                avgPrice: ev.data.avgPrice !== undefined ? String(ev.data.avgPrice) : undefined,
                createdAt: ctx.now,
                updatedAt: ctx.now,
              };
              break;
            }
          }
          reply = {
            commandId: command.commandId,
            engineSeq: ctx.engineSeq.toString(),
            status: 'OK',
            order: orderSnap,
          };
          break;
        }

        case 'CANCEL_ORDER': {
          const cancelEv = events.find((e) => e.type === 'ORDER_CANCELLED');
          reply = {
            commandId: command.commandId,
            engineSeq: ctx.engineSeq.toString(),
            status: 'OK',
            order: cancelEv
              ? {
                  orderId: String(cancelEv.data.orderId),
                  userId: String(cancelEv.data.userId),
                  market: String(cancelEv.data.market),
                  side: cancelEv.data.side as Side,
                  type: OrderType.LIMIT,
                  quantity: String(cancelEv.data.quantity),
                  status: OrderStatus.CANCELLED,
                  filledQuantity: String(cancelEv.data.filledQuantity ?? '0'),
                  createdAt: ctx.now,
                  updatedAt: ctx.now,
                }
              : undefined,
          };
          break;
        }

        case 'DEPOSIT':
        case 'WITHDRAW_REQUEST':
        case 'WITHDRAW_COMPLETE':
        case 'WITHDRAW_REJECT': {
          const balEv = events.find((e) => e.type === 'BALANCE_UPDATED');
          reply = {
            commandId: command.commandId,
            engineSeq: ctx.engineSeq.toString(),
            status: 'OK',
            balance: balEv
              ? {
                  asset: String(balEv.data.asset),
                  available: String(balEv.data.available),
                  locked: String(balEv.data.locked),
                }
              : undefined,
          };
          break;
        }

        default: {
          reply = {
            commandId: command.commandId,
            engineSeq: ctx.engineSeq.toString(),
            status: 'OK',
          };
          break;
        }
      }
    }

    // 5. Save to idempotency cache & maintain window (max 1M entries)
    state.idempotency.set(command.commandId, { events, reply, ts: ctx.now });
    if (state.idempotency.size > 1_000_000) {
      const oldestKey = state.idempotency.keys().next().value;
      if (oldestKey) state.idempotency.delete(oldestKey);
    }
    if (command.userId && clientOrderId) {
      state.clientOrderMap.set(`${command.userId}:${String(clientOrderId)}`, command.commandId);
      if (state.clientOrderMap.size > 1_000_000) {
        const oldestClient = state.clientOrderMap.keys().next().value;
        if (oldestClient) state.clientOrderMap.delete(oldestClient);
      }
    }

    return { events, reply };
  }

  static checkInvariants(state: EngineState): void {
    // 1. Assert no crossed books
    for (const market of state.markets.values()) {
      const bestBid = market.book.bestBid();
      const bestAsk = market.book.bestAsk();
      if (bestBid !== null && bestAsk !== null) {
        if (bestBid.price >= bestAsk.price) {
          throw new Error(
            `[ENGINE_ASSERT FAIL] Crossed book in ${market.config.symbol}: bestBid (${bestBid.price}) >= bestAsk (${bestAsk.price})`
          );
        }
      }
    }

    // 2. Assert conservation and lock consistency
    state.balanceManager.checkInvariants(state.markets);
  }
}
