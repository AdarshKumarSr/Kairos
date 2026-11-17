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

function getInitialUser(): UserDto | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('kairos_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getInitialToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem('kairos_token');
  } catch {
    return null;
  }
}

const initialUser = getInitialUser();
const initialToken = getInitialToken();
const initialAuth = Boolean(initialToken);

export const useAuth = create<AuthState>((set, get) => ({
  user: initialUser,
  accessToken: initialToken,
  isAuthenticated: initialAuth,
  isLoading: !initialAuth,
  error: null,

  signin: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.auth.signin({ email, password });
      api.setAccessToken(res.accessToken);
      if (res.csrfToken && typeof window !== 'undefined') {
        try {
          localStorage.setItem('kairos_csrf', res.csrfToken);
        } catch {
          // Ignored
        }
      }
      if (res.user && typeof window !== 'undefined') {
        try {
          localStorage.setItem('kairos_user', JSON.stringify(res.user));
        } catch {
          // Ignored
        }
      }
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
      if (res.accessToken) {
        api.setAccessToken(res.accessToken);
        wsClient.setAuthToken(res.accessToken);
        if (res.user && typeof window !== 'undefined') {
          try {
            localStorage.setItem('kairos_user', JSON.stringify(res.user));
          } catch {
            // Ignored
          }
        }
        set({
          user: res.user,
          accessToken: res.accessToken,
          isAuthenticated: true,
          isLoading: false,
        });
      } else {
        // Automatically sign in after signup to get active tokens
        const signInRes = await api.auth.signin({ email, password });
        api.setAccessToken(signInRes.accessToken);
        if (signInRes.csrfToken && typeof window !== 'undefined') {
          try {
            localStorage.setItem('kairos_csrf', signInRes.csrfToken);
          } catch {
            // Ignored
          }
        }
        if (signInRes.user && typeof window !== 'undefined') {
          try {
            localStorage.setItem('kairos_user', JSON.stringify(signInRes.user));
          } catch {
            // Ignored
          }
        }
        wsClient.setAuthToken(signInRes.accessToken);
        set({
          user: signInRes.user,
          accessToken: signInRes.accessToken,
          isAuthenticated: true,
          isLoading: false,
        });
      }
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
      if (typeof window !== 'undefined') {
        try {
          localStorage.removeItem('kairos_token');
          localStorage.removeItem('kairos_user');
          localStorage.removeItem('kairos_csrf');
        } catch {
          // Ignored
        }
      }
      set({
        user: null,
        accessToken: null,
        isAuthenticated: false,
        isLoading: false,
      });
    }
  },

  checkSession: async () => {
    const current = get();
    // Only show full loading blocker if not already marked authenticated
    if (!current.isAuthenticated) {
      set({ isLoading: true });
    }

    try {
      // 1. If we have an access token, try /api/v1/auth/me to verify
      if (current.accessToken) {
        try {
          const { user } = await api.auth.me();
          if (user) {
            if (typeof window !== 'undefined') {
              try {
                localStorage.setItem('kairos_user', JSON.stringify(user));
              } catch {
                // Ignored
              }
            }
            set({
              user,
              isAuthenticated: true,
              isLoading: false,
            });
            return true;
          }
        } catch {
          // Token may have expired, proceed to refresh token
        }
      }

      // 2. Try rotating refresh token
      const token = await api.refreshToken();
      if (token) {
        const { user } = await api.auth.me();
        api.setAccessToken(token);
        wsClient.setAuthToken(token);
        if (user && typeof window !== 'undefined') {
          try {
            localStorage.setItem('kairos_user', JSON.stringify(user));
          } catch {
            // Ignored
          }
        }
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

    // Only if not authenticated do we clear state
    api.setAccessToken(null);
    wsClient.setAuthToken(null);
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem('kairos_token');
        localStorage.removeItem('kairos_user');
        localStorage.removeItem('kairos_csrf');
      } catch {
        // Ignored
      }
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
