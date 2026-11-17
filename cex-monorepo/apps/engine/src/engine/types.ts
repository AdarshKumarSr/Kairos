import {
  Command,
  CommandType,
  Event,
  EventType,
  MarketConfig,
  MarketStatus,
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

export interface EngineState {
  markets: Map<string, MarketState>;
  idempotency: Map<string, Event[]>;
  clientOrderMap: Map<string, string>; // `${userId}:${clientOrderId}` -> commandId
  balanceManager: BalanceManager;
}

export interface ProcessResult {
  events: Event[];
}

export {
  BalanceManager,
  Command,
  CommandType,
  EngineOrder,
  Event,
  EventType,
  MarketConfig,
  MarketStatus,
  OrderStatus,
  OrderType,
  RejectCode,
  Side,
};
