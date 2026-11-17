import { create } from 'zustand';
import type { OrderDto, TradeDto } from '../lib/api';

interface OrdersState {
  openOrders: OrderDto[];
  orderHistory: OrderDto[];
  trades: TradeDto[];

  setOpenOrders: (orders: OrderDto[]) => void;
  addOpenOrder: (order: OrderDto) => void;
  updateOrder: (order: OrderDto) => void;
  removeOpenOrder: (orderId: string) => void;

  setHistory: (orders: OrderDto[]) => void;
  setTrades: (trades: TradeDto[]) => void;
  addTrade: (trade: TradeDto) => void;
}

export const useOrders = create<OrdersState>((set) => ({
  openOrders: [],
  orderHistory: [],
  trades: [],

  setOpenOrders: (orders) => set({ openOrders: orders }),

  addOpenOrder: (order) =>
    set((state) => {
      // Don't add duplicate
      if (state.openOrders.some((o) => o.orderId === order.orderId)) {
        return state;
      }
      return { openOrders: [order, ...state.openOrders] };
    }),

  updateOrder: (order) =>
    set((state) => {
      const isTerminal =
        order.status === 'FILLED' ||
        order.status === 'CANCELLED' ||
        order.status === 'REJECTED';

      const updatedOpen = isTerminal
        ? state.openOrders.filter((o) => o.orderId !== order.orderId)
        : state.openOrders.map((o) => (o.orderId === order.orderId ? order : o));

      // If terminal, add/update in history
      const updatedHistory = isTerminal
        ? [order, ...state.orderHistory.filter((o) => o.orderId !== order.orderId)]
        : state.orderHistory;

      return { openOrders: updatedOpen, orderHistory: updatedHistory };
    }),

  removeOpenOrder: (orderId) =>
    set((state) => ({
      openOrders: state.openOrders.filter((o) => o.orderId !== orderId),
    })),

  setHistory: (orders) => set({ orderHistory: orders }),

  setTrades: (trades) => set({ trades }),

  addTrade: (trade) =>
    set((state) => {
      if (state.trades.some((t) => t.id === trade.id)) return state;
      return { trades: [trade, ...state.trades.slice(0, 99)] };
    }),
}));
