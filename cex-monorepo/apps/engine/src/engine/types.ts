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

/** Stubbed balance manager interface for Phase 6; full real balances plugged in Phase 7. */
export interface BalanceManager {
  checkAndLock(
    userId: string,
    asset: string,
    amount: bigint
  ): boolean;
  unlock(
    userId: string,
    asset: string,
    amount: bigint
  ): void;
}

export class StubBalanceManager implements BalanceManager {
  checkAndLock(_userId: string, _asset: string, _amount: bigint): boolean {
    return true; // Approves all locks in Phase 6
  }

  unlock(_userId: string, _asset: string, _amount: bigint): void {
    // No-op in Phase 6
  }
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
