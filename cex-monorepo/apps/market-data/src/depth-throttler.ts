import { Side } from '@cex/types';
import type { DepthDeltaMessage, DepthLevel } from './types.js';

export class DepthThrottler {
  public readonly market: string;
  private coalescedBids = new Map<string, string>();
  private coalescedAsks = new Map<string, string>();
  private highestSeq = 0n;
  private lastFlushedSeq = 0n;

  constructor(market: string) {
    this.market = market;
  }

  public getHighestSeq(): bigint {
    return this.highestSeq;
  }

  public getLastFlushedSeq(): bigint {
    return this.lastFlushedSeq;
  }

  public addDelta(
    side: Side | string,
    price: string,
    quantity: string,
    seq: bigint
  ): void {
    if (seq < this.highestSeq) {
      return; // Never allow seq to regress
    }

    this.highestSeq = seq;
    const isBuy = side === Side.BUY || side === 'BUY';

    if (isBuy) {
      this.coalescedBids.set(price, quantity);
    } else {
      this.coalescedAsks.set(price, quantity);
    }
  }

  public flush(now = Date.now()): DepthDeltaMessage | null {
    if (this.coalescedBids.size === 0 && this.coalescedAsks.size === 0) {
      return null;
    }

    const b: DepthLevel[] = Array.from(this.coalescedBids.entries());
    const a: DepthLevel[] = Array.from(this.coalescedAsks.entries());
    const seqStr = this.highestSeq.toString();

    this.lastFlushedSeq = this.highestSeq;
    this.coalescedBids.clear();
    this.coalescedAsks.clear();

    return {
      e: 'depthUpdate',
      s: this.market,
      seq: seqStr,
      b,
      a,
      ts: now,
    };
  }

  public hasPendingDeltas(): boolean {
    return this.coalescedBids.size > 0 || this.coalescedAsks.size > 0;
  }

  public clear(): void {
    this.coalescedBids.clear();
    this.coalescedAsks.clear();
    this.highestSeq = 0n;
    this.lastFlushedSeq = 0n;
  }
}
