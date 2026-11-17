import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { Redis } from 'ioredis';
import { ConnectionManager } from './connection-manager.js';
import { RedisSubscriber } from './redis-subscriber.js';
import type {
  ClientAuthMessage,
  ClientMessage,
  ClientPingMessage,
  ClientSubscribeMessage,
  ClientUnsubscribeMessage,
  ServerErrorResponse,
  ServerSuccessResponse,
  WsServerMetrics,
  WsServerOptions,
} from './types.js';

export class WsServer {
  public readonly port: number;
  private actualPort: number;
  private server: http.Server;
  private wss: WebSocketServer;
  private connectionManager: ConnectionManager;
  private redisSubscriber: RedisSubscriber;
  private cmdRedis: Redis;
  private subRedis: Redis;
  private jwtSecret: string;
  private pingIntervalMs: number;
  private maxSubscriptions: number;
  private rateLimitPerSec: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(options: WsServerOptions & { cmdRedis?: Redis; subRedis?: Redis } = {}) {
    this.port = options.port ?? 8080;
    this.actualPort = this.port;
    this.jwtSecret =
      options.jwtSecret ??
      process.env.JWT_ACCESS_SECRET ??
      'test-jwt-access-secret-minimum-32-chars-long';
    this.pingIntervalMs = options.pingIntervalMs ?? 20000;
    this.maxSubscriptions = options.maxSubscriptions ?? 50;
    this.rateLimitPerSec = options.rateLimitPerSec ?? 20;

    const redisUrl =
      options.redisUrl ??
      process.env.REDIS_URL ??
      'redis://:cex_dev_redis@localhost:6379';

    this.cmdRedis =
      options.cmdRedis ??
      new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
    this.subRedis =
      options.subRedis ??
      new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });

    this.connectionManager = new ConnectionManager(options.maxBufferedAmount ?? 1024 * 1024);
    this.redisSubscriber = new RedisSubscriber({
      subRedis: this.subRedis,
      cmdRedis: this.cmdRedis,
      connectionManager: this.connectionManager,
    });

    this.server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Kairos WebSocket Server OK');
    });

    this.wss = new WebSocketServer({
      server: this.server,
      perMessageDeflate: false,
    });

    this.setupWss();
  }

  public getConnectionManager(): ConnectionManager {
    return this.connectionManager;
  }

  public getPort(): number {
    return this.actualPort;
  }

  public getMetrics(): WsServerMetrics {
    return this.connectionManager.getMetrics();
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    await this.redisSubscriber.start();

    await new Promise<void>((resolve, reject) => {
      this.server.listen(this.port, () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
          this.actualPort = addr.port;
        }
        resolve();
      });
      this.server.once('error', reject);
    });

    this.heartbeatTimer = setInterval(() => {
      this.runHeartbeat();
    }, this.pingIntervalMs);

    this.isRunning = true;
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    await this.redisSubscriber.stop();
    this.connectionManager.clear();

    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });

    this.cmdRedis.disconnect();
    this.subRedis.disconnect();

    this.isRunning = false;
  }

  private setupWss(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      const state = this.connectionManager.addConnection(ws);

      ws.on('pong', () => {
        state.isAlive = true;
        state.missedPongs = 0;
      });

      ws.on('message', async (data: Buffer | string) => {
        await this.handleClientMessage(ws, data.toString());
      });

      ws.on('close', () => {
        this.connectionManager.removeConnection(ws);
      });

      ws.on('error', () => {
        this.connectionManager.removeConnection(ws);
      });
    });
  }

  private async handleClientMessage(ws: WebSocket, raw: string): Promise<void> {
    const state = this.connectionManager.getConnection(ws);
    if (!state) return;

    // 1. Rate Limiting Check (max 20 msg/sec per connection)
    const now = Date.now();
    if (now - state.rateLimitWindowStart >= 1000) {
      state.rateLimitWindowStart = now;
      state.messageCount = 1;
    } else {
      state.messageCount++;
      if (state.messageCount > this.rateLimitPerSec) {
        const errorFrame: ServerErrorResponse = {
          error: {
            code: 429,
            message: `Rate limit exceeded: max ${this.rateLimitPerSec} messages per second`,
          },
        };
        this.connectionManager.sendSafe(ws, JSON.stringify(errorFrame));
        return;
      }
    }

    // 2. Strict JSON Parse
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      const errorFrame: ServerErrorResponse = {
        error: { code: 400, message: 'Invalid JSON' },
      };
      this.connectionManager.sendSafe(ws, JSON.stringify(errorFrame));
      return;
    }

    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      const errorFrame: ServerErrorResponse = {
        error: { code: 400, message: 'Message must be an object with a method string' },
        id: (msg as { id?: string | number })?.id,
      };
      this.connectionManager.sendSafe(ws, JSON.stringify(errorFrame));
      return;
    }

    // 3. Dispatch Methods
    switch (msg.method) {
      case 'SUBSCRIBE':
        await this.handleSubscribe(ws, msg as ClientSubscribeMessage);
        break;
      case 'UNSUBSCRIBE':
        this.handleUnsubscribe(ws, msg as ClientUnsubscribeMessage);
        break;
      case 'AUTH':
        this.handleAuth(ws, msg as ClientAuthMessage);
        break;
      case 'PING':
        this.handlePing(ws, msg as ClientPingMessage);
        break;
      default: {
        const errorFrame: ServerErrorResponse = {
          error: { code: 400, message: `Unknown method: ${(msg as { method: string }).method}` },
          id: (msg as { id?: string | number }).id,
        };
        this.connectionManager.sendSafe(ws, JSON.stringify(errorFrame));
      }
    }
  }

  private async handleSubscribe(ws: WebSocket, msg: ClientSubscribeMessage): Promise<void> {
    const state = this.connectionManager.getConnection(ws);
    if (!state) return;

    if (!Array.isArray(msg.params)) {
      const errorFrame: ServerErrorResponse = {
        error: { code: 400, message: 'Params must be an array of topic strings' },
        id: msg.id,
      };
      this.connectionManager.sendSafe(ws, JSON.stringify(errorFrame));
      return;
    }

    if (state.subscriptions.size + msg.params.length > this.maxSubscriptions) {
      const errorFrame: ServerErrorResponse = {
        error: {
          code: 400,
          message: `Max subscriptions limit (${this.maxSubscriptions}) exceeded`,
        },
        id: msg.id,
      };
      this.connectionManager.sendSafe(ws, JSON.stringify(errorFrame));
      return;
    }

    for (const topic of msg.params) {
      if (typeof topic !== 'string' || topic.trim() === '') {
        const errorFrame: ServerErrorResponse = {
          error: { code: 400, message: 'Topic must be a non-empty string' },
          id: msg.id,
        };
        this.connectionManager.sendSafe(ws, JSON.stringify(errorFrame));
        return;
      }

      if (topic === 'user') {
        if (!state.userId) {
          const errorFrame: ServerErrorResponse = {
            error: {
              code: 401,
              message: "Authentication required for private stream 'user'",
            },
            id: msg.id,
          };
          this.connectionManager.sendSafe(ws, JSON.stringify(errorFrame));
          return;
        }
        this.connectionManager.subscribe(ws, 'user');
      } else if (topic.startsWith('depth@')) {
        const market = topic.slice('depth@'.length);
        this.connectionManager.subscribe(ws, topic);
        // Fetch and deliver initial snapshot immediately
        void this.redisSubscriber.fetchAndSendSnapshot(ws, market);
      } else if (
        topic.startsWith('trade@') ||
        topic.startsWith('ticker@') ||
        topic.startsWith('kline_')
      ) {
        this.connectionManager.subscribe(ws, topic);
      } else {
        const errorFrame: ServerErrorResponse = {
          error: { code: 400, message: `Unknown stream topic: ${topic}` },
          id: msg.id,
        };
        this.connectionManager.sendSafe(ws, JSON.stringify(errorFrame));
        return;
      }
    }

    const successFrame: ServerSuccessResponse = {
      result: null,
      id: msg.id,
    };
    this.connectionManager.sendSafe(ws, JSON.stringify(successFrame));
  }

  private handleUnsubscribe(ws: WebSocket, msg: ClientUnsubscribeMessage): void {
    if (!Array.isArray(msg.params)) {
      const errorFrame: ServerErrorResponse = {
        error: { code: 400, message: 'Params must be an array of topic strings' },
        id: msg.id,
      };
      this.connectionManager.sendSafe(ws, JSON.stringify(errorFrame));
      return;
    }

    for (const topic of msg.params) {
      if (typeof topic === 'string') {
        this.connectionManager.unsubscribe(ws, topic);
      }
    }

    const successFrame: ServerSuccessResponse = {
      result: null,
      id: msg.id,
    };
    this.connectionManager.sendSafe(ws, JSON.stringify(successFrame));
  }

  private handleAuth(ws: WebSocket, msg: ClientAuthMessage): void {
    if (typeof msg.token !== 'string' || !msg.token) {
      const errorFrame: ServerErrorResponse = {
        error: { code: 400, message: 'Token string is required for AUTH' },
        id: msg.id,
      };
      this.connectionManager.sendSafe(ws, JSON.stringify(errorFrame));
      return;
    }

    try {
      const decoded = jwt.verify(msg.token, this.jwtSecret) as { sub: string };
      if (!decoded || !decoded.sub) {
        throw new Error('Token missing sub claim');
      }

      this.connectionManager.authenticate(ws, decoded.sub);

      const successFrame: ServerSuccessResponse = {
        result: 'AUTH_SUCCESS',
        id: msg.id,
      };
      this.connectionManager.sendSafe(ws, JSON.stringify(successFrame));
    } catch {
      const errorFrame: ServerErrorResponse = {
        error: { code: 401, message: 'Invalid or expired token' },
        id: msg.id,
      };
      this.connectionManager.sendSafe(ws, JSON.stringify(errorFrame));
    }
  }

  private handlePing(ws: WebSocket, msg: ClientPingMessage): void {
    const state = this.connectionManager.getConnection(ws);
    if (state) {
      state.isAlive = true;
      state.missedPongs = 0;
    }

    const pongFrame: ServerSuccessResponse = {
      result: 'PONG',
      id: msg.id,
    };
    this.connectionManager.sendSafe(ws, JSON.stringify(pongFrame));
  }

  private runHeartbeat(): void {
    for (const state of this.connectionManager.getAllConnections()) {
      if (!state.isAlive) {
        state.missedPongs++;
        if (state.missedPongs >= 2) {
          try {
            state.socket.terminate();
          } catch {
            // ignore
          }
          this.connectionManager.removeConnection(state.socket);
          continue;
        }
      }

      state.isAlive = false;
      try {
        state.socket.ping();
      } catch {
        // socket may be closing
      }
    }
  }
}
