import { create } from 'zustand';
import type { MarketConfig } from '@cex/types';
import type { TickerDto } from '../lib/api';

interface MarketState {
  markets: MarketConfig[];
  activeSymbol: string;
  activeMarket: MarketConfig | null;
  ticker: TickerDto | null;
  tickers: Record<string, TickerDto>;

  setMarkets: (markets: MarketConfig[]) => void;
  setActiveSymbol: (symbol: string) => void;
  setTicker: (ticker: TickerDto) => void;
  updateTickers: (tickers: TickerDto[]) => void;
}

export const useMarket = create<MarketState>((set, get) => ({
  markets: [],
  activeSymbol: 'SOL_USDT',
  activeMarket: null,
  ticker: null,
  tickers: {},

  setMarkets: (markets) => {
    const active = markets.find((m) => m.symbol === get().activeSymbol) || markets[0] || null;
    set({
      markets,
      activeMarket: active,
      activeSymbol: active ? active.symbol : get().activeSymbol,
    });
  },

  setActiveSymbol: (symbol) => {
    const active = get().markets.find((m) => m.symbol === symbol) || null;
    const currentTicker = get().tickers[symbol] || null;
    set({
      activeSymbol: symbol,
      activeMarket: active,
      ticker: currentTicker,
    });
  },

  setTicker: (ticker) => {
    set((state) => ({
      ticker: ticker.market === state.activeSymbol ? ticker : state.ticker,
      tickers: { ...state.tickers, [ticker.market]: ticker },
    }));
  },

  updateTickers: (tickersList) => {
    const map: Record<string, TickerDto> = { ...get().tickers };
    for (const t of tickersList) {
      map[t.market] = t;
    }
    const currentActive = map[get().activeSymbol] || get().ticker;
    set({ tickers: map, ticker: currentActive });
  },
}));
