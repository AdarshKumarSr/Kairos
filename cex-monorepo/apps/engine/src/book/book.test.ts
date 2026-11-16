import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Side } from '@cex/types';
import { DoublyLinkedList } from './linked-list.js';
import { SortedPriceLevels } from './sorted-price-levels.js';
import { Book } from './book.js';
import type { EngineOrder } from './types.js';

function createOrder(overrides: Partial<EngineOrder> = {}): EngineOrder {
  return {
    orderId: overrides.orderId ?? 'ord-1',
    userId: overrides.userId ?? 'usr-1',
    market: overrides.market ?? 'BTC-USDT',
    side: overrides.side ?? Side.BUY,
    type: overrides.type ?? 'LIMIT',
    price: overrides.price ?? 50000n,
    quantity: overrides.quantity ?? 100000000n,
    filled: overrides.filled ?? 0n,
    engineSeq: overrides.engineSeq ?? 1n,
    postOnly: overrides.postOnly ?? false,
    ioc: overrides.ioc ?? false,
    lockedAmount: overrides.lockedAmount ?? 5000000000000n,
  };
}

describe('DoublyLinkedList', () => {
  it('pushes elements and tracks size', () => {
    const list = new DoublyLinkedList<number>();
    expect(list.size).toBe(0);
    expect(list.isEmpty).toBe(true);

    const n1 = list.pushBack(10);
    const n2 = list.pushBack(20);
    const n3 = list.pushBack(30);

    expect(list.size).toBe(3);
    expect(list.isEmpty).toBe(false);
    expect(list.first()).toBe(n1);
    expect(n2.value).toBe(20);
    expect(list.last()).toBe(n3);
    expect(list.toArray()).toEqual([10, 20, 30]);
  });

  it('removes head node correctly', () => {
    const list = new DoublyLinkedList<string>();
    const n1 = list.pushBack('a');
    const n2 = list.pushBack('b');

    expect(list.remove(n1)).toBe(true);
    expect(list.size).toBe(1);
    expect(list.first()).toBe(n2);
    expect(list.last()).toBe(n2);
    expect(list.toArray()).toEqual(['b']);
  });

  it('removes tail node correctly', () => {
    const list = new DoublyLinkedList<string>();
    const n1 = list.pushBack('a');
    const n2 = list.pushBack('b');

    expect(list.remove(n2)).toBe(true);
    expect(list.size).toBe(1);
    expect(list.first()).toBe(n1);
    expect(list.last()).toBe(n1);
    expect(list.toArray()).toEqual(['a']);
  });

  it('removes middle node correctly', () => {
    const list = new DoublyLinkedList<string>();
    const n1 = list.pushBack('a');
    const n2 = list.pushBack('b');
    const n3 = list.pushBack('c');

    expect(list.remove(n2)).toBe(true);
    expect(list.size).toBe(2);
    expect(list.first()).toBe(n1);
    expect(list.last()).toBe(n3);
    expect(list.toArray()).toEqual(['a', 'c']);
  });

  it('handles removing the only node', () => {
    const list = new DoublyLinkedList<number>();
    const n1 = list.pushBack(99);

    expect(list.remove(n1)).toBe(true);
    expect(list.size).toBe(0);
    expect(list.isEmpty).toBe(true);
    expect(list.first()).toBeNull();
    expect(list.last()).toBeNull();
  });

  it('returns false when removing an already removed node', () => {
    const list = new DoublyLinkedList<number>();
    const n1 = list.pushBack(1);
    list.remove(n1);
    expect(list.remove(n1)).toBe(false);
  });

  it('returns false when removing a node from another list', () => {
    const listA = new DoublyLinkedList<number>();
    const listB = new DoublyLinkedList<number>();
    const nA = listA.pushBack(1);
    expect(listB.remove(nA)).toBe(false);
  });

  it('clears all nodes completely', () => {
    const list = new DoublyLinkedList<number>();
    list.pushBack(1);
    list.pushBack(2);
    list.pushBack(3);

    list.clear();
    expect(list.size).toBe(0);
    expect(list.isEmpty).toBe(true);
    expect(list.first()).toBeNull();
    expect(list.last()).toBeNull();
    expect(list.toArray()).toEqual([]);
  });

  it('iterates via generator in FIFO order', () => {
    const list = new DoublyLinkedList<number>();
    list.pushBack(1);
    list.pushBack(2);
    list.pushBack(3);

    const elements: number[] = [];
    for (const val of list.iterate()) {
      elements.push(val);
    }
    expect(elements).toEqual([1, 2, 3]);
  });
});

describe('SortedPriceLevels', () => {
  it('maintains bids in descending order (highest price first)', () => {
    const bids = new SortedPriceLevels(Side.BUY);
    bids.getOrCreateLevel(100n);
    bids.getOrCreateLevel(300n);
    bids.getOrCreateLevel(200n);
    bids.getOrCreateLevel(500n);

    const prices = bids.getAllLevels().map((l) => l.price);
    expect(prices).toEqual([500n, 300n, 200n, 100n]);
    expect(bids.best()?.price).toBe(500n);
  });

  it('maintains asks in ascending order (lowest price first)', () => {
    const asks = new SortedPriceLevels(Side.SELL);
    asks.getOrCreateLevel(300n);
    asks.getOrCreateLevel(100n);
    asks.getOrCreateLevel(400n);
    asks.getOrCreateLevel(200n);

    const prices = asks.getAllLevels().map((l) => l.price);
    expect(prices).toEqual([100n, 200n, 300n, 400n]);
    expect(asks.best()?.price).toBe(100n);
  });

  it('deletes level correctly and preserves sort order', () => {
    const bids = new SortedPriceLevels(Side.BUY);
    bids.getOrCreateLevel(100n);
    bids.getOrCreateLevel(200n);
    bids.getOrCreateLevel(300n);

    expect(bids.deleteLevel(200n)).toBe(true);
    expect(bids.deleteLevel(999n)).toBe(false);

    const prices = bids.getAllLevels().map((l) => l.price);
    expect(prices).toEqual([300n, 100n]);
  });

  it('returns topN depth levels accurately', () => {
    const bids = new SortedPriceLevels(Side.BUY);
    const l1 = bids.getOrCreateLevel(300n);
    const l2 = bids.getOrCreateLevel(200n);
    const l3 = bids.getOrCreateLevel(100n);

    l1.add(createOrder({ orderId: '1', price: 300n, quantity: 50n }));
    l2.add(createOrder({ orderId: '2', price: 200n, quantity: 30n }));
    l3.add(createOrder({ orderId: '3', price: 100n, quantity: 20n }));

    const top2 = bids.topN(2);
    expect(top2).toHaveLength(2);
    expect(top2[0]).toEqual({ price: 300n, quantity: 50n, orderCount: 1 });
    expect(top2[1]).toEqual({ price: 200n, quantity: 30n, orderCount: 1 });
  });
});

describe('Book', () => {
  it('adds orders and prevents duplicate order IDs', () => {
    const book = new Book('BTC-USDT');
    const order1 = createOrder({ orderId: 'ord-1', side: Side.BUY, price: 50000n });
    const order2 = createOrder({ orderId: 'ord-1', side: Side.BUY, price: 50000n });

    expect(book.add(order1)).toBe(true);
    expect(book.add(order2)).toBe(false);
    expect(book.orderCount).toBe(1);
    expect(book.totalBidQuantity).toBe(100000000n);
  });

  it('rejects order with mismatched market or invalid price/quantity', () => {
    const book = new Book('BTC-USDT');
    const wrongMarket = createOrder({ market: 'ETH-USDT' });
    const zeroPrice = createOrder({ price: 0n });
    const zeroRemaining = createOrder({ quantity: 100n, filled: 100n });

    expect(book.add(wrongMarket)).toBe(false);
    expect(book.add(zeroPrice)).toBe(false);
    expect(book.add(zeroRemaining)).toBe(false);
    expect(book.orderCount).toBe(0);
  });

  it('maintains strict FIFO order within the same price level', () => {
    const book = new Book('BTC-USDT');
    const o1 = createOrder({ orderId: 'ord-1', price: 50000n, engineSeq: 1n });
    const o2 = createOrder({ orderId: 'ord-2', price: 50000n, engineSeq: 2n });
    const o3 = createOrder({ orderId: 'ord-3', price: 50000n, engineSeq: 3n });

    book.add(o1);
    book.add(o2);
    book.add(o3);

    const level = book.bestBid();
    expect(level).not.toBeNull();
    const orders = level!.queue.toArray();
    expect(orders.map((o) => o.orderId)).toEqual(['ord-1', 'ord-2', 'ord-3']);
  });

  it('removes orders in O(1) and cleans up empty price levels', () => {
    const book = new Book('BTC-USDT');
    const o1 = createOrder({ orderId: 'ord-1', price: 50000n, quantity: 100n });
    const o2 = createOrder({ orderId: 'ord-2', price: 50000n, quantity: 200n });

    book.add(o1);
    book.add(o2);
    expect(book.totalBidQuantity).toBe(300n);

    // Cancel o1
    const removed1 = book.remove('ord-1');
    expect(removed1?.orderId).toBe('ord-1');
    expect(book.orderCount).toBe(1);
    expect(book.totalBidQuantity).toBe(200n);
    expect(book.bestBid()?.price).toBe(50000n);

    // Cancel o2 -> level should be deleted
    const removed2 = book.remove('ord-2');
    expect(removed2?.orderId).toBe('ord-2');
    expect(book.orderCount).toBe(0);
    expect(book.totalBidQuantity).toBe(0n);
    expect(book.bestBid()).toBeNull();

    // Removing non-existent order returns null
    expect(book.remove('ord-none')).toBeNull();
  });

  it('reduces order quantity for partial fills', () => {
    const book = new Book('BTC-USDT');
    const o1 = createOrder({ orderId: 'ord-1', price: 50000n, quantity: 100n });
    book.add(o1);

    const res1 = book.reduce('ord-1', 40n);
    expect(res1).not.toBeNull();
    expect(res1?.fullyFilled).toBe(false);
    expect(res1?.remainingQuantity).toBe(60n);
    expect(book.totalBidQuantity).toBe(60n);
    expect(book.orderCount).toBe(1);

    const res2 = book.reduce('ord-1', 60n);
    expect(res2).not.toBeNull();
    expect(res2?.fullyFilled).toBe(true);
    expect(res2?.remainingQuantity).toBe(0n);
    expect(book.totalBidQuantity).toBe(0n);
    expect(book.orderCount).toBe(0);
    expect(book.bestBid()).toBeNull();
  });

  it('clamps reduction when quantityToReduce exceeds remaining', () => {
    const book = new Book('BTC-USDT');
    const o1 = createOrder({ orderId: 'ord-1', price: 50000n, quantity: 50n });
    book.add(o1);

    const res = book.reduce('ord-1', 100n);
    expect(res).not.toBeNull();
    expect(res?.fullyFilled).toBe(true);
    expect(res?.order.filled).toBe(50n);
    expect(res?.remainingQuantity).toBe(0n);
    expect(book.orderCount).toBe(0);
  });

  it('provides depth ladder for bids and asks', () => {
    const book = new Book('BTC-USDT');
    book.add(createOrder({ orderId: 'b1', side: Side.BUY, price: 49000n, quantity: 10n }));
    book.add(createOrder({ orderId: 'b2', side: Side.BUY, price: 50000n, quantity: 20n }));
    book.add(createOrder({ orderId: 'a1', side: Side.SELL, price: 51000n, quantity: 15n }));
    book.add(createOrder({ orderId: 'a2', side: Side.SELL, price: 52000n, quantity: 25n }));

    const depth = book.depth(10);
    expect(depth.bids).toHaveLength(2);
    expect(depth.bids[0]?.price).toBe(50000n);
    expect(depth.bids[1]?.price).toBe(49000n);

    expect(depth.asks).toHaveLength(2);
    expect(depth.asks[0]?.price).toBe(51000n);
    expect(depth.asks[1]?.price).toBe(52000n);
  });

  it('supports deterministic snapshot and restore', () => {
    const book = new Book('BTC-USDT');
    book.add(createOrder({ orderId: 'b1', side: Side.BUY, price: 49000n, quantity: 10n }));
    book.add(createOrder({ orderId: 'b2', side: Side.BUY, price: 50000n, quantity: 20n, filled: 5n }));
    book.add(createOrder({ orderId: 'a1', side: Side.SELL, price: 51000n, quantity: 15n }));

    const snap1 = book.snapshot();
    const restored = Book.restore(snap1);
    const snap2 = restored.snapshot();

    expect(JSON.stringify(snap1)).toBe(JSON.stringify(snap2));
    expect(restored.orderCount).toBe(book.orderCount);
    expect(restored.totalBidQuantity).toBe(book.totalBidQuantity);
    expect(restored.totalAskQuantity).toBe(book.totalAskQuantity);
    expect(restored.bestBid()?.price).toBe(50000n);
    expect(restored.bestAsk()?.price).toBe(51000n);
  });
});

describe('Book Property-Based Tests (fast-check: 1000 runs)', () => {
  it('satisfies Invariant 11, sorted levels, index size, and deterministic snapshotting', () => {
    // Generate valid random actions
    const orderIdArb = fc.integer({ min: 1, max: 200 }).map((n) => `ord-${n}`);
    const sideArb = fc.constantFrom(Side.BUY, Side.SELL);
    const priceArb = fc.bigInt({ min: 100n, max: 2000n });
    const quantityArb = fc.bigInt({ min: 10n, max: 10000n });

    type Action =
      | { type: 'ADD'; id: string; side: Side; price: bigint; qty: bigint }
      | { type: 'CANCEL'; id: string }
      | { type: 'REDUCE'; id: string; qty: bigint };

    const actionArb: fc.Arbitrary<Action> = fc.oneof(
      fc.record({
        type: fc.constant('ADD' as const),
        id: orderIdArb,
        side: sideArb,
        price: priceArb,
        qty: quantityArb,
      }),
      fc.record({
        type: fc.constant('CANCEL' as const),
        id: orderIdArb,
      }),
      fc.record({
        type: fc.constant('REDUCE' as const),
        id: orderIdArb,
        qty: fc.bigInt({ min: 1n, max: 5000n }),
      }),
    );

    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 60 }), (actions) => {
        const book = new Book('BTC-USDT');
        let seq = 1n;

        for (const act of actions) {
          if (act.type === 'ADD') {
            book.add(
              createOrder({
                orderId: act.id,
                side: act.side,
                price: act.price,
                quantity: act.qty,
                engineSeq: seq++,
              }),
            );
          } else if (act.type === 'CANCEL') {
            book.remove(act.id);
          } else {
            book.reduce(act.id, act.qty);
          }
        }

        // Invariant 1: Bids are strictly descending
        const bidLevels = book.bids.getAllLevels();
        for (let i = 0; i < bidLevels.length - 1; i++) {
          expect(bidLevels[i]!.price).toBeGreaterThan(bidLevels[i + 1]!.price);
        }

        // Invariant 2: Asks are strictly ascending
        const askLevels = book.asks.getAllLevels();
        for (let i = 0; i < askLevels.length - 1; i++) {
          expect(askLevels[i]!.price).toBeLessThan(askLevels[i + 1]!.price);
        }

        // Invariant 11: totalBidQuantity equals exact sum of remaining buy quantities
        let expectedTotalBids = 0n;
        let expectedBidOrders = 0;
        for (const lvl of bidLevels) {
          expect(lvl.isEmpty).toBe(false);
          let levelSum = 0n;
          for (const order of lvl.queue.iterate()) {
            const rem = order.quantity - order.filled;
            expect(rem).toBeGreaterThan(0n);
            levelSum += rem;
            expectedBidOrders += 1;
          }
          expect(lvl.totalQuantity).toBe(levelSum);
          expectedTotalBids += levelSum;
        }
        expect(book.totalBidQuantity).toBe(expectedTotalBids);

        // Invariant 11: totalAskQuantity equals exact sum of remaining sell quantities
        let expectedTotalAsks = 0n;
        let expectedAskOrders = 0;
        for (const lvl of askLevels) {
          expect(lvl.isEmpty).toBe(false);
          let levelSum = 0n;
          for (const order of lvl.queue.iterate()) {
            const rem = order.quantity - order.filled;
            expect(rem).toBeGreaterThan(0n);
            levelSum += rem;
            expectedAskOrders += 1;
          }
          expect(lvl.totalQuantity).toBe(levelSum);
          expectedTotalAsks += levelSum;
        }
        expect(book.totalAskQuantity).toBe(expectedTotalAsks);

        // Index consistency
        expect(book.orderCount).toBe(expectedBidOrders + expectedAskOrders);

        // Determinism: Snapshot -> Restore -> Snapshot
        const snap = book.snapshot();
        const restored = Book.restore(snap);
        const snapAfterRestore = restored.snapshot();
        expect(JSON.stringify(snap)).toBe(JSON.stringify(snapAfterRestore));
      }),
      { numRuns: 1000 },
    );
  });
});

describe('Benchmark (100k adds + 100k cancels)', () => {
  it('completes 100,000 adds and 100,000 cancels in < 1,000 ms', () => {
    const book = new Book('BTC-USDT');
    const COUNT = 100_000;
    const orders: EngineOrder[] = new Array(COUNT);

    // Pre-create orders to measure only book data structure operations
    for (let i = 0; i < COUNT; i++) {
      const isBuy = (i & 1) === 0;
      // Spread across 1,000 price levels
      const price = isBuy ? 50000n - BigInt(i % 500) : 50001n + BigInt(i % 500);
      orders[i] = {
        orderId: `bench-${i}`,
        userId: 'usr-bench',
        market: 'BTC-USDT',
        side: isBuy ? Side.BUY : Side.SELL,
        type: 'LIMIT',
        price,
        quantity: 1000000n,
        filled: 0n,
        engineSeq: BigInt(i + 1),
        postOnly: false,
        ioc: false,
        lockedAmount: 50000000000n,
      };
    }

    const start = performance.now();

    // 100,000 adds
    for (let i = 0; i < COUNT; i++) {
      book.add(orders[i]!);
    }

    expect(book.orderCount).toBe(COUNT);

    // 100,000 cancels
    for (let i = 0; i < COUNT; i++) {
      book.remove(`bench-${i}`);
    }

    const elapsedMs = performance.now() - start;

    expect(book.orderCount).toBe(0);
    expect(book.totalBidQuantity).toBe(0n);
    expect(book.totalAskQuantity).toBe(0n);

    // Total duration should be well under 1,000 ms
    expect(elapsedMs).toBeLessThan(1000);
  });
});
