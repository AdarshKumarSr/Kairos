'use client';

import React, { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '../../stores/useAuth';
import { Loader2 } from 'lucide-react';

export function AuthGuard({
  children,
  requireAdmin = false,
}: {
  children: React.ReactNode;
  requireAdmin?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isAuthenticated, isLoading, checkSession } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) {
      checkSession();
    }
  }, [isAuthenticated, checkSession]);

  useEffect(() => {
    if (!isLoading) {
      if (!isAuthenticated) {
        router.replace(`/signin?redirect=${encodeURIComponent(pathname)}`);
      } else if (requireAdmin && user?.role !== 'ADMIN') {
        router.replace('/trade/SOL_USDT');
      }
    }
  }, [isLoading, isAuthenticated, requireAdmin, user, router, pathname]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg text-muted">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  if (!isAuthenticated || (requireAdmin && user?.role !== 'ADMIN')) {
    return null;
  }

  return <>{children}</>;
}
