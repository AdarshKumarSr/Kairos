export type WsConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface DepthDeltaMessage {
  type: 'DEPTH_UPDATE';
  market: string;
  seq: string;
  deltas: [string, string][]; // [price, qty] (qty="0" means delete)
}

export interface DepthSnapshotMessage {
  type: 'DEPTH_SNAPSHOT';
  market: string;
  lastSeq: string;
  bids: [string, string][];
  asks: [string, string][];
}

export interface TradeMessage {
  type: 'TRADE';
  market: string;
  price: string;
  quantity: string;
  takerSide: 'BUY' | 'SELL';
  ts: number;
}

export interface TickerMessage {
  type: 'TICKER';
  market: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: number;
  high: string;
  low: string;
  baseVolume: string;
  quoteVolume: string;
  tradesCount: number;
}

export interface KlineMessage {
  type: 'KLINE';
  market: string;
  interval: string;
  candle: {
    t: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    x?: boolean;
  };
}

export interface UserEventMessage {
  type: 'USER_EVENT';
  event: 'ORDER_PLACED' | 'ORDER_UPDATED' | 'ORDER_CANCELLED' | 'TRADE' | 'BALANCE_UPDATED';
  data: unknown;
}

export type WsServerMessage =
  | DepthSnapshotMessage
  | DepthDeltaMessage
  | TradeMessage
  | TickerMessage
  | KlineMessage
  | UserEventMessage
  | { type: 'PONG' }
  | { type: 'ERROR'; error: { code: string; message: string } };

type MessageHandler = (msg: WsServerMessage) => void;
type StatusHandler = (status: WsConnectionStatus) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private url: string;
  private status: WsConnectionStatus = 'disconnected';
  private subscriptions = new Set<string>();
  private messageHandlers = new Map<string, Set<MessageHandler>>();
  private statusHandlers = new Set<StatusHandler>();
  private pendingQueue: unknown[] = [];
  private authToken: string | null = null;

  // Reconnection params
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isExplicitlyClosed = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  // Depth gap tracking per market
  private lastDepthSeq = new Map<string, bigint>();
  private onDepthGapCb?: (market: string) => void;

  constructor() {
    this.url = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080';
  }

  public setDepthGapHandler(cb: (market: string) => void) {
    this.onDepthGapCb = cb;
  }

  public setAuthToken(token: string | null) {
    this.authToken = token;
    if (token && this.status === 'connected') {
      this.send({ type: 'AUTH', token });
    }
  }

  public connect(customUrl?: string) {
    if (customUrl) this.url = customUrl;
    if (this.status === 'connected' || this.status === 'connecting') return;

    this.isExplicitlyClosed = false;
    this.setStatus(this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting');

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.setStatus('connected');
        this.startHeartbeat();

        // Re-authenticate if token exists
        if (this.authToken) {
          this.send({ type: 'AUTH', token: this.authToken });
        }

        // Resubscribe to all existing channels
        for (const channel of this.subscriptions) {
          this.send({ type: 'SUBSCRIBE', channel });
        }

        // Flush pending message queue
        while (this.pendingQueue.length > 0) {
          const item = this.pendingQueue.shift();
          this.send(item);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg: WsServerMessage = JSON.parse(event.data);
          this.handleIncoming(msg);
        } catch {
          // Ignore invalid JSON frames
        }
      };

      this.ws.onerror = () => {
        // Handled in onclose
      };

      this.ws.onclose = () => {
        this.cleanup();
        this.setStatus('disconnected');
        if (!this.isExplicitlyClosed) {
          this.scheduleReconnect();
        }
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  public disconnect() {
    this.isExplicitlyClosed = true;
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  public subscribe(channel: string, handler?: MessageHandler) {
    this.subscriptions.add(channel);
    if (handler) {
      if (!this.messageHandlers.has(channel)) {
        this.messageHandlers.set(channel, new Set());
      }
      this.messageHandlers.get(channel)!.add(handler);
    }

    if (this.status === 'connected') {
      this.send({ type: 'SUBSCRIBE', channel });
    } else if (this.status === 'disconnected') {
      this.connect();
    }
  }

  public unsubscribe(channel: string, handler?: MessageHandler) {
    if (handler && this.messageHandlers.has(channel)) {
      this.messageHandlers.get(channel)!.delete(handler);
    }

    // Only unsubscribe on wire if no handlers remain
    const remaining = this.messageHandlers.get(channel)?.size ?? 0;
    if (remaining === 0) {
      this.subscriptions.delete(channel);
      this.messageHandlers.delete(channel);
      if (this.status === 'connected') {
        this.send({ type: 'UNSUBSCRIBE', channel });
      }
    }
  }

  public onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  public getStatus(): WsConnectionStatus {
    return this.status;
  }

  public send(data: unknown) {
    if (this.ws && this.status === 'connected' && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      // Limit queue to 50 items
      if (this.pendingQueue.length < 50) {
        this.pendingQueue.push(data);
      }
    }
  }

  private handleIncoming(msg: WsServerMessage) {
    // 1. Check for Depth Gap Detection
    if (msg.type === 'DEPTH_SNAPSHOT') {
      this.lastDepthSeq.set(msg.market, BigInt(msg.lastSeq));
    } else if (msg.type === 'DEPTH_UPDATE') {
      const currentSeq = BigInt(msg.seq);
      const prevSeq = this.lastDepthSeq.get(msg.market);
      if (prevSeq !== undefined) {
        if (currentSeq > prevSeq + 1n) {
          // Detected sequence gap!
          if (this.onDepthGapCb) {
            this.onDepthGapCb(msg.market);
          }
          // Request snapshot resync
          this.send({ type: 'SUBSCRIBE', channel: `depth@${msg.market}` });
        }
      }
      this.lastDepthSeq.set(msg.market, currentSeq);
    }

    // 2. Dispatch to relevant channel listeners
    let channelKey = '';
    if (msg.type === 'DEPTH_SNAPSHOT' || msg.type === 'DEPTH_UPDATE') {
      channelKey = `depth@${msg.market}`;
    } else if (msg.type === 'TRADE') {
      channelKey = `trade@${msg.market}`;
    } else if (msg.type === 'TICKER') {
      channelKey = `ticker@${msg.market}`;
    } else if (msg.type === 'KLINE') {
      channelKey = `kline_${msg.interval}@${msg.market}`;
    } else if (msg.type === 'USER_EVENT') {
      channelKey = 'user';
    }

    if (channelKey && this.messageHandlers.has(channelKey)) {
      for (const handler of this.messageHandlers.get(channelKey)!) {
        handler(msg);
      }
    }

    // Also dispatch to catch-all '*' listeners if any
    if (this.messageHandlers.has('*')) {
      for (const handler of this.messageHandlers.get('*')!) {
        handler(msg);
      }
    }
  }

  private setStatus(status: WsConnectionStatus) {
    this.status = status;
    for (const h of this.statusHandlers) {
      h(status);
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    // Exponential backoff with jitter: min(10s, 500ms * 1.5^attempts) + random(0..500ms)
    const baseDelay = Math.min(10000, 500 * Math.pow(1.5, this.reconnectAttempts));
    const jitter = Math.random() * 500;
    const delay = baseDelay + jitter;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.status === 'connected') {
        this.send({ type: 'PING' });
      }
    }, 20000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private cleanup() {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export const wsClient = new WsClient();
