import type { Redis } from 'ioredis';

export type DepthLevel = [string, string];

export interface DepthSnapshot {
  market: string;
  seq: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
  ts: number;
}

export interface DepthDeltaMessage {
  e: 'depthUpdate';
  s: string;
  seq: string;
  b: DepthLevel[];
  a: DepthLevel[];
  ts: number;
}

export interface TradeMessage {
  e: 'trade';
  s: string;
  tradeId: string;
  p: string;
  q: string;
  t: number;
  m: boolean;
  takerSide: 'BUY' | 'SELL';
  seq: string;
}

export interface TickerMessage {
  market: string;
  lastPrice: string;
  priceChange24h: string;
  priceChangePercent24h: string;
  high24h: string;
  low24h: string;
  volume24h: string;
  quoteVolume24h: string;
  tradeCount24h: number;
  bestBid: string | null;
  bestAsk: string | null;
  ts: number;
}

export type KlineInterval = '1m' | '5m' | '15m' | '1h' | '1d';

export interface KlineData {
  t: number;
  T: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  q: string;
  n: number;
  x: boolean;
}

export interface KlineMessage {
  e: 'kline';
  s: string;
  i: KlineInterval;
  k: KlineData;
}

export interface UserOrderUpdateMessage {
  e: 'orderUpdate';
  orderId: string;
  clientOrderId?: string | undefined;
  market: string;
  side: 'BUY' | 'SELL';
  price?: string | undefined;
  quantity: string;
  filledQuantity: string;
  status: string;
  ts: number;
}

export interface UserBalanceUpdateMessage {
  e: 'balanceUpdate';
  asset: string;
  available: string;
  locked: string;
  ts: number;
}

export interface MarketDataOptions {
  redisUrl?: string;
  redis?: Redis;
  streamEvents?: string;
  groupName?: string;
  consumerName?: string;
  throttleMs?: number;
  batchSize?: number;
  blockMs?: number;
}
