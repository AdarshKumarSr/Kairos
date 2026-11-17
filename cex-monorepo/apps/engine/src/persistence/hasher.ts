import crypto from 'node:crypto';
import { EngineState } from '../engine/types.js';

/**
 * Computes a deterministic SHA-256 cryptographic hash representing
 * the complete state of the engine (all order books, price levels,
 * resting orders, balances, fee accounts, deposits/withdrawals, and sequence number).
 *
 * Invariant 7 (Determinism): Replaying the same journal produces an identical state hash.
 */
export function computeStateHash(state: EngineState, engineSeq: bigint = 0n): string {
  const markets = Array.from(state.markets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([symbol, ms]) => ({
      symbol,
      config: {
        symbol: ms.config.symbol,
        baseAsset: ms.config.baseAsset,
        quoteAsset: ms.config.quoteAsset,
        tickSize: ms.config.tickSize.toString(),
        lotSize: ms.config.lotSize.toString(),
        minNotional: ms.config.minNotional.toString(),
        makerFeeBps: ms.config.makerFeeBps,
        takerFeeBps: ms.config.takerFeeBps,
        status: ms.config.status,
      },
      book: ms.book.snapshot(),
    }));

  const balances = state.balanceManager.snapshot();

  const canonical = {
    engineSeq: engineSeq.toString(),
    markets,
    balances,
  };

  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
