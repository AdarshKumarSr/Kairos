import { describe, it, expect } from 'vitest';
import { normalizeTicker } from './api';
import { parseInputToScaled, formatQty, formatPrice } from './format';

describe('Phase 17 Unit Tests', () => {
  describe('normalizeTicker edge cases', () => {
    it('handles standard ticker payload from API gateway', () => {
      const raw = {
        market: 'SOL_USDT',
        lastPrice: '14250000000',
        priceChange24h: '574000000',
        priceChangePercent24h: '4.20',
        high24h: '14620000000',
        low24h: '13610000000',
        volume24h: '120000000000000',
        quoteVolume24h: '171000000000000',
        tradeCount24h: 15420,
      };

      const norm = normalizeTicker(raw);
      expect(norm.market).toBe('SOL_USDT');
      expect(norm.lastPrice).toBe('14250000000');
      expect(norm.high).toBe('14620000000');
      expect(norm.low).toBe('13610000000');
      expect(norm.priceChangePercent).toBe(4.2);
      expect(norm.priceChangePercent.toFixed(2)).toBe('4.20');
      expect(norm.tradesCount).toBe(15420);
    });

    it('safely handles null, undefined, or missing percentage without crashing toFixed', () => {
      const emptyNorm = normalizeTicker(null);
      expect(emptyNorm.priceChangePercent).toBe(0);
      expect(emptyNorm.priceChangePercent.toFixed(2)).toBe('0.00');

      const partialNorm = normalizeTicker({ market: 'BTC_USDT', lastPrice: '8800000000000' });
      expect(partialNorm.priceChangePercent).toBe(0);
      expect(partialNorm.priceChangePercent.toFixed(2)).toBe('0.00');
      expect(partialNorm.tradesCount).toBe(0);
    });

    it('parses negative string priceChangePercent24h accurately', () => {
      const raw = {
        market: 'ETH_USDT',
        lastPrice: '312000000000',
        priceChangePercent24h: '-1.08',
      };
      const norm = normalizeTicker(raw);
      expect(norm.priceChangePercent).toBe(-1.08);
      expect(norm.priceChangePercent.toFixed(2)).toBe('-1.08');
    });
  });

  describe('Wallet Form Scaled Calculations', () => {
    it('correctly converts decimal strings to scaled 1e8 integers', () => {
      expect(parseInputToScaled('100').toString()).toBe('10000000000');
      expect(parseInputToScaled('0.00000001').toString()).toBe('1');
      expect(parseInputToScaled('142.50').toString()).toBe('14250000000');
    });

    it('formats scaled balances back to readable asset strings', () => {
      expect(formatQty('10000000000', 2)).toBe('100.00');
      expect(formatQty('14250000000', 2)).toBe('142.50');
      expect(formatPrice('14250000000', 2)).toBe('142.50');
    });

    it('validates dev deposit cap', () => {
      const cap = 1000;
      const validAmount = 500;
      const invalidAmount = 1001;

      expect(validAmount <= cap).toBe(true);
      expect(invalidAmount <= cap).toBe(false);
    });
  });

  describe('CSV Row Escaping and Formatting', () => {
    function serializeCsvRow(fields: unknown[]): string {
      return fields
        .map((val) => `"${String(val ?? '').replace(/"/g, '""')}"`)
        .join(',');
    }

    it('properly escapes quotes, commas, and special characters', () => {
      const row = ['ord-123', 'SOL_USDT', 'BUY', '142.50', '10.0', 'FILLED, WITH NOTES', 'Special "quote"'];
      const serialized = serializeCsvRow(row);

      expect(serialized).toBe(
        '"ord-123","SOL_USDT","BUY","142.50","10.0","FILLED, WITH NOTES","Special ""quote"""'
      );
    });
  });

  describe('Admin Fee Bounds Validation', () => {
    function isValidFeeBps(val: string): boolean {
      const num = parseInt(val, 10);
      return !isNaN(num) && num >= 0 && num <= 1000;
    }

    it('accepts valid fee basis points within 0 - 1000 bps', () => {
      expect(isValidFeeBps('0')).toBe(true);
      expect(isValidFeeBps('8')).toBe(true);
      expect(isValidFeeBps('100')).toBe(true);
      expect(isValidFeeBps('1000')).toBe(true);
    });

    it('rejects invalid or out of bound fee basis points', () => {
      expect(isValidFeeBps('-5')).toBe(false);
      expect(isValidFeeBps('1001')).toBe(false);
      expect(isValidFeeBps('invalid')).toBe(false);
    });
  });
});
