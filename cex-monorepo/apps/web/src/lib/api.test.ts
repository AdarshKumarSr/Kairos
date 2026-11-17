import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Side, OrderType } from '@cex/types';
import { api, ApiClientError } from './api';

describe('apps/web/src/lib/api.ts', () => {
  beforeEach(() => {
    api.setAccessToken(null);
    vi.restoreAllMocks();
  });

  it('manages accessToken in memory', () => {
    expect(api.getAccessToken()).toBeNull();
    api.setAccessToken('test-token-123');
    expect(api.getAccessToken()).toBe('test-token-123');
  });

  it('handles 401 and calls /auth/refresh automatically', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    // First call: GET /api/v1/orders/open returns 401
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'Token expired' } }),
    });

    // Refresh call: POST /api/v1/auth/refresh returns new token
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        user: { id: 'u1', email: 'test@example.com', role: 'USER' },
        accessToken: 'refreshed-token-456',
      }),
    });

    // Retry call: GET /api/v1/orders/open succeeds
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ orders: [] }),
    });

    const res = await api.orders.getOpen();
    expect(res).toEqual({ orders: [] });
    expect(api.getAccessToken()).toBe('refreshed-token-456');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws ApiClientError with code and fields on error responses', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      json: async () => ({
        error: {
          code: 'INVALID_TICK',
          message: 'Price must be a multiple of tick size',
        },
      }),
    });

    try {
      await api.orders.place({
        market: 'SOL_USDT',
        side: Side.BUY,
        type: OrderType.LIMIT,
        price: '142.123',
        quantity: '1.0',
      });
      expect.fail('Should have thrown ApiClientError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ApiClientError);
      const apiErr = err as ApiClientError;
      expect(apiErr.status).toBe(422);
      expect(apiErr.code).toBe('INVALID_TICK');
      expect(apiErr.message).toBe('Price must be a multiple of tick size');
    }
  });
});
