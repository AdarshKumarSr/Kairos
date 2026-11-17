import type {
  Command,
  CommandType,
  EngineReply,
  Event,
  EventType,
  MarketConfig,
  OrderSnapshot,
} from '@cex/types';
import { MarketStatus, OrderStatus, OrderType, RejectCode, Side } from '@cex/types';
import { BalanceManager } from '../balance/balance-manager.js';
import type { BalanceManagerSnapshot } from '../balance/balance-manager.js';
import { Book } from '../book/book.js';
import type { BookSnapshot, EngineOrder } from '../book/types.js';

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

export interface EngineMarketSnapshot {
  config: MarketConfig;
  book: BookSnapshot;
}

export interface EngineSnapshot {
  version: number;
  engineSeq: string;
  lastStreamId: string;
  timestamp: number;
  markets: EngineMarketSnapshot[];
  balances: BalanceManagerSnapshot;
  idempotency: Array<[string, IdempotencyRecord]>;
  clientOrderMap: Array<[string, string]>;
}

export interface RestoredEngine {
  state: EngineState;
  engineSeq: bigint;
  lastStreamId: string;
}

export interface ProcessResult {
  events: Event[];
  reply: EngineReply;
}

export { BalanceManager, MarketStatus, OrderStatus, OrderType, RejectCode, Side };
export type {
  BalanceManagerSnapshot,
  BookSnapshot,
  Command,
  CommandType,
  EngineOrder,
  EngineReply,
  Event,
  EventType,
  MarketConfig,
  OrderSnapshot,
};
