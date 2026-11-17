import { prisma as defaultPrisma, type PrismaClient } from '@cex/db';
import { createLogger, type winston } from '@cex/logger';
import type { Event } from '@cex/types';
import { Redis } from 'ioredis';
import { EventProjector, type EventProjectorOptions } from './projector.js';
import type { DbWorkerMetrics, DbWorkerOptions, StreamEventItem } from './types.js';

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

export class DbWorker {
  private readonly redis: Redis;
  private readonly ownsRedis: boolean;
  private readonly prisma: PrismaClient;
  private readonly logger: winston.Logger;
  private readonly projector: EventProjector;

  private readonly streamEvents: string;
  private readonly deadStreamEvents: string;
  private readonly groupName: string;
  private readonly consumerName: string;
  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly maxAttempts: number;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly attempts = new Map<string, number>();

  private lagSeconds = 0;
  private currentBatchSize = 0;
  private eventsTotal = 0;
  private deadEventsTotal = 0;
  private batchesTotal = 0;

  constructor(options: DbWorkerOptions & EventProjectorOptions = {}) {
    this.streamEvents = options.streamEvents ?? 'engine.events';
    this.deadStreamEvents = options.deadStreamEvents ?? 'engine.events.dead';
    this.groupName = options.groupName ?? 'dbw';
    this.consumerName = options.consumerName ?? 'dbw-1';
    this.batchSize = options.batchSize ?? 500;
    this.blockMs = options.blockMs ?? 50;
    this.maxAttempts = options.maxAttempts ?? 3;

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

    this.prisma = options.prisma ?? defaultPrisma;
    this.logger = createLogger('db-worker');
    this.projector = new EventProjector({
      autoCreateUsers: options.autoCreateUsers ?? false,
      autoCreateAssets: options.autoCreateAssets ?? false,
    });
  }

  public getMetrics(): DbWorkerMetrics {
    return {
      lagSeconds: this.lagSeconds,
      batchSize: this.currentBatchSize,
      eventsTotal: this.eventsTotal,
      deadEventsTotal: this.deadEventsTotal,
      batchesTotal: this.batchesTotal,
    };
  }

  public getProjector(): EventProjector {
    return this.projector;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // 1. Initialize projector (load asset cache)
    await this.projector.init(this.prisma);

    // 2. Ensure consumer group exists
    await this.initGroup();

    // 3. Recover pending entries on startup
    await this.recoverPending();

    // 4. Start polling loop
    this.loopPromise = this.runLoop();
  }

  public async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

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
    let startId = '0';
    while (this.running) {
      const res = (await this.redis.xreadgroup(
        'GROUP',
        this.groupName,
        this.consumerName,
        'COUNT',
        this.batchSize,
        'STREAMS',
        this.streamEvents,
        startId
      )) as [string, [string, string[]][]][] | null;

      if (!res || res.length === 0 || !res[0] || res[0][1].length === 0) {
        break;
      }

      const entries = res[0][1];
      await this.processBatchEntries(entries);

      if (entries.length < this.batchSize) {
        break;
      }

      const lastEntry = entries[entries.length - 1];
      if (lastEntry) {
        startId = lastEntry[0];
      }
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
        this.logger.error('Error in DbWorker polling loop', { err });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  public async processBatchEntries(
    entries: [string, string[]][]
  ): Promise<void> {
    if (entries.length === 0) return;

    const validItems: StreamEventItem[] = [];

    for (const [id, fields] of entries) {
      const parsed = parseStreamFields(fields);
      const rawEvent = parsed['event'];

      if (!rawEvent) {
        await this.handlePoisonEntry(id, '', 'Missing event field in stream entry');
        continue;
      }

      try {
        const event = JSON.parse(rawEvent) as Event;
        validItems.push({ streamId: id, event, raw: rawEvent });
      } catch (parseErr) {
        await this.handlePoisonEntry(
          id,
          rawEvent,
          parseErr instanceof Error ? parseErr.message : 'Invalid event JSON'
        );
      }
    }

    if (validItems.length === 0) return;

    try {
      // Execute entire batch inside a single database transaction
      await this.prisma.$transaction(
        async (tx) => {
          await this.projector.projectBatch(
            tx,
            validItems.map((item) => item.event)
          );
        },
        { timeout: 30000 }
      );

      // Invariant 10 & Phase 11 Step 3: XACK only after successful commit
      const streamIds = validItems.map((item) => item.streamId);
      await this.redis.xack(this.streamEvents, this.groupName, ...streamIds);

      for (const id of streamIds) {
        this.attempts.delete(id);
      }

      this.eventsTotal += validItems.length;
      this.batchesTotal++;
      this.currentBatchSize = validItems.length;

      const lastEvent = validItems[validItems.length - 1]?.event;
      if (lastEvent) {
        this.lagSeconds = Math.max(0, (Date.now() - lastEvent.ts) / 1000);
      }
    } catch (batchError) {
      // Transaction failed: isolate items individually to identify poison events
      await this.handleFailedBatch(validItems, batchError);
    }
  }

  private async handlePoisonEntry(
    streamId: string,
    raw: string,
    errorMsg: string
  ): Promise<void> {
    let count = this.attempts.get(streamId) ?? 0;
    while (count < this.maxAttempts) {
      count++;
      this.attempts.set(streamId, count);

      if (count >= this.maxAttempts) {
        await this.redis.xadd(
          this.deadStreamEvents,
          '*',
          'streamId',
          streamId,
          'data',
          raw,
          'error',
          errorMsg,
          'failedAt',
          Date.now().toString()
        );
        await this.redis.xack(this.streamEvents, this.groupName, streamId);
        this.attempts.delete(streamId);
        this.deadEventsTotal++;
        this.logger.error(
          'DbWorker moved unparseable entry to dead stream after max attempts',
          { streamId, error: errorMsg }
        );
        break;
      }
    }
  }

  private async handleFailedBatch(
    items: StreamEventItem[],
    batchError: unknown
  ): Promise<void> {
    this.logger.warn(
      'DbWorker batch failed; processing items individually to isolate errors',
      { err: batchError, count: items.length }
    );

    for (const item of items) {
      let succeeded = false;

      while (!succeeded) {
        try {
          await this.prisma.$transaction(async (tx) => {
            await this.projector.projectBatch(tx, [item.event]);
          });

          // Individual item commit succeeded!
          await this.redis.xack(this.streamEvents, this.groupName, item.streamId);
          this.attempts.delete(item.streamId);
          this.eventsTotal++;
          succeeded = true;
        } catch (itemErr) {
          const count = (this.attempts.get(item.streamId) ?? 0) + 1;
          this.attempts.set(item.streamId, count);

          if (count >= this.maxAttempts) {
            // Poison event! Move to dead letter stream
            await this.redis.xadd(
              this.deadStreamEvents,
              '*',
              'streamId',
              item.streamId,
              'event',
              item.raw,
              'error',
              itemErr instanceof Error ? itemErr.message : String(itemErr),
              'failedAt',
              Date.now().toString()
            );
            await this.redis.xack(
              this.streamEvents,
              this.groupName,
              item.streamId
            );
            this.attempts.delete(item.streamId);
            this.deadEventsTotal++;
            this.logger.error(
              'DbWorker poison event moved to dead stream after max attempts',
              { streamId: item.streamId, err: itemErr }
            );
            break;
          }
        }
      }
    }
  }
}
