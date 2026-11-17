import { SCALE } from '@cex/money';
import { RejectCode, type MarketConfig } from '@cex/types';

export interface SliderCalcParams {
  side: 'BUY' | 'SELL';
  orderType: 'LIMIT' | 'MARKET';
  pct: 25 | 50 | 75 | 100;
  availableQuote: bigint; // USDT scaled 1e8
  availableBase: bigint;  // Base scaled 1e8
  priceScaled?: bigint;   // Scaled 1e8
  lotSize: bigint;
}

/**
 * Computes quantity or quote budget using pure BigInt math.
 * Snaps to lotSize multiples.
 */
export function calculateSliderAmount(params: SliderCalcParams): {
  quantity: bigint;
  quoteAmount: bigint;
} {
  const { side, orderType, pct, availableQuote, availableBase, priceScaled, lotSize } = params;
  const pctBig = BigInt(pct);

  if (side === 'BUY') {
    if (orderType === 'MARKET') {
      // For Market Buy: calculate quote spend budget
      const budget = (availableQuote * pctBig) / 100n;
      return { quantity: 0n, quoteAmount: budget };
    }

    // For Limit Buy: need price
    if (!priceScaled || priceScaled <= 0n) {
      return { quantity: 0n, quoteAmount: 0n };
    }

    // Allocate quote amount = availableQuote * pct / 100
    const quoteToSpend = (availableQuote * pctBig) / 100n;
    // Quantity = (quoteToSpend * SCALE) / priceScaled
    const rawQty = (quoteToSpend * SCALE) / priceScaled;
    // Snap to lotSize
    const validLot = lotSize > 0n ? lotSize : 1n;
    const snappedQty = (rawQty / validLot) * validLot;
    const actualSpend = (snappedQty * priceScaled) / SCALE;

    return { quantity: snappedQty, quoteAmount: actualSpend };
  } else {
    // SELL (Limit or Market): allocate base asset
    const rawQty = (availableBase * pctBig) / 100n;
    const validLot = lotSize > 0n ? lotSize : 1n;
    const snappedQty = (rawQty / validLot) * validLot;

    let quoteAmount = 0n;
    if (priceScaled && priceScaled > 0n) {
      quoteAmount = (snappedQty * priceScaled) / SCALE;
    }

    return { quantity: snappedQty, quoteAmount };
  }
}

export interface ValidationParams {
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  priceScaled: bigint;
  quantityScaled: bigint;
  quoteQuantityScaled: bigint;
  marketConfig: MarketConfig;
  availableQuote: bigint;
  availableBase: bigint;
}

export interface ValidationResult {
  valid: boolean;
  errors: {
    price?: string;
    quantity?: string;
    quoteQuantity?: string;
    general?: string;
  };
  notional: bigint;
  estimatedFee: bigint;
}

/**
 * Pure client-side validation of order params before submission.
 */
export function validateOrder(params: ValidationParams): ValidationResult {
  const {
    side,
    type,
    priceScaled,
    quantityScaled,
    quoteQuantityScaled,
    marketConfig,
    availableQuote,
    availableBase,
  } = params;

  const errors: ValidationResult['errors'] = {};
  const tickSize = BigInt(marketConfig.tickSize);
  const lotSize = BigInt(marketConfig.lotSize);
  const minNotional = BigInt(marketConfig.minNotional);

  let notional = 0n;
  let estimatedFee = 0n;
  const feeBps = BigInt(type === 'MARKET' ? marketConfig.takerFeeBps : marketConfig.makerFeeBps);

  if (type === 'LIMIT') {
    // 1. Price validation
    if (priceScaled <= 0n) {
      errors.price = 'Price must be greater than 0';
    } else if (tickSize > 0n && priceScaled % tickSize !== 0n) {
      errors.price = `Price must be a multiple of tick size (${marketConfig.tickSize})`;
    }

    // 2. Quantity validation
    if (quantityScaled <= 0n) {
      errors.quantity = 'Quantity must be greater than 0';
    } else if (lotSize > 0n && quantityScaled % lotSize !== 0n) {
      errors.quantity = `Quantity must be a multiple of lot size (${marketConfig.lotSize})`;
    }

    // 3. Min Notional validation
    if (priceScaled > 0n && quantityScaled > 0n) {
      notional = (priceScaled * quantityScaled) / SCALE;
      if (notional < minNotional) {
        errors.quantity = `Total order value must be at least minimum notional (${marketConfig.minNotional})`;
      }

      // Estimated fee (in quote asset)
      estimatedFee = (notional * feeBps) / 10000n;

      // 4. Balance check
      if (side === 'BUY') {
        const required = notional;
        if (required > availableQuote) {
          errors.general = 'Insufficient USDT balance for this order';
        }
      } else {
        if (quantityScaled > availableBase) {
          errors.general = `Insufficient ${marketConfig.baseAsset} balance for this order`;
        }
      }
    }
  } else {
    // MARKET Order
    if (side === 'BUY') {
      if (quoteQuantityScaled <= 0n) {
        errors.quoteQuantity = 'Amount to spend must be greater than 0';
      } else if (quoteQuantityScaled < minNotional) {
        errors.quoteQuantity = `Amount to spend must be at least minimum notional (${marketConfig.minNotional})`;
      } else if (quoteQuantityScaled > availableQuote) {
        errors.general = 'Insufficient USDT balance for this order';
      }
      notional = quoteQuantityScaled;
      estimatedFee = (notional * feeBps) / 10000n;
    } else {
      // SELL Market
      if (quantityScaled <= 0n) {
        errors.quantity = 'Quantity must be greater than 0';
      } else if (lotSize > 0n && quantityScaled % lotSize !== 0n) {
        errors.quantity = `Quantity must be a multiple of lot size (${marketConfig.lotSize})`;
      } else if (quantityScaled > availableBase) {
        errors.general = `Insufficient ${marketConfig.baseAsset} balance for this order`;
      }
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    notional,
    estimatedFee,
  };
}

/**
 * Maps engine rejection codes to human-friendly feedback messages.
 */
export function getRejectMessage(code?: RejectCode | string): string {
  if (!code) return 'Order was rejected.';

  switch (code) {
    case RejectCode.INSUFFICIENT_FUNDS:
      return 'Insufficient funds in your account for this order.';
    case RejectCode.MARKET_NOT_ACTIVE:
      return 'Market is currently halted or inactive.';
    case RejectCode.INVALID_TICK:
      return 'Price does not match market tick size.';
    case RejectCode.INVALID_LOT:
      return 'Quantity does not match market lot size.';
    case RejectCode.BELOW_MIN_NOTIONAL:
      return 'Order value is below the minimum required notional amount.';
    case RejectCode.INVALID_FLAGS:
      return 'Invalid order execution flags.';
    case RejectCode.POST_ONLY_WOULD_CROSS:
      return 'Post-Only order would have crossed the order book and executed as taker.';
    case RejectCode.SELF_TRADE:
      return 'Order rejected to prevent self-trading.';
    case RejectCode.DUPLICATE_ORDER:
      return 'Duplicate order submission detected.';
    case RejectCode.ORDER_NOT_FOUND:
      return 'Order was not found or has already finished.';
    case RejectCode.NOT_OWNER:
      return 'You are not authorized to cancel this order.';
    default:
      return `Order rejected (${code}).`;
  }
}
