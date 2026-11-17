import { Redis } from 'ioredis';
import { MarketConfig, MarketStatus } from '@cex/types';
import { PrismaClient } from '@cex/db';

export const DEFAULT_MARKETS: MarketConfig[] = [
  {
    symbol: 'SOL_USDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    tickSize: '1000000', // 0.01 (1e8)
    lotSize: '1000000', // 0.01 (1e8)
    minNotional: '500000000', // 5.00 USDT (1e8)
    makerFeeBps: 8,
    takerFeeBps: 10,
    status: MarketStatus.ACTIVE,
  },
  {
    symbol: 'BTC_USDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    tickSize: '10000000', // 0.10 (1e8)
    lotSize: '10000', // 0.0001 (1e8)
    minNotional: '1000000000', // 10.00 USDT (1e8)
    makerFeeBps: 8,
    takerFeeBps: 10,
    status: MarketStatus.ACTIVE,
  },
  {
    symbol: 'ETH_USDT',
    baseAsset: 'ETH',
    quoteAsset: 'USDT',
    tickSize: '1000000', // 0.01 (1e8)
    lotSize: '100000', // 0.001 (1e8)
    minNotional: '1000000000', // 10.00 USDT (1e8)
    makerFeeBps: 8,
    takerFeeBps: 10,
    status: MarketStatus.ACTIVE,
  },
];

export class MarketConfigCache {
  private readonly cache = new Map<string, MarketConfig>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis
  ) {
    // Seed with defaults initially
    for (const m of DEFAULT_MARKETS) {
      this.cache.set(m.symbol, m);
    }
  }

  public async init(): Promise<void> {
    await this.refresh();
  }

  public async refresh(): Promise<void> {
    try {
      const dbMarkets = await this.prisma.market.findMany();
      if (dbMarkets.length > 0) {
        for (const m of dbMarkets) {
          const cfg: MarketConfig = {
            symbol: m.symbol,
            baseAsset: m.baseAsset,
            quoteAsset: m.quoteAsset,
            tickSize: m.tickSize.toString(),
            lotSize: m.lotSize.toString(),
            minNotional: m.minNotional.toString(),
            makerFeeBps: m.makerFeeBps,
            takerFeeBps: m.takerFeeBps,
            status: m.status as MarketStatus,
          };
          this.cache.set(m.symbol, cfg);
        }
      }
    } catch {
      // If DB is unreachable or unseeded, retain in-memory defaults
    }

    // Write to Redis keys: marketcfg:{symbol} per Section 4.7
    try {
      const pipe = this.redis.pipeline();
      for (const [symbol, cfg] of this.cache) {
        pipe.set(`marketcfg:${symbol}`, JSON.stringify(cfg));
      }
      await pipe.exec();
    } catch {
      // Redis pipeline optional during disconnected tests
    }
  }

  public get(symbol: string): MarketConfig | undefined {
    return this.cache.get(symbol);
  }

  public getAll(): MarketConfig[] {
    return Array.from(this.cache.values());
  }

  public set(config: MarketConfig): void {
    this.cache.set(config.symbol, config);
    this.redis.set(`marketcfg:${config.symbol}`, JSON.stringify(config)).catch(() => {});
  }
}
