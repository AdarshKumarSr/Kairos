import type { TickerMessage } from './types.js';

const SCALE = 100_000_000n;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

interface MinuteBucket {
  minuteTs: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint;
  quoteVolume: bigint;
  count: number;
}

export class Rolling24hStats {
  public readonly market: string;
  private buckets = new Map<number, MinuteBucket>();
  private lastPrice: bigint | null = null;

  constructor(market: string) {
    this.market = market;
  }

  public recordTrade(priceStr: string, quantityStr: string, ts: number): void {
    const price = BigInt(priceStr);
    const quantity = BigInt(quantityStr);
    const quoteVolume = (price * quantity) / SCALE;

    this.lastPrice = price;
    const minuteTs = Math.floor(ts / ONE_MINUTE_MS) * ONE_MINUTE_MS;

    const existing = this.buckets.get(minuteTs);
    if (!existing) {
      this.buckets.set(minuteTs, {
        minuteTs,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: quantity,
        quoteVolume,
        count: 1,
      });
    } else {
      existing.close = price;
      if (price > existing.high) existing.high = price;
      if (price < existing.low) existing.low = price;
      existing.volume += quantity;
      existing.quoteVolume += quoteVolume;
      existing.count++;
    }

    // Periodically prune buckets older than 24 hours
    this.prune(ts);
  }

  public prune(now: number): void {
    const cutoff = now - ONE_DAY_MS;
    for (const [minuteTs] of this.buckets) {
      if (minuteTs < cutoff) {
        this.buckets.delete(minuteTs);
      }
    }
  }

  public getLastPrice(): string | null {
    return this.lastPrice !== null ? this.lastPrice.toString() : null;
  }

  public getStats(
    now = Date.now(),
    bestBid: string | null = null,
    bestAsk: string | null = null
  ): TickerMessage {
    this.prune(now);

    if (this.buckets.size === 0) {
      const priceStr = this.lastPrice !== null ? this.lastPrice.toString() : '0';
      return {
        market: this.market,
        lastPrice: priceStr,
        priceChange24h: '0',
        priceChangePercent24h: '0.00',
        high24h: priceStr,
        low24h: priceStr,
        volume24h: '0',
        quoteVolume24h: '0',
        tradeCount24h: 0,
        bestBid,
        bestAsk,
        ts: now,
      };
    }

    const sortedBuckets = Array.from(this.buckets.values()).sort(
      (a, b) => a.minuteTs - b.minuteTs
    );

    const firstBucket = sortedBuckets[0]!;
    const open = firstBucket.open;
    const close = this.lastPrice ?? sortedBuckets[sortedBuckets.length - 1]!.close;

    let high = firstBucket.high;
    let low = firstBucket.low;
    let totalVolume = 0n;
    let totalQuoteVolume = 0n;
    let totalCount = 0;

    for (const b of sortedBuckets) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      totalVolume += b.volume;
      totalQuoteVolume += b.quoteVolume;
      totalCount += b.count;
    }

    const priceChange = close - open;
    let pctStr = '0.00';
    if (open > 0n) {
      const pctNum = Number((priceChange * 10_000n) / open) / 100;
      pctStr = pctNum.toFixed(2);
    }

    return {
      market: this.market,
      lastPrice: close.toString(),
      priceChange24h: priceChange.toString(),
      priceChangePercent24h: pctStr,
      high24h: high.toString(),
      low24h: low.toString(),
      volume24h: totalVolume.toString(),
      quoteVolume24h: totalQuoteVolume.toString(),
      tradeCount24h: totalCount,
      bestBid,
      bestAsk,
      ts: now,
    };
  }

  public clear(): void {
    this.buckets.clear();
    this.lastPrice = null;
  }
}
