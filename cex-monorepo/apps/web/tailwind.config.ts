import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: ['class', '[data-theme="night"]'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        surface2: 'var(--surface2)',
        line: 'var(--line)',
        line2: 'var(--line2)',
        text: 'var(--text)',
        text2: 'var(--text2)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        accent: {
          DEFAULT: 'var(--accent)',
          text: 'var(--accent-text)',
          hover: 'var(--accent-hover)',
          soft: 'var(--accent-soft)',
        },
        'on-accent': 'var(--on-accent)',
        up: {
          DEFAULT: 'var(--up)',
          soft: 'var(--up-soft)',
          fill: 'var(--upfill)',
        },
        'on-up': 'var(--on-up)',
        down: {
          DEFAULT: 'var(--down)',
          text: 'var(--down-text)',
          soft: 'var(--down-soft)',
          fill: 'var(--downfill)',
        },
        'on-down': 'var(--on-down)',
        warn: {
          DEFAULT: 'var(--warn)',
          soft: 'var(--warn-soft)',
          line: 'var(--warn-line)',
        },
        overlay: 'var(--overlay)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Inter Tight', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '8px',
        md: '8px',
        lg: '10px',
        xl: '12px',
      },
    },
  },
  plugins: [],
};

export default config;
