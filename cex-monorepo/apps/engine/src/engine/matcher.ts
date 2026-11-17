import { calcFee, lockForBuyLimit, minBig, mulDiv, SCALE } from '@cex/money';
import { Event, OrderStatus, OrderType, RejectCode, Side } from '@cex/types';
import { EngineOrder } from '../book/types.js';
import { EngineContext, EngineState } from './types.js';
import { ValidatedOrderPayload } from './validation.js';

export interface MatchResult {
  events: Event[];
}

export function matchOrder(
  state: EngineState,
  order: ValidatedOrderPayload,
  commandId: string,
  ctx: EngineContext
): MatchResult {
  const events: Event[] = [];
  const book = order.market.book;
  const isBuy = order.side === Side.BUY;
  const oppositeSide = isBuy ? Side.SELL : Side.BUY;

  // 1. Post-only check
  if (order.postOnly) {
    const bestOpposite = isBuy ? book.bestAsk() : book.bestBid();
    if (bestOpposite !== null) {
      const wouldCross = isBuy ? order.price >= bestOpposite.price : order.price <= bestOpposite.price;
      if (wouldCross) {
        state.balanceManager.unlock(order.userId, order.lockAsset, order.lockAmount);
        events.push({
          engineSeq: ctx.engineSeq.toString(),
          commandId,
          type: 'ORDER_REJECTED',
          ts: ctx.now,
          data: {
            orderId: order.orderId,
            clientOrderId: order.clientOrderId,
            userId: order.userId,
            market: order.market.config.symbol,
            side: order.side,
            type: order.type,
            code: RejectCode.POST_ONLY_WOULD_CROSS,
            reason: 'Post-only order would cross existing liquidity',
          },
        });
        return { events };
      }
    }
  }

  // Track touched price levels to emit DEPTH_DELTA at the end
  const touchedLevels = new Map<string, { side: Side; price: bigint }>();
  let tradeIndex = 1;
  let stpTriggered = false;

  let takerRemaining = order.quantity;
  let remainingBudget = order.quoteQuantity;
  let filledSoFar = 0n;

  // 2. Matching loop
  while (true) {
    const bestOppositeLevel = isBuy ? book.bestAsk() : book.bestBid();
    if (!bestOppositeLevel || bestOppositeLevel.isEmpty) {
      break;
    }

    // Check crossing condition
    if (order.type === OrderType.LIMIT) {
      const crosses = isBuy
        ? order.price >= bestOppositeLevel.price
        : order.price <= bestOppositeLevel.price;
      if (!crosses) {
        break;
      }
    }

    // Check budget / quantity limit
    if (order.type === OrderType.MARKET) {
      if (isBuy && remainingBudget <= 0n) break;
      if (!isBuy && takerRemaining <= 0n) break;
    } else if (order.type === OrderType.LIMIT) {
      if (takerRemaining <= 0n) break;
    }

    const makerNode = bestOppositeLevel.queue.head;
    if (!makerNode) {
      break;
    }

    const maker = makerNode.value;
    const makerRemaining = maker.quantity - maker.filled;
    if (makerRemaining <= 0n) {
      book.remove(maker.orderId);
      continue;
    }

    // STP: Self-Trade Prevention (CANCEL_TAKER)
    if (maker.userId === order.userId) {
      stpTriggered = true;
      let unlockRemaining = 0n;
      if (order.type === OrderType.LIMIT) {
        unlockRemaining = isBuy ? lockForBuyLimit(order.price, takerRemaining) : takerRemaining;
      } else {
        unlockRemaining = isBuy ? remainingBudget : takerRemaining;
      }
      state.balanceManager.unlock(order.userId, order.lockAsset, unlockRemaining);

      events.push({
        engineSeq: ctx.engineSeq.toString(),
        commandId,
        type: 'ORDER_CANCELLED',
        ts: ctx.now,
        data: {
          orderId: order.orderId,
          clientOrderId: order.clientOrderId,
          userId: order.userId,
          market: order.market.config.symbol,
          side: order.side,
          reason: 'STP',
          code: RejectCode.SELF_TRADE,
          quantity: order.type === OrderType.MARKET && isBuy ? filledSoFar.toString() : order.quantity.toString(),
          filledQuantity: filledSoFar.toString(),
          remainingQuantity: order.type === OrderType.MARKET && isBuy ? remainingBudget.toString() : takerRemaining.toString(),
          status: OrderStatus.CANCELLED,
        },
      });
      break;
    }

    // Execute trade against maker at maker.price
    const tradePrice = maker.price;
    let tradeQty = 0n;
    let quoteAmt = 0n;

    if (order.type === OrderType.MARKET && isBuy) {
      const maxQty = mulDiv(remainingBudget, SCALE, tradePrice);
      if (maxQty <= 0n) {
        break;
      }
      tradeQty = minBig(makerRemaining, maxQty);
      if (tradeQty <= 0n) {
        break;
      }
      quoteAmt = mulDiv(tradePrice, tradeQty, SCALE);
      remainingBudget -= quoteAmt;
      takerRemaining -= tradeQty;
    } else {
      tradeQty = minBig(takerRemaining, makerRemaining);
      if (tradeQty <= 0n) {
        break;
      }
      quoteAmt = mulDiv(tradePrice, tradeQty, SCALE);
      takerRemaining -= tradeQty;
    }

    filledSoFar += tradeQty;

    // Reduce maker order in book
    const reduceResult = book.reduce(maker.orderId, tradeQty);
    const makerFullyFilled = reduceResult ? reduceResult.fullyFilled : false;
    const makerRemainingAfter = reduceResult ? reduceResult.remainingQuantity : 0n;

    // Calculate fees in received asset
    // Buyer receives base (tradeQty), pays fee in base
    // Seller receives quote (quoteAmt), pays fee in quote
    const buyerFee = calcFee(tradeQty, isBuy ? order.market.config.takerFeeBps : order.market.config.makerFeeBps);
    const sellerFee = calcFee(quoteAmt, isBuy ? order.market.config.makerFeeBps : order.market.config.takerFeeBps);

    const takerFee = isBuy ? buyerFee : sellerFee;
    const makerFee = isBuy ? sellerFee : buyerFee;

    const tradeId = `t-${ctx.engineSeq}-${tradeIndex++}`;
    touchedLevels.set(`${oppositeSide}:${tradePrice}`, { side: oppositeSide, price: tradePrice });

    // Emit TRADE event
    events.push({
      engineSeq: ctx.engineSeq.toString(),
      commandId,
      type: 'TRADE',
      ts: ctx.now,
      data: {
        tradeId,
        market: order.market.config.symbol,
        price: tradePrice.toString(),
        quantity: tradeQty.toString(),
        quoteQuantity: quoteAmt.toString(),
        makerOrderId: maker.orderId,
        takerOrderId: order.orderId,
        makerUserId: maker.userId,
        takerUserId: order.userId,
        takerSide: order.side,
        makerFee: makerFee.toString(),
        takerFee: takerFee.toString(),
      },
    });

    // Emit ORDER_UPDATED for maker
    events.push({
      engineSeq: ctx.engineSeq.toString(),
      commandId,
      type: 'ORDER_UPDATED',
      ts: ctx.now,
      data: {
        orderId: maker.orderId,
        userId: maker.userId,
        market: order.market.config.symbol,
        side: maker.side,
        price: maker.price.toString(),
        quantity: maker.quantity.toString(),
        filledQuantity: (maker.quantity - makerRemainingAfter).toString(),
        remainingQuantity: makerRemainingAfter.toString(),
        status: makerFullyFilled ? OrderStatus.FILLED : OrderStatus.PARTIALLY_FILLED,
      },
    });
  }

  // 3. Post-match remainder handling
  if (!stpTriggered) {
    const isFullyFilled =
      order.type === OrderType.LIMIT
        ? takerRemaining === 0n
        : isBuy
          ? remainingBudget === 0n || takerRemaining === 0n
          : takerRemaining === 0n;

    if (isFullyFilled) {
      events.push({
        engineSeq: ctx.engineSeq.toString(),
        commandId,
        type: 'ORDER_UPDATED',
        ts: ctx.now,
        data: {
          orderId: order.orderId,
          clientOrderId: order.clientOrderId,
          userId: order.userId,
          market: order.market.config.symbol,
          side: order.side,
          price: order.price.toString(),
          quantity: order.type === OrderType.MARKET && isBuy ? filledSoFar.toString() : order.quantity.toString(),
          filledQuantity: filledSoFar.toString(),
          remainingQuantity: '0',
          status: OrderStatus.FILLED,
        },
      });
    } else {
      // Order has remainder
      if (order.type === OrderType.LIMIT) {
        if (!order.ioc) {
          // Rest on book
          const remainingLock = isBuy
            ? lockForBuyLimit(order.price, takerRemaining)
            : takerRemaining;

          const restingOrder: EngineOrder = {
            orderId: order.orderId,
            userId: order.userId,
            market: order.market.config.symbol,
            side: order.side,
            type: order.type,
            price: order.price,
            quantity: order.quantity,
            filled: filledSoFar,
            engineSeq: ctx.engineSeq,
            postOnly: order.postOnly,
            ioc: order.ioc,
            lockedAmount: remainingLock,
          };

          book.add(restingOrder);
          touchedLevels.set(`${order.side}:${order.price}`, {
            side: order.side,
            price: order.price,
          });

          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId,
            type: 'ORDER_PLACED',
            ts: ctx.now,
            data: {
              orderId: order.orderId,
              clientOrderId: order.clientOrderId,
              userId: order.userId,
              market: order.market.config.symbol,
              side: order.side,
              type: order.type,
              price: order.price.toString(),
              quantity: order.quantity.toString(),
              filledQuantity: filledSoFar.toString(),
              remainingQuantity: takerRemaining.toString(),
              status: filledSoFar > 0n ? OrderStatus.PARTIALLY_FILLED : OrderStatus.OPEN,
            },
          });
        } else {
          // IOC remainder cancelled
          const unlockAmount = isBuy
            ? lockForBuyLimit(order.price, takerRemaining)
            : takerRemaining;
          state.balanceManager.unlock(order.userId, order.lockAsset, unlockAmount);

          events.push({
            engineSeq: ctx.engineSeq.toString(),
            commandId,
            type: 'ORDER_CANCELLED',
            ts: ctx.now,
            data: {
              orderId: order.orderId,
              clientOrderId: order.clientOrderId,
              userId: order.userId,
              market: order.market.config.symbol,
              side: order.side,
              reason: 'IOC',
              quantity: order.quantity.toString(),
              filledQuantity: filledSoFar.toString(),
              remainingQuantity: takerRemaining.toString(),
              status: OrderStatus.CANCELLED,
            },
          });
        }
      } else {
        // Market order remainder cancelled
        const unlockAmount = isBuy ? remainingBudget : takerRemaining;
        state.balanceManager.unlock(order.userId, order.lockAsset, unlockAmount);

        events.push({
          engineSeq: ctx.engineSeq.toString(),
          commandId,
          type: 'ORDER_CANCELLED',
          ts: ctx.now,
          data: {
            orderId: order.orderId,
            clientOrderId: order.clientOrderId,
            userId: order.userId,
            market: order.market.config.symbol,
            side: order.side,
            reason: 'MARKET',
            quantity: isBuy ? filledSoFar.toString() : order.quantity.toString(),
            filledQuantity: filledSoFar.toString(),
            remainingQuantity: isBuy ? remainingBudget.toString() : takerRemaining.toString(),
            status: OrderStatus.CANCELLED,
          },
        });
      }
    }
  }

  // 4. Emit DEPTH_DELTA for touched price levels
  for (const { side, price } of touchedLevels.values()) {
    const level = side === Side.BUY ? book.bids.getLevel(price) : book.asks.getLevel(price);
    const quantity = level ? level.totalQuantity : 0n;
    events.push({
      engineSeq: ctx.engineSeq.toString(),
      commandId,
      type: 'DEPTH_DELTA',
      ts: ctx.now,
      data: {
        market: order.market.config.symbol,
        side,
        price: price.toString(),
        quantity: quantity.toString(),
      },
    });
  }

  return { events };
}
