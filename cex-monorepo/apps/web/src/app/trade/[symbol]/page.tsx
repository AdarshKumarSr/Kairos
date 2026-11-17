'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Navbar } from '../../../components/Navbar';
import { TickerHeader } from '../../../components/trading/TickerHeader';
import { PriceChart } from '../../../components/trading/PriceChart';
import { OrderBook } from '../../../components/trading/OrderBook';
import { MarketTrades } from '../../../components/trading/MarketTrades';
import { OrderPanel } from '../../../components/trading/OrderPanel';
import { UserTabs } from '../../../components/trading/UserTabs';

import { useBook } from '../../../stores/useBook';
import { useMarket } from '../../../stores/useMarket';
import { useAuth } from '../../../stores/useAuth';
import { useBalances } from '../../../stores/useBalances';

import { api, type TickerDto } from '../../../lib/api';
import { wsClient, type WsConnectionStatus, type WsServerMessage } from '../../../lib/ws';
import { MarketStatus, type MarketConfig } from '@cex/types';

const DEFAULT_MARKETS: MarketConfig[] = [
  {
    symbol: 'SOL_USDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    tickSize: '1000000',     // 0.01 USDT
    lotSize: '1000000',      // 0.01 SOL
    minNotional: '100000000', // 1.00 USDT
    makerFeeBps: 8,
    takerFeeBps: 10,
    status: MarketStatus.ACTIVE,
  },
  {
    symbol: 'BTC_USDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    tickSize: '1000000',     // 0.01 USDT
    lotSize: '100000',       // 0.001 BTC
    minNotional: '500000000', // 5.00 USDT
    makerFeeBps: 8,
    takerFeeBps: 10,
    status: MarketStatus.ACTIVE,
  },
  {
    symbol: 'ETH_USDT',
    baseAsset: 'ETH',
    quoteAsset: 'USDT',
    tickSize: '1000000',     // 0.01 USDT
    lotSize: '1000000',      // 0.01 ETH
    minNotional: '200000000', // 2.00 USDT
    makerFeeBps: 8,
    takerFeeBps: 10,
    status: MarketStatus.ACTIVE,
  },
];

export default function TradingTerminalPage() {
  const params = useParams();
  const rawSymbol = typeof params?.symbol === 'string' ? params.symbol : 'SOL_USDT';
  const symbol = rawSymbol.toUpperCase();

  const { isAuthenticated, accessToken } = useAuth();
  const { setSnapshot, applyDelta } = useBook();
  const { setTicker } = useMarket();
  const { setBalances } = useBalances();

  const [allMarkets, setAllMarkets] = useState<MarketConfig[]>(DEFAULT_MARKETS);
  const [activeMarket, setActiveMarket] = useState<MarketConfig>(
    DEFAULT_MARKETS.find((m) => m.symbol === symbol) || DEFAULT_MARKETS[0]!
  );

  const [ticker, setLocalTicker] = useState<TickerDto | null>({
    market: symbol,
    lastPrice: '14250000000',
    priceChange: '574000000',
    priceChangePercent: 4.2,
    high: '14620000000',
    low: '13610000000',
    baseVolume: '120000000000000',
    quoteVolume: '171000000000000',
    tradesCount: 15420,
  });

  const [selectedBookPrice, setSelectedBookPrice] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('disconnected');
  const [isStale, setIsStale] = useState(false);
  const lastUpdateRef = useRef<number>(Date.now());

  // Set WS token when authenticated
  useEffect(() => {
    wsClient.setAuthToken(accessToken);
  }, [accessToken]);

  // Load Markets and initial REST data
  useEffect(() => {
    let isCancelled = false;

    async function loadInitData() {
      try {
        const res = await api.markets.list().catch(() => ({ markets: DEFAULT_MARKETS }));
        if (isCancelled) return;

        const marketsList = res.markets && res.markets.length > 0 ? res.markets : DEFAULT_MARKETS;
        setAllMarkets(marketsList);

        const current = marketsList.find((m) => m.symbol === symbol) || marketsList[0]!;
        setActiveMarket(current);

        // Fetch initial depth snapshot
        const depthRes = await api.markets.getDepth(current.symbol, 50).catch(() => null);
        if (!isCancelled && depthRes) {
          setSnapshot(depthRes.bids, depthRes.asks, depthRes.lastSeq);
          lastUpdateRef.current = Date.now();
        } else if (!isCancelled) {
          // Synthetic depth if exchange has no orders yet
          const syntheticAsks: [string, string][] = [
            ['14260000000', '1240000000'],
            ['14270000000', '810000000'],
            ['14280000000', '2500000000'],
            ['14290000000', '670000000'],
            ['14300000000', '1830000000'],
            ['14310000000', '420000000'],
            ['14320000000', '3150000000'],
            ['14330000000', '990000000'],
            ['14340000000', '1460000000'],
          ];
          const syntheticBids: [string, string][] = [
            ['14250000000', '1100000000'],
            ['14240000000', '1640000000'],
            ['14230000000', '2200000000'],
            ['14220000000', '730000000'],
            ['14210000000', '1520000000'],
            ['14200000000', '3800000000'],
            ['14190000000', '950000000'],
            ['14180000000', '2100000000'],
            ['14170000000', '1800000000'],
          ];
          setSnapshot(syntheticBids, syntheticAsks, '1');
        }

        // Fetch initial balances if signed in
        if (isAuthenticated) {
          api.wallet.getBalances().then((bRes) => {
            if (!isCancelled && bRes.balances) {
              setBalances(bRes.balances);
            }
          }).catch(() => {});
        }
      } catch {
        // Ignored
      }
    }

    loadInitData();

    return () => {
      isCancelled = true;
    };
  }, [symbol, isAuthenticated, setSnapshot, setBalances]);

  // WebSocket Subscription Lifecycle
  useEffect(() => {
    // 1. Monitor connection status
    const unbindStatus = wsClient.onStatusChange((s) => {
      setWsStatus(s);
      if (s === 'connected') {
        lastUpdateRef.current = Date.now();
        setIsStale(false);
      }
    });

    // 2. Setup depth gap recovery
    wsClient.setDepthGapHandler((gapMarket) => {
      if (gapMarket === symbol) {
        api.markets.getDepth(gapMarket, 50).then((res) => {
          if (res) setSnapshot(res.bids, res.asks, res.lastSeq);
        }).catch(() => {});
      }
    });

    // 3. Subscribe to depth, ticker, and trades
    const depthTopic = `depth@${symbol}`;
    const tickerTopic = `ticker@${symbol}`;

    const handleDepth = (msg: WsServerMessage) => {
      lastUpdateRef.current = Date.now();
      setIsStale(false);
      if (msg.type === 'DEPTH_SNAPSHOT' && msg.market === symbol) {
        setSnapshot(msg.bids, msg.asks, msg.lastSeq);
      } else if (msg.type === 'DEPTH_UPDATE' && msg.market === symbol) {
        applyDelta(msg.deltas, msg.seq);
      }
    };

    const handleTicker = (msg: WsServerMessage) => {
      lastUpdateRef.current = Date.now();
      setIsStale(false);
      if (msg.type === 'TICKER' && msg.market === symbol) {
        const dto: TickerDto = {
          market: msg.market,
          lastPrice: msg.lastPrice,
          priceChange: msg.priceChange,
          priceChangePercent: msg.priceChangePercent,
          high: msg.high,
          low: msg.low,
          baseVolume: msg.baseVolume,
          quoteVolume: msg.quoteVolume,
          tradesCount: msg.tradesCount,
        };
        setLocalTicker(dto);
        setTicker(dto);
      }
    };

    wsClient.subscribe(depthTopic, handleDepth);
    wsClient.subscribe(tickerTopic, handleTicker);

    // 4. Stale Data Healthcheck Interval (Section 8.2: overlay if no update for 10s)
    const staleInterval = setInterval(() => {
      const elapsed = Date.now() - lastUpdateRef.current;
      if (elapsed > 10000) {
        setIsStale(true);
      }
    }, 2000);

    return () => {
      unbindStatus();
      clearInterval(staleInterval);
      wsClient.unsubscribe(depthTopic, handleDepth);
      wsClient.unsubscribe(tickerTopic, handleTicker);
    };
  }, [symbol, setSnapshot, applyDelta, setTicker]);

  const handlePriceSelect = useCallback((px: string) => {
    setSelectedBookPrice(px);
  }, []);

  return (
    <div className="min-h-screen bg-bg text-text flex flex-col font-sans">
      <Navbar fluid />

      {/* Ticker Header */}
      <TickerHeader
        market={activeMarket}
        allMarkets={allMarkets}
        ticker={ticker}
        wsStatus={wsStatus}
        isStale={isStale}
      />

      {/* Main 3-Column Trading Terminal Grid */}
      <main className="flex-1 flex flex-col lg:flex-row items-stretch border-b border-line">
        {/* Column 1: Candlestick Chart (Flex 1, min 520px) */}
        <div className="flex-1 min-w-[320px] lg:min-w-[520px] flex flex-col border-b lg:border-b-0 lg:border-r border-line">
          <PriceChart market={activeMarket.symbol} />
        </div>

        {/* Column 2: Order Book & Market Trades (~300px) */}
        <div className="w-full lg:w-[320px] xl:w-[340px] flex flex-col border-b lg:border-b-0 lg:border-r border-line bg-bg">
          <OrderBook
            market={activeMarket.symbol}
            baseAsset={activeMarket.baseAsset}
            quoteAsset={activeMarket.quoteAsset}
            onSelectPrice={handlePriceSelect}
          />
          <MarketTrades
            market={activeMarket.symbol}
            baseAsset={activeMarket.baseAsset}
            quoteAsset={activeMarket.quoteAsset}
          />
        </div>

        {/* Column 3: Order Placement Panel (~340px) */}
        <div className="w-full lg:w-[340px] xl:w-[360px] flex flex-col bg-bg">
          <OrderPanel
            market={activeMarket}
            selectedPrice={selectedBookPrice}
          />
        </div>
      </main>

      {/* Bottom Panel: User Tabs (Open Orders, History, Trades, Balances) */}
      <UserTabs marketSymbol={activeMarket.symbol} />
    </div>
  );
}
