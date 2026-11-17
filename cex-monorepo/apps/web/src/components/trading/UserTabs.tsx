'use client';

import React, { useState, useEffect } from 'react';
import { useOrders } from '../../stores/useOrders';
import { useBalances } from '../../stores/useBalances';
import { useAuth } from '../../stores/useAuth';
import { api, type OrderDto } from '../../lib/api';
import { wsClient, type WsServerMessage } from '../../lib/ws';
import { formatBalance, formatPrice, formatQty } from '../../lib/format';
import { Side, OrderStatus, OrderType } from '@cex/types';

interface UserTabsProps {
  marketSymbol: string;
}

type TabType = 'open' | 'history' | 'trades' | 'balances';

export function UserTabs({ marketSymbol }: UserTabsProps) {
  const { isAuthenticated, user } = useAuth();
  const {
    openOrders,
    orderHistory,
    trades: userTrades,
    setOpenOrders,
    setHistory,
    setTrades,
    updateOrder,
    removeOpenOrder,
    addOpenOrder,
  } = useOrders();

  const { balances, setBalances, updateBalance } = useBalances();

  const [activeTab, setActiveTab] = useState<TabType>('open');
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  // Load user data on mount / auth change
  useEffect(() => {
    if (!isAuthenticated) return;

    // 1. Load open orders
    api.orders
      .getOpen(marketSymbol)
      .then((res) => {
        if (res.orders) setOpenOrders(res.orders);
      })
      .catch(() => {});

    // 2. Load order history
    api.orders
      .getHistory(marketSymbol, undefined, 30)
      .then((res) => {
        if (res.orders) setHistory(res.orders);
      })
      .catch(() => {});

    // 3. Load user trades
    api.orders
      .getMyTrades(marketSymbol, undefined, 30)
      .then((res) => {
        if (res.trades) setTrades(res.trades);
      })
      .catch(() => {});

    // 4. Load balances
    api.wallet
      .getBalances()
      .then((res) => {
        if (res.balances) setBalances(res.balances);
      })
      .catch(() => {});

    // 5. Subscribe to private user stream
    const handleUserWs = (msg: WsServerMessage) => {
      if (msg.type === 'USER_EVENT') {
        const d = (msg.data && typeof msg.data === 'object' ? msg.data : {}) as Record<string, unknown>;
        if (msg.event === 'ORDER_PLACED' || msg.event === 'ORDER_UPDATED' || d.e === 'orderUpdate') {
          const raw = (d.data && typeof d.data === 'object' ? d.data : d) as Record<string, unknown>;
          const orderDto: OrderDto = {
            orderId: String(raw.orderId || ''),
            clientOrderId: raw.clientOrderId ? String(raw.clientOrderId) : undefined,
            userId: String(raw.userId || user?.id || ''),
            market: String(raw.market || ''),
            side: (raw.side || Side.BUY) as Side,
            type: (raw.type || OrderType.LIMIT) as OrderType,
            price: raw.price ? String(raw.price) : undefined,
            quantity: String(raw.quantity || '0'),
            quoteQuantity: raw.quoteQuantity ? String(raw.quoteQuantity) : undefined,
            filledQuantity: String(raw.filledQuantity || '0'),
            avgPrice: raw.avgPrice ? String(raw.avgPrice) : undefined,
            status: (raw.status || OrderStatus.OPEN) as OrderStatus,
            createdAt: typeof raw.ts === 'number' || typeof raw.ts === 'string' ? raw.ts : Date.now(),
          };

          if (
            orderDto.status === OrderStatus.FILLED ||
            orderDto.status === OrderStatus.CANCELLED ||
            orderDto.status === OrderStatus.REJECTED
          ) {
            updateOrder(orderDto);
          } else {
            addOpenOrder(orderDto);
          }
        } else if (msg.event === 'ORDER_CANCELLED') {
          const raw = (d.data && typeof d.data === 'object' ? d.data : d) as Record<string, unknown>;
          if (raw.orderId) {
            removeOpenOrder(String(raw.orderId));
          }
        } else if (msg.event === 'BALANCE_UPDATED' || d.e === 'balanceUpdate') {
          const raw = (d.data && typeof d.data === 'object' ? d.data : d) as Record<string, unknown>;
          if (raw.asset) {
            updateBalance(String(raw.asset), String(raw.available || '0'), String(raw.locked || '0'));
          }
        }
      }
    };

    wsClient.subscribe('user', handleUserWs);

    return () => {
      wsClient.unsubscribe('user', handleUserWs);
    };
  }, [isAuthenticated, marketSymbol, setOpenOrders, setHistory, setTrades, setBalances, updateBalance, addOpenOrder, removeOpenOrder, updateOrder, user?.id]);

  const handleCancelOrder = async (orderId: string) => {
    setCancellingId(orderId);
    try {
      await api.orders.cancel(orderId);
      removeOpenOrder(orderId);
      // Refresh balances after cancel
      api.wallet.getBalances().then((res) => {
        if (res.balances) setBalances(res.balances);
      }).catch(() => {});
    } catch {
      // Ignored
    } finally {
      setCancellingId(null);
    }
  };

  const formatTime = (ts: number | string) => {
    try {
      const d = new Date(typeof ts === 'number' ? ts : ts);
      return d.toLocaleString();
    } catch {
      return String(ts);
    }
  };

  // Filter open orders for active market
  const marketOpenOrders = openOrders.filter(
    (o) => o.market === marketSymbol || !o.market
  );

  return (
    <section className="border-t border-line bg-bg select-none flex-1 min-h-[260px]">
      {/* Tabs Bar */}
      <div className="flex gap-6 px-5 border-b border-line overflow-x-auto text-sm">
        <button
          type="button"
          onClick={() => setActiveTab('open')}
          className={`py-3 font-medium transition-colors border-b-2 -mb-[1px] whitespace-nowrap ${
            activeTab === 'open'
              ? 'border-accent text-text font-semibold'
              : 'border-transparent text-muted hover:text-text'
          }`}
        >
          Open Orders ({marketOpenOrders.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('history')}
          className={`py-3 font-medium transition-colors border-b-2 -mb-[1px] whitespace-nowrap ${
            activeTab === 'history'
              ? 'border-accent text-text font-semibold'
              : 'border-transparent text-muted hover:text-text'
          }`}
        >
          Order History
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('trades')}
          className={`py-3 font-medium transition-colors border-b-2 -mb-[1px] whitespace-nowrap ${
            activeTab === 'trades'
              ? 'border-accent text-text font-semibold'
              : 'border-transparent text-muted hover:text-text'
          }`}
        >
          Trade History
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('balances')}
          className={`py-3 font-medium transition-colors border-b-2 -mb-[1px] whitespace-nowrap ${
            activeTab === 'balances'
              ? 'border-accent text-text font-semibold'
              : 'border-transparent text-muted hover:text-text'
          }`}
        >
          Balances
        </button>
      </div>

      {!isAuthenticated ? (
        <div className="p-12 text-center text-muted text-sm font-sans">
          Please sign in to view your orders and balances.
        </div>
      ) : (
        <div className="overflow-x-auto">
          {/* TAB 1: OPEN ORDERS */}
          {activeTab === 'open' && (
            <div className="min-w-[760px]">
              <div className="grid grid-cols-7 gap-4 px-5 py-2.5 text-xs text-muted font-medium border-b border-line/40">
                <span>Time</span>
                <span>Side</span>
                <span>Type</span>
                <span className="text-right">Price</span>
                <span>Filled</span>
                <span className="text-right">Amount</span>
                <span className="text-right">Action</span>
              </div>

              {marketOpenOrders.length > 0 ? (
                marketOpenOrders.map((o) => {
                  const isBuy = o.side === Side.BUY;
                  const filledBig = BigInt(o.filledQuantity || '0');
                  const totalBig = BigInt(o.quantity || '1');
                  const pct = totalBig > 0n ? Math.min(100, Number((filledBig * 100n) / totalBig)) : 0;

                  return (
                    <div
                      key={o.orderId}
                      className="grid grid-cols-7 gap-4 px-5 py-3 items-center text-xs font-mono border-b border-line/30 hover:bg-surface2/30 transition-colors"
                    >
                      <span className="text-muted">{formatTime(o.createdAt)}</span>
                      <span className={isBuy ? 'text-up font-semibold' : 'text-down font-semibold'}>
                        {o.side}
                      </span>
                      <span className="text-text2">{o.type}</span>
                      <span className="text-right text-text">
                        {o.price ? formatPrice(o.price, 2) : 'Market'}
                      </span>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-line overflow-hidden">
                          <div
                            className="h-full bg-accent transition-all duration-300"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-muted text-[11px] w-8 text-right">{pct}%</span>
                      </div>
                      <span className="text-right text-text">{formatQty(o.quantity, 2)}</span>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          disabled={cancellingId === o.orderId}
                          onClick={() => handleCancelOrder(o.orderId)}
                          className="px-2.5 py-1 border border-line rounded text-xs text-muted hover:text-text hover:border-text transition-colors disabled:opacity-50"
                        >
                          {cancellingId === o.orderId ? '...' : 'Cancel'}
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="p-8 text-center text-muted text-xs font-mono">
                  No open orders for this market
                </div>
              )}
            </div>
          )}

          {/* TAB 2: ORDER HISTORY */}
          {activeTab === 'history' && (
            <div className="min-w-[760px]">
              <div className="grid grid-cols-6 gap-4 px-5 py-2.5 text-xs text-muted font-medium border-b border-line/40">
                <span>Time</span>
                <span>Side</span>
                <span>Type</span>
                <span className="text-right">Price</span>
                <span className="text-right">Filled / Amount</span>
                <span className="text-right">Status</span>
              </div>

              {orderHistory.length > 0 ? (
                orderHistory.map((o) => (
                  <div
                    key={o.orderId}
                    className="grid grid-cols-6 gap-4 px-5 py-3 items-center text-xs font-mono border-b border-line/30 hover:bg-surface2/30 transition-colors"
                  >
                    <span className="text-muted">{formatTime(o.createdAt)}</span>
                    <span
                      className={
                        o.side === Side.BUY ? 'text-up font-semibold' : 'text-down font-semibold'
                      }
                    >
                      {o.side}
                    </span>
                    <span className="text-text2">{o.type}</span>
                    <span className="text-right text-text">
                      {o.price ? formatPrice(o.price, 2) : 'Market'}
                    </span>
                    <span className="text-right text-text">
                      {formatQty(o.filledQuantity, 2)} / {formatQty(o.quantity, 2)}
                    </span>
                    <span className="text-right font-medium">
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] ${
                          o.status === OrderStatus.FILLED
                            ? 'bg-up-soft text-up'
                            : o.status === OrderStatus.CANCELLED
                            ? 'bg-surface2 text-muted'
                            : 'bg-down-soft text-down'
                        }`}
                      >
                        {o.status}
                      </span>
                    </span>
                  </div>
                ))
              ) : (
                <div className="p-8 text-center text-muted text-xs font-mono">
                  No past orders found
                </div>
              )}
            </div>
          )}

          {/* TAB 3: TRADE HISTORY */}
          {activeTab === 'trades' && (
            <div className="min-w-[650px]">
              <div className="grid grid-cols-5 gap-4 px-5 py-2.5 text-xs text-muted font-medium border-b border-line/40">
                <span>Time</span>
                <span>Side</span>
                <span className="text-right">Price</span>
                <span className="text-right">Quantity</span>
                <span className="text-right">Engine Seq</span>
              </div>

              {userTrades.length > 0 ? (
                userTrades.map((t) => (
                  <div
                    key={t.id}
                    className="grid grid-cols-5 gap-4 px-5 py-3 items-center text-xs font-mono border-b border-line/30 hover:bg-surface2/30 transition-colors"
                  >
                    <span className="text-muted">{formatTime(t.createdAt)}</span>
                    <span
                      className={
                        t.takerSide === Side.BUY ? 'text-up font-semibold' : 'text-down font-semibold'
                      }
                    >
                      {t.takerSide}
                    </span>
                    <span className="text-right text-text">{formatPrice(t.price, 2)}</span>
                    <span className="text-right text-text">{formatQty(t.quantity, 4)}</span>
                    <span className="text-right text-muted">{t.engineSeq}</span>
                  </div>
                ))
              ) : (
                <div className="p-8 text-center text-muted text-xs font-mono">
                  No executed trades yet
                </div>
              )}
            </div>
          )}

          {/* TAB 4: BALANCES */}
          {activeTab === 'balances' && (
            <div className="min-w-[500px]">
              <div className="grid grid-cols-4 gap-4 px-5 py-2.5 text-xs text-muted font-medium border-b border-line/40">
                <span>Asset</span>
                <span className="text-right">Available</span>
                <span className="text-right">In Orders (Locked)</span>
                <span className="text-right">Total Balance</span>
              </div>

              {Object.values(balances).length > 0 ? (
                Object.values(balances).map((b) => {
                  const avail = BigInt(b.available || '0');
                  const locked = BigInt(b.locked || '0');
                  const total = avail + locked;

                  return (
                    <div
                      key={b.asset}
                      className="grid grid-cols-4 gap-4 px-5 py-3 items-center text-xs font-mono border-b border-line/30 hover:bg-surface2/30 transition-colors"
                    >
                      <span className="font-bold text-text">{b.asset}</span>
                      <span className="text-right text-text">{formatBalance(avail, 4)}</span>
                      <span className="text-right text-muted">{formatBalance(locked, 4)}</span>
                      <span className="text-right font-medium text-text">{formatBalance(total, 4)}</span>
                    </div>
                  );
                })
              ) : (
                <div className="p-8 text-center text-muted text-xs font-mono">
                  No balances recorded
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
