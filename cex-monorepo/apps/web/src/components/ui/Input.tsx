import React from 'react';
import clsx from 'clsx';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  prefixNode?: React.ReactNode;
  suffixNode?: React.ReactNode;
  mono?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      helperText,
      prefixNode,
      suffixNode,
      mono = false,
      className,
      id,
      ...props
    },
    ref
  ) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="flex flex-col gap-1.5 w-full">
        {label && (
          <label htmlFor={inputId} className="text-xs font-medium text-text select-none">
            {label}
          </label>
        )}
        <div
          className={clsx(
            'flex items-center min-h-[44px] px-3 bg-bg border rounded-lg transition-colors focus-within:border-accent',
            error ? 'border-down' : 'border-line',
            className
          )}
        >
          {prefixNode && <div className="mr-2 text-muted">{prefixNode}</div>}
          <input
            ref={ref}
            id={inputId}
            className={clsx(
              'w-full bg-transparent text-text text-sm outline-none placeholder:text-muted',
              mono && 'font-mono tabular-nums'
            )}
            {...props}
          />
          {suffixNode && <div className="ml-2 text-muted">{suffixNode}</div>}
        </div>
        {error && <span className="text-xs text-down font-medium">{error}</span>}
        {!error && helperText && <span className="text-xs text-muted">{helperText}</span>}
      </div>
    );
  }
);

Input.displayName = 'Input';
