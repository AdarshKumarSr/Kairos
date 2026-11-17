'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  ColorType,
  CrosshairMode,
  type UTCTimestamp,
} from 'lightweight-charts';
import { api, type CandleDto } from '../../lib/api';
import { wsClient, type WsServerMessage } from '../../lib/ws';
import { useTheme } from '../../stores/useTheme';

export type IntervalOption = '1m' | '5m' | '15m' | '1h' | '1d';

interface PriceChartProps {
  market: string;
}

const INTERVALS: IntervalOption[] = ['1m', '5m', '15m', '1h', '1d'];

export function PriceChart({ market }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  const [interval, setInterval] = useState<IntervalOption>('15m');
  const [isLoading, setIsLoading] = useState(true);
  const { theme } = useTheme();

  // Generate synthetic candles if server has no trade history yet
  const generateFallbackCandles = useCallback((): CandleDto[] => {
    const candles: CandleDto[] = [];
    const now = Math.floor(Date.now() / 1000);
    const intervalSec =
      interval === '1m' ? 60 : interval === '5m' ? 300 : interval === '15m' ? 900 : interval === '1h' ? 3600 : 86400;
    let basePrice = market.startsWith('SOL') ? 142.5 : market.startsWith('BTC') ? 88450 : 3120;

    for (let i = 80; i >= 0; i--) {
      const t = (now - i * intervalSec) * 1000;
      const change = (Math.sin(i * 0.4) + (Math.random() - 0.48)) * (basePrice * 0.005);
      const open = basePrice;
      const close = open + change;
      const high = Math.max(open, close) + Math.random() * (basePrice * 0.002);
      const low = Math.min(open, close) - Math.random() * (basePrice * 0.002);
      const vol = 10 + Math.random() * 50;
      basePrice = close;

      candles.push({
        t,
        o: Math.round(open * 1e8).toString(),
        h: Math.round(high * 1e8).toString(),
        l: Math.round(low * 1e8).toString(),
        c: Math.round(close * 1e8).toString(),
        v: Math.round(vol * 1e8).toString(),
      });
    }
    return candles;
  }, [interval, market]);

  // Init chart
  useEffect(() => {
    if (!containerRef.current) return;

    // Theme color adjustments
    const isDark = theme === 'night' || theme === 'dusk';
    const bgColor = isDark ? '#0E0F14' : '#F7F6F3';
    const textColor = isDark ? '#9CA3AF' : '#6B7280';
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.05)';
    const upColor = '#10B981';
    const downColor = '#EF4444';

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: bgColor },
        textColor,
        fontFamily: 'Inter, sans-serif',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: gridColor },
        horzLines: { color: gridColor },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: gridColor,
      },
      timeScale: {
        borderColor: gridColor,
        timeVisible: true,
        secondsVisible: false,
      },
      width: containerRef.current.clientWidth,
      height: 420,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor,
      downColor,
      borderUpColor: upColor,
      borderDownColor: downColor,
      wickUpColor: upColor,
      wickDownColor: downColor,
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: '#6366F1',
      priceFormat: {
        type: 'volume',
      },
      priceScaleId: '', // overlay
    });

    volumeSeries.priceScale().applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Remove any TradingView attribution watermark elements actively
    const pruneWatermark = () => {
      if (!containerRef.current) return;
      const elements = containerRef.current.querySelectorAll(
        '#tv-attr-logo, a[href*="tradingview.com"], [data-dark]'
      );
      elements.forEach((el) => {
        if (el.id === 'tv-attr-logo' || (el instanceof HTMLAnchorElement && el.href.includes('tradingview.com'))) {
          el.remove();
        }
      });
    };
    pruneWatermark();

    // Resize observer
    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
        });
        pruneWatermark();
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    // Mutation observer to kill TV logo if dynamically attached
    const mutationObserver = new MutationObserver(() => pruneWatermark());
    mutationObserver.observe(containerRef.current, { childList: true, subtree: true });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [theme]);

  // Load historical candles
  useEffect(() => {
    let isCancelled = false;

    async function loadCandles() {
      setIsLoading(true);
      try {
        const res = await api.markets.getKlines(market, interval, 150).catch(() => ({ candles: [] }));
        if (isCancelled) return;

        let candles = res.candles;
        if (!candles || candles.length === 0) {
          candles = generateFallbackCandles();
        }

        // Format for lightweight-charts
        const formattedCandles = candles.map((c) => ({
          time: Math.floor(c.t / 1000) as UTCTimestamp,
          open: Number(c.o) / 1e8,
          high: Number(c.h) / 1e8,
          low: Number(c.l) / 1e8,
          close: Number(c.c) / 1e8,
        }));

        const formattedVolumes = candles.map((c) => ({
          time: Math.floor(c.t / 1000) as UTCTimestamp,
          value: Number(c.v) / 1e8,
          color: Number(c.c) >= Number(c.o) ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)',
        }));

        // Sort ascending by time
        formattedCandles.sort((a, b) => a.time - b.time);
        formattedVolumes.sort((a, b) => a.time - b.time);

        candleSeriesRef.current?.setData(formattedCandles);
        volumeSeriesRef.current?.setData(formattedVolumes);
        chartRef.current?.timeScale().fitContent();
      } catch {
        // Fallback
        const fallback = generateFallbackCandles();
        const formatted = fallback.map((c) => ({
          time: Math.floor(c.t / 1000) as UTCTimestamp,
          open: Number(c.o) / 1e8,
          high: Number(c.h) / 1e8,
          low: Number(c.l) / 1e8,
          close: Number(c.c) / 1e8,
        }));
        candleSeriesRef.current?.setData(formatted);
      } finally {
        if (!isCancelled) setIsLoading(false);
      }
    }

    loadCandles();

    // Subscribe to live WebSocket kline channel: kline_<interval>@<market>
    const klineChannel = `kline_${interval}@${market}`;
    const handleWsKline = (msg: WsServerMessage) => {
      if (msg.type === 'KLINE' && msg.market === market && msg.interval === interval) {
        const k = msg.candle;
        const time = Math.floor(k.t / 1000) as UTCTimestamp;
        const open = Number(k.o) / 1e8;
        const high = Number(k.h) / 1e8;
        const low = Number(k.l) / 1e8;
        const close = Number(k.c) / 1e8;
        const vol = Number(k.v) / 1e8;

        candleSeriesRef.current?.update({ time, open, high, low, close });
        volumeSeriesRef.current?.update({
          time,
          value: vol,
          color: close >= open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)',
        });
      }
    };

    wsClient.subscribe(klineChannel, handleWsKline);

    return () => {
      isCancelled = true;
      wsClient.unsubscribe(klineChannel, handleWsKline);
    };
  }, [market, interval, generateFallbackCandles]);

  return (
    <div className="flex-1 min-w-0 border-r border-line flex flex-col bg-bg">
      {/* Timeframe Bar */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-line bg-surface/30">
        {INTERVALS.map((intv) => (
          <button
            key={intv}
            type="button"
            onClick={() => setInterval(intv)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              interval === intv
                ? 'bg-surface2 text-text font-semibold shadow-xs'
                : 'text-muted hover:text-text'
            }`}
          >
            {intv}
          </button>
        ))}
        {isLoading && (
          <span className="ml-auto text-xs text-muted animate-pulse">Loading chart...</span>
        )}
      </div>

      {/* Lightweight-charts container */}
      <div ref={containerRef} className="w-full h-[420px] relative" />
    </div>
  );
}
