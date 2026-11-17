import { create } from 'zustand';
import { api, type UserDto } from '../lib/api';
import { wsClient } from '../lib/ws';

interface AuthState {
  user: UserDto | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  signin: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  signout: () => Promise<void>;
  checkSession: () => Promise<boolean>;
  clearError: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,

  signin: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.auth.signin({ email, password });
      api.setAccessToken(res.accessToken);
      wsClient.setAuthToken(res.accessToken);
      set({
        user: res.user,
        accessToken: res.accessToken,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to sign in';
      set({ isLoading: false, error: msg });
      throw err;
    }
  },

  signup: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.auth.signup({ email, password });
      api.setAccessToken(res.accessToken);
      wsClient.setAuthToken(res.accessToken);
      set({
        user: res.user,
        accessToken: res.accessToken,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to sign up';
      set({ isLoading: false, error: msg });
      throw err;
    }
  },

  signout: async () => {
    try {
      await api.auth.signout();
    } catch {
      // Ignore network errors on signout
    } finally {
      api.setAccessToken(null);
      wsClient.setAuthToken(null);
      set({
        user: null,
        accessToken: null,
        isAuthenticated: false,
        isLoading: false,
      });
    }
  },

  checkSession: async () => {
    set({ isLoading: true });
    try {
      const token = await api.refreshToken();
      if (token) {
        const { user } = await api.auth.me();
        api.setAccessToken(token);
        wsClient.setAuthToken(token);
        set({
          user,
          accessToken: token,
          isAuthenticated: true,
          isLoading: false,
        });
        return true;
      }
    } catch {
      // Not logged in or expired
    }
    set({
      user: null,
      accessToken: null,
      isAuthenticated: false,
      isLoading: false,
    });
    return false;
  },

  clearError: () => set({ error: null }),
}));

// Connect API client 401 callback to auth store signout
if (typeof window !== 'undefined') {
  api.setOnUnauthorized(() => {
    useAuth.getState().signout();
  });
}
