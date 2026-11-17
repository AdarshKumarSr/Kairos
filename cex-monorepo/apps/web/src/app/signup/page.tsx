'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../stores/useAuth';
import { BrandLogo } from '../../components/BrandLogo';
import { ThemeSelector } from '../../components/ThemeSelector';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { toast } from '../../components/ui/Toast';
import { Eye, EyeOff } from 'lucide-react';

export default function SignUpPage() {
  const router = useRouter();
  const { signup, isLoading, error, clearError } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
    confirmPassword?: string;
  }>({});

  const validate = () => {
    const errors: { email?: string; password?: string; confirmPassword?: string } = {};
    if (!email.trim()) errors.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Invalid email address';

    if (!password) {
      errors.password = 'Password is required';
    } else if (password.length < 8) {
      errors.password = 'Password must be at least 8 characters';
    } else if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      errors.password = 'Password must contain uppercase, lowercase, and number';
    }

    if (password !== confirmPassword) {
      errors.confirmPassword = 'Passwords do not match';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    if (!validate()) return;

    try {
      await signup(email, password);
      toast.success('Account created successfully! Welcome to Kairos.');
      router.push('/trade/SOL_USDT');
    } catch {
      // Error handled by store
    }
  };

  return (
    <div className="relative min-h-screen flex flex-wrap bg-bg text-text">
      {/* Top right theme switcher */}
      <div className="absolute top-4 right-4 z-20">
        <ThemeSelector />
      </div>

      {/* Left Brand Panel */}
      <aside className="flex-1 min-w-[320px] max-w-full lg:max-w-[540px] bg-surface border-r border-line p-8 md:p-14 flex flex-col justify-between gap-10">
        <BrandLogo size="lg" />

        <div className="flex flex-col gap-8 max-w-md">
          {/* Depth graphic from design */}
          <svg
            viewBox="0 0 480 200"
            className="w-full h-44 rounded-lg bg-surface2/30"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              d="M0 200 L0 60 L60 64 L120 80 L180 100 L220 128 L240 150 L240 200 Z"
              fill="var(--up-soft)"
            />
            <path
              d="M0 60 L60 64 L120 80 L180 100 L220 128 L240 150"
              fill="none"
              stroke="var(--up)"
              strokeWidth="2"
            />
            <path
              d="M240 200 L240 150 L260 128 L300 100 L360 80 L420 64 L480 60 L480 200 Z"
              fill="var(--down-soft)"
            />
            <path
              d="M240 150 L260 128 L300 100 L360 80 L420 64 L480 60"
              fill="none"
              stroke="var(--down)"
              strokeWidth="2"
            />
            <line
              x1="240"
              y1="20"
              x2="240"
              y2="200"
              stroke="var(--line)"
              strokeDasharray="3 4"
            />
          </svg>

          <div className="flex flex-col gap-3">
            <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-text">
              Deterministic spot matching. Zero float.
            </h2>
            <p className="text-sm md:text-base text-muted leading-relaxed">
              Real order books, linked-list FIFO queues and integer money math. Experience high-throughput spot trading built for mathematical precision.
            </p>
          </div>
        </div>

        <span className="text-xs text-muted">
          Simulated wallet: test balances with zero real currency.
        </span>
      </aside>

      {/* Right Form Panel */}
      <main className="flex-1 min-w-[320px] p-8 md:p-14 flex items-center justify-center">
        <form onSubmit={handleSubmit} className="w-full max-w-sm flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">Create your account</h1>
            <p className="text-sm text-muted">
              Start trading spot markets with institutional execution.
            </p>
          </div>

          {error && (
            <div className="p-3 bg-down-soft border border-down/30 rounded-lg text-xs font-medium text-down-text">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-4">
            <Input
              id="signup-email"
              label="Email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldErrors.email}
              autoComplete="email"
            />

            <Input
              id="signup-password"
              label="Password"
              type={showPassword ? 'text' : 'password'}
              placeholder="At least 8 characters (A-Z, a-z, 0-9)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password}
              autoComplete="new-password"
              suffixNode={
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="p-1 text-muted hover:text-text transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              }
            />

            <Input
              id="signup-confirm-password"
              label="Confirm Password"
              type={showPassword ? 'text' : 'password'}
              placeholder="Re-enter your password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              error={fieldErrors.confirmPassword}
              autoComplete="new-password"
            />
          </div>

          <div className="flex flex-col gap-3 pt-2">
            <Button type="submit" size="lg" isLoading={isLoading} className="w-full">
              Create account
            </Button>
            <p className="text-sm text-center text-muted">
              Already have an account?{' '}
              <Link href="/signin" className="text-accent hover:underline font-medium">
                Sign in
              </Link>
            </p>
          </div>
        </form>
      </main>
    </div>
  );
}
