import { describe, it, expect } from 'vitest';
import { parseInputToScaled, formatPrice, formatQty, formatPct } from './format';

describe('apps/web/src/lib/format.ts', () => {
  it('parseInputToScaled: parses valid decimals to 1e8 BigInt', () => {
    expect(parseInputToScaled('0')).toBe(0n);
    expect(parseInputToScaled('1')).toBe(100_000_000n);
    expect(parseInputToScaled('142.50')).toBe(14_250_000_000n);
    expect(parseInputToScaled('0.00000001')).toBe(1n);
    expect(parseInputToScaled('100.')).toBe(10_000_000_000n);
  });

  it('parseInputToScaled: rejects invalid decimal formats', () => {
    expect(() => parseInputToScaled('abc')).toThrow();
    expect(() => parseInputToScaled('1.2.3')).toThrow();
    expect(() => parseInputToScaled('0.123456789')).toThrow(); // > 8 decimals
    expect(() => parseInputToScaled('-5')).toThrow();
  });

  it('formatPrice: formats scaled BigInt into fixed decimal strings', () => {
    expect(formatPrice(14_250_000_000n, 2)).toBe('142.50');
    expect(formatPrice('14250000000', 2)).toBe('142.50');
    expect(formatPrice(100_000_000n, 2)).toBe('1.00');
    expect(formatPrice(0n, 2)).toBe('0.00');
    expect(formatPrice(142_555_000n, 4)).toBe('1.4255');
    // Resilient to null/undefined/"undefined"
    expect(formatPrice(null, 2)).toBe('0.00');
    expect(formatPrice(undefined, 2)).toBe('0.00');
    expect(formatPrice('undefined', 2)).toBe('0.00');
    expect(formatPrice('null', 2)).toBe('0.00');
    expect(formatPrice('', 2)).toBe('0.00');
  });

  it('formatQty: formats quantities accurately without floats', () => {
    expect(formatQty(100_000_000n, 4)).toBe('1.0000');
    expect(formatQty(125_000_000n, 2)).toBe('1.25');
    expect(formatQty(50_000_000n, 4)).toBe('0.5000');
    expect(formatQty(1n, 8)).toBe('0.00000001');
    // Resilient to null/undefined/"undefined"
    expect(formatQty(null, 4)).toBe('0.0000');
    expect(formatQty(undefined, 4)).toBe('0.0000');
    expect(formatQty('undefined', 4)).toBe('0.0000');
    expect(formatQty('null', 4)).toBe('0.0000');
  });

  it('formatPct: formats positive and negative percentage changes', () => {
    // 4.20% in 1e8 scaled: 4.20 * 100_000_000n = 420_000_000n
    expect(formatPct(420_000_000n)).toBe('+4.20%');
    expect(formatPct(-115_000_000n)).toBe('-1.15%');
    expect(formatPct(0n)).toBe('+0.00%');
    expect(formatPct(5.75)).toBe('+5.75%');
    expect(formatPct(-3.2)).toBe('-3.20%');
  });
});
