'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { Navbar } from '../../components/Navbar';
import { AuthGuard } from '../../components/auth/AuthGuard';
import { Button } from '../../components/ui/Button';
import { api, type OrderDto, type TradeDto } from '../../lib/api';
import { formatPrice, formatQty } from '../../lib/format';
import { Download, RefreshCw, ArrowUpRight, ArrowDownLeft, AlertCircle } from 'lucide-react';
import { OrderStatus, Side } from '@cex/types';

export default function OrdersPage() {
  const [activeTab, setActiveTab] = useState<'orders' | 'trades'>('orders');
  const [orders, setOrders] = useState<OrderDto[]>([]);
  const [trades, setTrades] = useState<TradeDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Filters
  const [filterMarket, setFilterMarket] = useState<string>('ALL');
  const [filterSide, setFilterSide] = useState<string>('ALL');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterFrom, setFilterFrom] = useState<string>('');
  const [filterTo, setFilterTo] = useState<string>('');

  // Pagination
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const loadData = async () => {
    try {
      const [ordersRes, tradesRes] = await Promise.all([
        api.orders.getHistory(undefined, undefined, 100).catch(() => ({ orders: [] })),
        api.orders.getMyTrades(undefined, undefined, 100).catch(() => ({ trades: [] })),
      ]);
      setOrders(ordersRes.orders || []);
      setTrades(tradesRes.trades || []);
    } catch (err) {
      console.error('Failed to load orders/trades data:', err);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleRefresh = () => {
    setIsRefreshing(true);
    setStatusMessage(null);
    loadData();
  };

  const handleCancelOrder = async (orderId: string) => {
    try {
      setCancellingId(orderId);
      setStatusMessage(null);
      await api.orders.cancel(orderId);
      setStatusMessage({ text: 'Order cancelled successfully.', type: 'success' });
      await loadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to cancel order.';
      setStatusMessage({ text: msg, type: 'error' });
    } finally {
      setCancellingId(null);
    }
  };

  // Filtered orders
  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (filterMarket !== 'ALL' && o.market !== filterMarket) return false;
      if (filterSide !== 'ALL' && o.side !== filterSide) return false;
      if (filterStatus !== 'ALL' && o.status !== filterStatus) return false;

      const orderTime = typeof o.createdAt === 'number' ? o.createdAt : new Date(o.createdAt).getTime();
      if (filterFrom) {
        const fromTime = new Date(filterFrom).getTime();
        if (orderTime < fromTime) return false;
      }
      if (filterTo) {
        const toTime = new Date(filterTo).getTime() + 86400000; // end of day
        if (orderTime > toTime) return false;
      }
      return true;
    });
  }, [orders, filterMarket, filterSide, filterStatus, filterFrom, filterTo]);

  // Filtered trades
  const filteredTrades = useMemo(() => {
    return trades.filter((t) => {
      if (filterMarket !== 'ALL' && t.market && t.market !== filterMarket) return false;
      const tradeSide = t.side || t.takerSide;
      if (filterSide !== 'ALL' && tradeSide !== filterSide) return false;

      const tradeTime = new Date(t.createdAt).getTime();
      if (filterFrom) {
        const fromTime = new Date(filterFrom).getTime();
        if (tradeTime < fromTime) return false;
      }
      if (filterTo) {
        const toTime = new Date(filterTo).getTime() + 86400000;
        if (tradeTime > toTime) return false;
      }
      return true;
    });
  }, [trades, filterMarket, filterSide, filterFrom, filterTo]);

  // Reset pagination on filter change
  useEffect(() => {
    setPage(1);
  }, [activeTab, filterMarket, filterSide, filterStatus, filterFrom, filterTo]);

  // Export visible filter as CSV
  const handleExportCsv = () => {
    const today = new Date().toISOString().slice(0, 10);
    if (activeTab === 'orders') {
      const headers = ['Order ID', 'Time', 'Market', 'Side', 'Type', 'Price', 'Quantity', 'Filled', 'Status'];
      const rows = filteredOrders.map((o) => {
        const timeStr = typeof o.createdAt === 'number' ? new Date(o.createdAt).toISOString() : o.createdAt;
        const priceStr = o.price ? (BigInt(o.price) / 100000000n).toString() : 'MARKET';
        const qtyStr = (BigInt(o.quantity) / 100000000n).toString();
        const filledStr = (BigInt(o.filledQuantity) / 100000000n).toString();
        return [
          o.orderId,
          timeStr,
          o.market,
          o.side,
          o.type,
          priceStr,
          qtyStr,
          filledStr,
          o.status,
        ];
      });

      const csvContent =
        'data:text/csv;charset=utf-8,' +
        [headers.join(','), ...rows.map((e) => e.map((val) => `"${String(val).replace(/"/g, '""')}"`).join(','))].join('\n');

      const encodedUri = encodeURI(csvContent);
      const link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', `kairos-orders-${today}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else {
      const headers = ['Trade ID', 'Time', 'Market', 'Side', 'Price', 'Quantity', 'Fee'];
      const rows = filteredTrades.map((t) => {
        const timeStr = t.createdAt;
        const priceStr = (BigInt(t.price) / 100000000n).toString();
        const qtyStr = (BigInt(t.quantity) / 100000000n).toString();
        const feeStr = t.fee ? (BigInt(t.fee) / 100000000n).toString() : '0';
        return [
          t.id,
          timeStr,
          t.market || '',
          t.side || t.takerSide || '',
          priceStr,
          qtyStr,
          feeStr,
        ];
      });

      const csvContent =
        'data:text/csv;charset=utf-8,' +
        [headers.join(','), ...rows.map((e) => e.map((val) => `"${String(val).replace(/"/g, '""')}"`).join(','))].join('\n');

      const encodedUri = encodeURI(csvContent);
      const link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', `kairos-trades-${today}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  // Pagination slicing
  const activeListLength = activeTab === 'orders' ? filteredOrders.length : filteredTrades.length;
  const totalPages = Math.ceil(activeListLength / pageSize) || 1;
  const paginatedOrders = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredOrders.slice(start, start + pageSize);
  }, [filteredOrders, page, pageSize]);

  const paginatedTrades = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredTrades.slice(start, start + pageSize);
  }, [filteredTrades, page, pageSize]);

  return (
    <AuthGuard>
      <div className="min-h-screen bg-bg text-text flex flex-col font-sans">
        <Navbar />

        <main className="flex-1 max-w-7xl w-full mx-auto px-6 lg:px-8 py-10 md:py-14 flex flex-col gap-8">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 border-b border-line pb-8">
            <div className="flex flex-col gap-2">
              <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">Orders</h1>
              <p className="text-sm text-muted max-w-xl">
                Comprehensive order lifecycle records, fill executions, and exact fee deductions.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="md"
                onClick={handleRefresh}
                leftIcon={<RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />}
              >
                Refresh
              </Button>
              <Button
                variant="outline"
                size="md"
                onClick={handleExportCsv}
                leftIcon={<Download className="w-4 h-4" />}
              >
                Export CSV
              </Button>
            </div>
          </div>

          {/* Feedback message */}
          {statusMessage && (
            <div
              className={`p-3 rounded-lg text-sm flex items-center justify-between gap-2 ${
                statusMessage.type === 'success'
                  ? 'bg-up-soft border border-up/30 text-up'
                  : 'bg-down-soft border border-down/30 text-down'
              }`}
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                <span>{statusMessage.text}</span>
              </div>
              <button
                type="button"
                onClick={() => setStatusMessage(null)}
                className="opacity-70 hover:opacity-100"
              >
                ✕
              </button>
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-8 border-b border-line">
            <button
              type="button"
              onClick={() => setActiveTab('orders')}
              className={`pb-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === 'orders'
                  ? 'border-accent text-text'
                  : 'border-transparent text-muted hover:text-text'
              }`}
            >
              Order history ({filteredOrders.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('trades')}
              className={`pb-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === 'trades'
                  ? 'border-accent text-text'
                  : 'border-transparent text-muted hover:text-text'
              }`}
            >
              Trades and fees ({filteredTrades.length})
            </button>
          </div>

          {/* Filter Bar */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 bg-surface border border-line p-4 rounded-xl shadow-sm text-xs">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="filter-market" className="text-muted font-medium">Market</label>
              <select
                id="filter-market"
                value={filterMarket}
                onChange={(e) => setFilterMarket(e.target.value)}
                className="bg-surface2 border border-line rounded-lg px-2.5 py-2 text-text outline-none focus:border-accent"
              >
                <option value="ALL">All markets</option>
                <option value="SOL_USDT">SOL_USDT</option>
                <option value="BTC_USDT">BTC_USDT</option>
                <option value="ETH_USDT">ETH_USDT</option>
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="filter-side" className="text-muted font-medium">Side</label>
              <select
                id="filter-side"
                value={filterSide}
                onChange={(e) => setFilterSide(e.target.value)}
                className="bg-surface2 border border-line rounded-lg px-2.5 py-2 text-text outline-none focus:border-accent"
              >
                <option value="ALL">All sides</option>
                <option value="BUY">Buy</option>
                <option value="SELL">Sell</option>
              </select>
            </div>

            {activeTab === 'orders' && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="filter-status" className="text-muted font-medium">Status</label>
                <select
                  id="filter-status"
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="bg-surface2 border border-line rounded-lg px-2.5 py-2 text-text outline-none focus:border-accent"
                >
                  <option value="ALL">All statuses</option>
                  <option value={OrderStatus.OPEN}>Open</option>
                  <option value={OrderStatus.PARTIALLY_FILLED}>Partially filled</option>
                  <option value={OrderStatus.FILLED}>Filled</option>
                  <option value={OrderStatus.CANCELLED}>Cancelled</option>
                  <option value={OrderStatus.REJECTED}>Rejected</option>
                </select>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="filter-from" className="text-muted font-medium">From</label>
              <input
                id="filter-from"
                type="date"
                value={filterFrom}
                onChange={(e) => setFilterFrom(e.target.value)}
                className="bg-surface2 border border-line rounded-lg px-2.5 py-1.5 text-text outline-none focus:border-accent"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="filter-to" className="text-muted font-medium">To</label>
              <input
                id="filter-to"
                type="date"
                value={filterTo}
                onChange={(e) => setFilterTo(e.target.value)}
                className="bg-surface2 border border-line rounded-lg px-2.5 py-1.5 text-text outline-none focus:border-accent"
              />
            </div>
          </div>

          {/* Tables Section */}
          {activeTab === 'orders' ? (
            <div className="flex flex-col gap-4">
              <div className="bg-surface border border-line rounded-xl overflow-x-auto shadow-sm">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-line text-xs text-muted font-medium bg-surface2/30 select-none">
                    <tr>
                      <th className="py-3.5 px-6">Time</th>
                      <th className="py-3.5 px-4">Market</th>
                      <th className="py-3.5 px-4">Side</th>
                      <th className="py-3.5 px-4">Type</th>
                      <th className="py-3.5 px-4 text-right">Price</th>
                      <th className="py-3.5 px-4 text-right">Filled / Amount</th>
                      <th className="py-3.5 px-4 text-center">Status</th>
                      <th className="py-3.5 px-6 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/40">
                    {isLoading ? (
                      <tr>
                        <td colSpan={8} className="py-12 text-center text-muted">
                          Loading orders...
                        </td>
                      </tr>
                    ) : paginatedOrders.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-12 text-center text-muted">
                          No matching orders found.
                        </td>
                      </tr>
                    ) : (
                      paginatedOrders.map((o) => {
                        const isBuy = o.side === Side.BUY;
                        const isOpen = o.status === OrderStatus.OPEN || o.status === OrderStatus.PARTIALLY_FILLED;
                        const dateStr = typeof o.createdAt === 'number'
                          ? new Date(o.createdAt).toLocaleString()
                          : new Date(o.createdAt).toLocaleString();

                        return (
                          <tr key={o.orderId} className="hover:bg-surface2/30 transition-colors">
                            <td className="py-4 px-6 font-mono text-xs text-muted">{dateStr}</td>
                            <td className="py-4 px-4 font-semibold text-text">{o.market}</td>
                            <td className="py-4 px-4 font-medium">
                              <span className={isBuy ? 'text-up' : 'text-down'}>
                                {isBuy ? 'Buy' : 'Sell'}
                              </span>
                            </td>
                            <td className="py-4 px-4 text-muted text-xs uppercase">{o.type}</td>
                            <td className="py-4 px-4 text-right font-mono font-medium text-text">
                              {o.price ? formatPrice(o.price, 2) : 'MARKET'}
                            </td>
                            <td className="py-4 px-4 text-right font-mono">
                              <span className="text-text font-medium">{formatQty(o.filledQuantity)}</span>
                              <span className="text-muted"> / {formatQty(o.quantity)}</span>
                            </td>
                            <td className="py-4 px-4 text-center">
                              <span
                                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                  o.status === OrderStatus.FILLED
                                    ? 'bg-up-soft text-up'
                                    : o.status === OrderStatus.PARTIALLY_FILLED
                                    ? 'bg-accent-soft text-accent'
                                    : o.status === OrderStatus.OPEN
                                    ? 'bg-accent-soft text-accent'
                                    : o.status === OrderStatus.CANCELLED
                                    ? 'bg-surface2 text-muted'
                                    : 'bg-down-soft text-down'
                                }`}
                              >
                                {o.status}
                              </span>
                            </td>
                            <td className="py-4 px-6 text-right">
                              {isOpen && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-down hover:border-down"
                                  isLoading={cancellingId === o.orderId}
                                  onClick={() => handleCancelOrder(o.orderId)}
                                >
                                  Cancel
                                </Button>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="bg-surface border border-line rounded-xl overflow-x-auto shadow-sm">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-line text-xs text-muted font-medium bg-surface2/30 select-none">
                    <tr>
                      <th className="py-3.5 px-6">Time</th>
                      <th className="py-3.5 px-4">Market</th>
                      <th className="py-3.5 px-4">Side</th>
                      <th className="py-3.5 px-4 text-right">Price</th>
                      <th className="py-3.5 px-4 text-right">Executed Quantity</th>
                      <th className="py-3.5 px-6 text-right">Fee</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/40">
                    {isLoading ? (
                      <tr>
                        <td colSpan={6} className="py-12 text-center text-muted">
                          Loading executed trades...
                        </td>
                      </tr>
                    ) : paginatedTrades.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-12 text-center text-muted">
                          No executed trades found.
                        </td>
                      </tr>
                    ) : (
                      paginatedTrades.map((t) => {
                        const tradeSide = t.side || t.takerSide || Side.BUY;
                        const isBuy = tradeSide === Side.BUY;

                        return (
                          <tr key={t.id} className="hover:bg-surface2/30 transition-colors">
                            <td className="py-4 px-6 font-mono text-xs text-muted">
                              {new Date(t.createdAt).toLocaleString()}
                            </td>
                            <td className="py-4 px-4 font-semibold text-text">{t.market || '—'}</td>
                            <td className="py-4 px-4 font-medium">
                              <span className="inline-flex items-center gap-1.5">
                                {isBuy ? (
                                  <ArrowDownLeft className="w-3.5 h-3.5 text-up" />
                                ) : (
                                  <ArrowUpRight className="w-3.5 h-3.5 text-down" />
                                )}
                                <span className={isBuy ? 'text-up' : 'text-down'}>
                                  {isBuy ? 'Buy' : 'Sell'}
                                </span>
                              </span>
                            </td>
                            <td className="py-4 px-4 text-right font-mono font-medium text-text">
                              {formatPrice(t.price, 2)}
                            </td>
                            <td className="py-4 px-4 text-right font-mono text-text">
                              {formatQty(t.quantity)}
                            </td>
                            <td className="py-4 px-6 text-right font-mono text-xs text-muted">
                              {t.fee ? formatQty(t.fee) : '0'}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-muted pt-2">
              <span>
                Page {page} of {totalPages} ({activeListLength} entries)
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </main>
      </div>
    </AuthGuard>
  );
}
