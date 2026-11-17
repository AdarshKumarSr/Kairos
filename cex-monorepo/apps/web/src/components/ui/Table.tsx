import React from 'react';
import clsx from 'clsx';

export function Table({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={clsx('w-full border-collapse text-left text-sm', className)}>
        {children}
      </table>
    </div>
  );
}

export function TableHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <thead
      className={clsx(
        'border-b border-line text-xs font-medium text-muted select-none',
        className
      )}
    >
      {children}
    </thead>
  );
}

export function TableBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <tbody className={clsx('divide-y divide-line/40', className)}>{children}</tbody>;
}

export function TableRow({
  children,
  onClick,
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <tr
      onClick={onClick}
      className={clsx(
        'transition-colors',
        onClick ? 'cursor-pointer hover:bg-surface2/50' : 'hover:bg-surface2/30',
        className
      )}
    >
      {children}
    </tr>
  );
}

export function TableHead({
  children,
  align = 'left',
  className,
}: {
  children: React.ReactNode;
  align?: 'left' | 'center' | 'right';
  className?: string;
}) {
  return (
    <th
      className={clsx(
        'py-2.5 px-3 whitespace-nowrap',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className
      )}
    >
      {children}
    </th>
  );
}

export function TableCell({
  children,
  align = 'left',
  mono = false,
  className,
}: {
  children: React.ReactNode;
  align?: 'left' | 'center' | 'right';
  mono?: boolean;
  className?: string;
}) {
  return (
    <td
      className={clsx(
        'py-2.5 px-3 text-text text-sm whitespace-nowrap',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        mono && 'font-mono tabular-nums',
        className
      )}
    >
      {children}
    </td>
  );
}
