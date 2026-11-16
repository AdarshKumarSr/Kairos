import { Side } from '@cex/types';

export interface EngineOrder {
  orderId: string;
  userId: string;
  market: string;
  side: Side;
  type: 'LIMIT' | 'MARKET';
  price: bigint; // 0n for market orders
  quantity: bigint; // original total quantity
  filled: bigint; // quantity filled so far
  engineSeq: bigint; // strict time priority
  postOnly: boolean;
  ioc: boolean;
  lockedAmount: bigint; // remaining lock for this order
}

export interface DepthLevel {
  price: bigint;
  quantity: bigint;
  orderCount: number;
}

export interface DepthLadder {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface SerializedOrder {
  orderId: string;
  userId: string;
  market: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  price: string;
  quantity: string;
  filled: string;
  engineSeq: string;
  postOnly: boolean;
  ioc: boolean;
  lockedAmount: string;
}

export interface SerializedPriceLevel {
  price: string;
  totalQuantity: string;
  orders: SerializedOrder[];
}

export interface BookSnapshot {
  market: string;
  bids: SerializedPriceLevel[];
  asks: SerializedPriceLevel[];
  totalBidQuantity: string;
  totalAskQuantity: string;
  orderCount: number;
}
