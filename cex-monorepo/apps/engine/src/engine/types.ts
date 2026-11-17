import {
  Command,
  CommandType,
  EngineReply,
  Event,
  EventType,
  MarketConfig,
  MarketStatus,
  OrderSnapshot,
  OrderStatus,
  OrderType,
  RejectCode,
  Side,
} from '@cex/types';
import { BalanceManager } from '../balance/balance-manager.js';
import { Book } from '../book/book.js';
import { EngineOrder } from '../book/types.js';

export interface EngineContext {
  engineSeq: bigint;
  now: number;
}

export interface ParsedMarketConfig {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: bigint;
  lotSize: bigint;
  minNotional: bigint;
  makerFeeBps: number;
  takerFeeBps: number;
  status: MarketStatus;
}

export interface MarketState {
  config: ParsedMarketConfig;
  book: Book;
}

export interface IdempotencyRecord {
  events: Event[];
  reply: EngineReply;
  ts: number;
  paramsHash?: string;
}

export interface EngineState {
  markets: Map<string, MarketState>;
  idempotency: Map<string, IdempotencyRecord>;
  clientOrderMap: Map<string, string>; // `${userId}:${clientOrderId}` -> commandId
  balanceManager: BalanceManager;
}

export interface ProcessResult {
  events: Event[];
  reply: EngineReply;
}

export {
  BalanceManager,
  Command,
  CommandType,
  EngineOrder,
  EngineReply,
  Event,
  EventType,
  MarketConfig,
  MarketStatus,
  OrderSnapshot,
  OrderStatus,
  OrderType,
  RejectCode,
  Side,
};
