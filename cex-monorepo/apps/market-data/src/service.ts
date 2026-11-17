import { createLogger, type winston } from '@cex/logger';
import type { Event } from '@cex/types';
import { Redis } from 'ioredis';
import { BookMirror } from './book-mirror.js';
import { CandleManager } from './candle-manager.js';
import { DepthThrottler } from './depth-throttler.js';
import { Rolling24hStats } from './rolling-stats.js';
import type {
  MarketDataOptions,
  TradeMessage,
  UserBalanceUpdateMessage,
  UserOrderUpdateMessage,
} from './types.js';

export function parseStreamFields(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const k = fields[i];
    const v = fields[i + 1];
    if (k !== undefined && v !== undefined) {
      obj[k] = v;
    }
  }
  return obj;
}

export class MarketDataService {
  private readonly redis: Redis;
  private readonly ownsRedis: boolean;
  private readonly logger: winston.Logger;

  private readonly streamEvents: string;
  private readonly groupName: string;
  private readonly consumerName: string;
  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly throttleMs: number;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private throttleTimer: NodeJS.Timeout | null = null;
  private tickerTimer: NodeJS.Timeout | null = null;

  private bookMirrors = new Map<string, BookMirror>();
  private depthThrottlers = new Map<string, DepthThrottler>();
  private rollingStats = new Map<string, Rolling24hStats>();
  private candleManager = new CandleManager();

  private eventsProcessed = 0;

  constructor(options: MarketDataOptions = {}) {
    this.streamEvents = options.streamEvents ?? 'engine.events';
    this.groupName = options.groupName ?? 'md';
    this.consumerName = options.consumerName ?? 'md-1';
    this.batchSize = options.batchSize ?? 500;
    this.blockMs = options.blockMs ?? 50;
    this.throttleMs = options.throttleMs ?? 100;

    if (options.redis) {
      this.redis = options.redis;
      this.ownsRedis = false;
    } else {
      const url =
        options.redisUrl ??
        process.env.REDIS_URL ??
        'redis://:cex_dev_redis@localhost:6379';
      this.redis = new Redis(url, { maxRetriesPerRequest: null });
      this.ownsRedis = true;
    }

    this.logger = createLogger('market-data');
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getEventsProcessed(): number {
    return this.eventsProcessed;
  }

  public getBookMirror(market: string): BookMirror {
    let mirror = this.bookMirrors.get(market);
    if (!mirror) {
      mirror = new BookMirror(market);
      this.bookMirrors.set(market, mirror);
    }
    return mirror;
  }

  public getRollingStats(market: string): Rolling24hStats {
    let stats = this.rollingStats.get(market);
    if (!stats) {
      stats = new Rolling24hStats(market);
      this.rollingStats.set(market, stats);
    }
    return stats;
  }

  public getDepthThrottler(market: string): DepthThrottler {
    let throttler = this.depthThrottlers.get(market);
    if (!throttler) {
      throttler = new DepthThrottler(market);
      this.depthThrottlers.set(market, throttler);
    }
    return throttler;
  }

  public getCandleManager(): CandleManager {
    return this.candleManager;
  }

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // 1. Initialize consumer group on stream
    await this.initGroup();

    // 2. Recover any pending entries
    await this.recoverPending();

    // 3. Start depth throttling timer (every throttleMs, default 100ms)
    this.throttleTimer = setInterval(() => {
      this.flushDepthDeltas().catch((err) => {
        this.logger.error('Error in flushDepthDeltas', { err });
      });
    }, this.throttleMs);

    // 4. Start 1-second ticker refresh timer
    this.tickerTimer = setInterval(() => {
      this.refreshTickers().catch((err) => {
        this.logger.error('Error in refreshTickers', { err });
      });
    }, 1000);

    // 5. Start main polling loop
    this.loopPromise = this.runLoop();
  }

  public async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.throttleTimer) {
      clearInterval(this.throttleTimer);
      this.throttleTimer = null;
    }

    if (this.tickerTimer) {
      clearInterval(this.tickerTimer);
      this.tickerTimer = null;
    }

    // Flush any remaining depth deltas before stopping
    await this.flushDepthDeltas();

    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }

    if (this.ownsRedis) {
      this.redis.disconnect();
    }
  }

  private async initGroup(): Promise<void> {
    try {
      await this.redis.xgroup(
        'CREATE',
        this.streamEvents,
        this.groupName,
        '0',
        'MKSTREAM'
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  public async recoverPending(): Promise<void> {
    while (this.running) {
      const res = (await this.redis.xreadgroup(
        'GROUP',
        this.groupName,
        this.consumerName,
        'COUNT',
        this.batchSize,
        'STREAMS',
        this.streamEvents,
        '0'
      )) as [string, [string, string[]][]][] | null;

      if (!res || res.length === 0 || !res[0] || res[0][1].length === 0) {
        break;
      }

      const entries = res[0][1];
      await this.processBatchEntries(entries);
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const res = (await this.redis.xreadgroup(
          'GROUP',
          this.groupName,
          this.consumerName,
          'COUNT',
          this.batchSize,
          'BLOCK',
          this.blockMs,
          'STREAMS',
          this.streamEvents,
          '>'
        )) as [string, [string, string[]][]][] | null;

        if (res && res.length > 0 && res[0] && res[0][1].length > 0) {
          await this.processBatchEntries(res[0][1]);
        }
      } catch (err: unknown) {
        if (!this.running) break;
        this.logger.error('Error in MarketDataService polling loop', { err });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  public async processBatchEntries(
    entries: [string, string[]][]
  ): Promise<void> {
    if (entries.length === 0) return;

    const pipeline = this.redis.pipeline();
    const ackIds: string[] = [];
    const marketsToSnapshot = new Set<string>();

    for (const [id, fields] of entries) {
      ackIds.push(id);
      const parsed = parseStreamFields(fields);
      const rawEvent = parsed['event'];
      if (!rawEvent) continue;

      let event: Event;
      try {
        event = JSON.parse(rawEvent) as Event;
      } catch {
        continue;
      }

      this.processSingleEvent(event, pipeline, marketsToSnapshot);
      this.eventsProcessed++;
    }

    // Write top-50 depth snapshots to Redis key depth:{market} after batch
    for (const market of marketsToSnapshot) {
      const mirror = this.bookMirrors.get(market);
      if (mirror) {
        const snapshot = mirror.getSnapshot(50);
        pipeline.set(`depth:${market}`, JSON.stringify(snapshot));
      }
    }

    // Acknowledge all processed entries in this batch
    if (ackIds.length > 0) {
      pipeline.xack(this.streamEvents, this.groupName, ...ackIds);
    }

    await pipeline.exec();
  }

  public processSingleEvent(
    event: Event,
    pipeline: ReturnType<Redis['pipeline']>,
    marketsToSnapshot?: Set<string>
  ): void {
    const d = event.data as Record<string, unknown>;
    const seq = BigInt(event.engineSeq);
    const ts = event.ts;

    switch (event.type) {
      case 'DEPTH_DELTA': {
        const market = String(d.market ?? '');
        if (!market) break;

        const side = String(d.side ?? 'BUY') as 'BUY' | 'SELL';
        const price = String(d.price ?? '0');
        const quantity = String(d.quantity ?? '0');

        const mirror = this.getBookMirror(market);
        mirror.applyDelta(side, price, quantity, seq);

        const throttler = this.getDepthThrottler(market);
        throttler.addDelta(side, price, quantity, seq);

        if (marketsToSnapshot) {
          marketsToSnapshot.add(market);
        }
        break;
      }

      case 'TRADE': {
        const market = String(d.market ?? '');
        if (!market) break;

        const tradeId = String(d.tradeId ?? d.id ?? `trade-${event.engineSeq}`);
        const price = String(d.price ?? '0');
        const quantity = String(d.quantity ?? '0');
        const takerSide = String(d.takerSide ?? 'BUY') as 'BUY' | 'SELL';

        // 1. Update 24h rolling stats
        const stats = this.getRollingStats(market);
        stats.recordTrade(price, quantity, ts);

        const mirror = this.getBookMirror(market);
        const ticker = stats.getStats(ts, mirror.getBestBid(), mirror.getBestAsk());
        const tickerJson = JSON.stringify(ticker);

        pipeline.set(`ticker:${market}`, tickerJson);
        pipeline.publish(`md:ticker:${market}`, tickerJson);

        // 2. Update In-progress Candles (K-lines)
        const klineMsgs = this.candleManager.onTrade(market, price, quantity, ts);
        for (const kmsg of klineMsgs) {
          const klineJson = JSON.stringify(kmsg);
          pipeline.set(`kline:${kmsg.i}:${market}`, JSON.stringify(kmsg.k));
          pipeline.publish(`md:kline:${kmsg.i}:${market}`, klineJson);
        }

        // 3. Publish trade on md:trade:{market}
        const isMakerBuyer = takerSide === 'SELL';
        const tradeMsg: TradeMessage = {
          e: 'trade',
          s: market,
          tradeId,
          p: price,
          q: quantity,
          t: ts,
          m: isMakerBuyer,
          takerSide,
          seq: event.engineSeq,
        };
        pipeline.publish(`md:trade:${market}`, JSON.stringify(tradeMsg));
        break;
      }

      case 'ORDER_ACCEPTED':
      case 'ORDER_PLACED':
      case 'ORDER_UPDATED':
      case 'ORDER_CANCELLED':
      case 'ORDER_REJECTED': {
        const userId = d.userId ? String(d.userId) : null;
        if (!userId || userId === 'unknown') break;

        const orderMsg: UserOrderUpdateMessage = {
          e: 'orderUpdate',
          orderId: String(d.orderId ?? ''),
          clientOrderId: d.clientOrderId ? String(d.clientOrderId) : undefined,
          market: String(d.market ?? ''),
          side: (d.side ? String(d.side) : 'BUY') as 'BUY' | 'SELL',
          price: d.price ? String(d.price) : undefined,
          quantity: String(d.quantity ?? '0'),
          filledQuantity: String(d.filledQuantity ?? '0'),
          status: String(d.status ?? event.type.replace('ORDER_', '')),
          ts,
        };

        pipeline.publish(`user:${userId}`, JSON.stringify(orderMsg));
        break;
      }

      case 'BALANCE_UPDATED': {
        const userId = d.userId ? String(d.userId) : null;
        if (!userId || userId === 'unknown') break;

        const balMsg: UserBalanceUpdateMessage = {
          e: 'balanceUpdate',
          asset: String(d.asset ?? ''),
          available: String(d.available ?? '0'),
          locked: String(d.locked ?? '0'),
          ts,
        };

        pipeline.publish(`user:${userId}`, JSON.stringify(balMsg));
        break;
      }

      default:
        break;
    }
  }

  public async flushDepthDeltas(now = Date.now()): Promise<number> {
    let flushedCount = 0;
    const pipeline = this.redis.pipeline();

    for (const [market, throttler] of this.depthThrottlers) {
      if (throttler.hasPendingDeltas()) {
        const delta = throttler.flush(now);
        if (delta) {
          pipeline.publish(`md:depth:${market}`, JSON.stringify(delta));
          flushedCount++;
        }
      }
    }

    if (flushedCount > 0) {
      await pipeline.exec();
    }

    return flushedCount;
  }

  public async refreshTickers(now = Date.now()): Promise<void> {
    if (this.rollingStats.size === 0) return;

    const pipeline = this.redis.pipeline();

    for (const [market, stats] of this.rollingStats) {
      const mirror = this.bookMirrors.get(market);
      const ticker = stats.getStats(
        now,
        mirror ? mirror.getBestBid() : null,
        mirror ? mirror.getBestAsk() : null
      );
      const json = JSON.stringify(ticker);
      pipeline.set(`ticker:${market}`, json);
      pipeline.publish(`md:ticker:${market}`, json);
    }

    await pipeline.exec();
  }
}
