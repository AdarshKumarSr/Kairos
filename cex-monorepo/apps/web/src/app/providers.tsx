'use client';

import React, { useEffect } from 'react';
import { useTheme } from '../stores/useTheme';
import { useAuth } from '../stores/useAuth';

export function Providers({ children }: { children: React.ReactNode }) {
  const initTheme = useTheme((s) => s.initTheme);
  const checkSession = useAuth((s) => s.checkSession);

  useEffect(() => {
    initTheme();
    checkSession();
  }, [initTheme, checkSession]);

  return <>{children}</>;
}
