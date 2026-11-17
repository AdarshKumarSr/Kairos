import { calcFee, lockForBuyLimit, minBig, mulDiv, SCALE } from '@cex/money';
import { Side } from '@cex/types';
import { MarketState, ParsedMarketConfig } from '../engine/types.js';

export interface UserBalance {
  available: bigint;
  locked: bigint;
}

export interface PendingWithdrawal {
  userId: string;
  asset: string;
  amount: bigint;
}

export interface SettleTradeParams {
  buyerUserId: string;
  sellerUserId: string;
  market: ParsedMarketConfig;
  takerSide: Side;
  tradePrice: bigint;
  tradeQty: bigint;
  quoteAmt: bigint;
  buyerLockToConsume: bigint;
}

export interface SettleTradeResult {
  buyerFee: bigint;
  sellerFee: bigint;
  quoteAmt: bigint;
  refund: bigint;
}

export class BalanceManager {
  private readonly balances = new Map<string, UserBalance>(); // `${userId}:${asset}` -> UserBalance
  private readonly feeAccounts = new Map<string, bigint>(); // `${asset}` -> bigint
  private readonly totalDeposited = new Map<string, bigint>(); // `${asset}` -> bigint
  private readonly totalWithdrawn = new Map<string, bigint>(); // `${asset}` -> bigint
  private readonly pendingWithdrawals = new Map<string, PendingWithdrawal>(); // `${withdrawalId}` -> PendingWithdrawal
  private readonly assets = new Set<string>();

  balanceKey(userId: string, asset: string): string {
    return `${userId}:${asset}`;
  }

  private getOrCreate(userId: string, asset: string): UserBalance {
    this.assets.add(asset);
    const key = this.balanceKey(userId, asset);
    let bal = this.balances.get(key);
    if (!bal) {
      bal = { available: 0n, locked: 0n };
      this.balances.set(key, bal);
    }
    return bal;
  }

  get(userId: string, asset: string): UserBalance {
    const key = this.balanceKey(userId, asset);
    const bal = this.balances.get(key);
    return bal ? { available: bal.available, locked: bal.locked } : { available: 0n, locked: 0n };
  }

  checkAndLock(userId: string, asset: string, amount: bigint): boolean {
    return this.lock(userId, asset, amount);
  }

  lock(userId: string, asset: string, amount: bigint): boolean {
    if (amount < 0n) throw new Error('Lock amount cannot be negative');
    if (amount === 0n) return true;

    const bal = this.getOrCreate(userId, asset);
    if (bal.available < amount) {
      return false;
    }

    bal.available -= amount;
    bal.locked += amount;
    return true;
  }

  unlock(userId: string, asset: string, amount: bigint): void {
    if (amount < 0n) throw new Error('Unlock amount cannot be negative');
    if (amount === 0n) return;

    const bal = this.getOrCreate(userId, asset);
    if (bal.locked < amount) {
      throw new Error(`Cannot unlock ${amount} ${asset}: only ${bal.locked} locked for user ${userId}`);
    }

    bal.locked -= amount;
    bal.available += amount;
  }

  consumeLock(userId: string, asset: string, amount: bigint): void {
    if (amount < 0n) throw new Error('Consume lock amount cannot be negative');
    if (amount === 0n) return;

    const bal = this.getOrCreate(userId, asset);
    if (bal.locked < amount) {
      throw new Error(`Cannot consume ${amount} ${asset}: only ${bal.locked} locked for user ${userId}`);
    }

    bal.locked -= amount;
  }

  creditAvailable(userId: string, asset: string, amount: bigint): void {
    if (amount < 0n) throw new Error('Credit amount cannot be negative');
    if (amount === 0n) return;

    const bal = this.getOrCreate(userId, asset);
    bal.available += amount;
  }

  deposit(userId: string, asset: string, amount: bigint): void {
    if (amount <= 0n) throw new Error('Deposit amount must be positive');
    this.creditAvailable(userId, asset, amount);
    this.totalDeposited.set(asset, (this.totalDeposited.get(asset) ?? 0n) + amount);
    this.assets.add(asset);
  }

  withdrawRequest(userId: string, asset: string, amount: bigint, withdrawalId: string): boolean {
    if (amount <= 0n) throw new Error('Withdrawal amount must be positive');
    if (this.pendingWithdrawals.has(withdrawalId)) return false;

    if (!this.lock(userId, asset, amount)) {
      return false;
    }

    this.pendingWithdrawals.set(withdrawalId, { userId, asset, amount });
    return true;
  }

  withdrawComplete(withdrawalId: string): PendingWithdrawal | null {
    const pw = this.pendingWithdrawals.get(withdrawalId);
    if (!pw) return null;

    this.consumeLock(pw.userId, pw.asset, pw.amount);
    this.totalWithdrawn.set(pw.asset, (this.totalWithdrawn.get(pw.asset) ?? 0n) + pw.amount);
    this.pendingWithdrawals.delete(withdrawalId);
    return pw;
  }

  withdrawReject(withdrawalId: string): PendingWithdrawal | null {
    const pw = this.pendingWithdrawals.get(withdrawalId);
    if (!pw) return null;

    this.unlock(pw.userId, pw.asset, pw.amount);
    this.pendingWithdrawals.delete(withdrawalId);
    return pw;
  }

  addFee(asset: string, amount: bigint): void {
    if (amount < 0n) throw new Error('Fee amount cannot be negative');
    if (amount === 0n) return;
    this.feeAccounts.set(asset, (this.feeAccounts.get(asset) ?? 0n) + amount);
    this.assets.add(asset);
  }

  getFee(asset: string): bigint {
    return this.feeAccounts.get(asset) ?? 0n;
  }

  getTotalDeposited(asset: string): bigint {
    return this.totalDeposited.get(asset) ?? 0n;
  }

  getTotalWithdrawn(asset: string): bigint {
    return this.totalWithdrawn.get(asset) ?? 0n;
  }

  getAllBalances(): IterableIterator<[string, UserBalance]> {
    return this.balances.entries();
  }

  getAllAssets(): IterableIterator<string> {
    return this.assets.values();
  }

  getPendingWithdrawals(): Map<string, PendingWithdrawal> {
    return this.pendingWithdrawals;
  }

  /**
   * Settles a trade according to Section 5.3:
   * Buyer : locked(quote) decreases by the portion of the lock used for this fill.
   *         If buyer is taker and limit price > tradePrice:
   *         (limitPrice - tradePrice) * qty / SCALE is refunded back to available!
   *         available(base) += qty - buyerFee (fee in base)
   * Seller: locked(base) -= qty
   *         available(quote) += quoteAmt - sellerFee (fee in quote)
   * Fees  : maker pays makerFeeBps, taker pays takerFeeBps in received asset.
   */
  settleTrade(params: SettleTradeParams): SettleTradeResult {
    const {
      buyerUserId,
      sellerUserId,
      market,
      takerSide,
      tradeQty,
      quoteAmt,
      buyerLockToConsume,
    } = params;

    const isTakerBuyer = takerSide === Side.BUY;

    // Fees in received asset (rounded UP via calcFee)
    const buyerFee = calcFee(tradeQty, isTakerBuyer ? market.takerFeeBps : market.makerFeeBps);
    const sellerFee = calcFee(quoteAmt, isTakerBuyer ? market.makerFeeBps : market.takerFeeBps);

    // 1. Fee accounts credit
    this.addFee(market.baseAsset, buyerFee);
    this.addFee(market.quoteAsset, sellerFee);

    // 2. Buyer settlement
    // Buyer receives base (tradeQty - buyerFee)
    this.creditAvailable(buyerUserId, market.baseAsset, tradeQty - buyerFee);

    // Buyer locked quote consumption & price-improvement refund
    const refund = buyerLockToConsume > quoteAmt ? buyerLockToConsume - quoteAmt : 0n;
    this.consumeLock(buyerUserId, market.quoteAsset, buyerLockToConsume);
    if (refund > 0n) {
      this.creditAvailable(buyerUserId, market.quoteAsset, refund);
    }

    // 3. Seller settlement
    // Seller locked base, loses tradeQty
    this.consumeLock(sellerUserId, market.baseAsset, tradeQty);
    // Seller receives quote (quoteAmt - sellerFee)
    this.creditAvailable(sellerUserId, market.quoteAsset, quoteAmt - sellerFee);

    return {
      buyerFee,
      sellerFee,
      quoteAmt,
      refund,
    };
  }

  /**
   * Verifies Invariants 1 (Conservation), 2 (Non-negative), and 3 (Lock Consistency).
   */
  checkInvariants(markets: Map<string, MarketState>): void {
    // 1. Non-negative balances
    for (const [key, bal] of this.balances.entries()) {
      if (bal.available < 0n) {
        throw new Error(`[INVARIANT_VIOLATION] Negative available balance for ${key}: ${bal.available}`);
      }
      if (bal.locked < 0n) {
        throw new Error(`[INVARIANT_VIOLATION] Negative locked balance for ${key}: ${bal.locked}`);
      }
    }

    // 2. Lock consistency: user.locked === sum(open orders lockedAmount) + sum(pending withdrawals)
    const expectedLocks = new Map<string, bigint>();

    for (const market of markets.values()) {
      for (const order of market.book.getAllOrders()) {
        const lockAsset = order.side === Side.BUY ? market.config.quoteAsset : market.config.baseAsset;
        const key = this.balanceKey(order.userId, lockAsset);
        expectedLocks.set(key, (expectedLocks.get(key) ?? 0n) + order.lockedAmount);
      }
    }

    for (const pw of this.pendingWithdrawals.values()) {
      const key = this.balanceKey(pw.userId, pw.asset);
      expectedLocks.set(key, (expectedLocks.get(key) ?? 0n) + pw.amount);
    }

    for (const [key, bal] of this.balances.entries()) {
      const expected = expectedLocks.get(key) ?? 0n;
      if (bal.locked !== expected) {
        throw new Error(
          `[INVARIANT_VIOLATION] Lock consistency failed for ${key}: locked is ${bal.locked}, expected ${expected}`
        );
      }
    }

    // 3. Conservation per asset: totalDeposited - totalWithdrawn === sum(available + locked) + feeAccount
    for (const asset of this.assets) {
      let userTotal = 0n;
      const suffix = `:${asset}`;
      for (const [key, bal] of this.balances.entries()) {
        if (key.endsWith(suffix)) {
          userTotal += bal.available + bal.locked;
        }
      }

      const fee = this.getFee(asset);
      const deposited = this.getTotalDeposited(asset);
      const withdrawn = this.getTotalWithdrawn(asset);

      const netDeposited = deposited - withdrawn;
      const totalCirculating = userTotal + fee;

      if (netDeposited !== totalCirculating) {
        throw new Error(
          `[INVARIANT_VIOLATION] Conservation failed for ${asset}: netDeposited (${netDeposited}) !== circulating (${totalCirculating}) [users=${userTotal}, fee=${fee}]`
        );
      }
    }
  }
}

/** Stubbed balance manager that approves all locks for Phase 6 unit tests */
export class StubBalanceManager extends BalanceManager {
  override lock(_userId: string, _asset: string, _amount: bigint): boolean {
    return true;
  }
  override unlock(_userId: string, _asset: string, _amount: bigint): void {}
  override consumeLock(_userId: string, _asset: string, _amount: bigint): void {}
  override creditAvailable(_userId: string, _asset: string, _amount: bigint): void {}
  override settleTrade(params: SettleTradeParams): SettleTradeResult {
    return {
      buyerFee: 0n,
      sellerFee: 0n,
      quoteAmt: params.quoteAmt,
      refund: 0n,
    };
  }
  override checkInvariants(_markets: Map<string, MarketState>): void {}
}
