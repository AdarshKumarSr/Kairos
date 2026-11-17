import type { KlineData, KlineInterval, KlineMessage } from './types.js';

const SCALE = 100_000_000n;

export const INTERVAL_DURATIONS: Record<KlineInterval, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

export const SUPPORTED_INTERVALS: KlineInterval[] = [
  '1m',
  '5m',
  '15m',
  '1h',
  '1d',
];

export class CandleManager {
  // Key: `${market}:${interval}` -> KlineData
  private activeCandles = new Map<string, KlineData>();

  public onTrade(
    market: string,
    priceStr: string,
    quantityStr: string,
    ts: number
  ): KlineMessage[] {
    const messages: KlineMessage[] = [];
    const price = BigInt(priceStr);
    const quantity = BigInt(quantityStr);
    const quoteAmt = (price * quantity) / SCALE;

    for (const interval of SUPPORTED_INTERVALS) {
      const durationMs = INTERVAL_DURATIONS[interval];
      const bucketStart = Math.floor(ts / durationMs) * durationMs;
      const bucketEnd = bucketStart + durationMs;
      const key = `${market}:${interval}`;

      const current = this.activeCandles.get(key);

      if (!current) {
        // Initial candle
        const newCandle: KlineData = {
          t: bucketStart,
          T: bucketEnd,
          o: priceStr,
          h: priceStr,
          l: priceStr,
          c: priceStr,
          v: quantityStr,
          q: quoteAmt.toString(),
          n: 1,
          x: false,
        };
        this.activeCandles.set(key, newCandle);
        messages.push({
          e: 'kline',
          s: market,
          i: interval,
          k: { ...newCandle },
        });
      } else if (bucketStart > current.t) {
        // Current candle has closed!
        const closedCandle: KlineData = {
          ...current,
          x: true,
        };
        messages.push({
          e: 'kline',
          s: market,
          i: interval,
          k: closedCandle,
        });

        // Start new active candle
        const nextCandle: KlineData = {
          t: bucketStart,
          T: bucketEnd,
          o: priceStr,
          h: priceStr,
          l: priceStr,
          c: priceStr,
          v: quantityStr,
          q: quoteAmt.toString(),
          n: 1,
          x: false,
        };
        this.activeCandles.set(key, nextCandle);
        messages.push({
          e: 'kline',
          s: market,
          i: interval,
          k: { ...nextCandle },
        });
      } else {
        // Update in-progress candle
        if (price > BigInt(current.h)) current.h = priceStr;
        if (price < BigInt(current.l)) current.l = priceStr;
        current.c = priceStr;
        current.v = (BigInt(current.v) + quantity).toString();
        current.q = (BigInt(current.q) + quoteAmt).toString();
        current.n++;
        current.x = false;

        messages.push({
          e: 'kline',
          s: market,
          i: interval,
          k: { ...current },
        });
      }
    }

    return messages;
  }

  public getInProgressCandle(
    market: string,
    interval: KlineInterval
  ): KlineData | null {
    const current = this.activeCandles.get(`${market}:${interval}`);
    return current ? { ...current } : null;
  }

  public clear(): void {
    this.activeCandles.clear();
  }
}
