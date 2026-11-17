import React from 'react';
import clsx from 'clsx';

export interface TabItem {
  id: string;
  label: React.ReactNode;
  badge?: string | number;
}

export interface TabsProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  variant?: 'pill' | 'line' | 'market';
  size?: 'sm' | 'md';
  className?: string;
}

export function Tabs({
  items,
  activeId,
  onChange,
  variant = 'line',
  size = 'md',
  className,
}: TabsProps) {
  if (variant === 'pill') {
    return (
      <div
        className={clsx(
          'flex items-center gap-1 p-1 bg-surface2 rounded-lg',
          className
        )}
      >
        {items.map((tab) => {
          const isActive = tab.id === activeId;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={clsx(
                'flex-1 flex items-center justify-center font-medium transition-all rounded-md select-none',
                size === 'sm' ? 'py-1 px-2.5 text-xs' : 'py-1.5 px-3 text-sm',
                isActive
                  ? 'bg-surface text-text shadow-sm'
                  : 'text-muted hover:text-text'
              )}
            >
              <span>{tab.label}</span>
              {tab.badge !== undefined && (
                <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-line text-muted">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  // Default 'line' tabs
  return (
    <div
      className={clsx(
        'flex items-center border-b border-line gap-6 overflow-x-auto',
        className
      )}
    >
      {items.map((tab) => {
        const isActive = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={clsx(
              'relative py-3 text-sm font-medium transition-colors select-none whitespace-nowrap',
              isActive ? 'text-text' : 'text-muted hover:text-text'
            )}
          >
            <span>{tab.label}</span>
            {tab.badge !== undefined && (
              <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-surface2 text-muted">
                {tab.badge}
              </span>
            )}
            {isActive && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent" />
            )}
          </button>
        );
      })}
    </div>
  );
}
