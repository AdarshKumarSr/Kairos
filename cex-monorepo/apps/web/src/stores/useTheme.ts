import { create } from 'zustand';

export type KairosTheme = 'night' | 'paper' | 'mist' | 'dusk';

export interface ThemeOption {
  id: KairosTheme;
  label: string;
  bg: string;
  ac: string;
  ring: string;
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'night', label: 'Night', bg: '#0E0F14', ac: '#8470FF', ring: '#4A4E5E' },
  { id: 'paper', label: 'Paper', bg: '#F7F6F3', ac: '#5B3FFF', ring: '#CFCBC1' },
  { id: 'mist', label: 'Mist', bg: '#EEF1F6', ac: '#5B3FFF', ring: '#C3CAD9' },
  { id: 'dusk', label: 'Dusk', bg: '#14112B', ac: '#A594FF', ring: '#5A5499' },
];

interface ThemeState {
  theme: KairosTheme;
  setTheme: (theme: KairosTheme) => void;
  initTheme: () => void;
}

export const useTheme = create<ThemeState>((set) => ({
  theme: 'night',

  setTheme: (theme) => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('kairos-theme', theme);
        document.documentElement.setAttribute('data-theme', theme);
        if (theme === 'night' || theme === 'dusk') {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      } catch {
        // Ignore localStorage errors
      }
    }
    set({ theme });
  },

  initTheme: () => {
    if (typeof window !== 'undefined') {
      try {
        const stored = localStorage.getItem('kairos-theme') as KairosTheme | null;
        const validTheme = stored && THEME_OPTIONS.some((t) => t.id === stored) ? stored : 'night';
        document.documentElement.setAttribute('data-theme', validTheme);
        if (validTheme === 'night' || validTheme === 'dusk') {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
        set({ theme: validTheme });
      } catch {
        set({ theme: 'night' });
      }
    }
  },
}));
