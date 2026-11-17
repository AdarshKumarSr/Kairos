import { Redis } from 'ioredis';
import { Command, EngineReply, Event } from '@cex/types';
import { Engine } from '../engine/engine.js';
import { EngineContext, EngineState } from '../engine/types.js';

export interface EngineRunnerOptions {
  redis?: Redis;
  redisUrl?: string;
  streamCommands?: string;
  streamReplies?: string;
  streamEvents?: string;
  groupName?: string;
  consumerName?: string;
  batchSize?: number;
  blockMs?: number;
  startSeq?: bigint;
  maxEventsLen?: number;
}

export function parseStreamFields(fields: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const k = fields[i];
    const v = fields[i + 1];
    if (k !== undefined && v !== undefined) {
      map[k] = v;
    }
  }
  return map;
}

export class EngineRunner {
  private readonly state: EngineState;
  private readonly redis: Redis;
  private readonly ownsRedis: boolean;

  private readonly streamCommands: string;
  private readonly streamReplies: string;
  private readonly streamEvents: string;
  private readonly groupName: string;
  private readonly consumerName: string;
  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly maxEventsLen: number;

  private seq: bigint;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private batchCounter = 0;

  constructor(state: EngineState, options: EngineRunnerOptions = {}) {
    this.state = state;
    this.streamCommands = options.streamCommands ?? 'engine.commands';
    this.streamReplies = options.streamReplies ?? 'engine.replies';
    this.streamEvents = options.streamEvents ?? 'engine.events';
    this.groupName = options.groupName ?? 'engine';
    this.consumerName = options.consumerName ?? 'engine-1';
    this.batchSize = options.batchSize ?? 100;
    this.blockMs = options.blockMs ?? 1000;
    this.maxEventsLen = options.maxEventsLen ?? 10_000_000;
    this.seq = options.startSeq ?? 0n;

    if (options.redis) {
      this.redis = options.redis;
      this.ownsRedis = false;
    } else {
      const url = options.redisUrl ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
      this.redis = new Redis(url, { maxRetriesPerRequest: null });
      this.ownsRedis = true;
    }
  }

  public getSeq(): bigint {
    return this.seq;
  }

  public getState(): EngineState {
    return this.state;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // 1. Ensure consumer group exists
    await this.initGroup();

    // 2. Recover unacknowledged pending entries first
    await this.recoverPending();

    // 3. Start processing loop
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
      await this.redis.xgroup('CREATE', this.streamCommands, this.groupName, '$', 'MKSTREAM');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  private async recoverPending(): Promise<void> {
    while (this.running) {
      const res = (await this.redis.xreadgroup(
        'GROUP',
        this.groupName,
        this.consumerName,
        'COUNT',
        this.batchSize,
        'STREAMS',
        this.streamCommands,
        '0'
      )) as [string, [string, string[]][]][] | null;

      if (!res || res.length === 0 || !res[0] || res[0][1].length === 0) {
        break;
      }

      const entries = res[0][1];
      await this.processBatch(entries);
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
          this.streamCommands,
          '>'
        )) as [string, [string, string[]][]][] | null;

        if (res && res.length > 0 && res[0] && res[0][1].length > 0) {
          await this.processBatch(res[0][1]);
        }
      } catch (err: unknown) {
        if (!this.running) break;
        // Wait 100ms before retrying on error
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  public async processBatch(entries: [string, string[]][]): Promise<void> {
    if (entries.length === 0) return;

    const pipeline = this.redis.pipeline();
    const now = Date.now();

    for (const [id, fields] of entries) {
      const parsedFields = parseStreamFields(fields);
      const rawCmd = parsedFields['command'] ?? parsedFields['data'];
      if (!rawCmd) {
        // Poison entry: ack and skip
        pipeline.xack(this.streamCommands, this.groupName, id);
        continue;
      }

      let command: Command;
      try {
        command = JSON.parse(rawCmd) as Command;
      } catch {
        // Malformed command: ack and skip
        pipeline.xack(this.streamCommands, this.groupName, id);
        continue;
      }

      // Assign engineSeq and process pure in-memory
      const currentSeq = ++this.seq;
      const ctx: EngineContext = { engineSeq: currentSeq, now };
      const { events, reply } = Engine.process(this.state, command, ctx);

      // Publish reply
      pipeline.xadd(
        this.streamReplies,
        '*',
        'reply',
        JSON.stringify(reply),
        'commandId',
        reply.commandId,
        'engineSeq',
        reply.engineSeq
      );

      // Publish events
      for (const event of events) {
        pipeline.xadd(
          this.streamEvents,
          '*',
          'event',
          JSON.stringify(event),
          'type',
          event.type,
          'engineSeq',
          event.engineSeq
        );
      }

      // Acknowledge command
      pipeline.xack(this.streamCommands, this.groupName, id);
    }

    // Stream trimming periodically
    this.batchCounter += entries.length;
    if (this.batchCounter >= 1000) {
      this.batchCounter = 0;
      pipeline.xtrim(this.streamEvents, 'MAXLEN', '~', this.maxEventsLen);
    }

    await pipeline.exec();
  }
}
