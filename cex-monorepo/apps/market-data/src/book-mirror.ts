import { Side } from '@cex/types';
import type { DepthLevel, DepthSnapshot } from './types.js';

export class BookMirror {
  public readonly market: string;
  private bids = new Map<bigint, bigint>();
  private asks = new Map<bigint, bigint>();
  private lastSeq = 0n;

  constructor(market: string) {
    this.market = market;
  }

  public getSeq(): bigint {
    return this.lastSeq;
  }

  public applyDelta(
    side: Side | string,
    priceStr: string,
    quantityStr: string,
    seq: bigint
  ): boolean {
    if (seq < this.lastSeq) {
      return false; // Stale delta from earlier sequence
    }

    this.lastSeq = seq;
    const price = BigInt(priceStr);
    const quantity = BigInt(quantityStr);

    const isBuy = side === Side.BUY || side === 'BUY';
    const targetMap = isBuy ? this.bids : this.asks;

    if (quantity <= 0n) {
      targetMap.delete(price);
    } else {
      targetMap.set(price, quantity);
    }

    return true;
  }

  public getBestBid(): string | null {
    if (this.bids.size === 0) return null;
    let max = -1n;
    for (const p of this.bids.keys()) {
      if (max === -1n || p > max) {
        max = p;
      }
    }
    return max >= 0n ? max.toString() : null;
  }

  public getBestAsk(): string | null {
    if (this.asks.size === 0) return null;
    let min = -1n;
    for (const p of this.asks.keys()) {
      if (min === -1n || p < min) {
        min = p;
      }
    }
    return min >= 0n ? min.toString() : null;
  }

  public getSnapshot(limit = 50, now = Date.now()): DepthSnapshot {
    const sortedBids: DepthLevel[] = Array.from(this.bids.entries())
      .sort((a, b) => (b[0] > a[0] ? 1 : b[0] < a[0] ? -1 : 0))
      .slice(0, limit)
      .map(([p, q]) => [p.toString(), q.toString()]);

    const sortedAsks: DepthLevel[] = Array.from(this.asks.entries())
      .sort((a, b) => (a[0] > b[0] ? 1 : a[0] < b[0] ? -1 : 0))
      .slice(0, limit)
      .map(([p, q]) => [p.toString(), q.toString()]);

    return {
      market: this.market,
      seq: this.lastSeq.toString(),
      bids: sortedBids,
      asks: sortedAsks,
      ts: now,
    };
  }

  public clear(): void {
    this.bids.clear();
    this.asks.clear();
    this.lastSeq = 0n;
  }
}
