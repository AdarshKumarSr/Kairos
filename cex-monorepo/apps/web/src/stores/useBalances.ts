import { create } from 'zustand';
import type { BalanceDto } from '../lib/api';

interface BalancesState {
  balances: Record<string, BalanceDto>;

  setBalances: (balancesList: BalanceDto[]) => void;
  updateBalance: (asset: string, available: string, locked: string) => void;
  getBalance: (asset: string) => BalanceDto;
}

export const useBalances = create<BalancesState>((set, get) => ({
  balances: {},

  setBalances: (list) => {
    const map: Record<string, BalanceDto> = {};
    for (const b of list) {
      map[b.asset] = b;
    }
    set({ balances: map });
  },

  updateBalance: (asset, available, locked) => {
    set((state) => ({
      balances: {
        ...state.balances,
        [asset]: { asset, available, locked },
      },
    }));
  },

  getBalance: (asset) => {
    return get().balances[asset] || { asset, available: '0', locked: '0' };
  },
}));
