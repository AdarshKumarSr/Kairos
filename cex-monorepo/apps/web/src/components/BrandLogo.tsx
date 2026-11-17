import React from 'react';
import Link from 'next/link';
import clsx from 'clsx';

export function BrandLogo({
  size = 'md',
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const sizeClasses = {
    sm: 'text-xl',
    md: 'text-2xl',
    lg: 'text-3xl',
  };

  return (
    <Link
      href="/"
      aria-label="Kairos home"
      className={clsx(
        'inline-flex items-center select-none whitespace-nowrap font-display font-semibold tracking-[-0.035em] text-text hover:opacity-95 transition-opacity',
        sizeClasses[size],
        className
      )}
    >
      <span>ka</span>
      <span
        aria-hidden="true"
        className="inline-block relative w-[0.19em] h-[0.55em] mx-[0.06em] bg-accent rounded-[0.04em]"
      >
        <span className="absolute left-1/2 w-[0.04em] -ml-[0.02em] -top-[0.28em] -bottom-[0.09em] bg-accent rounded-[0.02em]" />
      </span>
      <span>ros</span>
    </Link>
  );
}
