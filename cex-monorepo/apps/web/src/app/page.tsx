'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Navbar } from '../components/Navbar';
import { BrandLogo } from '../components/BrandLogo';
import { Button } from '../components/ui/Button';
import { api, type TickerDto } from '../lib/api';
import { formatPrice } from '../lib/format';
import { type MarketConfig, MarketStatus } from '@cex/types';
import { ArrowUpRight, Search } from 'lucide-react';

export default function MarketsLandingPage() {
  const [markets, setMarkets] = useState<MarketConfig[]>([]);
  const [tickers, setTickers] = useState<Record<string, TickerDto>>({});
  const [query, setQuery] = useState('');

  useEffect(() => {
    async function loadData() {
      try {
        const [marketsRes, tickersRes] = await Promise.all([
          api.markets.list().catch(() => ({
            markets: [
              { symbol: 'SOL_USDT', baseAsset: 'SOL', quoteAsset: 'USDT', tickSize: '1000000', lotSize: '1000000', minNotional: '100000000', makerFeeBps: 8, takerFeeBps: 10, status: MarketStatus.ACTIVE },
              { symbol: 'BTC_USDT', baseAsset: 'BTC', quoteAsset: 'USDT', tickSize: '1000000', lotSize: '100000', minNotional: '100000000', makerFeeBps: 8, takerFeeBps: 10, status: MarketStatus.ACTIVE },
              { symbol: 'ETH_USDT', baseAsset: 'ETH', quoteAsset: 'USDT', tickSize: '1000000', lotSize: '1000000', minNotional: '100000000', makerFeeBps: 8, takerFeeBps: 10, status: MarketStatus.ACTIVE },
            ],
          })),
          api.markets.getTicker().catch(() => ({
            tickers: [
              { market: 'SOL_USDT', lastPrice: '14250000000', priceChange: '574000000', priceChangePercent: 4.2, high: '14620000000', low: '13610000000', baseVolume: '120000000000000', quoteVolume: '171000000000000', tradesCount: 15420 },
              { market: 'BTC_USDT', lastPrice: '8845000000000', priceChange: '125000000000', priceChangePercent: 1.43, high: '8910000000000', low: '8690000000000', baseVolume: '24000000000', quoteVolume: '212280000000000', tradesCount: 42100 },
              { market: 'ETH_USDT', lastPrice: '312000000000', priceChange: '-3400000000', priceChangePercent: -1.08, high: '319000000000', low: '308000000000', baseVolume: '540000000000', quoteVolume: '168480000000000', tradesCount: 22100 },
            ],
          })),
        ]);

        setMarkets(marketsRes.markets || []);
        const tMap: Record<string, TickerDto> = {};
        if (tickersRes.tickers) {
          for (const t of tickersRes.tickers) {
            if (t && t.market) tMap[t.market] = t;
          }
        }
        setTickers(tMap);
      } catch {
        // Retain fallback defaults
      }
    }
    loadData();
  }, []);

  const filteredMarkets = markets.filter(
    (m) =>
      m.symbol.toLowerCase().includes(query.toLowerCase()) ||
      m.baseAsset.toLowerCase().includes(query.toLowerCase())
  );

  const solTickerRaw = tickers['SOL_USDT'] || {
    market: 'SOL_USDT',
    lastPrice: '14250000000',
    priceChange: '574000000',
    priceChangePercent: 4.2,
    high: '14620000000',
    low: '13610000000',
    baseVolume: '120000000000000',
    quoteVolume: '171000000000000',
    tradesCount: 15420,
  };
  const solPct = typeof solTickerRaw.priceChangePercent === 'number'
    ? (isNaN(solTickerRaw.priceChangePercent) ? 0 : solTickerRaw.priceChangePercent)
    : parseFloat(String(solTickerRaw.priceChangePercent || '0')) || 0;

  const solTicker = {
    ...solTickerRaw,
    priceChangePercent: solPct,
    tradesCount: solTickerRaw.tradesCount ?? 0,
  };

  return (
    <div className="min-h-screen bg-bg text-text flex flex-col font-sans">
      <Navbar />

      {/* Hero Section */}
      <section className="border-b border-line bg-bg py-16 md:py-24">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          <div className="lg:col-span-7 flex flex-col gap-6">
            <div className="inline-flex items-center gap-2 px-3 py-1 border border-line rounded-full text-xs uppercase tracking-widest text-muted w-fit">
              <span className="w-1.5 h-1.5 rounded-full bg-accent" />
              Practice the decisive moment
            </div>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-semibold tracking-tight text-text leading-[1.08] text-balance">
              Trade spot crypto with mathematical precision.
            </h1>
            <p className="text-base md:text-lg text-muted max-w-xl leading-relaxed">
              Every order is journaled before it is acknowledged. Pure in-memory matching, price-time priority FIFO queues, and zero-float scaled integer money math.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Link href="/signup">
                <Button size="lg" variant="primary">
                  Create free account
                </Button>
              </Link>
              <Link href="/trade/SOL_USDT">
                <Button size="lg" variant="outline" rightIcon={<ArrowUpRight className="w-4 h-4" />}>
                  Open terminal
                </Button>
              </Link>
            </div>
          </div>

          {/* Featured Card */}
          <div className="lg:col-span-5 bg-surface border border-line rounded-2xl p-6 flex flex-col gap-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="text-xs text-muted">Featured Market</span>
                <div className="text-2xl font-bold font-display mt-0.5">SOL / USDT</div>
              </div>
              <span
                className={`font-mono text-sm px-2.5 py-1 rounded-md font-medium ${
                  (solTicker.priceChangePercent ?? 0) >= 0
                    ? 'text-up bg-up-soft'
                    : 'text-down bg-down-soft'
                }`}
              >
                {(solTicker.priceChangePercent ?? 0) >= 0 ? '+' : ''}
                {(solTicker.priceChangePercent ?? 0).toFixed(2)}%
              </span>
            </div>

            <div className="text-4xl font-mono font-medium tracking-tight">
              {formatPrice(solTicker.lastPrice, 2)}
            </div>

            {/* Sparkline Graphic */}
            <svg
              viewBox="0 0 400 120"
              className="w-full h-28"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="fillSol" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--up)" stopOpacity="0.22" />
                  <stop offset="1" stopColor="var(--up)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                d="M0 100 L30 94 L60 98 L90 82 L120 86 L150 70 L180 74 L210 56 L240 62 L270 42 L300 48 L330 26 L360 30 L400 12 L400 120 L0 120 Z"
                fill="url(#fillSol)"
              />
              <path
                d="M0 100 L30 94 L60 98 L90 82 L120 86 L150 70 L180 74 L210 56 L240 62 L270 42 L300 48 L330 26 L360 30 L400 12"
                fill="none"
                stroke="var(--up)"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>

            <div className="grid grid-cols-3 gap-3 pt-4 border-t border-line text-xs">
              <div>
                <span className="text-muted block">24h High</span>
                <span className="font-mono font-medium text-text mt-0.5 block">
                  {formatPrice(solTicker.high, 2)}
                </span>
              </div>
              <div>
                <span className="text-muted block">24h Low</span>
                <span className="font-mono font-medium text-text mt-0.5 block">
                  {formatPrice(solTicker.low, 2)}
                </span>
              </div>
              <div>
                <span className="text-muted block">24h Trades</span>
                <span className="font-mono font-medium text-text mt-0.5 block">
                  {solTicker.tradesCount.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Markets Table Section */}
      <section className="flex-1 py-14">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 flex flex-col gap-6">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Spot Markets</h2>
              <p className="text-sm text-muted mt-1">Live market data and order book depth.</p>
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="text"
                placeholder="Search SOL, BTC, ETH..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full bg-surface border border-line rounded-lg pl-9 pr-3 py-2 text-sm text-text placeholder:text-muted outline-none focus:border-accent"
              />
            </div>
          </div>

          <div className="bg-surface border border-line rounded-xl overflow-x-auto shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-muted font-medium bg-surface2/30 select-none">
                <tr>
                  <th className="py-3.5 px-5">Market</th>
                  <th className="py-3.5 px-4 text-right">Last Price</th>
                  <th className="py-3.5 px-4 text-right">24h Change</th>
                  <th className="py-3.5 px-4 text-right">24h High</th>
                  <th className="py-3.5 px-4 text-right">24h Low</th>
                  <th className="py-3.5 px-5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/40">
                {filteredMarkets.map((m) => {
                  const t = tickers[m.symbol] || {
                    market: m.symbol,
                    lastPrice: '0',
                    priceChange: '0',
                    priceChangePercent: 0,
                    high: '0',
                    low: '0',
                    baseVolume: '0',
                    quoteVolume: '0',
                    tradesCount: 0,
                  };
                  const rawPct = t.priceChangePercent ?? (t as unknown as Record<string, unknown>).priceChangePercent24h ?? 0;
                  const pct =
                    typeof rawPct === 'number'
                      ? isNaN(rawPct)
                        ? 0
                        : rawPct
                      : parseFloat(String(rawPct)) || 0;
                  const isUp = pct >= 0;

                  return (
                    <tr
                      key={m.symbol}
                      className="hover:bg-surface2/40 transition-colors cursor-pointer group"
                    >
                      <td className="py-4 px-5">
                        <Link href={`/trade/${m.symbol}`} className="flex items-center gap-2">
                          <span className="font-semibold text-text">{m.baseAsset}</span>
                          <span className="text-xs text-muted">/{m.quoteAsset}</span>
                        </Link>
                      </td>
                      <td className="py-4 px-4 text-right font-mono font-medium text-text">
                        {t.lastPrice !== '0' ? formatPrice(t.lastPrice, 2) : '—'}
                      </td>
                      <td
                        className={`py-4 px-4 text-right font-mono font-medium ${
                          isUp ? 'text-up' : 'text-down'
                        }`}
                      >
                        {t.lastPrice !== '0' ? (
                          <>
                            {isUp ? '+' : ''}
                            {pct.toFixed(2)}%
                          </>
                        ) : (
                          '0.00%'
                        )}
                      </td>
                      <td className="py-4 px-4 text-right font-mono text-muted">
                        {t.high !== '0' ? formatPrice(t.high, 2) : '—'}
                      </td>
                      <td className="py-4 px-4 text-right font-mono text-muted">
                        {t.low !== '0' ? formatPrice(t.low, 2) : '—'}
                      </td>
                      <td className="py-4 px-5 text-right">
                        <Link href={`/trade/${m.symbol}`}>
                          <Button size="sm" variant="outline" className="opacity-80 group-hover:opacity-100">
                            Trade
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-line py-8 bg-surface2/20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted">
          <BrandLogo size="sm" />
          <div className="flex items-center gap-6">
            <span>Deterministic spot exchange</span>
            <span>$10^8$ Scaled BigInt arithmetic</span>
            <span>Simulated test balances</span>
          </div>
          <span>&copy; {new Date().getFullYear()} Kairos CEX</span>
        </div>
      </footer>
    </div>
  );
}
