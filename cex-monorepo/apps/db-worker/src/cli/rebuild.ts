import { prisma as defaultPrisma, type PrismaClient } from '@cex/db';
import { createLogger } from '@cex/logger';
import type { Event } from '@cex/types';
import { Redis } from 'ioredis';
import { pathToFileURL } from 'node:url';
import { EventProjector } from '../projector.js';
import { parseStreamFields } from '../worker.js';

export interface RebuildOptions {
  redisUrl?: string;
  redis?: Redis;
  prisma?: PrismaClient;
  streamEvents?: string;
  batchSize?: number;
  autoCreateUsers?: boolean;
  autoCreateAssets?: boolean;
}

export interface RebuildResult {
  totalEventsReplayed: number;
  durationMs: number;
}

export async function rebuildDatabase(
  options: RebuildOptions = {}
): Promise<RebuildResult> {
  const logger = createLogger('db-worker-rebuild');
  const startTs = Date.now();

  const streamEvents = options.streamEvents ?? 'engine.events';
  const batchSize = options.batchSize ?? 500;
  const prisma = options.prisma ?? defaultPrisma;

  const ownsRedis = !options.redis;
  const redis =
    options.redis ??
    new Redis(
      options.redisUrl ??
        process.env.REDIS_URL ??
        'redis://:cex_dev_redis@localhost:6379'
    );

  try {
    logger.info('Starting disaster recovery database rebuild...');

    // 1. Truncate projection tables
    logger.info('Truncating projection tables ("Order", "Trade", "LedgerEntry", "Balance")...');
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Order", "Trade", "LedgerEntry", "Balance" CASCADE;'
    );

    // 2. Initialize projector
    const projector = new EventProjector({
      autoCreateUsers: options.autoCreateUsers ?? true,
      autoCreateAssets: options.autoCreateAssets ?? true,
    });
    await projector.init(prisma);

    // 3. Replay all events from the beginning of Redis stream
    let lastId = '0-0';
    let totalEventsReplayed = 0;

    logger.info(`Replaying stream '${streamEvents}' from '0-0'...`);

    while (true) {
      const res = (await redis.xread(
        'COUNT',
        batchSize,
        'STREAMS',
        streamEvents,
        lastId
      )) as [string, [string, string[]][]][] | null;

      if (!res || res.length === 0 || !res[0] || res[0][1].length === 0) {
        break;
      }

      const entries = res[0][1];
      const events: Event[] = [];

      for (const [id, fields] of entries) {
        lastId = id;
        const parsed = parseStreamFields(fields);
        const rawEvent = parsed['event'];
        if (rawEvent) {
          try {
            events.push(JSON.parse(rawEvent) as Event);
          } catch {
            // Skip corrupt entries during disaster recovery replay
          }
        }
      }

      if (events.length > 0) {
        await prisma.$transaction(
          async (tx) => {
            await projector.projectBatch(tx, events);
          },
          { timeout: 30000 }
        );
        totalEventsReplayed += events.length;
      }

      if (entries.length < batchSize) {
        break;
      }
    }

    const durationMs = Date.now() - startTs;
    logger.info(
      `Rebuild completed successfully in ${durationMs}ms.`,
      { totalEventsReplayed, durationMs }
    );

    return { totalEventsReplayed, durationMs };
  } finally {
    if (ownsRedis) {
      redis.disconnect();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  rebuildDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Rebuild failed:', err);
      process.exit(1);
    });
}
