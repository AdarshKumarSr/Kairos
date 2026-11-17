'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { Navbar } from '../../components/Navbar';
import { AuthGuard } from '../../components/auth/AuthGuard';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { Input } from '../../components/ui/Input';
import { api, type BalanceDto, type DepositDto, type WithdrawalDto } from '../../lib/api';
import { formatQty, parseInputToScaled } from '../../lib/format';
import { ArrowDownLeft, ArrowUpRight, Clock, CheckCircle2, XCircle, RefreshCw, AlertCircle } from 'lucide-react';

interface AssetMeta {
  symbol: string;
  name: string;
  initial: string;
}

const SUPPORTED_ASSETS: AssetMeta[] = [
  { symbol: 'USDT', name: 'Tether USD', initial: '₮' },
  { symbol: 'SOL', name: 'Solana', initial: 'S' },
  { symbol: 'BTC', name: 'Bitcoin', initial: '₿' },
  { symbol: 'ETH', name: 'Ethereum', initial: 'Ξ' },
];

const DEV_DEPOSIT_MAX = 1000; // max 1000 units per simulated deposit

type HistoryItem = {
  id: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  asset: string;
  amount: string;
  status: 'PENDING' | 'COMPLETED' | 'REJECTED';
  createdAt: string;
};

export default function WalletPage() {
  const [balances, setBalances] = useState<Record<string, BalanceDto>>({});
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 6;

  // Modal states
  const [depositModalOpen, setDepositModalOpen] = useState(false);
  const [withdrawModalOpen, setWithdrawModalOpen] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState('USDT');
  const [amountInput, setAmountInput] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadWalletData = async () => {
    try {
      const [balancesRes, historyRes] = await Promise.all([
        api.wallet.getBalances().catch(() => ({ balances: [] })),
        api.wallet.getHistory().catch(() => ({ deposits: [], withdrawals: [] })),
      ]);

      const bMap: Record<string, BalanceDto> = {};
      for (const a of SUPPORTED_ASSETS) {
        bMap[a.symbol] = { asset: a.symbol, available: '0', locked: '0' };
      }
      for (const b of balancesRes.balances) {
        bMap[b.asset] = b;
      }
      setBalances(bMap);

      const items: HistoryItem[] = [
        ...historyRes.deposits.map((d: DepositDto) => ({
          id: d.id,
          type: 'DEPOSIT' as const,
          asset: d.asset,
          amount: d.amount,
          status: 'COMPLETED' as const,
          createdAt: d.createdAt,
        })),
        ...historyRes.withdrawals.map((w: WithdrawalDto) => ({
          id: w.id,
          type: 'WITHDRAWAL' as const,
          asset: w.asset,
          amount: w.amount,
          status: (w.status === 'APPROVED' ? 'COMPLETED' : w.status) as 'PENDING' | 'COMPLETED' | 'REJECTED',
          createdAt: w.createdAt,
        })),
      ];

      items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setHistory(items);
    } catch (err) {
      console.error('Failed to load wallet data:', err);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadWalletData();
  }, []);

  const handleRefresh = () => {
    setIsRefreshing(true);
    loadWalletData();
  };

  const openDeposit = (asset = 'USDT') => {
    setSelectedAsset(asset);
    setAmountInput('');
    setActionError(null);
    setActionSuccess(null);
    setDepositModalOpen(true);
  };

  const openWithdraw = (asset = 'USDT') => {
    setSelectedAsset(asset);
    setAmountInput('');
    setActionError(null);
    setActionSuccess(null);
    setWithdrawModalOpen(true);
  };

  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    setActionSuccess(null);

    const val = parseFloat(amountInput);
    if (!amountInput || isNaN(val) || val <= 0) {
      setActionError('Please enter a valid amount greater than 0.');
      return;
    }
    if (val > DEV_DEPOSIT_MAX) {
      setActionError(`Maximum simulated deposit is ${DEV_DEPOSIT_MAX} ${selectedAsset}.`);
      return;
    }

    try {
      setIsSubmitting(true);
      const scaledAmount = parseInputToScaled(amountInput).toString();
      await api.wallet.deposit(selectedAsset, scaledAmount);
      setActionSuccess(`Successfully deposited ${amountInput} ${selectedAsset}.`);
      setAmountInput('');
      await loadWalletData();
      setTimeout(() => {
        setDepositModalOpen(false);
        setActionSuccess(null);
      }, 1200);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Deposit failed. Please try again.';
      setActionError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleWithdrawSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    setActionSuccess(null);

    const val = parseFloat(amountInput);
    if (!amountInput || isNaN(val) || val <= 0) {
      setActionError('Please enter a valid amount greater than 0.');
      return;
    }

    const currentBal = balances[selectedAsset];
    const availScaled = BigInt(currentBal?.available || '0');
    const requestedScaled = BigInt(parseInputToScaled(amountInput));

    if (requestedScaled > availScaled) {
      setActionError(`Insufficient available balance. You have ${formatQty(currentBal?.available || '0')} ${selectedAsset}.`);
      return;
    }

    try {
      setIsSubmitting(true);
      await api.wallet.withdraw(selectedAsset, requestedScaled.toString());
      setActionSuccess(`Withdrawal of ${amountInput} ${selectedAsset} requested. Funds are locked pending admin review.`);
      setAmountInput('');
      await loadWalletData();
      setTimeout(() => {
        setWithdrawModalOpen(false);
        setActionSuccess(null);
      }, 1200);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Withdrawal failed. Please try again.';
      setActionError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Pagination for history
  const totalPages = Math.ceil(history.length / pageSize) || 1;
  const paginatedHistory = useMemo(() => {
    const start = (page - 1) * pageSize;
    return history.slice(start, start + pageSize);
  }, [history, page, pageSize]);

  return (
    <AuthGuard>
      <div className="min-h-screen bg-bg text-text flex flex-col font-sans">
        <Navbar />

        <main className="flex-1 max-w-7xl w-full mx-auto px-6 lg:px-8 py-10 md:py-14 flex flex-col gap-10">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6 border-b border-line pb-8">
            <div className="flex flex-col gap-2">
              <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">Wallet</h1>
              <p className="text-sm text-muted max-w-xl">
                Simulated balances for paper-trading. Deposits and withdrawals are ledger entries executed under zero-float scaled arithmetic.
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
              <Button variant="primary" size="md" onClick={() => openDeposit('USDT')}>
                Deposit
              </Button>
              <Button variant="outline" size="md" onClick={() => openWithdraw('USDT')}>
                Withdraw
              </Button>
            </div>
          </div>

          {/* Balances Section */}
          <section className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold tracking-tight">Balances</h2>
            <div className="bg-surface border border-line rounded-xl overflow-x-auto shadow-sm">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line text-xs text-muted font-medium bg-surface2/30 select-none">
                  <tr>
                    <th className="py-3.5 px-6">Asset</th>
                    <th className="py-3.5 px-4 text-right">Total</th>
                    <th className="py-3.5 px-4 text-right">Available</th>
                    <th className="py-3.5 px-4 text-right">In orders (locked)</th>
                    <th className="py-3.5 px-6 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {SUPPORTED_ASSETS.map((asset) => {
                    const bal = balances[asset.symbol] || { asset: asset.symbol, available: '0', locked: '0' };
                    const avail = BigInt(bal.available || '0');
                    const locked = BigInt(bal.locked || '0');
                    const total = (avail + locked).toString();

                    return (
                      <tr key={asset.symbol} className="hover:bg-surface2/30 transition-colors">
                        <td className="py-4 px-6">
                          <div className="flex items-center gap-3">
                            <span className="w-9 h-9 rounded-full bg-surface2 border border-line flex items-center justify-center font-bold text-sm text-text">
                              {asset.initial}
                            </span>
                            <div>
                              <span className="font-semibold text-text block">{asset.symbol}</span>
                              <span className="text-xs text-muted block">{asset.name}</span>
                            </div>
                          </div>
                        </td>
                        <td className="py-4 px-4 text-right font-mono font-medium text-text">
                          {formatQty(total)}
                        </td>
                        <td className="py-4 px-4 text-right font-mono font-medium text-up">
                          {formatQty(bal.available || '0')}
                        </td>
                        <td className="py-4 px-4 text-right font-mono text-muted">
                          {formatQty(bal.locked || '0')}
                        </td>
                        <td className="py-4 px-6 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openDeposit(asset.symbol)}
                            >
                              Deposit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openWithdraw(asset.symbol)}
                            >
                              Withdraw
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* History Section */}
          <section className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold tracking-tight">Deposit and withdrawal history</h2>
              <span className="text-xs text-muted">
                Showing {history.length} total ledger records
              </span>
            </div>

            <div className="bg-surface border border-line rounded-xl overflow-x-auto shadow-sm">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line text-xs text-muted font-medium bg-surface2/30 select-none">
                  <tr>
                    <th className="py-3.5 px-6">Time</th>
                    <th className="py-3.5 px-4">Type</th>
                    <th className="py-3.5 px-4">Asset</th>
                    <th className="py-3.5 px-4 text-right">Amount</th>
                    <th className="py-3.5 px-6 text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {isLoading ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-muted">
                        Loading transaction history...
                      </td>
                    </tr>
                  ) : paginatedHistory.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-muted">
                        No deposits or withdrawals recorded yet. Click &quot;Deposit&quot; to add funds.
                      </td>
                    </tr>
                  ) : (
                    paginatedHistory.map((item) => (
                      <tr key={item.id} className="hover:bg-surface2/30 transition-colors">
                        <td className="py-4 px-6 font-mono text-xs text-muted">
                          {new Date(item.createdAt).toLocaleString()}
                        </td>
                        <td className="py-4 px-4 font-medium">
                          <span className="inline-flex items-center gap-1.5">
                            {item.type === 'DEPOSIT' ? (
                              <ArrowDownLeft className="w-4 h-4 text-up" />
                            ) : (
                              <ArrowUpRight className="w-4 h-4 text-warn" />
                            )}
                            <span className={item.type === 'DEPOSIT' ? 'text-up' : 'text-text'}>
                              {item.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'}
                            </span>
                          </span>
                        </td>
                        <td className="py-4 px-4 font-semibold text-text">{item.asset}</td>
                        <td className="py-4 px-4 text-right font-mono font-medium text-text">
                          {formatQty(item.amount)}
                        </td>
                        <td className="py-4 px-6 text-right">
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${
                              item.status === 'COMPLETED'
                                ? 'bg-up-soft text-up'
                                : item.status === 'PENDING'
                                ? 'bg-warn-soft text-warn'
                                : 'bg-down-soft text-down'
                            }`}
                          >
                            {item.status === 'COMPLETED' ? (
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            ) : item.status === 'PENDING' ? (
                              <Clock className="w-3.5 h-3.5" />
                            ) : (
                              <XCircle className="w-3.5 h-3.5" />
                            )}
                            {item.status === 'COMPLETED'
                              ? 'Completed'
                              : item.status === 'PENDING'
                              ? 'Pending'
                              : 'Rejected'}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between text-xs text-muted pt-2">
                <span>
                  Page {page} of {totalPages}
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
          </section>
        </main>

        {/* Deposit Modal */}
        <Modal
          isOpen={depositModalOpen}
          onClose={() => setDepositModalOpen(false)}
          title={`Simulated Deposit: ${selectedAsset}`}
          description={`Simulate crediting your ledger with testnet funds (max ${DEV_DEPOSIT_MAX} ${selectedAsset} per request).`}
        >
          <form onSubmit={handleDepositSubmit} className="flex flex-col gap-4">
            {actionError && (
              <div className="p-3 bg-down-soft border border-down/30 rounded-lg text-down text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{actionError}</span>
              </div>
            )}
            {actionSuccess && (
              <div className="p-3 bg-up-soft border border-up/30 rounded-lg text-up text-xs flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                <span>{actionSuccess}</span>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="deposit-asset" className="text-xs font-medium text-muted">
                Select Asset
              </label>
              <select
                id="deposit-asset"
                value={selectedAsset}
                onChange={(e) => setSelectedAsset(e.target.value)}
                className="w-full bg-surface2 border border-line rounded-lg px-3 py-2.5 text-sm text-text outline-none focus:border-accent"
              >
                {SUPPORTED_ASSETS.map((a) => (
                  <option key={a.symbol} value={a.symbol}>
                    {a.symbol} — {a.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between items-center text-xs text-muted">
                <label htmlFor="deposit-amount" className="font-medium">
                  Deposit Amount
                </label>
                <span>Max: {DEV_DEPOSIT_MAX} {selectedAsset}</span>
              </div>
              <Input
                id="deposit-amount"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                autoFocus
              />
            </div>

            <div className="flex items-center gap-3 pt-3">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setDepositModalOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                className="flex-1"
                isLoading={isSubmitting}
              >
                Confirm Deposit
              </Button>
            </div>
          </form>
        </Modal>

        {/* Withdraw Modal */}
        <Modal
          isOpen={withdrawModalOpen}
          onClose={() => setWithdrawModalOpen(false)}
          title={`Simulated Withdrawal: ${selectedAsset}`}
          description="Request a withdrawal. Requested funds are locked in your ledger until approved by an admin."
        >
          <form onSubmit={handleWithdrawSubmit} className="flex flex-col gap-4">
            {actionError && (
              <div className="p-3 bg-down-soft border border-down/30 rounded-lg text-down text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{actionError}</span>
              </div>
            )}
            {actionSuccess && (
              <div className="p-3 bg-up-soft border border-up/30 rounded-lg text-up text-xs flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                <span>{actionSuccess}</span>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="withdraw-asset" className="text-xs font-medium text-muted">
                Select Asset
              </label>
              <select
                id="withdraw-asset"
                value={selectedAsset}
                onChange={(e) => setSelectedAsset(e.target.value)}
                className="w-full bg-surface2 border border-line rounded-lg px-3 py-2.5 text-sm text-text outline-none focus:border-accent"
              >
                {SUPPORTED_ASSETS.map((a) => (
                  <option key={a.symbol} value={a.symbol}>
                    {a.symbol} — {a.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between items-center text-xs text-muted">
                <label htmlFor="withdraw-amount" className="font-medium">
                  Withdrawal Amount
                </label>
                <div className="flex items-center gap-2">
                  <span>Available: {formatQty(balances[selectedAsset]?.available || '0')}</span>
                  <button
                    type="button"
                    onClick={() => {
                      const avail = BigInt(balances[selectedAsset]?.available || '0');
                      const whole = avail / 100000000n;
                      const frac = (avail % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
                      setAmountInput(frac.length > 0 ? `${whole}.${frac}` : whole.toString());
                    }}
                    className="text-accent hover:underline font-medium text-xs"
                  >
                    Max
                  </button>
                </div>
              </div>
              <Input
                id="withdraw-amount"
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                autoFocus
              />
            </div>

            <div className="flex items-center gap-3 pt-3">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setWithdrawModalOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                className="flex-1"
                isLoading={isSubmitting}
              >
                Submit Request
              </Button>
            </div>
          </form>
        </Modal>
      </div>
    </AuthGuard>
  );
}
