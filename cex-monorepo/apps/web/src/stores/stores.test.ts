import { describe, it, expect, beforeEach } from 'vitest';
import { Side, OrderType, OrderStatus, MarketStatus } from '@cex/types';
import type { OrderDto } from '../lib/api';
import { useMarket } from './useMarket';
import { useBook } from './useBook';
import { useOrders } from './useOrders';
import { useBalances } from './useBalances';
import { useTheme } from './useTheme';

describe('apps/web/src/stores', () => {
  beforeEach(() => {
    useBook.getState().clear();
    useOrders.setState({ openOrders: [], orderHistory: [], trades: [] });
    useBalances.setState({ balances: {} });
  });

  it('useTheme: updates theme and persists preference', () => {
    const { setTheme } = useTheme.getState();
    setTheme('night');
    expect(useTheme.getState().theme).toBe('night');
    setTheme('paper');
    expect(useTheme.getState().theme).toBe('paper');
  });

  it('useMarket: manages active market and ticker lookup', () => {
    const { setMarkets, setActiveSymbol, setTicker } = useMarket.getState();
    setMarkets([
      {
        symbol: 'SOL_USDT',
        baseAsset: 'SOL',
        quoteAsset: 'USDT',
        tickSize: '1000000',
        lotSize: '1000000',
        minNotional: '100000000',
        makerFeeBps: 8,
        takerFeeBps: 10,
        status: MarketStatus.ACTIVE,
      },
      {
        symbol: 'BTC_USDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        tickSize: '1000000',
        lotSize: '100000',
        minNotional: '100000000',
        makerFeeBps: 8,
        takerFeeBps: 10,
        status: MarketStatus.ACTIVE,
      },
    ]);

    expect(useMarket.getState().activeSymbol).toBe('SOL_USDT');
    setActiveSymbol('BTC_USDT');
    expect(useMarket.getState().activeSymbol).toBe('BTC_USDT');
    expect(useMarket.getState().activeMarket?.baseAsset).toBe('BTC');

    setTicker({
      market: 'BTC_USDT',
      lastPrice: '8800000000000',
      priceChange: '120000000000',
      priceChangePercent: 1.38,
      high: '8900000000000',
      low: '8700000000000',
      baseVolume: '100000000',
      quoteVolume: '8800000000000',
      tradesCount: 500,
    });
    expect(useMarket.getState().ticker?.lastPrice).toBe('8800000000000');
  });

  it('useBook: applies snapshots and deltas with spread computation', () => {
    const { setSnapshot, applyDelta } = useBook.getState();

    // 142.50 = 14250000000n, 142.60 = 14260000000n
    setSnapshot(
      [['14250000000', '1000000000']], // Best Bid: 142.50 (10 SOL)
      [['14260000000', '500000000']],  // Best Ask: 142.60 (5 SOL)
      '100'
    );

    let state = useBook.getState();
    expect(state.bids.length).toBe(1);
    expect(state.asks.length).toBe(1);
    expect(state.spread).toBe('0.10');

    // Apply delta: new bid @ 142.55 (5 SOL)
    applyDelta([['14255000000', '500000000']], '101');
    state = useBook.getState();
    expect(state.bids[0]?.[0]).toBe('14255000000');
    expect(state.spread).toBe('0.05');

    // Apply delta: remove ask @ 142.60 (qty = "0")
    applyDelta([['14260000000', '0']], '102');
    state = useBook.getState();
    expect(state.asks.length).toBe(0);
  });

  it('useBalances: updates and reads asset available and locked balances', () => {
    const { setBalances, updateBalance, getBalance } = useBalances.getState();
    setBalances([
      { asset: 'USDT', available: '50000000000', locked: '0' },
      { asset: 'SOL', available: '1000000000', locked: '200000000' },
    ]);

    expect(getBalance('USDT').available).toBe('50000000000');
    expect(getBalance('SOL').locked).toBe('200000000');
    expect(getBalance('UNKNOWN').available).toBe('0');

    updateBalance('USDT', '40000000000', '10000000000');
    expect(getBalance('USDT').available).toBe('40000000000');
    expect(getBalance('USDT').locked).toBe('10000000000');
  });

  it('useOrders: manages open orders, terminal status transitions, and history', () => {
    const { addOpenOrder, updateOrder, addTrade } = useOrders.getState();

    const order1: OrderDto = {
      orderId: 'o-1',
      market: 'SOL_USDT',
      userId: 'u-1',
      side: Side.BUY,
      type: OrderType.LIMIT,
      price: '14250000000',
      quantity: '100000000',
      filledQuantity: '0',
      status: OrderStatus.OPEN,
      createdAt: Date.now(),
    };

    addOpenOrder(order1);
    expect(useOrders.getState().openOrders.length).toBe(1);

    // Update order to partially filled
    updateOrder({ ...order1, filledQuantity: '50000000', status: OrderStatus.PARTIALLY_FILLED });
    expect(useOrders.getState().openOrders[0]?.filledQuantity).toBe('50000000');
    expect(useOrders.getState().orderHistory.length).toBe(0);

    // Update order to FILLED -> moves to history
    updateOrder({ ...order1, filledQuantity: '100000000', status: OrderStatus.FILLED });
    expect(useOrders.getState().openOrders.length).toBe(0);
    expect(useOrders.getState().orderHistory.length).toBe(1);

    // Trades
    addTrade({
      id: 't-1',
      price: '14250000000',
      quantity: '50000000',
      takerSide: Side.BUY,
      createdAt: new Date().toISOString(),
      engineSeq: '500',
    });
    expect(useOrders.getState().trades.length).toBe(1);
  });
});
