'use client';

import React from 'react';
import { useTheme, THEME_OPTIONS } from '../stores/useTheme';

export function ThemeSelector() {
  const { theme, setTheme } = useTheme();

  return (
    <div role="group" aria-label="Colour theme" className="flex items-center gap-1">
      {THEME_OPTIONS.map((t) => {
        const isSelected = theme === t.id;
        const strokeColor = isSelected ? t.ac : 'transparent';

        return (
          <button
            key={t.id}
            type="button"
            aria-label={`${t.label} theme`}
            title={t.label}
            aria-pressed={isSelected}
            onClick={() => setTheme(t.id)}
            className="w-10 h-10 p-0 bg-transparent border-0 cursor-pointer flex items-center justify-center rounded-full hover:bg-surface2/50 transition-colors"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
              <circle
                cx="12"
                cy="12"
                r="11"
                fill="none"
                stroke={strokeColor}
                strokeWidth="1.6"
              />
              <circle cx="12" cy="12" r="8" fill={t.ring} />
              <path d="M12 5.2 A6.8 6.8 0 0 0 12 18.8 Z" fill={t.bg} />
              <path d="M12 5.2 A6.8 6.8 0 0 1 12 18.8 Z" fill={t.ac} />
            </svg>
          </button>
        );
      })}
    </div>
  );
}
