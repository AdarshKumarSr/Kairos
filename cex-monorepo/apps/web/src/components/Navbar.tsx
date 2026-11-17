'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BrandLogo } from './BrandLogo';
import { ThemeSelector } from './ThemeSelector';
import { Button } from './ui/Button';
import { useAuth } from '../stores/useAuth';
import { Menu, X, Shield, User } from 'lucide-react';

interface NavbarProps {
  fluid?: boolean;
}

interface NavLinkItem {
  label: string;
  href: string;
  activeCheck?: (p: string) => boolean;
}

export function Navbar({ fluid = false }: NavbarProps) {
  const pathname = usePathname();
  const { isAuthenticated, user, signout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navLinks: NavLinkItem[] = [
    { label: 'Trade', href: '/trade/SOL_USDT', activeCheck: (p: string) => p.startsWith('/trade') },
  ];

  if (isAuthenticated) {
    navLinks.push(
      { label: 'Wallet', href: '/wallet' },
      { label: 'Orders', href: '/orders' }
    );
    if (user?.role === 'ADMIN') {
      navLinks.push({ label: 'Admin', href: '/admin' });
    }
  }

  const isLinkActive = (item: (typeof navLinks)[0]) => {
    if (item.activeCheck) return item.activeCheck(pathname);
    return pathname === item.href;
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-line bg-bg/95 backdrop-blur-md select-none transition-colors">
      <div
        className={`${
          fluid ? 'px-4 sm:px-6' : 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8'
        } h-14 flex items-center justify-between gap-4`}
      >
        {/* Left: Brand + Desktop Links */}
        <div className="flex items-center gap-8">
          <BrandLogo size="md" />

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
            {navLinks.map((item) => {
              const active = isLinkActive(item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`relative py-4 transition-colors ${
                    active
                      ? 'text-text font-semibold'
                      : 'text-muted hover:text-text'
                  }`}
                >
                  {item.label}
                  {active && (
                    <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent rounded-full" />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Right: Theme Selector + Auth Actions */}
        <div className="hidden md:flex items-center gap-4">
          <ThemeSelector />

          {isAuthenticated ? (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-2.5 py-1 rounded-md bg-surface border border-line text-xs font-mono text-text2">
                <User className="w-3.5 h-3.5 text-muted" />
                <span className="max-w-[150px] truncate">{user?.email}</span>
                {user?.role === 'ADMIN' && (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[10px] font-sans font-bold bg-accent/15 text-accent border border-accent/30">
                    <Shield className="w-2.5 h-2.5" />
                    ADMIN
                  </span>
                )}
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={() => signout()}
                className="h-8 text-xs font-medium"
              >
                Sign out
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link href="/signin">
                <Button variant="ghost" size="sm" className="h-8 text-xs font-medium">
                  Sign in
                </Button>
              </Link>
              <Link href="/signup">
                <Button variant="primary" size="sm" className="h-8 text-xs font-medium">
                  Get started
                </Button>
              </Link>
            </div>
          )}
        </div>

        {/* Mobile menu trigger */}
        <div className="flex md:hidden items-center gap-3">
          <ThemeSelector />
          <button
            type="button"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            className="p-1.5 rounded-lg border border-line text-muted hover:text-text transition-colors"
            aria-label="Toggle navigation menu"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile dropdown drawer */}
      {mobileMenuOpen && (
        <div className="md:hidden border-b border-line bg-surface/98 px-5 py-4 flex flex-col gap-3 shadow-lg">
          <nav className="flex flex-col gap-1">
            {navLinks.map((item) => {
              const active = isLinkActive(item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? 'bg-accent/10 text-accent font-semibold'
                      : 'text-muted hover:text-text hover:bg-surface2/60'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="pt-3 border-t border-line/60 flex flex-col gap-2">
            {isAuthenticated ? (
              <>
                <div className="px-3 py-1.5 text-xs text-muted font-mono truncate">
                  {user?.email}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    signout();
                    setMobileMenuOpen(false);
                  }}
                  className="w-full text-xs"
                >
                  Sign out
                </Button>
              </>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Link href="/signin" onClick={() => setMobileMenuOpen(false)}>
                  <Button variant="ghost" size="sm" className="w-full text-xs">
                    Sign in
                  </Button>
                </Link>
                <Link href="/signup" onClick={() => setMobileMenuOpen(false)}>
                  <Button variant="primary" size="sm" className="w-full text-xs">
                    Register
                  </Button>
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
