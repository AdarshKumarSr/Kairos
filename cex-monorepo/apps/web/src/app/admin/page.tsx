'use client';

import React, { useEffect, useState } from 'react';
import { Navbar } from '../../components/Navbar';
import { AuthGuard } from '../../components/auth/AuthGuard';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { Input } from '../../components/ui/Input';
import {
  api,
  type WithdrawalDto,
  type AuditLogDto,
  type FeeReportDto,
} from '../../lib/api';
import { formatQty } from '../../lib/format';
import { type MarketConfig, MarketStatus } from '@cex/types';
import {
  ShieldAlert,
  PauseCircle,
  PlayCircle,
  CheckCircle2,
  RefreshCw,
  AlertCircle,
  DollarSign,
  SlidersHorizontal,
} from 'lucide-react';

export default function AdminPage() {
  const [markets, setMarkets] = useState<MarketConfig[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalDto[]>([]);
  const [fees, setFees] = useState<FeeReportDto[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogDto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Action status message
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Fee modal state
  const [feeModalOpen, setFeeModalOpen] = useState(false);
  const [selectedMarket, setSelectedMarket] = useState<MarketConfig | null>(null);
  const [makerFeeInput, setMakerFeeInput] = useState('8');
  const [takerFeeInput, setTakerFeeInput] = useState('10');
  const [isUpdatingFees, setIsUpdatingFees] = useState(false);

  // Market action loading
  const [actionLoadingMarket, setActionLoadingMarket] = useState<string | null>(null);
  // Withdrawal action loading
  const [actionLoadingWithdrawal, setActionLoadingWithdrawal] = useState<string | null>(null);

  const loadAdminData = async () => {
    try {
      const [marketsRes, withdrawalsRes, feesRes, auditRes] = await Promise.all([
        api.markets.list().catch(() => ({ markets: [] })),
        api.admin.getPendingWithdrawals().catch(() => ({ withdrawals: [] })),
        api.admin.getFees().catch(() => ({ fees: [] })),
        api.admin.getAuditLogs().catch(() => ({ audit: [] })),
      ]);

      setMarkets(marketsRes.markets || []);
      setWithdrawals(withdrawalsRes.withdrawals || []);
      setFees(feesRes.fees || []);
      setAuditLogs(auditRes.audit || []);
    } catch (err) {
      console.error('Failed to load admin console data:', err);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadAdminData();
  }, []);

  const handleRefresh = () => {
    setIsRefreshing(true);
    setStatusMessage(null);
    loadAdminData();
  };

  // Toggle Halt / Resume
  const handleToggleMarketStatus = async (market: MarketConfig) => {
    try {
      setActionLoadingMarket(market.symbol);
      setStatusMessage(null);
      if (market.status === MarketStatus.ACTIVE) {
        await api.admin.haltMarket(market.symbol);
        setStatusMessage({ text: `Market ${market.symbol} has been halted.`, type: 'success' });
      } else {
        await api.admin.resumeMarket(market.symbol);
        setStatusMessage({ text: `Market ${market.symbol} has been resumed.`, type: 'success' });
      }
      await loadAdminData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update market status.';
      setStatusMessage({ text: msg, type: 'error' });
    } finally {
      setActionLoadingMarket(null);
    }
  };

  // Open Edit Fees Modal
  const openEditFees = (market: MarketConfig) => {
    setSelectedMarket(market);
    setMakerFeeInput(market.makerFeeBps.toString());
    setTakerFeeInput(market.takerFeeBps.toString());
    setFeeModalOpen(true);
  };

  // Submit Edit Fees
  const handleSaveFees = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMarket) return;

    const makerBps = parseInt(makerFeeInput, 10);
    const takerBps = parseInt(takerFeeInput, 10);

    if (isNaN(makerBps) || makerBps < 0 || makerBps > 1000) {
      setStatusMessage({ text: 'Maker fee must be between 0 and 1000 bps.', type: 'error' });
      return;
    }
    if (isNaN(takerBps) || takerBps < 0 || takerBps > 1000) {
      setStatusMessage({ text: 'Taker fee must be between 0 and 1000 bps.', type: 'error' });
      return;
    }

    try {
      setIsUpdatingFees(true);
      await api.admin.updateMarket(selectedMarket.symbol, {
        makerFeeBps: makerBps,
        takerFeeBps: takerBps,
      });
      setStatusMessage({
        text: `Fees for ${selectedMarket.symbol} updated: maker ${makerBps} bps, taker ${takerBps} bps.`,
        type: 'success',
      });
      setFeeModalOpen(false);
      await loadAdminData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update fees.';
      setStatusMessage({ text: msg, type: 'error' });
    } finally {
      setIsUpdatingFees(false);
    }
  };

  // Approve Withdrawal
  const handleApproveWithdrawal = async (id: string) => {
    try {
      setActionLoadingWithdrawal(id);
      setStatusMessage(null);
      await api.admin.approveWithdrawal(id);
      setStatusMessage({ text: 'Withdrawal approved successfully.', type: 'success' });
      await loadAdminData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to approve withdrawal.';
      setStatusMessage({ text: msg, type: 'error' });
    } finally {
      setActionLoadingWithdrawal(null);
    }
  };

  // Reject Withdrawal
  const handleRejectWithdrawal = async (id: string) => {
    try {
      setActionLoadingWithdrawal(id);
      setStatusMessage(null);
      await api.admin.rejectWithdrawal(id);
      setStatusMessage({ text: 'Withdrawal rejected. Funds unlocked back to trader.', type: 'success' });
      await loadAdminData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to reject withdrawal.';
      setStatusMessage({ text: msg, type: 'error' });
    } finally {
      setActionLoadingWithdrawal(null);
    }
  };

  return (
    <AuthGuard requireAdmin>
      <div className="min-h-screen bg-bg text-text flex flex-col font-sans">
        <Navbar />

        <main className="flex-1 max-w-7xl w-full mx-auto px-6 lg:px-8 py-10 md:py-14 flex flex-col gap-10">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 border-b border-line pb-8">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="p-1 rounded bg-accent-soft text-accent">
                  <ShieldAlert className="w-5 h-5" />
                </span>
                <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">Admin Console</h1>
              </div>
              <p className="text-sm text-muted max-w-2xl">
                Manage trading pairs, halt or resume matching queues, audit fee revenues, and process withdrawal approvals. Every operation creates an immutable audit row.
              </p>
            </div>
            <Button
              variant="outline"
              size="md"
              onClick={handleRefresh}
              leftIcon={<RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />}
            >
              Refresh Data
            </Button>
          </div>

          {/* Feedback banner */}
          {statusMessage && (
            <div
              className={`p-3.5 rounded-lg text-sm flex items-center justify-between gap-2 shadow-sm ${
                statusMessage.type === 'success'
                  ? 'bg-up-soft border border-up/30 text-up'
                  : 'bg-down-soft border border-down/30 text-down'
              }`}
            >
              <div className="flex items-center gap-2.5">
                {statusMessage.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                )}
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

          {/* Fee Revenue Summary */}
          <section className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-accent" />
              <h2 className="text-xl font-semibold tracking-tight">Fee Revenue Summary</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {fees.length === 0 ? (
                <div className="col-span-full bg-surface border border-line rounded-xl p-6 text-center text-sm text-muted">
                  No accumulated trading fees recorded in this epoch yet.
                </div>
              ) : (
                fees.map((f, i) => (
                  <div
                    key={i}
                    className="bg-surface border border-line rounded-xl p-5 flex flex-col gap-2 shadow-sm"
                  >
                    <span className="text-xs text-muted font-medium uppercase tracking-wider">
                      {f.market}
                    </span>
                    <span className="text-2xl font-mono font-medium text-text">
                      {formatQty(f.totalFees || f.totalFeesQuote || '0')}
                    </span>
                    <span className="text-xs text-muted">
                      Total quote fee accumulated
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Markets Management */}
          <section className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">Markets Management</h2>
                <p className="text-xs text-muted mt-0.5">
                  While a market is halted, traders can cancel active resting orders but cannot place new ones.
                </p>
              </div>
            </div>

            <div className="bg-surface border border-line rounded-xl overflow-x-auto shadow-sm">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line text-xs text-muted font-medium bg-surface2/30 select-none">
                  <tr>
                    <th className="py-3.5 px-6">Market</th>
                    <th className="py-3.5 px-4">Status</th>
                    <th className="py-3.5 px-4 text-right">Maker Fee</th>
                    <th className="py-3.5 px-4 text-right">Taker Fee</th>
                    <th className="py-3.5 px-4 text-right">Tick Size / Lot</th>
                    <th className="py-3.5 px-6 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {markets.map((m) => {
                    const isActive = m.status === MarketStatus.ACTIVE;
                    const isBusy = actionLoadingMarket === m.symbol;

                    return (
                      <tr key={m.symbol} className="hover:bg-surface2/30 transition-colors">
                        <td className="py-4 px-6 font-semibold text-text">{m.symbol}</td>
                        <td className="py-4 px-4">
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              isActive ? 'bg-up-soft text-up' : 'bg-warn-soft text-warn'
                            }`}
                          >
                            {isActive ? 'Active' : 'Halted'}
                          </span>
                        </td>
                        <td className="py-4 px-4 text-right font-mono text-text">
                          {m.makerFeeBps} bps
                        </td>
                        <td className="py-4 px-4 text-right font-mono text-text">
                          {m.takerFeeBps} bps
                        </td>
                        <td className="py-4 px-4 text-right font-mono text-xs text-muted">
                          {formatQty(m.tickSize)} / {formatQty(m.lotSize)}
                        </td>
                        <td className="py-4 px-6 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openEditFees(m)}
                              leftIcon={<SlidersHorizontal className="w-3.5 h-3.5" />}
                            >
                              Edit fees
                            </Button>
                            {isActive ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-warn hover:border-warn"
                                isLoading={isBusy}
                                onClick={() => handleToggleMarketStatus(m)}
                                leftIcon={<PauseCircle className="w-3.5 h-3.5" />}
                              >
                                Halt
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="primary"
                                isLoading={isBusy}
                                onClick={() => handleToggleMarketStatus(m)}
                                leftIcon={<PlayCircle className="w-3.5 h-3.5" />}
                              >
                                Resume
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Pending Withdrawals Queue */}
          <section className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold tracking-tight">Pending Withdrawals Queue</h2>
                <span className="px-2 py-0.5 rounded-full bg-accent-soft text-accent text-xs font-semibold">
                  {withdrawals.length}
                </span>
              </div>
              <span className="text-xs text-muted">
                Requires manual operator confirmation before funds exit the exchange ledger.
              </span>
            </div>

            <div className="bg-surface border border-line rounded-xl overflow-x-auto shadow-sm">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line text-xs text-muted font-medium bg-surface2/30 select-none">
                  <tr>
                    <th className="py-3.5 px-6">Requested</th>
                    <th className="py-3.5 px-4">User</th>
                    <th className="py-3.5 px-4">Asset</th>
                    <th className="py-3.5 px-4 text-right">Amount</th>
                    <th className="py-3.5 px-6 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {isLoading ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-muted">
                        Loading pending requests...
                      </td>
                    </tr>
                  ) : withdrawals.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-muted">
                        No withdrawals are waiting for review. All queue items are settled.
                      </td>
                    </tr>
                  ) : (
                    withdrawals.map((w) => {
                      const isBusy = actionLoadingWithdrawal === w.id;

                      return (
                        <tr key={w.id} className="hover:bg-surface2/30 transition-colors">
                          <td className="py-4 px-6 font-mono text-xs text-muted">
                            {new Date(w.createdAt).toLocaleString()}
                          </td>
                          <td className="py-4 px-4 font-mono text-xs text-text">
                            {w.userEmail || w.userId}
                          </td>
                          <td className="py-4 px-4 font-semibold text-text">{w.asset}</td>
                          <td className="py-4 px-4 text-right font-mono font-medium text-text">
                            {formatQty(w.amount)}
                          </td>
                          <td className="py-4 px-6 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-down hover:border-down"
                                disabled={isBusy}
                                isLoading={isBusy}
                                onClick={() => handleRejectWithdrawal(w.id)}
                              >
                                Reject
                              </Button>
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={isBusy}
                                isLoading={isBusy}
                                onClick={() => handleApproveWithdrawal(w.id)}
                              >
                                Approve
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Audit Log Viewer */}
          <section className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold tracking-tight">Recent Audit Log</h2>
            <div className="bg-surface border border-line rounded-xl overflow-x-auto shadow-sm">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line text-xs text-muted font-medium bg-surface2/30 select-none">
                  <tr>
                    <th className="py-3.5 px-6">Timestamp</th>
                    <th className="py-3.5 px-4">Actor</th>
                    <th className="py-3.5 px-4">Action</th>
                    <th className="py-3.5 px-6">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {isLoading ? (
                    <tr>
                      <td colSpan={4} className="py-12 text-center text-muted">
                        Loading audit trail...
                      </td>
                    </tr>
                  ) : auditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-12 text-center text-muted">
                        No audit events recorded yet.
                      </td>
                    </tr>
                  ) : (
                    auditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-surface2/30 transition-colors">
                        <td className="py-3 px-6 font-mono text-xs text-muted">
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-muted">
                          {log.actorId ? log.actorId.slice(0, 12) + '...' : 'SYSTEM'}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs font-semibold text-text">
                          {log.action}
                        </td>
                        <td className="py-3 px-6 font-mono text-xs text-muted truncate max-w-xs">
                          {typeof log.meta === 'object' ? JSON.stringify(log.meta) : String(log.meta)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </main>

        {/* Edit Fees Modal */}
        <Modal
          isOpen={feeModalOpen}
          onClose={() => setFeeModalOpen(false)}
          title={`Edit Fees: ${selectedMarket?.symbol || ''}`}
          description="Fees are specified in basis points (100 bps = 1.00%). Charged in the asset each side receives."
        >
          <form onSubmit={handleSaveFees} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="maker-fee" className="text-xs font-medium text-muted">
                Maker Fee (basis points)
              </label>
              <Input
                id="maker-fee"
                type="number"
                min="0"
                max="1000"
                value={makerFeeInput}
                onChange={(e) => setMakerFeeInput(e.target.value)}
                autoFocus
              />
              <span className="text-xs text-muted">
                {(parseInt(makerFeeInput || '0', 10) / 100).toFixed(2)}% maker fee
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="taker-fee" className="text-xs font-medium text-muted">
                Taker Fee (basis points)
              </label>
              <Input
                id="taker-fee"
                type="number"
                min="0"
                max="1000"
                value={takerFeeInput}
                onChange={(e) => setTakerFeeInput(e.target.value)}
              />
              <span className="text-xs text-muted">
                {(parseInt(takerFeeInput || '0', 10) / 100).toFixed(2)}% taker fee
              </span>
            </div>

            <div className="flex items-center gap-3 pt-3">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setFeeModalOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                className="flex-1"
                isLoading={isUpdatingFees}
              >
                Save Fee Changes
              </Button>
            </div>
          </form>
        </Modal>
      </div>
    </AuthGuard>
  );
}
