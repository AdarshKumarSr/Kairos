'use client';

import React, { useMemo } from 'react';
import { useBook } from '../../stores/useBook';
import { formatPrice, formatQty } from '../../lib/format';

interface OrderBookProps {
  market: string;
  quoteAsset: string;
  baseAsset: string;
  onSelectPrice: (priceFormatted: string) => void;
}

interface ProcessedRow {
  priceRaw: string;
  priceFormatted: string;
  qtyRaw: string;
  qtyFormatted: string;
  cumFormatted: string;
  barPercent: number;
}

export function OrderBook({
  quoteAsset,
  baseAsset,
  onSelectPrice,
}: OrderBookProps) {
  const { bids, asks, spread, spreadPercent } = useBook();

  // Process asks (lowest asks at the bottom near spread, top 20)
  const processedAsks = useMemo<ProcessedRow[]>(() => {
    let cum = 0n;
    const rows = asks.slice(0, 16).map(([p, q]) => {
      const qBig = BigInt(q);
      cum += qBig;
      return {
        priceRaw: p,
        priceFormatted: formatPrice(p, 2),
        qtyRaw: q,
        qtyFormatted: formatQty(q, 2),
        cumBig: cum,
      };
    });

    const maxCum = rows.length > 0 ? rows[rows.length - 1]!.cumBig : 1n;
    return rows
      .map((r) => ({
        priceRaw: r.priceRaw,
        priceFormatted: r.priceFormatted,
        qtyRaw: r.qtyRaw,
        qtyFormatted: r.qtyFormatted,
        cumFormatted: formatQty(r.cumBig, 2),
        barPercent: maxCum > 0n ? Math.min(100, Number((r.cumBig * 100n) / maxCum)) : 0,
      }))
      .reverse(); // Lowest ask nearest to spread
  }, [asks]);

  // Process bids (highest bids at the top near spread, top 20)
  const processedBids = useMemo<ProcessedRow[]>(() => {
    let cum = 0n;
    const rows = bids.slice(0, 16).map(([p, q]) => {
      const qBig = BigInt(q);
      cum += qBig;
      return {
        priceRaw: p,
        priceFormatted: formatPrice(p, 2),
        qtyRaw: q,
        qtyFormatted: formatQty(q, 2),
        cumBig: cum,
      };
    });

    const maxCum = rows.length > 0 ? rows[rows.length - 1]!.cumBig : 1n;
    return rows.map((r) => ({
      priceRaw: r.priceRaw,
      priceFormatted: r.priceFormatted,
      qtyRaw: r.qtyRaw,
      qtyFormatted: r.qtyFormatted,
      cumFormatted: formatQty(r.cumBig, 2),
      barPercent: maxCum > 0n ? Math.min(100, Number((r.cumBig * 100n) / maxCum)) : 0,
    }));
  }, [bids]);

  return (
    <div className="flex flex-col select-none text-xs">
      <div className="px-4 py-2 font-semibold text-text border-b border-line">
        Order Book
      </div>

      {/* Header Row */}
      <div className="grid grid-cols-3 px-4 py-1.5 text-muted font-medium border-b border-line/40">
        <span>Price ({quoteAsset})</span>
        <span className="text-right">Qty ({baseAsset})</span>
        <span className="text-right">Total</span>
      </div>

      {/* Asks (Red) */}
      <div className="flex flex-col justify-end min-h-[190px]">
        {processedAsks.length > 0 ? (
          processedAsks.map((r) => (
            <div
              key={`ask-${r.priceRaw}`}
              onClick={() => onSelectPrice(r.priceFormatted)}
              className="relative grid grid-cols-3 px-4 py-0.5 items-center font-mono cursor-pointer hover:bg-down-soft/40 transition-colors"
            >
              {/* Depth Bar */}
              <span
                className="absolute top-0 right-0 bottom-0 bg-down-soft transition-all duration-150 pointer-events-none"
                style={{ width: `${r.barPercent}%` }}
              />
              <span className="relative text-down font-medium">{r.priceFormatted}</span>
              <span className="relative text-right text-text">{r.qtyFormatted}</span>
              <span className="relative text-right text-muted">{r.cumFormatted}</span>
            </div>
          ))
        ) : (
          <div className="py-6 text-center text-muted font-mono">No asks</div>
        )}
      </div>

      {/* Spread Row */}
      <div className="flex items-baseline justify-between px-4 py-1.5 bg-surface border-y border-line my-0.5">
        <span className="font-mono text-sm font-semibold text-up">
          {bids[0] ? formatPrice(bids[0][0], 2) : '—'}
        </span>
        <span className="text-muted text-xs">
          Spread {spread ? `${spread} (${spreadPercent})` : '—'}
        </span>
      </div>

      {/* Bids (Green) */}
      <div className="flex flex-col min-h-[190px]">
        {processedBids.length > 0 ? (
          processedBids.map((r) => (
            <div
              key={`bid-${r.priceRaw}`}
              onClick={() => onSelectPrice(r.priceFormatted)}
              className="relative grid grid-cols-3 px-4 py-0.5 items-center font-mono cursor-pointer hover:bg-up-soft/40 transition-colors"
            >
              {/* Depth Bar */}
              <span
                className="absolute top-0 right-0 bottom-0 bg-up-soft transition-all duration-150 pointer-events-none"
                style={{ width: `${r.barPercent}%` }}
              />
              <span className="relative text-up font-medium">{r.priceFormatted}</span>
              <span className="relative text-right text-text">{r.qtyFormatted}</span>
              <span className="relative text-right text-muted">{r.cumFormatted}</span>
            </div>
          ))
        ) : (
          <div className="py-6 text-center text-muted font-mono">No bids</div>
        )}
      </div>
    </div>
  );
}
