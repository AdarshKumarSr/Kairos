import { Side } from '@cex/types';
import { ListNode } from './linked-list.js';
import { PriceLevel } from './price-level.js';
import { SortedPriceLevels } from './sorted-price-levels.js';
import type {
  BookSnapshot,
  DepthLadder,
  EngineOrder,
  SerializedOrder,
  SerializedPriceLevel,
} from './types.js';

interface IndexEntry {
  side: Side;
  price: bigint;
  node: ListNode<EngineOrder>;
}

export interface ReduceResult {
  order: EngineOrder;
  remainingQuantity: bigint;
  fullyFilled: boolean;
}

export class Book {
  readonly market: string;
  readonly bids: SortedPriceLevels;
  readonly asks: SortedPriceLevels;
  private readonly index: Map<string, IndexEntry> = new Map();

  constructor(market: string) {
    this.market = market;
    this.bids = new SortedPriceLevels(Side.BUY);
    this.asks = new SortedPriceLevels(Side.SELL);
  }

  get orderCount(): number {
    return this.index.size;
  }

  get totalBidQuantity(): bigint {
    return this.bids.totalQuantity;
  }

  get totalAskQuantity(): bigint {
    return this.asks.totalQuantity;
  }

  add(order: EngineOrder): boolean {
    if (order.market !== this.market || order.price <= 0n) {
      return false;
    }

    if (this.index.has(order.orderId)) {
      return false;
    }

    const remaining = order.quantity - order.filled;
    if (remaining <= 0n) {
      return false;
    }

    const levels = order.side === Side.BUY ? this.bids : this.asks;
    const level = levels.getOrCreateLevel(order.price);
    const node = level.add(order);

    this.index.set(order.orderId, {
      side: order.side,
      price: order.price,
      node,
    });

    return true;
  }

  remove(orderId: string): EngineOrder | null {
    const entry = this.index.get(orderId);
    if (!entry) {
      return null;
    }

    const levels = entry.side === Side.BUY ? this.bids : this.asks;
    const level = levels.getLevel(entry.price);

    if (level) {
      level.remove(entry.node);
      if (level.isEmpty) {
        levels.deleteLevel(entry.price);
      }
    }

    this.index.delete(orderId);
    return entry.node.value;
  }

  reduce(orderId: string, quantityToReduce: bigint): ReduceResult | null {
    if (quantityToReduce <= 0n) {
      return null;
    }

    const entry = this.index.get(orderId);
    if (!entry) {
      return null;
    }

    const order = entry.node.value;
    const currentRemaining = order.quantity - order.filled;
    const actualReduce = quantityToReduce > currentRemaining ? currentRemaining : quantityToReduce;

    order.filled += actualReduce;

    const levels = entry.side === Side.BUY ? this.bids : this.asks;
    const level = levels.getLevel(entry.price);
    if (level) {
      level.reduce(actualReduce);
    }

    const newRemaining = order.quantity - order.filled;
    const fullyFilled = newRemaining <= 0n;

    if (fullyFilled) {
      if (level) {
        level.remove(entry.node);
        if (level.isEmpty) {
          levels.deleteLevel(entry.price);
        }
      }
      this.index.delete(orderId);
    }

    return {
      order,
      remainingQuantity: newRemaining,
      fullyFilled,
    };
  }

  get(orderId: string): EngineOrder | null {
    const entry = this.index.get(orderId);
    return entry ? entry.node.value : null;
  }

  *getAllOrders(): IterableIterator<EngineOrder> {
    for (const entry of this.index.values()) {
      yield entry.node.value;
    }
  }

  bestBid(): PriceLevel | null {
    return this.bids.best();
  }

  bestAsk(): PriceLevel | null {
    return this.asks.best();
  }

  depth(n = 20): DepthLadder {
    return {
      bids: this.bids.topN(n),
      asks: this.asks.topN(n),
    };
  }

  clear(): void {
    this.bids.clear();
    this.asks.clear();
    this.index.clear();
  }

  snapshot(): BookSnapshot {
    const serializeLevel = (level: PriceLevel): SerializedPriceLevel => {
      const orders: SerializedOrder[] = [];
      for (const order of level.queue.iterate()) {
        orders.push({
          orderId: order.orderId,
          userId: order.userId,
          market: order.market,
          side: order.side,
          type: order.type,
          price: order.price.toString(),
          quantity: order.quantity.toString(),
          filled: order.filled.toString(),
          engineSeq: order.engineSeq.toString(),
          postOnly: order.postOnly,
          ioc: order.ioc,
          lockedAmount: order.lockedAmount.toString(),
        });
      }
      return {
        price: level.price.toString(),
        totalQuantity: level.totalQuantity.toString(),
        orders,
      };
    };

    const bids: SerializedPriceLevel[] = [];
    for (const level of this.bids.getAllLevels()) {
      bids.push(serializeLevel(level));
    }

    const asks: SerializedPriceLevel[] = [];
    for (const level of this.asks.getAllLevels()) {
      asks.push(serializeLevel(level));
    }

    return {
      market: this.market,
      bids,
      asks,
      totalBidQuantity: this.totalBidQuantity.toString(),
      totalAskQuantity: this.totalAskQuantity.toString(),
      orderCount: this.orderCount,
    };
  }

  static restore(snapshot: BookSnapshot): Book {
    const book = new Book(snapshot.market);

    const deserializeOrder = (so: SerializedOrder): EngineOrder => ({
      orderId: so.orderId,
      userId: so.userId,
      market: so.market,
      side: so.side as Side,
      type: so.type,
      price: BigInt(so.price),
      quantity: BigInt(so.quantity),
      filled: BigInt(so.filled),
      engineSeq: BigInt(so.engineSeq),
      postOnly: so.postOnly,
      ioc: so.ioc,
      lockedAmount: BigInt(so.lockedAmount),
    });

    for (const level of snapshot.bids) {
      for (const order of level.orders) {
        book.add(deserializeOrder(order));
      }
    }

    for (const level of snapshot.asks) {
      for (const order of level.orders) {
        book.add(deserializeOrder(order));
      }
    }

    return book;
  }
}
