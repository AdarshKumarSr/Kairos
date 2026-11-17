import { create } from 'zustand';

export interface BookLevel {
  price: string;
  quantity: string;
  total?: string;
}

interface BookState {
  bids: [string, string][];
  asks: [string, string][];
  lastSeq: string;
  spread: string | null;
  spreadPercent: string | null;

  setSnapshot: (bids: [string, string][], asks: [string, string][], seq: string) => void;
  applyDelta: (deltas: [string, string][], seq: string) => void;
  clear: () => void;
}

function calculateSpread(bestBid?: string, bestAsk?: string): { spread: string | null; spreadPercent: string | null } {
  if (!bestBid || !bestAsk) return { spread: null, spreadPercent: null };
  const bid = BigInt(bestBid);
  const ask = BigInt(bestAsk);
  if (ask <= bid) return { spread: '0.00', spreadPercent: '0.00%' };
  const diff = ask - bid;
  // Scaled 1e8: diff / 1e8 -> formatted
  const diffStr = (Number(diff) / 1e8).toFixed(2);
  const pct = ((Number(diff) / Number(ask)) * 100).toFixed(2);
  return { spread: diffStr, spreadPercent: `${pct}%` };
}

export const useBook = create<BookState>((set) => ({
  bids: [],
  asks: [],
  lastSeq: '0',
  spread: null,
  spreadPercent: null,

  setSnapshot: (bids, asks, seq) => {
    // Ensure bids are sorted descending (highest first)
    const sortedBids = [...bids].sort((a, b) => (BigInt(b[0]) > BigInt(a[0]) ? 1 : -1));
    // Ensure asks are sorted ascending (lowest first)
    const sortedAsks = [...asks].sort((a, b) => (BigInt(a[0]) > BigInt(b[0]) ? 1 : -1));

    const { spread, spreadPercent } = calculateSpread(sortedBids[0]?.[0], sortedAsks[0]?.[0]);

    set({
      bids: sortedBids,
      asks: sortedAsks,
      lastSeq: seq,
      spread,
      spreadPercent,
    });
  },

  applyDelta: (deltas, seq) => {
    set((state) => {
      const bidMap = new Map<string, string>(state.bids);
      const askMap = new Map<string, string>(state.asks);

      for (const [price, qty] of deltas) {
        if (qty === '0' || qty === '0.00000000') {
          bidMap.delete(price);
          askMap.delete(price);
        } else {
          // If price is <= best bid or lower, it's a bid; if >= best ask or higher, it's an ask
          const bestBid = state.bids[0]?.[0];
          const bestAsk = state.asks[0]?.[0];
          const priceBig = BigInt(price);

          if (bestBid && priceBig <= BigInt(bestBid)) {
            bidMap.set(price, qty);
          } else if (bestAsk && priceBig >= BigInt(bestAsk)) {
            askMap.set(price, qty);
          } else {
            // Default to whichever map it was in previously, or compare with midpoint
            if (bidMap.has(price)) bidMap.set(price, qty);
            else if (askMap.has(price)) askMap.set(price, qty);
            else bidMap.set(price, qty);
          }
        }
      }

      const updatedBids = Array.from(bidMap.entries())
        .sort((a, b) => (BigInt(b[0]) > BigInt(a[0]) ? 1 : -1))
        .slice(0, 50);

      const updatedAsks = Array.from(askMap.entries())
        .sort((a, b) => (BigInt(a[0]) > BigInt(b[0]) ? 1 : -1))
        .slice(0, 50);

      const { spread, spreadPercent } = calculateSpread(updatedBids[0]?.[0], updatedAsks[0]?.[0]);

      return {
        bids: updatedBids,
        asks: updatedAsks,
        lastSeq: seq,
        spread,
        spreadPercent,
      };
    });
  },

  clear: () => set({ bids: [], asks: [], lastSeq: '0', spread: null, spreadPercent: null }),
}));
