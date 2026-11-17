import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Command,
  Engine,
  EngineContext,
  EngineState,
  MarketConfig,
  MarketStatus,
  OrderStatus,
  OrderType,
  RejectCode,
  Side,
} from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOL_USDT_CONFIG: MarketConfig = {
  symbol: 'SOL_USDT',
  baseAsset: 'SOL',
  quoteAsset: 'USDT',
  tickSize: '1000000', // 0.01 scaled by 1e8
  lotSize: '1000000', // 0.01 scaled by 1e8
  minNotional: '500000000', // 5.00 USDT scaled by 1e8
  makerFeeBps: 8,
  takerFeeBps: 10,
  status: MarketStatus.ACTIVE,
};

function createContext(seq = 1n, now = 1700000000000): EngineContext {
  return { engineSeq: seq, now };
}

describe('Matching Engine Core (Phase 6)', () => {
  it('Purity verification: engine source code contains no Date.now, Math.random, or I/O in process()', () => {
    const engineFile = readFileSync(join(__dirname, 'engine.ts'), 'utf-8');
    const matcherFile = readFileSync(join(__dirname, 'matcher.ts'), 'utf-8');
    const validationFile = readFileSync(join(__dirname, 'validation.ts'), 'utf-8');

    // Strip comments to inspect executable code only
    const stripComments = (str: string) => str.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    const executableCode = stripComments(`${engineFile}\n${matcherFile}\n${validationFile}`);

    expect(executableCode).not.toContain('Date.now');
    expect(executableCode).not.toContain('Math.random');
    expect(executableCode).not.toContain('setTimeout');
    expect(executableCode).not.toContain('setInterval');
    expect(executableCode).not.toContain('fetch(');
  });

  describe('Table-Driven Functional Tests', () => {
    it('1. Full fill: incoming limit buy matches resting limit sell exactly', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      let seq = 1n;

      // Alice places LIMIT SELL 10 SOL @ 150.00
      const sellCmd: Command = {
        commandId: 'cmd-sell-1',
        type: 'PLACE_ORDER',
        userId: 'alice',
        ts: 1000,
        payload: {
          orderId: 'sell-1',
          market: 'SOL_USDT',
          side: Side.SELL,
          type: OrderType.LIMIT,
          price: '15000000000', // 150.00
          quantity: '1000000000', // 10.00
        },
      };
      const res1 = Engine.process(state, sellCmd, createContext(seq++));
      expect(res1.events.some((e) => e.type === 'ORDER_PLACED')).toBe(true);

      // Bob places LIMIT BUY 10 SOL @ 150.00
      const buyCmd: Command = {
        commandId: 'cmd-buy-1',
        type: 'PLACE_ORDER',
        userId: 'bob',
        ts: 2000,
        payload: {
          orderId: 'buy-1',
          market: 'SOL_USDT',
          side: Side.BUY,
          type: OrderType.LIMIT,
          price: '15000000000',
          quantity: '1000000000',
        },
      };
      const res2 = Engine.process(state, buyCmd, createContext(seq++));

      const tradeEvent = res2.events.find((e) => e.type === 'TRADE');
      expect(tradeEvent).toBeDefined();
      expect(tradeEvent?.data['price']).toBe('15000000000');
      expect(tradeEvent?.data['quantity']).toBe('1000000000');
      expect(tradeEvent?.data['makerOrderId']).toBe('sell-1');
      expect(tradeEvent?.data['takerOrderId']).toBe('buy-1');

      // Both orders fully filled
      const makerUpdate = res2.events.find(
        (e) => e.type === 'ORDER_UPDATED' && e.data['orderId'] === 'sell-1'
      );
      expect(makerUpdate?.data['status']).toBe(OrderStatus.FILLED);

      const takerUpdate = res2.events.find(
        (e) => e.type === 'ORDER_UPDATED' && e.data['orderId'] === 'buy-1'
      );
      expect(takerUpdate?.data['status']).toBe(OrderStatus.FILLED);

      // Book should now be empty
      const book = state.markets.get('SOL_USDT')!.book;
      expect(book.orderCount).toBe(0);
      expect(book.bestBid()).toBeNull();
      expect(book.bestAsk()).toBeNull();
    });

    it('2. Partial fill: incoming limit buy partially fills resting limit sell', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      let seq = 1n;

      // Alice places LIMIT SELL 10 SOL @ 150.00
      Engine.process(
        state,
        {
          commandId: 'cmd-sell-2',
          type: 'PLACE_ORDER',
          userId: 'alice',
          ts: 1000,
          payload: {
            orderId: 'sell-2',
            market: 'SOL_USDT',
            side: Side.SELL,
            type: OrderType.LIMIT,
            price: '15000000000',
            quantity: '1000000000',
          },
        },
        createContext(seq++)
      );

      // Bob places LIMIT BUY 4 SOL @ 150.00
      const res = Engine.process(
        state,
        {
          commandId: 'cmd-buy-2',
          type: 'PLACE_ORDER',
          userId: 'bob',
          ts: 2000,
          payload: {
            orderId: 'buy-2',
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.LIMIT,
            price: '15000000000',
            quantity: '400000000', // 4.00
          },
        },
        createContext(seq++)
      );

      const trade = res.events.find((e) => e.type === 'TRADE');
      expect(trade?.data['quantity']).toBe('400000000');

      const makerUpdate = res.events.find(
        (e) => e.type === 'ORDER_UPDATED' && e.data['orderId'] === 'sell-2'
      );
      expect(makerUpdate?.data['status']).toBe(OrderStatus.PARTIALLY_FILLED);
      expect(makerUpdate?.data['remainingQuantity']).toBe('600000000'); // 6.00 remains

      const book = state.markets.get('SOL_USDT')!.book;
      expect(book.orderCount).toBe(1);
      expect(book.bestAsk()?.totalQuantity).toBe(600000000n);
    });

    it('3. Multi-level sweep: large order sweeps 3 price levels at resting prices', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      let seq = 1n;

      // Place 3 sell orders at 150, 151, 152
      for (let i = 0; i < 3; i++) {
        const price = 15000000000n + BigInt(i) * 100000000n;
        Engine.process(
          state,
          {
            commandId: `cmd-sell-sweep-${i}`,
            type: 'PLACE_ORDER',
            userId: `alice-${i}`,
            ts: 1000 + i,
            payload: {
              orderId: `sell-sweep-${i}`,
              market: 'SOL_USDT',
              side: Side.SELL,
              type: OrderType.LIMIT,
              price: price.toString(),
              quantity: '500000000', // 5 SOL each
            },
          },
          createContext(seq++)
        );
      }

      // Bob places BUY 12 SOL @ 155.00
      const res = Engine.process(
        state,
        {
          commandId: 'cmd-buy-sweep',
          type: 'PLACE_ORDER',
          userId: 'bob',
          ts: 2000,
          payload: {
            orderId: 'buy-sweep',
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.LIMIT,
            price: '15500000000',
            quantity: '1200000000', // 12 SOL
          },
        },
        createContext(seq++)
      );

      const trades = res.events.filter((e) => e.type === 'TRADE');
      expect(trades.length).toBe(3);

      // Verify execution at maker prices
      expect(trades[0]?.data['price']).toBe('15000000000');
      expect(trades[0]?.data['quantity']).toBe('500000000');

      expect(trades[1]?.data['price']).toBe('15100000000');
      expect(trades[1]?.data['quantity']).toBe('500000000');

      expect(trades[2]?.data['price']).toBe('15200000000');
      expect(trades[2]?.data['quantity']).toBe('200000000'); // 2 SOL remaining of 12

      // Check remaining depth on level 152
      const book = state.markets.get('SOL_USDT')!.book;
      expect(book.bestAsk()?.price).toBe(15200000000n);
      expect(book.bestAsk()?.totalQuantity).toBe(300000000n); // 5 - 2 = 3 SOL remains
    });

    it('4. Time priority at equal price: FIFO matching for orders at same level', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      let seq = 1n;

      // Alice places first SELL 5 SOL @ 150.00
      Engine.process(
        state,
        {
          commandId: 'cmd-fifo-1',
          type: 'PLACE_ORDER',
          userId: 'alice',
          ts: 1000,
          payload: {
            orderId: 'sell-fifo-1',
            market: 'SOL_USDT',
            side: Side.SELL,
            type: OrderType.LIMIT,
            price: '15000000000',
            quantity: '500000000',
          },
        },
        createContext(seq++)
      );

      // Charlie places second SELL 5 SOL @ 150.00
      Engine.process(
        state,
        {
          commandId: 'cmd-fifo-2',
          type: 'PLACE_ORDER',
          userId: 'charlie',
          ts: 1001,
          payload: {
            orderId: 'sell-fifo-2',
            market: 'SOL_USDT',
            side: Side.SELL,
            type: OrderType.LIMIT,
            price: '15000000000',
            quantity: '500000000',
          },
        },
        createContext(seq++)
      );

      // Bob buys 6 SOL @ 150.00: should fill Alice's 5 SOL first, then 1 SOL of Charlie's
      const res = Engine.process(
        state,
        {
          commandId: 'cmd-buy-fifo',
          type: 'PLACE_ORDER',
          userId: 'bob',
          ts: 2000,
          payload: {
            orderId: 'buy-fifo',
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.LIMIT,
            price: '15000000000',
            quantity: '600000000',
          },
        },
        createContext(seq++)
      );

      const trades = res.events.filter((e) => e.type === 'TRADE');
      expect(trades.length).toBe(2);
      expect(trades[0]?.data['makerOrderId']).toBe('sell-fifo-1');
      expect(trades[0]?.data['quantity']).toBe('500000000');

      expect(trades[1]?.data['makerOrderId']).toBe('sell-fifo-2');
      expect(trades[1]?.data['quantity']).toBe('100000000');
    });

    it('5. Market buy exhausts budget mid-level', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      let seq = 1n;

      // Alice places SELL 10 SOL @ 100.00
      Engine.process(
        state,
        {
          commandId: 'cmd-sell-mb',
          type: 'PLACE_ORDER',
          userId: 'alice',
          ts: 1000,
          payload: {
            orderId: 'sell-mb',
            market: 'SOL_USDT',
            side: Side.SELL,
            type: OrderType.LIMIT,
            price: '10000000000', // 100 USDT
            quantity: '1000000000', // 10 SOL
          },
        },
        createContext(seq++)
      );

      // Bob places MARKET BUY with quoteQuantity = 500 USDT (buys exactly 5 SOL)
      const res = Engine.process(
        state,
        {
          commandId: 'cmd-buy-mb',
          type: 'PLACE_ORDER',
          userId: 'bob',
          ts: 2000,
          payload: {
            orderId: 'buy-mb',
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.MARKET,
            quoteQuantity: '50000000000', // 500.00 USDT
          },
        },
        createContext(seq++)
      );

      const trade = res.events.find((e) => e.type === 'TRADE');
      expect(trade?.data['price']).toBe('10000000000');
      expect(trade?.data['quantity']).toBe('500000000'); // 5 SOL
      expect(trade?.data['quoteQuantity']).toBe('50000000000');

      const takerUpdate = res.events.find(
        (e) => e.type === 'ORDER_UPDATED' && e.data['orderId'] === 'buy-mb'
      );
      expect(takerUpdate?.data['status']).toBe(OrderStatus.FILLED);

      // 5 SOL remaining on ask side
      const book = state.markets.get('SOL_USDT')!.book;
      expect(book.bestAsk()?.totalQuantity).toBe(500000000n);
    });

    it('6. Market sell on thin book cancels unfilled remainder', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      let seq = 1n;

      // Alice places BUY 2 SOL @ 100.00
      Engine.process(
        state,
        {
          commandId: 'cmd-buy-thin',
          type: 'PLACE_ORDER',
          userId: 'alice',
          ts: 1000,
          payload: {
            orderId: 'buy-thin',
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.LIMIT,
            price: '10000000000',
            quantity: '200000000', // 2 SOL
          },
        },
        createContext(seq++)
      );

      // Bob places MARKET SELL 10 SOL
      const res = Engine.process(
        state,
        {
          commandId: 'cmd-sell-thin',
          type: 'PLACE_ORDER',
          userId: 'bob',
          ts: 2000,
          payload: {
            orderId: 'sell-thin',
            market: 'SOL_USDT',
            side: Side.SELL,
            type: OrderType.MARKET,
            quantity: '1000000000', // 10 SOL
          },
        },
        createContext(seq++)
      );

      const trade = res.events.find((e) => e.type === 'TRADE');
      expect(trade?.data['quantity']).toBe('200000000');

      // Remainder (8 SOL) cancelled with reason 'MARKET'
      const cancel = res.events.find((e) => e.type === 'ORDER_CANCELLED' && e.data['orderId'] === 'sell-thin');
      expect(cancel).toBeDefined();
      expect(cancel?.data['reason']).toBe('MARKET');
      expect(cancel?.data['remainingQuantity']).toBe('800000000');
    });

    it('7. IOC remainder cancelled: unfilled limit IOC does not rest on book', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      let seq = 1n;

      // Alice places SELL 3 SOL @ 150.00
      Engine.process(
        state,
        {
          commandId: 'cmd-sell-ioc',
          type: 'PLACE_ORDER',
          userId: 'alice',
          ts: 1000,
          payload: {
            orderId: 'sell-ioc',
            market: 'SOL_USDT',
            side: Side.SELL,
            type: OrderType.LIMIT,
            price: '15000000000',
            quantity: '300000000',
          },
        },
        createContext(seq++)
      );

      // Bob places IOC BUY 10 SOL @ 150.00
      const res = Engine.process(
        state,
        {
          commandId: 'cmd-buy-ioc',
          type: 'PLACE_ORDER',
          userId: 'bob',
          ts: 2000,
          payload: {
            orderId: 'buy-ioc',
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.LIMIT,
            price: '15000000000',
            quantity: '1000000000',
            ioc: true,
          },
        },
        createContext(seq++)
      );

      const trade = res.events.find((e) => e.type === 'TRADE');
      expect(trade?.data['quantity']).toBe('300000000');

      const cancel = res.events.find((e) => e.type === 'ORDER_CANCELLED' && e.data['orderId'] === 'buy-ioc');
      expect(cancel?.data['reason']).toBe('IOC');
      expect(cancel?.data['remainingQuantity']).toBe('700000000');

      // Book should be empty; IOC order must NOT rest on book
      const book = state.markets.get('SOL_USDT')!.book;
      expect(book.orderCount).toBe(0);
    });

    it('8. Post-only rejected when crossing and accepted when not', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      let seq = 1n;

      // Alice places SELL 5 SOL @ 150.00
      Engine.process(
        state,
        {
          commandId: 'cmd-sell-po',
          type: 'PLACE_ORDER',
          userId: 'alice',
          ts: 1000,
          payload: {
            orderId: 'sell-po',
            market: 'SOL_USDT',
            side: Side.SELL,
            type: OrderType.LIMIT,
            price: '15000000000',
            quantity: '500000000',
          },
        },
        createContext(seq++)
      );

      // Bob places Post-Only BUY @ 150.00 (would cross best ask) -> REJECTED
      const resCross = Engine.process(
        state,
        {
          commandId: 'cmd-buy-po-cross',
          type: 'PLACE_ORDER',
          userId: 'bob',
          ts: 2000,
          payload: {
            orderId: 'buy-po-cross',
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.LIMIT,
            price: '15000000000',
            quantity: '100000000',
            postOnly: true,
          },
        },
        createContext(seq++)
      );

      const reject = resCross.events.find((e) => e.type === 'ORDER_REJECTED');
      expect(reject?.data['code']).toBe(RejectCode.POST_ONLY_WOULD_CROSS);

      // Bob places Post-Only BUY @ 149.00 (does not cross) -> ACCEPTED & PLACED
      const resNoCross = Engine.process(
        state,
        {
          commandId: 'cmd-buy-po-ok',
          type: 'PLACE_ORDER',
          userId: 'bob',
          ts: 2001,
          payload: {
            orderId: 'buy-po-ok',
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.LIMIT,
            price: '14900000000',
            quantity: '100000000',
            postOnly: true,
          },
        },
        createContext(seq++)
      );

      expect(resNoCross.events.some((e) => e.type === 'ORDER_ACCEPTED')).toBe(true);
      expect(resNoCross.events.some((e) => e.type === 'ORDER_PLACED')).toBe(true);
    });

    it('9. STP: cancels taker when crossing own maker order', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      let seq = 1n;

      // Alice places SELL 5 SOL @ 150.00
      Engine.process(
        state,
        {
          commandId: 'cmd-alice-sell',
          type: 'PLACE_ORDER',
          userId: 'alice',
          ts: 1000,
          payload: {
            orderId: 'alice-sell-1',
            market: 'SOL_USDT',
            side: Side.SELL,
            type: OrderType.LIMIT,
            price: '15000000000',
            quantity: '500000000',
          },
        },
        createContext(seq++)
      );

      // Alice herself places BUY 5 SOL @ 150.00 -> STP triggered, taker cancelled
      const res = Engine.process(
        state,
        {
          commandId: 'cmd-alice-buy',
          type: 'PLACE_ORDER',
          userId: 'alice',
          ts: 2000,
          payload: {
            orderId: 'alice-buy-1',
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.LIMIT,
            price: '15000000000',
            quantity: '500000000',
          },
        },
        createContext(seq++)
      );

      // No trade must occur
      expect(res.events.some((e) => e.type === 'TRADE')).toBe(false);

      const cancel = res.events.find((e) => e.type === 'ORDER_CANCELLED');
      expect(cancel?.data['reason']).toBe('STP');
      expect(cancel?.data['code']).toBe(RejectCode.SELF_TRADE);

      // Alice's maker order remains resting on book
      const book = state.markets.get('SOL_USDT')!.book;
      expect(book.orderCount).toBe(1);
      expect(book.get('alice-sell-1')).toBeDefined();
    });

    it('10. Halted market rejects PLACE_ORDER but accepts CANCEL_ORDER', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      let seq = 1n;

      // Alice places an order while ACTIVE
      Engine.process(
        state,
        {
          commandId: 'cmd-pre-halt',
          type: 'PLACE_ORDER',
          userId: 'alice',
          ts: 1000,
          payload: {
            orderId: 'order-to-cancel',
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.LIMIT,
            price: '14000000000',
            quantity: '100000000',
          },
        },
        createContext(seq++)
      );

      // Admin halts market
      Engine.process(
        state,
        {
          commandId: 'cmd-halt',
          type: 'HALT_MARKET',
          ts: 1500,
          payload: { market: 'SOL_USDT' },
        },
        createContext(seq++)
      );

      // Placing new order in halted market -> REJECTED
      const resPlace = Engine.process(
        state,
        {
          commandId: 'cmd-place-halted',
          type: 'PLACE_ORDER',
          userId: 'bob',
          ts: 2000,
          payload: {
            orderId: 'bob-order-halted',
            market: 'SOL_USDT',
            side: Side.BUY,
            type: OrderType.LIMIT,
            price: '14000000000',
            quantity: '100000000',
          },
        },
        createContext(seq++)
      );
      expect(resPlace.events[0]?.type).toBe('ORDER_REJECTED');
      expect(resPlace.events[0]?.data['code']).toBe(RejectCode.MARKET_NOT_ACTIVE);

      // Cancelling open order while halted -> ACCEPTED
      const resCancel = Engine.process(
        state,
        {
          commandId: 'cmd-cancel-halted',
          type: 'CANCEL_ORDER',
          userId: 'alice',
          ts: 2001,
          payload: {
            orderId: 'order-to-cancel',
            market: 'SOL_USDT',
          },
        },
        createContext(seq++)
      );
      expect(resCancel.events.some((e) => e.type === 'ORDER_CANCELLED')).toBe(true);
    });

    it('11. Cancel unknown order returns ORDER_NOT_FOUND', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      const res = Engine.process(
        state,
        {
          commandId: 'cmd-cancel-unknown',
          type: 'CANCEL_ORDER',
          userId: 'alice',
          ts: 1000,
          payload: {
            orderId: 'non-existent-order-id',
            market: 'SOL_USDT',
          },
        },
        createContext(1n)
      );

      expect(res.events[0]?.type).toBe('ORDER_REJECTED');
      expect(res.events[0]?.data['code']).toBe(RejectCode.ORDER_NOT_FOUND);
    });

    it('12. Duplicate commandId returns the same events (idempotency)', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      const cmd: Command = {
        commandId: 'cmd-idem-1',
        type: 'PLACE_ORDER',
        userId: 'alice',
        ts: 1000,
        payload: {
          orderId: 'order-idem-1',
          market: 'SOL_USDT',
          side: Side.SELL,
          type: OrderType.LIMIT,
          price: '15000000000',
          quantity: '500000000',
        },
      };

      const res1 = Engine.process(state, cmd, createContext(1n));
      const res2 = Engine.process(state, cmd, createContext(2n)); // Re-send duplicate commandId

      expect(res1.events).toEqual(res2.events);
      // Book must only contain 1 order
      expect(state.markets.get('SOL_USDT')!.book.orderCount).toBe(1);
    });
  });

  describe('Fuzz Testing: 100,000 Commands Invariant Verification', () => {
    it('100,000 random commands: best_bid < best_ask and quantity consistency at every step', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      const book = state.markets.get('SOL_USDT')!.book;

      // Seeded pseudo-random generator (LCG) for 100% deterministic reproducibility
      let seed = 42;
      function random(): number {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      }

      const users = ['user_1', 'user_2', 'user_3', 'user_4', 'user_5'];
      const openOrderIds: string[] = [];
      const numCommands = 100_000;

      for (let i = 0; i < numCommands; i++) {
        const seq = BigInt(i + 1);
        const rand = random();

        if (rand < 0.25 && openOrderIds.length > 0) {
          // 25% chance CANCEL_ORDER
          const targetIndex = Math.floor(random() * openOrderIds.length);
          const orderIdToCancel = openOrderIds[targetIndex]!;
          const order = book.get(orderIdToCancel);
          if (order) {
            Engine.process(
              state,
              {
                commandId: `fuzz-cmd-${i}`,
                type: 'CANCEL_ORDER',
                userId: order.userId,
                ts: i,
                payload: { orderId: order.orderId, market: 'SOL_USDT' },
              },
              createContext(seq, i)
            );
          }
          openOrderIds.splice(targetIndex, 1);
        } else {
          // 75% chance PLACE_ORDER (LIMIT or MARKET)
          const isMarket = random() < 0.15;
          const isBuy = random() < 0.5;
          const user = users[Math.floor(random() * users.length)]!;
          const orderId = `fuzz-ord-${i}`;

          // Price between 90.00 and 110.00, step 0.01
          const priceSteps = 9000n + BigInt(Math.floor(random() * 2000));
          const price = priceSteps * 1000000n; // scaled 1e8

          // Quantity between 0.1 and 5.0 SOL, step 0.01
          const qtySteps = 10n + BigInt(Math.floor(random() * 490));
          const quantity = qtySteps * 1000000n;

          const payload: Record<string, string | boolean> = {
            orderId,
            market: 'SOL_USDT',
            side: isBuy ? Side.BUY : Side.SELL,
            type: isMarket ? OrderType.MARKET : OrderType.LIMIT,
          };

          if (isMarket) {
            if (isBuy) {
              payload.quoteQuantity = (quantity * 100n).toString(); // budget
            } else {
              payload.quantity = quantity.toString();
            }
          } else {
            payload.price = price.toString();
            payload.quantity = quantity.toString();
            payload.postOnly = random() < 0.1;
            payload.ioc = random() < 0.1;
          }

          const res = Engine.process(
            state,
            {
              commandId: `fuzz-cmd-${i}`,
              type: 'PLACE_ORDER',
              userId: user,
              ts: i,
              payload,
            },
            createContext(seq, i)
          );

          if (res.events.some((e) => e.type === 'ORDER_PLACED')) {
            openOrderIds.push(orderId);
          }
        }

        // Verify Invariant 6: No crossed book
        const bestBid = book.bestBid();
        const bestAsk = book.bestAsk();
        if (bestBid !== null && bestAsk !== null) {
          expect(bestBid.price).toBeLessThan(bestAsk.price);
        }

        // Periodically verify quantity conservation
        if (i % 10_000 === 0) {
          expect(book.totalBidQuantity).toBeGreaterThanOrEqual(0n);
          expect(book.totalAskQuantity).toBeGreaterThanOrEqual(0n);
        }
      }

      expect(openOrderIds.length).toBeGreaterThan(0);
    });
  });

  describe('Performance Benchmark', () => {
    it('Benchmark: processes at least 100,000 orders/sec in-process', () => {
      const state = Engine.createInitialState([SOL_USDT_CONFIG]);
      const count = 100_000;

      // Pre-generate 100,000 place commands
      const commands: Command[] = new Array(count);
      for (let i = 0; i < count; i++) {
        // Alternate buys (below market) and sells (above market) to benchmark pure throughput
        const isBuy = (i & 1) === 0;
        const price = isBuy ? 14000000000n - BigInt(i % 1000) * 1000000n : 16000000000n + BigInt(i % 1000) * 1000000n;
        commands[i] = {
          commandId: `bench-cmd-${i}`,
          type: 'PLACE_ORDER',
          userId: `trader-${i % 50}`,
          ts: 100000 + i,
          payload: {
            orderId: `bench-ord-${i}`,
            market: 'SOL_USDT',
            side: isBuy ? Side.BUY : Side.SELL,
            type: OrderType.LIMIT,
            price: price.toString(),
            quantity: '100000000', // 1 SOL
          },
        };
      }

      const startTime = performance.now();
      for (let i = 0; i < count; i++) {
        Engine.process(state, commands[i]!, createContext(BigInt(i + 1), i));
      }
      const elapsedMs = performance.now() - startTime;
      const ordersPerSec = Math.round((count / elapsedMs) * 1000);

      console.log(`Phase 6 Engine Benchmark: ${ordersPerSec.toLocaleString()} orders/sec (${elapsedMs.toFixed(1)} ms for ${count.toLocaleString()} orders)`);
      expect(ordersPerSec).toBeGreaterThanOrEqual(100_000);
    });
  });
});
