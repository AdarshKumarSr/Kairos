import { Redis } from 'ioredis';
import { Command, EngineReply } from '@cex/types';
import { AppError } from '../errors/app-error.js';

export class EngineOverloadedError extends AppError {
  constructor(message = 'Engine is overloaded, please retry shortly') {
    super('SERVICE_OVERLOADED', 503, message);
    this.name = 'EngineOverloadedError';
  }
}

export interface EngineClientOptions {
  pubRedis?: Redis;
  subRedis?: Redis;
  redisUrl?: string;
  streamCommands?: string;
  streamReplies?: string;
  maxQueueLen?: number;
  defaultTimeoutMs?: number;
}

interface PendingCommand {
  resolve: (reply: EngineReply) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export function parseReplyFields(fields: string[]): Record<string, string> {
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

export class EngineClient {
  private readonly pubRedis: Redis;
  private readonly subRedis: Redis;
  private readonly ownsConnections: boolean;

  private readonly streamCommands: string;
  private readonly streamReplies: string;
  private readonly maxQueueLen: number;
  private readonly defaultTimeoutMs: number;

  private readonly pending = new Map<string, PendingCommand>();
  private running = false;
  private consumerPromise: Promise<void> | null = null;
  private lastReplyId = '$';

  constructor(options: EngineClientOptions = {}) {
    this.streamCommands = options.streamCommands ?? 'engine.commands';
    this.streamReplies = options.streamReplies ?? 'engine.replies';
    this.maxQueueLen = options.maxQueueLen ?? 50_000;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 2000;

    if (options.pubRedis && options.subRedis) {
      this.pubRedis = options.pubRedis;
      this.subRedis = options.subRedis;
      this.ownsConnections = false;
    } else {
      const url = options.redisUrl ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
      this.pubRedis = new Redis(url, { maxRetriesPerRequest: null });
      this.subRedis = new Redis(url, { maxRetriesPerRequest: null });
      this.ownsConnections = true;
    }
  }

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Determine starting offset for replies (only listen to new replies)
    try {
      const lastEntry = (await this.pubRedis.xrevrange(
        this.streamReplies,
        '+',
        '-',
        'COUNT',
        1
      )) as [string, string[]][] | null;

      if (lastEntry && lastEntry.length > 0 && lastEntry[0]) {
        this.lastReplyId = lastEntry[0][0];
      } else {
        this.lastReplyId = '$';
      }
    } catch {
      this.lastReplyId = '$';
    }

    this.consumerPromise = this.runReplyConsumer();
  }

  public async close(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Reject / clear all pending promises
    for (const [cmdId, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(new Error(`EngineClient closed while waiting for command ${cmdId}`));
    }
    this.pending.clear();

    if (this.consumerPromise) {
      await this.consumerPromise;
      this.consumerPromise = null;
    }

    if (this.ownsConnections) {
      this.pubRedis.disconnect();
      this.subRedis.disconnect();
    }
  }

  public async send(command: Command, timeoutMs?: number): Promise<EngineReply> {
    if (!this.running) {
      await this.start();
    }

    // Step 5: Backpressure check
    const queueLen = await this.pubRedis.xlen(this.streamCommands);
    if (queueLen >= this.maxQueueLen) {
      throw new EngineOverloadedError(
        `Engine command queue limit exceeded (${queueLen} >= ${this.maxQueueLen})`
      );
    }

    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<EngineReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.commandId);
        // Gateway-side timeout: 2s -> 202 PENDING per Section 1348 & Section 6.1
        resolve({
          commandId: command.commandId,
          engineSeq: '0',
          status: 'PENDING',
        });
      }, timeout);

      this.pending.set(command.commandId, { resolve, reject, timer });

      this.pubRedis
        .xadd(
          this.streamCommands,
          '*',
          'command',
          JSON.stringify(command),
          'commandId',
          command.commandId
        )
        .catch((err) => {
          clearTimeout(timer);
          this.pending.delete(command.commandId);
          reject(err);
        });
    });
  }

  private async runReplyConsumer(): Promise<void> {
    while (this.running) {
      try {
        const res = (await this.subRedis.xread(
          'BLOCK',
          1000,
          'STREAMS',
          this.streamReplies,
          this.lastReplyId
        )) as [string, [string, string[]][]][] | null;

        if (res && res.length > 0 && res[0] && res[0][1].length > 0) {
          for (const [id, fields] of res[0][1]) {
            this.lastReplyId = id;
            const parsed = parseReplyFields(fields);
            const rawReply = parsed['reply'];
            if (rawReply) {
              try {
                const reply = JSON.parse(rawReply) as EngineReply;
                const p = this.pending.get(reply.commandId);
                if (p) {
                  clearTimeout(p.timer);
                  this.pending.delete(reply.commandId);
                  p.resolve(reply);
                }
              } catch {
                // Ignore malformed reply string
              }
            }
          }
        }
      } catch (err: unknown) {
        if (!this.running) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
}
