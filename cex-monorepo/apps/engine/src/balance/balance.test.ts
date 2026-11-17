import { describe, expect, it } from 'vitest';
import {
  Command,
  Engine,
  EngineContext,
  MarketConfig,
  MarketStatus,
  OrderStatus,
  OrderType,
  RejectCode,
  Side,
} from '../index.js';

const SOL_USDT: MarketConfig = {
  symbol: 'SOL_USDT',
  baseAsset: 'SOL',
  quoteAsset: 'USDT',
  tickSize: '1000000', // 0.01 (1e8)
  lotSize: '1000000', // 0.01 (1e8)
  minNotional: '500000000', // 5.00 USDT (1e8)
  makerFeeBps: 8, // 0.08%
  takerFeeBps: 10, // 0.10%
  status: MarketStatus.ACTIVE,
};

function ctx(seq: bigint, now = 1700000000000): EngineContext {
  return { engineSeq: seq, now };
}

describe('Balances, Locking, Fees, and Settlement (Phase 7)', () => {
  it('1. Replicates the worked example in Section 5.3 exactly to the unit', () => {
    const state = Engine.createInitialState([SOL_USDT]);
    let seq = 1n;

    // Alice deposits 100 SOL (100 * 1e8 = 10_000_000_000n)
    Engine.process(
      state,
      {
        commandId: 'dep-alice',
        type: 'DEPOSIT',
        userId: 'alice',
        ts: 1000,
        payload: { asset: 'SOL', amount: '10000000000' },
      },
      ctx(seq++)
    );

    // Bob deposits 5,000 USDT (5000 * 1e8 = 500_000_000_000n)
    Engine.process(
      state,
      {
        commandId: 'dep-bob',
        type: 'DEPOSIT',
        userId: 'bob',
        ts: 1001,
        payload: { asset: 'USDT', amount: '500000000000' },
      },
      ctx(seq++)
    );

    // Step 1: Alice places LIMIT SELL 10 SOL @ 142.50
    // Price = 14250000000n, Qty = 1000000000n. Locks 10 SOL.
    const resSell = Engine.process(
      state,
      {
        commandId: 'order-alice-sell',
        type: 'PLACE_ORDER',
        userId: 'alice',
        ts: 1002,
        payload: {
          orderId: 'alice-s1',
          market: 'SOL_USDT',
          side: Side.SELL,
          type: OrderType.LIMIT,
          price: '14250000000',
          quantity: '1000000000',
        },
      },
      ctx(seq++)
    );
    expect(resSell.events.some((e) => e.type === 'ORDER_PLACED')).toBe(true);

    const aliceBalStep1 = state.balanceManager.get('alice', 'SOL');
    expect(aliceBalStep1.available).toBe(9000000000n); // 90 SOL available
    expect(aliceBalStep1.locked).toBe(1000000000n); // 10 SOL locked

    // Step 2: Bob places LIMIT BUY 10 SOL @ 143.00
    // Price = 14300000000n, Qty = 1000000000n. Locks 10 x 143.00 = 1,430.00 USDT (143000000000n)
    const resBuy = Engine.process(
      state,
      {
        commandId: 'order-bob-buy',
        type: 'PLACE_ORDER',
        userId: 'bob',
        ts: 1003,
        payload: {
          orderId: 'bob-b1',
          market: 'SOL_USDT',
          side: Side.BUY,
          type: OrderType.LIMIT,
          price: '14300000000',
          quantity: '1000000000',
        },
      },
      ctx(seq++)
    );

    // Step 3: Trade executed at maker price 142.50
    const trade = resBuy.events.find((e) => e.type === 'TRADE');
    expect(trade).toBeDefined();
    expect(trade?.data['price']).toBe('14250000000');
    expect(trade?.data['quantity']).toBe('1000000000');
    expect(trade?.data['quoteQuantity']).toBe('142500000000'); // 1,425.00 USDT

    // Step 4 & 5: Fees
    // Bob (taker) fee: 10 bps on 10 SOL = 0.01 SOL (1000000n)
    expect(trade?.data['takerFee']).toBe('1000000');
    // Alice (maker) fee: 8 bps on 1,425 USDT = 1.14 USDT (114000000n)
    expect(trade?.data['makerFee']).toBe('114000000');

    // Step 6: Bob settlement:
    // Locked USDT -1430; pays 1425; refund 5.00 USDT back to available!
    // Available USDT = 5000 - 1425 = 3,575.00 USDT (357500000000n), Locked USDT = 0n.
    // Receives 10 SOL - 0.01 SOL = 9.99 SOL available (999000000n).
    const bobUsdt = state.balanceManager.get('bob', 'USDT');
    expect(bobUsdt.locked).toBe(0n);
    expect(bobUsdt.available).toBe(357500000000n);

    const bobSol = state.balanceManager.get('bob', 'SOL');
    expect(bobSol.locked).toBe(0n);
    expect(bobSol.available).toBe(999000000n); // 9.99 SOL

    // Step 7: Alice settlement:
    // Locked SOL -10 = 0 SOL locked, 90 SOL available.
    // Receives 1425 USDT - 1.14 USDT = 1,423.86 USDT (142386000000n) in available.
    const aliceSol = state.balanceManager.get('alice', 'SOL');
    expect(aliceSol.locked).toBe(0n);
    expect(aliceSol.available).toBe(9000000000n);

    const aliceUsdt = state.balanceManager.get('alice', 'USDT');
    expect(aliceUsdt.locked).toBe(0n);
    expect(aliceUsdt.available).toBe(142386000000n); // 1,423.86 USDT

    // Step 8: Fee account
    // +0.01 SOL (1000000n) and +1.14 USDT (114000000n)
    expect(state.balanceManager.getFee('SOL')).toBe(1000000n);
    expect(state.balanceManager.getFee('USDT')).toBe(114000000n);

    // Conservation check:
    // Total USDT: 3575 (Bob) + 1423.86 (Alice) + 1.14 (Fee) = 5000 USDT!
    expect(bobUsdt.available + aliceUsdt.available + state.balanceManager.getFee('USDT')).toBe(500000000000n);
    // Total SOL: 9.99 (Bob) + 90 (Alice) + 0.01 (Fee) = 100 SOL!
    expect(bobSol.available + aliceSol.available + state.balanceManager.getFee('SOL')).toBe(10000000000n);

    // Verify Invariants
    Engine.checkInvariants(state);
  });

  it('2. Buy at 150 matched at 140 refunds 10 per unit to buyer', () => {
    const state = Engine.createInitialState([SOL_USDT]);
    let seq = 1n;

    // Alice deposits 10 SOL and places LIMIT SELL 10 SOL @ 140.00
    Engine.process(state, { commandId: 'dep-a', type: 'DEPOSIT', userId: 'alice', ts: 1000, payload: { asset: 'SOL', amount: '1000000000' } }, ctx(seq++));
    Engine.process(state, {
      commandId: 'ord-a',
      type: 'PLACE_ORDER',
      userId: 'alice',
      ts: 1001,
      payload: { orderId: 's-140', market: 'SOL_USDT', side: Side.SELL, type: OrderType.LIMIT, price: '14000000000', quantity: '1000000000' },
    }, ctx(seq++));

    // Bob deposits 2000 USDT (2000 * 1e8) and places BUY 10 SOL @ 150.00 (locks 1500 USDT)
    Engine.process(state, { commandId: 'dep-b', type: 'DEPOSIT', userId: 'bob', ts: 1002, payload: { asset: 'USDT', amount: '200000000000' } }, ctx(seq++));
    Engine.process(state, {
      commandId: 'ord-b',
      type: 'PLACE_ORDER',
      userId: 'bob',
      ts: 1003,
      payload: { orderId: 'b-150', market: 'SOL_USDT', side: Side.BUY, type: OrderType.LIMIT, price: '15000000000', quantity: '1000000000' },
    }, ctx(seq++));

    // Trade price is 140.00. Bob locked 1500.00, only pays 1400.00.
    // 100.00 USDT refund (10 per unit x 10 units = 100 USDT) is returned to available!
    const bobUsdt = state.balanceManager.get('bob', 'USDT');
    expect(bobUsdt.available).toBe(60000000000n); // 2000 - 1400 = 600 USDT
    expect(bobUsdt.locked).toBe(0n);

    Engine.checkInvariants(state);
  });

  it('3. Fee rounding up on a tiny trade (exchange-favoring ceil)', () => {
    const TINY_MARKET: MarketConfig = {
      symbol: 'TINY_USD',
      baseAsset: 'TINY',
      quoteAsset: 'USD',
      tickSize: '1',
      lotSize: '1',
      minNotional: '1',
      makerFeeBps: 8,
      takerFeeBps: 10,
      status: MarketStatus.ACTIVE,
    };
    const state = Engine.createInitialState([TINY_MARKET]);
    let seq = 1n;

    // Alice deposits 100 TINY and sells 100 TINY @ 1.00 USD (price 1e8)
    Engine.process(state, { commandId: 'd-a', type: 'DEPOSIT', userId: 'alice', ts: 1000, payload: { asset: 'TINY', amount: '100' } }, ctx(seq++));
    Engine.process(state, { commandId: 'o-a', type: 'PLACE_ORDER', userId: 'alice', ts: 1001, payload: { orderId: 's-tiny', market: 'TINY_USD', side: Side.SELL, type: OrderType.LIMIT, price: '100000000', quantity: '100' } }, ctx(seq++));

    // Bob deposits 100 USD and buys 100 TINY @ 1.00 USD (locks 100 USD)
    Engine.process(state, { commandId: 'd-b', type: 'DEPOSIT', userId: 'bob', ts: 1002, payload: { asset: 'USD', amount: '100' } }, ctx(seq++));
    const res = Engine.process(state, { commandId: 'o-b', type: 'PLACE_ORDER', userId: 'bob', ts: 1003, payload: { orderId: 'b-tiny', market: 'TINY_USD', side: Side.BUY, type: OrderType.LIMIT, price: '100000000', quantity: '100' } }, ctx(seq++));

    const trade = res.events.find((e) => e.type === 'TRADE');
    expect(trade).toBeDefined();
    // Raw taker fee = 100 * 0.0010 = 0.10 -> rounds UP to 1 unit
    expect(trade?.data['takerFee']).toBe('1');
    // Raw maker fee = 100 * 0.0008 = 0.08 -> rounds UP to 1 unit
    expect(trade?.data['makerFee']).toBe('1');

    Engine.checkInvariants(state);
  });

  it('4. Cancel releases remaining lock after partial fill', () => {
    const state = Engine.createInitialState([SOL_USDT]);
    let seq = 1n;

    // Alice deposits 10 SOL and places LIMIT SELL 10 SOL @ 150.00
    Engine.process(state, { commandId: 'd-a', type: 'DEPOSIT', userId: 'alice', ts: 1000, payload: { asset: 'SOL', amount: '1000000000' } }, ctx(seq++));
    Engine.process(state, { commandId: 'o-a', type: 'PLACE_ORDER', userId: 'alice', ts: 1001, payload: { orderId: 's-10', market: 'SOL_USDT', side: Side.SELL, type: OrderType.LIMIT, price: '15000000000', quantity: '1000000000' } }, ctx(seq++));

    // Bob deposits and buys 4 SOL
    Engine.process(state, { commandId: 'd-b', type: 'DEPOSIT', userId: 'bob', ts: 1002, payload: { asset: 'USDT', amount: '100000000000' } }, ctx(seq++));
    Engine.process(state, { commandId: 'o-b', type: 'PLACE_ORDER', userId: 'bob', ts: 1003, payload: { orderId: 'b-4', market: 'SOL_USDT', side: Side.BUY, type: OrderType.LIMIT, price: '15000000000', quantity: '400000000' } }, ctx(seq++));

    // Alice has 4 SOL filled, 6 SOL remaining locked
    const aliceBalMid = state.balanceManager.get('alice', 'SOL');
    expect(aliceBalMid.locked).toBe(600000000n);
    expect(aliceBalMid.available).toBe(0n);

    // Alice cancels order 's-10'
    const resCancel = Engine.process(
      state,
      {
        commandId: 'cancel-a',
        type: 'CANCEL_ORDER',
        userId: 'alice',
        ts: 1004,
        payload: { orderId: 's-10', market: 'SOL_USDT' },
      },
      ctx(seq++)
    );
    expect(resCancel.events.some((e) => e.type === 'ORDER_CANCELLED')).toBe(true);

    // Remaining 6 SOL should be unlocked back to available
    const aliceBalEnd = state.balanceManager.get('alice', 'SOL');
    expect(aliceBalEnd.locked).toBe(0n);
    expect(aliceBalEnd.available).toBe(600000000n); // 6 SOL available

    Engine.checkInvariants(state);
  });

  it('5. Insufficient funds reject when placing order with low balance', () => {
    const state = Engine.createInitialState([SOL_USDT]);
    let seq = 1n;

    // Bob only deposits 10 USDT
    Engine.process(state, { commandId: 'd-b', type: 'DEPOSIT', userId: 'bob', ts: 1000, payload: { asset: 'USDT', amount: '1000000000' } }, ctx(seq++));

    // Bob tries to place order requiring 140 USDT
    const res = Engine.process(
      state,
      {
        commandId: 'o-fail',
        type: 'PLACE_ORDER',
        userId: 'bob',
        ts: 1001,
        payload: {
          orderId: 'b-fail',
          market: 'SOL_USDT',
          side: Side.BUY,
          type: OrderType.LIMIT,
          price: '14000000000',
          quantity: '100000000', // 1 SOL = 140 USDT
        },
      },
      ctx(seq++)
    );

    expect(res.events[0]?.type).toBe('ORDER_REJECTED');
    expect(res.events[0]?.data['code']).toBe(RejectCode.INSUFFICIENT_FUNDS);

    // Balances unchanged
    const bobUsdt = state.balanceManager.get('bob', 'USDT');
    expect(bobUsdt.available).toBe(1000000000n);
    expect(bobUsdt.locked).toBe(0n);

    Engine.checkInvariants(state);
  });

  it('6. Withdrawal lifecycle: request locks funds, reject unlocks, complete debits', () => {
    const state = Engine.createInitialState([SOL_USDT]);
    let seq = 1n;

    // User deposits 1,000 USDT
    Engine.process(state, { commandId: 'd-1', type: 'DEPOSIT', userId: 'user1', ts: 1000, payload: { asset: 'USDT', amount: '100000000000' } }, ctx(seq++));

    // Withdraw request 400 USDT
    const resReq = Engine.process(
      state,
      {
        commandId: 'w-req-1',
        type: 'WITHDRAW_REQUEST',
        userId: 'user1',
        ts: 1001,
        payload: { asset: 'USDT', amount: '40000000000', withdrawalId: 'w-1' },
      },
      ctx(seq++)
    );
    expect(resReq.events[0]?.type).toBe('BALANCE_UPDATED');
    let bal = state.balanceManager.get('user1', 'USDT');
    expect(bal.available).toBe(60000000000n);
    expect(bal.locked).toBe(40000000000n);
    Engine.checkInvariants(state);

    // Admin rejects withdrawal -> unlocked back to available
    const resRej = Engine.process(
      state,
      {
        commandId: 'w-rej-1',
        type: 'WITHDRAW_REJECT',
        ts: 1002,
        payload: { withdrawalId: 'w-1' },
      },
      ctx(seq++)
    );
    expect(resRej.events[0]?.type).toBe('BALANCE_UPDATED');
    bal = state.balanceManager.get('user1', 'USDT');
    expect(bal.available).toBe(100000000000n);
    expect(bal.locked).toBe(0n);
    Engine.checkInvariants(state);

    // Withdraw request 500 USDT and complete
    Engine.process(
      state,
      {
        commandId: 'w-req-2',
        type: 'WITHDRAW_REQUEST',
        userId: 'user1',
        ts: 1003,
        payload: { asset: 'USDT', amount: '50000000000', withdrawalId: 'w-2' },
      },
      ctx(seq++)
    );
    const resComp = Engine.process(
      state,
      {
        commandId: 'w-comp-2',
        type: 'WITHDRAW_COMPLETE',
        ts: 1004,
        payload: { withdrawalId: 'w-2' },
      },
      ctx(seq++)
    );
    expect(resComp.events[0]?.type).toBe('BALANCE_UPDATED');
    bal = state.balanceManager.get('user1', 'USDT');
    expect(bal.available).toBe(50000000000n);
    expect(bal.locked).toBe(0n);
    expect(state.balanceManager.getTotalWithdrawn('USDT')).toBe(50000000000n);

    Engine.checkInvariants(state);
  });

  it('7. Negative balance protection throws if invariant violated', () => {
    const state = Engine.createInitialState([SOL_USDT]);
    expect(() => state.balanceManager.unlock('ghost', 'USDT', 100n)).toThrow();
    expect(() => state.balanceManager.consumeLock('ghost', 'USDT', 100n)).toThrow();
  });

  describe('Fuzz & Conservation: 100,000 Commands Invariant Verification', () => {
    it('100,000 random commands: conservation and lock invariants hold at every step', () => {
      const state = Engine.createInitialState([SOL_USDT]);
      const book = state.markets.get('SOL_USDT')!.book;

      // Seeded PRNG
      let seed = 1337;
      function random(): number {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      }

      const users = ['trader_1', 'trader_2', 'trader_3', 'trader_4', 'trader_5'];

      // Initial funding: 1,000,000 USDT and 10,000 SOL each
      for (const user of users) {
        state.balanceManager.deposit(user, 'USDT', 100000000000000n);
        state.balanceManager.deposit(user, 'SOL', 1000000000000n);
      }

      const openOrderIds: string[] = [];
      const numCommands = 100_000;

      for (let i = 0; i < numCommands; i++) {
        const seq = BigInt(i + 1);
        const rand = random();

        if (rand < 0.20 && openOrderIds.length > 0) {
          // Cancel an existing open order
          const idx = Math.floor(random() * openOrderIds.length);
          const orderId = openOrderIds[idx]!;
          const order = book.get(orderId);
          if (order) {
            Engine.process(
              state,
              {
                commandId: `fuzz-c-${i}`,
                type: 'CANCEL_ORDER',
                userId: order.userId,
                ts: i,
                payload: { orderId: order.orderId, market: 'SOL_USDT' },
              },
              ctx(seq, i)
            );
          }
          openOrderIds.splice(idx, 1);
        } else if (rand < 0.25) {
          // Deposit more funds
          const user = users[Math.floor(random() * users.length)]!;
          const isUsdt = random() < 0.5;
          const asset = isUsdt ? 'USDT' : 'SOL';
          const amount = (100n + BigInt(Math.floor(random() * 500))) * 100000000n;
          Engine.process(
            state,
            {
              commandId: `fuzz-dep-${i}`,
              type: 'DEPOSIT',
              userId: user,
              ts: i,
              payload: { asset, amount: amount.toString() },
            },
            ctx(seq, i)
          );
        } else {
          // Place Order (LIMIT or MARKET)
          const user = users[Math.floor(random() * users.length)]!;
          const isBuy = random() < 0.5;
          const isMarket = random() < 0.15;
          const orderId = `fuzz-o-${i}`;

          // Price between 100.00 and 120.00, tick 0.01
          const price = (10000n + BigInt(Math.floor(random() * 2000))) * 1000000n;
          // Quantity between 0.1 and 3.0 SOL, lot 0.01
          const qty = (10n + BigInt(Math.floor(random() * 290))) * 1000000n;

          const payload: Record<string, string | boolean> = {
            orderId,
            market: 'SOL_USDT',
            side: isBuy ? Side.BUY : Side.SELL,
            type: isMarket ? OrderType.MARKET : OrderType.LIMIT,
          };

          if (isMarket) {
            if (isBuy) {
              payload.quoteQuantity = (qty * 110n).toString();
            } else {
              payload.quantity = qty.toString();
            }
          } else {
            payload.price = price.toString();
            payload.quantity = qty.toString();
            payload.postOnly = random() < 0.1;
            payload.ioc = random() < 0.1;
          }

          const res = Engine.process(
            state,
            {
              commandId: `fuzz-p-${i}`,
              type: 'PLACE_ORDER',
              userId: user,
              ts: i,
              payload,
            },
            ctx(seq, i)
          );

          if (res.events.some((e) => e.type === 'ORDER_PLACED')) {
            openOrderIds.push(orderId);
          }
        }

        // Verify Invariants at every step
        Engine.checkInvariants(state);
      }

      expect(openOrderIds.length).toBeGreaterThan(0);
    });
  });
});
