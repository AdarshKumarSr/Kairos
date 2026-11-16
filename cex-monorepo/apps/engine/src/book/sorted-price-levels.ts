import { Side } from '@cex/types';
import { PriceLevel } from './price-level.js';
import type { DepthLevel } from './types.js';

export class SortedPriceLevels {
  readonly side: Side;
  private readonly levels: PriceLevel[] = [];
  private readonly levelMap: Map<bigint, PriceLevel> = new Map();

  constructor(side: Side) {
    this.side = side;
  }

  get length(): number {
    return this.levels.length;
  }

  get totalQuantity(): bigint {
    let total = 0n;
    for (const level of this.levels) {
      total += level.totalQuantity;
    }
    return total;
  }

  best(): PriceLevel | null {
    return this.levels[0] ?? null;
  }

  getLevel(price: bigint): PriceLevel | null {
    return this.levelMap.get(price) ?? null;
  }

  getOrCreateLevel(price: bigint): PriceLevel {
    const existing = this.levelMap.get(price);
    if (existing) {
      return existing;
    }

    const newLevel = new PriceLevel(price);
    this.levelMap.set(price, newLevel);

    const index = this.findInsertIndex(price);
    this.levels.splice(index, 0, newLevel);
    return newLevel;
  }

  deleteLevel(price: bigint): boolean {
    if (!this.levelMap.has(price)) {
      return false;
    }
    this.levelMap.delete(price);
    const index = this.findIndex(price);
    if (index >= 0) {
      this.levels.splice(index, 1);
      return true;
    }
    return false;
  }

  topN(n: number): DepthLevel[] {
    const limit = Math.min(n, this.levels.length);
    const result: DepthLevel[] = [];
    for (let i = 0; i < limit; i++) {
      const level = this.levels[i]!;
      result.push({
        price: level.price,
        quantity: level.totalQuantity,
        orderCount: level.orderCount,
      });
    }
    return result;
  }

  getAllLevels(): readonly PriceLevel[] {
    return this.levels;
  }

  clear(): void {
    this.levels.length = 0;
    this.levelMap.clear();
  }

  private findIndex(price: bigint): number {
    let low = 0;
    let high = this.levels.length - 1;
    const isBids = this.side === Side.BUY;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      const midPrice = this.levels[mid]!.price;

      if (midPrice === price) {
        return mid;
      }

      if (isBids) {
        // Bids: descending
        if (midPrice < price) {
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      } else {
        // Asks: ascending
        if (midPrice > price) {
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
    }
    return -1;
  }

  private findInsertIndex(price: bigint): number {
    let low = 0;
    let high = this.levels.length - 1;
    const isBids = this.side === Side.BUY;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      const midPrice = this.levels[mid]!.price;

      if (midPrice === price) {
        return mid;
      }

      if (isBids) {
        // Bids: descending
        if (midPrice < price) {
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      } else {
        // Asks: ascending
        if (midPrice > price) {
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
    }
    return low;
  }
}
