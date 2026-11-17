import { isMultipleOf, lockForBuyLimit, mulDiv, SCALE } from '@cex/money';
import { MarketStatus, OrderType, RejectCode, Side } from '@cex/types';
import { EngineState, MarketState, ParsedMarketConfig } from './types.js';

export interface ValidatedOrderPayload {
  orderId: string;
  clientOrderId?: string | undefined;
  userId: string;
  market: MarketState;
  side: Side;
  type: OrderType;
  price: bigint;
  quantity: bigint;
  quoteQuantity: bigint;
  postOnly: boolean;
  ioc: boolean;
  lockAsset: string;
  lockAmount: bigint;
}

export interface ValidationFailure {
  code: RejectCode;
  reason: string;
}

export type ValidationResult =
  | { success: true; order: ValidatedOrderPayload }
  | { success: false; failure: ValidationFailure };

function parseBigIntSafe(val: unknown): bigint | null {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'string') {
    if (!/^\d+$/.test(val)) return null;
    try {
      return BigInt(val);
    } catch {
      return null;
    }
  }
  return null;
}

export function validatePlaceOrder(
  state: EngineState,
  userId: string | undefined,
  payload: Record<string, string | boolean>
): ValidationResult {
  if (!userId) {
    return {
      success: false,
      failure: { code: RejectCode.INSUFFICIENT_FUNDS, reason: 'Missing userId' },
    };
  }

  const marketSymbol = String(payload.market ?? '');
  const market = state.markets.get(marketSymbol);
  if (!market || market.config.status !== MarketStatus.ACTIVE) {
    return {
      success: false,
      failure: {
        code: RejectCode.MARKET_NOT_ACTIVE,
        reason: `Market ${marketSymbol} is not active`,
      },
    };
  }

  const side = payload.side as Side;
  if (side !== Side.BUY && side !== Side.SELL) {
    return {
      success: false,
      failure: {
        code: RejectCode.INVALID_FLAGS,
        reason: 'Invalid order side',
      },
    };
  }

  const type = (payload.type ?? OrderType.LIMIT) as OrderType;
  if (type !== OrderType.LIMIT && type !== OrderType.MARKET) {
    return {
      success: false,
      failure: {
        code: RejectCode.INVALID_FLAGS,
        reason: 'Invalid order type',
      },
    };
  }

  const postOnly = Boolean(payload.postOnly ?? false);
  const ioc = Boolean(payload.ioc ?? false);

  // Section 4.2 Invalid combinations:
  // postOnly with ioc; postOnly with MARKET; MARKET with price;
  // market BUY without quoteQuantity; market SELL with quoteQuantity;
  // market BUY with quantity; market SELL without quantity;
  // LIMIT with quoteQuantity; LIMIT without price or quantity.
  if (postOnly && ioc) {
    return {
      success: false,
      failure: {
        code: RejectCode.INVALID_FLAGS,
        reason: 'postOnly cannot be combined with ioc',
      },
    };
  }

  if (postOnly && type === OrderType.MARKET) {
    return {
      success: false,
      failure: {
        code: RejectCode.INVALID_FLAGS,
        reason: 'postOnly cannot be used with market orders',
      },
    };
  }

  if (type === OrderType.MARKET && payload.price !== undefined) {
    return {
      success: false,
      failure: {
        code: RejectCode.INVALID_FLAGS,
        reason: 'price must not be specified for market orders',
      },
    };
  }

  if (type === OrderType.MARKET) {
    if (side === Side.BUY) {
      if (payload.quoteQuantity === undefined || payload.quantity !== undefined) {
        return {
          success: false,
          failure: {
            code: RejectCode.INVALID_FLAGS,
            reason: 'Market BUY requires quoteQuantity and forbids quantity',
          },
        };
      }
    } else {
      // Side.SELL
      if (payload.quantity === undefined || payload.quoteQuantity !== undefined) {
        return {
          success: false,
          failure: {
            code: RejectCode.INVALID_FLAGS,
            reason: 'Market SELL requires quantity and forbids quoteQuantity',
          },
        };
      }
    }
  }

  if (type === OrderType.LIMIT) {
    if (payload.quoteQuantity !== undefined) {
      return {
        success: false,
        failure: {
          code: RejectCode.INVALID_FLAGS,
          reason: 'quoteQuantity cannot be used with limit orders',
        },
      };
    }
    if (payload.price === undefined || payload.quantity === undefined) {
      return {
        success: false,
        failure: {
          code: RejectCode.INVALID_FLAGS,
          reason: 'Limit order requires both price and quantity',
        },
      };
    }
  }

  // Parse price, quantity, quoteQuantity
  let price = 0n;
  let quantity = 0n;
  let quoteQuantity = 0n;

  if (type === OrderType.LIMIT) {
    const parsedPrice = parseBigIntSafe(payload.price);
    if (parsedPrice === null || parsedPrice <= 0n) {
      return {
        success: false,
        failure: {
          code: RejectCode.INVALID_TICK,
          reason: 'Invalid limit price',
        },
      };
    }
    if (!isMultipleOf(parsedPrice, market.config.tickSize)) {
      return {
        success: false,
        failure: {
          code: RejectCode.INVALID_TICK,
          reason: `Price is not a multiple of tick size (${market.config.tickSize})`,
        },
      };
    }
    price = parsedPrice;

    const parsedQty = parseBigIntSafe(payload.quantity);
    if (parsedQty === null || parsedQty <= 0n) {
      return {
        success: false,
        failure: {
          code: RejectCode.INVALID_LOT,
          reason: 'Invalid limit quantity',
        },
      };
    }
    if (!isMultipleOf(parsedQty, market.config.lotSize)) {
      return {
        success: false,
        failure: {
          code: RejectCode.INVALID_LOT,
          reason: `Quantity is not a multiple of lot size (${market.config.lotSize})`,
        },
      };
    }
    quantity = parsedQty;

    // Notional check for LIMIT: (price * quantity) / SCALE >= minNotional
    const notional = mulDiv(price, quantity, SCALE);
    if (notional < market.config.minNotional) {
      return {
        success: false,
        failure: {
          code: RejectCode.BELOW_MIN_NOTIONAL,
          reason: `Order notional (${notional}) is below minNotional (${market.config.minNotional})`,
        },
      };
    }
  } else {
    // OrderType.MARKET
    if (side === Side.BUY) {
      const parsedQuote = parseBigIntSafe(payload.quoteQuantity);
      if (parsedQuote === null || parsedQuote <= 0n) {
        return {
          success: false,
          failure: {
            code: RejectCode.BELOW_MIN_NOTIONAL,
            reason: 'Invalid market buy quoteQuantity',
          },
        };
      }
      if (parsedQuote < market.config.minNotional) {
        return {
          success: false,
          failure: {
            code: RejectCode.BELOW_MIN_NOTIONAL,
            reason: `quoteQuantity is below minNotional (${market.config.minNotional})`,
          },
        };
      }
      quoteQuantity = parsedQuote;
    } else {
      // Side.SELL
      const parsedQty = parseBigIntSafe(payload.quantity);
      if (parsedQty === null || parsedQty <= 0n) {
        return {
          success: false,
          failure: {
            code: RejectCode.INVALID_LOT,
            reason: 'Invalid market sell quantity',
          },
        };
      }
      if (!isMultipleOf(parsedQty, market.config.lotSize)) {
        return {
          success: false,
          failure: {
            code: RejectCode.INVALID_LOT,
            reason: `Quantity is not a multiple of lot size (${market.config.lotSize})`,
          },
        };
      }
      quantity = parsedQty;
    }
  }

  // Calculate required lock
  // LIMIT BUY: lock ceil(price * quantity / SCALE) of quote asset
  // LIMIT SELL: lock quantity of base asset
  // MARKET BUY: lock quoteQuantity of quote asset
  // MARKET SELL: lock quantity of base asset
  let lockAsset = '';
  let lockAmount = 0n;

  if (side === Side.BUY) {
    lockAsset = market.config.quoteAsset;
    lockAmount = type === OrderType.LIMIT ? lockForBuyLimit(price, quantity) : quoteQuantity;
  } else {
    lockAsset = market.config.baseAsset;
    lockAmount = quantity;
  }

  // Balance lock check
  const lockSuccess = state.balanceManager.checkAndLock(userId, lockAsset, lockAmount);
  if (!lockSuccess) {
    return {
      success: false,
      failure: {
        code: RejectCode.INSUFFICIENT_FUNDS,
        reason: `Insufficient available ${lockAsset}`,
      },
    };
  }

  const orderId = String(payload.orderId ?? '');
  const clientOrderId = payload.clientOrderId !== undefined ? String(payload.clientOrderId) : undefined;

  return {
    success: true,
    order: {
      orderId,
      clientOrderId,
      userId,
      market,
      side,
      type,
      price,
      quantity,
      quoteQuantity,
      postOnly,
      ioc,
      lockAsset,
      lockAmount,
    },
  };
}
