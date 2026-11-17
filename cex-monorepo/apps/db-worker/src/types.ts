import type { PrismaClient } from '@cex/db';
import type { Event } from '@cex/types';
import type { Redis } from 'ioredis';

export interface DbWorkerOptions {
  redisUrl?: string;
  redis?: Redis;
  prisma?: PrismaClient;
  streamEvents?: string;
  deadStreamEvents?: string;
  groupName?: string;
  consumerName?: string;
  batchSize?: number;
  blockMs?: number;
  maxAttempts?: number;
}

export interface DbWorkerMetrics {
  lagSeconds: number;
  batchSize: number;
  eventsTotal: number;
  deadEventsTotal: number;
  batchesTotal: number;
}

export interface ProjectedBatchSummary {
  ordersUpserted: number;
  tradesInserted: number;
  balancesUpserted: number;
  ledgerEntriesInserted: number;
  depositsUpserted: number;
  withdrawalsUpserted: number;
  eventsProcessed: number;
}

export interface StreamEventItem {
  streamId: string;
  event: Event;
  raw: string;
}
