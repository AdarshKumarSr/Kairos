import React from 'react';
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'buy' | 'sell' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      isLoading = false,
      leftIcon,
      rightIcon,
      className,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const baseStyles =
      'inline-flex items-center justify-center font-medium transition-colors select-none focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed';

    const sizeStyles = {
      sm: 'min-h-[32px] px-3 text-xs rounded-md gap-1.5',
      md: 'min-h-[42px] px-4 text-sm rounded-lg gap-2',
      lg: 'min-h-[48px] px-6 text-base font-semibold rounded-lg gap-2.5',
    };

    const variantStyles = {
      primary:
        'bg-accent text-on-accent hover:opacity-90 active:scale-[0.99]',
      secondary:
        'bg-surface2 text-text hover:bg-line active:scale-[0.99]',
      outline:
        'border border-line bg-transparent text-text hover:bg-surface2',
      ghost:
        'bg-transparent text-muted hover:text-text hover:bg-surface2',
      buy:
        'bg-up text-on-up font-semibold hover:opacity-90 active:scale-[0.99]',
      sell:
        'bg-down text-on-down font-semibold hover:opacity-90 active:scale-[0.99]',
      danger:
        'bg-down text-on-down hover:opacity-90 active:scale-[0.99]',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={clsx(
          baseStyles,
          sizeStyles[size],
          variantStyles[variant],
          className
        )}
        {...props}
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-current" />
        ) : (
          leftIcon
        )}
        <span>{children}</span>
        {!isLoading && rightIcon}
      </button>
    );
  }
);

Button.displayName = 'Button';
