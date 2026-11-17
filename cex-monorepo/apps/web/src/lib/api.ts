import type {
  MarketConfig,
  Side,
  OrderType,
  OrderStatus,
} from '@cex/types';

export interface UserDto {
  id: string;
  email: string;
  kycLevel: number;
  role: 'USER' | 'ADMIN';
  createdAt?: string;
}

export interface AuthResponse {
  user: UserDto;
  accessToken: string;
}

export interface OrderDto {
  orderId: string;
  clientOrderId?: string;
  userId: string;
  market: string;
  side: Side;
  type: OrderType;
  price?: string;
  quantity: string;
  quoteQuantity?: string;
  filledQuantity: string;
  avgPrice?: string;
  status: OrderStatus;
  createdAt: number | string;
  updatedAt?: number | string;
}

export interface TradeDto {
  id: string;
  price: string;
  quantity: string;
  takerSide: Side;
  createdAt: string;
  engineSeq: string;
}

export interface TickerDto {
  market: string;
  high: string;
  low: string;
  baseVolume: string;
  quoteVolume: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: number;
  tradesCount: number;
  bestBid?: string;
  bestAsk?: string;
}

export interface CandleDto {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  x?: boolean;
}

export interface DepthDto {
  market: string;
  lastSeq: string;
  bids: [string, string][]; // [price, qty]
  asks: [string, string][];
}

export interface BalanceDto {
  asset: string;
  available: string;
  locked: string;
}

export interface DepositDto {
  id: string;
  userId: string;
  asset: string;
  amount: string;
  createdAt: string;
}

export interface WithdrawalDto {
  id: string;
  userId: string;
  asset: string;
  amount: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'COMPLETED';
  createdAt: string;
  decidedAt?: string;
}

export interface FeeReportDto {
  market: string;
  totalFeesQuote: string;
  tradeCount: number;
}

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly fields?: Record<string, string> | undefined;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

class ApiClient {
  private accessToken: string | null = null;
  private isRefreshing = false;
  private refreshPromise: Promise<string | null> | null = null;
  private onUnauthorizedCb: (() => void) | null = null;
  private baseUrl = process.env.NEXT_PUBLIC_API_URL || '';

  public setAccessToken(token: string | null) {
    this.accessToken = token;
  }

  public getAccessToken(): string | null {
    return this.accessToken;
  }

  public setOnUnauthorized(cb: () => void) {
    this.onUnauthorizedCb = cb;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    isRetry = false
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include', // sends refresh token cookie
    });

    // Handle 401 Unauthorized -> Refresh token flow
    if (response.status === 401 && !isRetry && !endpoint.includes('/auth/')) {
      const newToken = await this.refreshToken();
      if (newToken) {
        return this.request<T>(endpoint, options, true);
      } else {
        if (this.onUnauthorizedCb) this.onUnauthorizedCb();
        throw new ApiClientError(401, 'UNAUTHORIZED', 'Session expired. Please sign in again.');
      }
    }

    if (!response.ok) {
      let errorData: { error?: { code?: string; message?: string; fields?: Record<string, string> } } = {};
      try {
        errorData = await response.json();
      } catch {
        errorData = { error: { message: response.statusText, code: 'UNKNOWN_ERROR' } };
      }
      const code = errorData.error?.code || 'API_ERROR';
      const message = errorData.error?.message || response.statusText;
      const fields = errorData.error?.fields;
      throw new ApiClientError(response.status, code, message, fields);
    }

    return response.json();
  }

  public async refreshToken(): Promise<string | null> {
    if (this.isRefreshing && this.refreshPromise) {
      return this.refreshPromise;
    }

    this.isRefreshing = true;
    this.refreshPromise = (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });
        if (!res.ok) {
          this.setAccessToken(null);
          return null;
        }
        const data: AuthResponse = await res.json();
        this.setAccessToken(data.accessToken);
        return data.accessToken;
      } catch {
        this.setAccessToken(null);
        return null;
      } finally {
        this.isRefreshing = false;
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  // Auth Endpoints
  public readonly auth = {
    signup: (data: { email: string; password: string }) =>
      this.request<AuthResponse>('/api/v1/auth/signup', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    signin: (data: { email: string; password: string }) =>
      this.request<AuthResponse>('/api/v1/auth/signin', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    signout: () =>
      this.request<{ message: string }>('/api/v1/auth/signout', {
        method: 'POST',
      }),
    me: () => this.request<{ user: UserDto }>('/api/v1/auth/me'),
  };

  // Public Market Data
  public readonly markets = {
    list: () => this.request<{ markets: MarketConfig[] }>('/api/v1/markets'),
    getDepth: (market: string, limit = 50) =>
      this.request<DepthDto>(`/api/v1/depth?market=${market}&limit=${limit}`),
    getTrades: (market: string, limit = 50) =>
      this.request<{ market: string; trades: TradeDto[] }>(
        `/api/v1/trades?market=${market}&limit=${limit}`
      ),
    getTicker: (market?: string) =>
      this.request<{ ticker?: TickerDto; tickers?: TickerDto[] }>(
        market ? `/api/v1/ticker?market=${market}` : '/api/v1/ticker'
      ),
    getKlines: (market: string, interval = '15m', limit = 500) =>
      this.request<{ market: string; interval: string; candles: CandleDto[] }>(
        `/api/v1/klines?market=${market}&interval=${interval}&limit=${limit}`
      ),
  };

  // Trading & Orders
  public readonly orders = {
    place: (order: {
      market: string;
      side: Side;
      type: OrderType;
      price?: string;
      quantity?: string;
      quoteQuantity?: string;
      postOnly?: boolean;
      timeInForce?: 'GTC' | 'IOC' | 'FOK';
      clientOrderId?: string;
    }) =>
      this.request<{ order: OrderDto }>('/api/v1/order', {
        method: 'POST',
        body: JSON.stringify(order),
      }),
    cancel: (orderId: string) =>
      this.request<{ order: OrderDto }>(`/api/v1/order/${orderId}`, {
        method: 'DELETE',
      }),
    get: (orderId: string) =>
      this.request<{ order: OrderDto }>(`/api/v1/order/${orderId}`),
    getOpen: (market?: string) =>
      this.request<{ orders: OrderDto[] }>(
        market ? `/api/v1/orders/open?market=${market}` : '/api/v1/orders/open'
      ),
    getHistory: (market?: string, cursor?: string, limit = 50) => {
      const q = new URLSearchParams();
      if (market) q.set('market', market);
      if (cursor) q.set('cursor', cursor);
      q.set('limit', limit.toString());
      return this.request<{ orders: OrderDto[]; nextCursor?: string }>(
        `/api/v1/orders/history?${q.toString()}`
      );
    },
    getMyTrades: (market?: string, cursor?: string, limit = 50) => {
      const q = new URLSearchParams();
      if (market) q.set('market', market);
      if (cursor) q.set('cursor', cursor);
      q.set('limit', limit.toString());
      return this.request<{ trades: TradeDto[]; nextCursor?: string }>(
        `/api/v1/trades/mine?${q.toString()}`
      );
    },
  };

  // Balances & Wallet
  public readonly wallet = {
    getBalances: () =>
      this.request<{ balances: BalanceDto[] }>('/api/v1/balances'),
    deposit: (asset: string, amount: string) =>
      this.request<{ deposit: DepositDto; balance: BalanceDto }>('/api/v1/wallet/deposit', {
        method: 'POST',
        body: JSON.stringify({ asset, amount }),
      }),
    withdraw: (asset: string, amount: string) =>
      this.request<{ withdrawal: WithdrawalDto; balance?: BalanceDto }>('/api/v1/wallet/withdraw', {
        method: 'POST',
        body: JSON.stringify({ asset, amount }),
      }),
    getHistory: () =>
      this.request<{ deposits: DepositDto[]; withdrawals: WithdrawalDto[] }>(
        '/api/v1/wallet/history'
      ),
  };

  // Admin Controls
  public readonly admin = {
    createMarket: (market: {
      symbol: string;
      baseAsset: string;
      quoteAsset: string;
      tickSize: string;
      lotSize: string;
      minNotional: string;
      makerFeeBps?: number;
      takerFeeBps?: number;
    }) =>
      this.request<{ status: string; market: MarketConfig }>('/api/v1/admin/markets', {
        method: 'POST',
        body: JSON.stringify(market),
      }),
    updateMarket: (
      symbol: string,
      updates: {
        tickSize?: string;
        lotSize?: string;
        minNotional?: string;
        makerFeeBps?: number;
        takerFeeBps?: number;
      }
    ) =>
      this.request<{ status: string; market: MarketConfig }>(`/api/v1/admin/markets/${symbol}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      }),
    haltMarket: (symbol: string) =>
      this.request<{ status: string; symbol: string; marketStatus: string }>(
        `/api/v1/admin/markets/${symbol}/halt`,
        { method: 'POST' }
      ),
    resumeMarket: (symbol: string) =>
      this.request<{ status: string; symbol: string; marketStatus: string }>(
        `/api/v1/admin/markets/${symbol}/resume`,
        { method: 'POST' }
      ),
    approveWithdrawal: (id: string) =>
      this.request<{ status: string; withdrawal: WithdrawalDto }>(
        `/api/v1/admin/withdrawals/${id}/approve`,
        { method: 'POST' }
      ),
    rejectWithdrawal: (id: string) =>
      this.request<{ status: string; withdrawal: WithdrawalDto }>(
        `/api/v1/admin/withdrawals/${id}/reject`,
        { method: 'POST' }
      ),
    getFees: () =>
      this.request<{ status: string; fees: FeeReportDto[] }>('/api/v1/admin/fees'),
  };
}

export const api = new ApiClient();
