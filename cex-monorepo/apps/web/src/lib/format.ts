import { toScaled, SCALE } from '@cex/money';

/**
 * Parses a user input string (e.g. "142.50", "0.01") into scaled 1e8 BigInt.
 * Throws if input is invalid or has > 8 decimals.
 */
export function parseInputToScaled(input: string): bigint {
  const trimmed = input.trim();
  if (!trimmed || trimmed === '0' || trimmed === '0.0') return 0n;
  // If user inputs e.g. "142." treat as "142"
  const sanitized = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  return toScaled(sanitized);
}

/**
 * Formats a scaled BigInt or string into a display price string (e.g. "142.50").
 * Preserves exact decimals up to specified precision without floating-point math.
 */
export function formatPrice(priceScaled: bigint | string, precision: number = 2): string {
  const bi = typeof priceScaled === 'bigint' ? priceScaled : BigInt(priceScaled || '0');
  const negative = bi < 0n;
  const abs = negative ? -bi : bi;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(8, '0');
  const truncatedFrac = fraction.slice(0, precision).padEnd(precision, '0');
  const res = precision > 0 ? `${whole}.${truncatedFrac}` : whole.toString();
  return negative ? `-${res}` : res;
}

/**
 * Formats a scaled BigInt or string into a display quantity string (e.g. "1.2500").
 */
export function formatQty(qtyScaled: bigint | string, precision: number = 4): string {
  const bi = typeof qtyScaled === 'bigint' ? qtyScaled : BigInt(qtyScaled || '0');
  const negative = bi < 0n;
  const abs = negative ? -bi : bi;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(8, '0');
  let trimmed = fraction.slice(0, precision);
  // Ensure at least minimum pad or trim trailing if desired
  if (precision > 0) {
    trimmed = trimmed.padEnd(precision, '0');
    const res = `${whole}.${trimmed}`;
    return negative ? `-${res}` : res;
  }
  return negative ? `-${whole}` : whole.toString();
}

/**
 * Formats a percentage change (e.g. +4.20%, -1.15%).
 * Input can be scaled 1e8, basis points (1/100th of 1%), or a decimal representation.
 */
export function formatPct(val: bigint | string | number): string {
  if (typeof val === 'number') {
    const sign = val > 0 ? '+' : '';
    return `${sign}${val.toFixed(2)}%`;
  }
  const bi = typeof val === 'bigint' ? val : BigInt(val || '0');
  // Scaled 1e8: 100% = 100 * 1e8 = 10_000_000_000n.
  // 1% = 1e8 = 100_000_000n.
  const isNegative = bi < 0n;
  const abs = isNegative ? -bi : bi;
  // Percentage = abs / 1_000_000n (gives whole pct + 2 decimals)
  const hundredths = abs / 1_000_000n; // 1% = 100 hundredths
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  const prefix = isNegative ? '-' : '+';
  return `${prefix}${whole}.${fraction}%`;
}

/**
 * Formats raw BigInt asset balance into standard human-readable display string.
 */
export function formatBalance(balanceScaled: bigint | string, precision: number = 4): string {
  return formatQty(balanceScaled, precision);
}
