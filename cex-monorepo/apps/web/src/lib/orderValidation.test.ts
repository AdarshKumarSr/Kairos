import { describe, it, expect } from 'vitest';
import { calculateSliderAmount, validateOrder, getRejectMessage } from './orderValidation';
import { MarketStatus, RejectCode, type MarketConfig } from '@cex/types';
import { toScaled } from '@cex/money';

const sampleMarket: MarketConfig = {
  symbol: 'SOL_USDT',
  baseAsset: 'SOL',
  quoteAsset: 'USDT',
  tickSize: '1000000', // 0.01 USDT
  lotSize: '1000000',  // 0.01 SOL
  minNotional: '500000000', // 5.00 USDT
  makerFeeBps: 8,
  takerFeeBps: 10,
  status: MarketStatus.ACTIVE,
};

describe('Order Validation and Slider Math (Zero Float)', () => {
  it('computes 50% slider quantity for BUY LIMIT using BigInt', () => {
    // User has 100 USDT (100 * 1e8)
    const availQuote = toScaled('100');
    // Price = 10 USDT (10 * 1e8)
    const priceScaled = toScaled('10');
    const lotSize = toScaled('0.01');

    const result = calculateSliderAmount({
      side: 'BUY',
      orderType: 'LIMIT',
      pct: 50,
      availableQuote: availQuote,
      availableBase: 0n,
      priceScaled,
      lotSize,
    });

    // 50% of 100 USDT = 50 USDT -> at 10 USDT/SOL = 5 SOL
    expect(result.quantity).toBe(toScaled('5'));
    expect(result.quoteAmount).toBe(toScaled('50'));
  });

  it('snaps BUY LIMIT quantity to lotSize boundary', () => {
    // User has 10 USDT. Price = 3 USDT. Lot = 0.5 SOL
    const availQuote = toScaled('10');
    const priceScaled = toScaled('3');
    const lotSize = toScaled('0.5');

    const result = calculateSliderAmount({
      side: 'BUY',
      orderType: 'LIMIT',
      pct: 100,
      availableQuote: availQuote,
      availableBase: 0n,
      priceScaled,
      lotSize,
    });

    // 10 / 3 = 3.33333333 SOL -> snapped to 0.5 lot = 3.0 SOL
    expect(result.quantity).toBe(toScaled('3.0'));
  });

  it('computes 25% slider quantity for SELL LIMIT', () => {
    // User has 20 SOL
    const availBase = toScaled('20');
    const lotSize = toScaled('0.01');

    const result = calculateSliderAmount({
      side: 'SELL',
      orderType: 'LIMIT',
      pct: 25,
      availableQuote: 0n,
      availableBase: availBase,
      priceScaled: toScaled('150'),
      lotSize,
    });

    // 25% of 20 = 5 SOL
    expect(result.quantity).toBe(toScaled('5'));
  });

  it('validates tick size and lot size multiples', () => {
    // Valid order
    const validRes = validateOrder({
      side: 'BUY',
      type: 'LIMIT',
      priceScaled: toScaled('142.50'),
      quantityScaled: toScaled('1.00'),
      quoteQuantityScaled: 0n,
      marketConfig: sampleMarket,
      availableQuote: toScaled('1000'),
      availableBase: 0n,
    });
    expect(validRes.valid).toBe(true);

    // Invalid tick (price not multiple of 0.01)
    const invalidTick = validateOrder({
      side: 'BUY',
      type: 'LIMIT',
      priceScaled: 142501234n, // not multiple of 1000000
      quantityScaled: toScaled('1.00'),
      quoteQuantityScaled: 0n,
      marketConfig: sampleMarket,
      availableQuote: toScaled('1000'),
      availableBase: 0n,
    });
    expect(invalidTick.valid).toBe(false);
    expect(invalidTick.errors.price).toBeDefined();

    // Below min notional (< 5 USDT)
    const belowMinNotional = validateOrder({
      side: 'BUY',
      type: 'LIMIT',
      priceScaled: toScaled('1.00'),
      quantityScaled: toScaled('1.00'), // notional = 1 USDT < 5 USDT
      quoteQuantityScaled: 0n,
      marketConfig: sampleMarket,
      availableQuote: toScaled('1000'),
      availableBase: 0n,
    });
    expect(belowMinNotional.valid).toBe(false);
    expect(belowMinNotional.errors.quantity).toContain('minimum notional');

    // Insufficient balance
    const insufficient = validateOrder({
      side: 'BUY',
      type: 'LIMIT',
      priceScaled: toScaled('140.00'),
      quantityScaled: toScaled('10.00'), // notional = 1400 USDT
      quoteQuantityScaled: 0n,
      marketConfig: sampleMarket,
      availableQuote: toScaled('500'), // only 500 USDT available
      availableBase: 0n,
    });
    expect(insufficient.valid).toBe(false);
    expect(insufficient.errors.general).toContain('Insufficient USDT');
  });

  it('maps rejection codes correctly', () => {
    expect(getRejectMessage(RejectCode.INSUFFICIENT_FUNDS)).toBe(
      'Insufficient funds in your account for this order.'
    );
    expect(getRejectMessage(RejectCode.POST_ONLY_WOULD_CROSS)).toContain(
      'Post-Only order would have crossed'
    );
    expect(getRejectMessage('UNKNOWN_CODE')).toContain('UNKNOWN_CODE');
  });
});
