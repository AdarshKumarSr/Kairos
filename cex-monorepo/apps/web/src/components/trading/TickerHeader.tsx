'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import type { MarketConfig } from '@cex/types';
import type { TickerDto } from '../../lib/api';
import { formatPrice } from '../../lib/format';
import type { WsConnectionStatus } from '../../lib/ws';

interface TickerHeaderProps {
  market: MarketConfig;
  allMarkets: MarketConfig[];
  ticker: TickerDto | null;
  wsStatus: WsConnectionStatus;
  isStale: boolean;
}

export function TickerHeader({
  market,
  allMarkets,
  ticker,
  wsStatus,
  isStale,
}: TickerHeaderProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const lastPrice = ticker?.lastPrice || '0';
  const rawPct = ticker?.priceChangePercent ?? (ticker as unknown as Record<string, unknown> | null)?.priceChangePercent24h ?? 0;
  const priceChangePercent =
    typeof rawPct === 'number'
      ? isNaN(rawPct)
        ? 0
        : rawPct
      : parseFloat(String(rawPct)) || 0;
  const isUp = priceChangePercent >= 0;
  const priceChange = ticker?.priceChange || (ticker as unknown as Record<string, unknown> | null)?.priceChange24h ? String((ticker as unknown as Record<string, unknown>).priceChange24h) : '0';
  const high24h = ticker?.high || (ticker as unknown as Record<string, unknown> | null)?.high24h ? String((ticker as unknown as Record<string, unknown>).high24h) : '0';
  const low24h = ticker?.low || (ticker as unknown as Record<string, unknown> | null)?.low24h ? String((ticker as unknown as Record<string, unknown>).low24h) : '0';
  const baseVol = ticker?.baseVolume || (ticker as unknown as Record<string, unknown> | null)?.volume24h ? String((ticker as unknown as Record<string, unknown>).volume24h) : '0';

  return (
    <section className="relative border-b border-line bg-bg select-none">
      <div className="px-5 py-3 flex flex-wrap items-center gap-x-8 gap-y-3 justify-between">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
          {/* Pair Selector Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setDropdownOpen((prev) => !prev)}
              className="flex items-center gap-2 py-1 pr-3 text-lg font-bold font-display hover:text-accent transition-colors"
              aria-label="Change market"
            >
              <span>{market.baseAsset}</span>
              <span className="text-muted font-normal">/{market.quoteAsset}</span>
              <ChevronDown className="w-4 h-4 text-muted" />
            </button>

            {dropdownOpen && (
              <div
                className="absolute top-full left-0 mt-1 w-52 bg-surface border border-line rounded-xl shadow-xl z-50 py-1.5"
                onMouseLeave={() => setDropdownOpen(false)}
              >
                <div className="px-3 py-1.5 text-xs font-semibold text-muted border-b border-line/60">
                  Select Market
                </div>
                {allMarkets.map((m) => (
                  <Link
                    key={m.symbol}
                    href={`/trade/${m.symbol}`}
                    onClick={() => setDropdownOpen(false)}
                    className={`flex items-center justify-between px-3 py-2 text-sm hover:bg-surface2/60 transition-colors ${
                      m.symbol === market.symbol ? 'text-accent font-semibold' : 'text-text'
                    }`}
                  >
                    <span>
                      {m.baseAsset}
                      <span className="text-muted text-xs">/{m.quoteAsset}</span>
                    </span>
                    <span className="text-xs text-muted font-mono">{m.status}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Last Price */}
          <div className="flex flex-col">
            <span
              className={`font-mono text-2xl font-medium tracking-tight ${
                isUp ? 'text-up' : 'text-down'
              }`}
            >
              {lastPrice !== '0' ? formatPrice(lastPrice, 2) : '—'}
            </span>
          </div>

          {/* 24h Change */}
          <div className="flex flex-col">
            <span className="text-xs text-muted">24h change</span>
            <span
              className={`font-mono text-xs font-medium ${isUp ? 'text-up' : 'text-down'}`}
            >
              {lastPrice !== '0' ? (
                <>
                  {isUp ? '+' : ''}
                  {formatPrice(priceChange, 2)} ({isUp ? '+' : ''}
                  {priceChangePercent.toFixed(2)}%)
                </>
              ) : (
                '—'
              )}
            </span>
          </div>

          {/* 24h High */}
          <div className="flex flex-col">
            <span className="text-xs text-muted">24h high</span>
            <span className="font-mono text-xs text-text font-medium">
              {high24h !== '0' ? formatPrice(high24h, 2) : '—'}
            </span>
          </div>

          {/* 24h Low */}
          <div className="flex flex-col">
            <span className="text-xs text-muted">24h low</span>
            <span className="font-mono text-xs text-text font-medium">
              {low24h !== '0' ? formatPrice(low24h, 2) : '—'}
            </span>
          </div>

          {/* 24h Volume */}
          <div className="flex flex-col">
            <span className="text-xs text-muted">24h volume ({market.baseAsset})</span>
            <span className="font-mono text-xs text-text font-medium">
              {baseVol !== '0' ? formatPrice(baseVol, 2) : '—'}
            </span>
          </div>
        </div>

        {/* Status Indicators: Connection Badge & Stale Notice */}
        <div className="flex items-center gap-3">
          {isStale && (
            <span className="text-xs font-medium px-2 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/20">
              Stale Data (&gt;10s)
            </span>
          )}

          <div className="flex items-center gap-2 text-xs text-muted">
            <span
              className={`w-2 h-2 rounded-full ${
                wsStatus === 'connected'
                  ? 'bg-up'
                  : wsStatus === 'reconnecting'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-down'
              }`}
            />
            <span className="capitalize">{wsStatus}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
