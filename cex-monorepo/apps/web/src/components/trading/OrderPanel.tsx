'use client';

import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useBalances } from '../../stores/useBalances';
import { useOrders } from '../../stores/useOrders';
import { useAuth } from '../../stores/useAuth';
import { formatBalance, formatPrice, parseInputToScaled } from '../../lib/format';
import {
  calculateSliderAmount,
  validateOrder,
  getRejectMessage,
} from '../../lib/orderValidation';
import { Side, OrderType, type MarketConfig } from '@cex/types';
import { toScaled } from '@cex/money';

interface OrderPanelProps {
  market: MarketConfig;
  selectedPrice?: string | null;
  onOrderSubmitted?: () => void;
}

export function OrderPanel({
  market,
  selectedPrice,
  onOrderSubmitted,
}: OrderPanelProps) {
  const { isAuthenticated } = useAuth();
  const { getBalance, updateBalance } = useBalances();
  const { addOpenOrder } = useOrders();

  const [side, setSide] = useState<Side>(Side.BUY);
  const [orderType, setOrderType] = useState<OrderType>(OrderType.LIMIT);
  const [price, setPrice] = useState('142.50');
  const [quantity, setQuantity] = useState('');
  const [quoteQuantity, setQuoteQuantity] = useState('');
  const [postOnly, setPostOnly] = useState(false);
  const [ioc, setIoc] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Balances
  const quoteBal = getBalance(market.quoteAsset);
  const baseBal = getBalance(market.baseAsset);

  const availQuoteBig = BigInt(quoteBal.available || '0');
  const availBaseBig = BigInt(baseBal.available || '0');

  // When orderbook price is clicked, update price field
  useEffect(() => {
    if (selectedPrice) {
      setPrice(selectedPrice);
    }
  }, [selectedPrice]);

  const handleSliderClick = (pct: 25 | 50 | 75 | 100) => {
    let pScaled = 0n;
    try {
      pScaled = parseInputToScaled(price);
    } catch {
      pScaled = 0n;
    }

    const { quantity: qBig, quoteAmount: qAmountBig } = calculateSliderAmount({
      side: side === Side.BUY ? 'BUY' : 'SELL',
      orderType: orderType === OrderType.LIMIT ? 'LIMIT' : 'MARKET',
      pct,
      availableQuote: availQuoteBig,
      availableBase: availBaseBig,
      priceScaled: pScaled,
      lotSize: BigInt(market.lotSize),
    });

    if (orderType === OrderType.LIMIT) {
      setQuantity((Number(qBig) / 1e8).toString());
    } else {
      if (side === Side.BUY) {
        setQuoteQuantity((Number(qAmountBig) / 1e8).toString());
      } else {
        setQuantity((Number(qBig) / 1e8).toString());
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!isAuthenticated) {
      setErrorMsg('Please sign in to place orders.');
      return;
    }

    let pScaled = 0n;
    let qScaled = 0n;
    let qqScaled = 0n;

    try {
      if (orderType === OrderType.LIMIT) {
        pScaled = parseInputToScaled(price);
        qScaled = parseInputToScaled(quantity);
      } else {
        if (side === Side.BUY) {
          qqScaled = parseInputToScaled(quoteQuantity);
        } else {
          qScaled = parseInputToScaled(quantity);
        }
      }
    } catch {
      setErrorMsg('Invalid number format.');
      return;
    }

    // Client-side preflight validation
    const validation = validateOrder({
      side: side === Side.BUY ? 'BUY' : 'SELL',
      type: orderType === OrderType.LIMIT ? 'LIMIT' : 'MARKET',
      priceScaled: pScaled,
      quantityScaled: qScaled,
      quoteQuantityScaled: qqScaled,
      marketConfig: market,
      availableQuote: availQuoteBig,
      availableBase: availBaseBig,
    });

    if (!validation.valid) {
      const firstErr =
        validation.errors.general ||
        validation.errors.price ||
        validation.errors.quantity ||
        validation.errors.quoteQuantity;
      setErrorMsg(firstErr || 'Validation failed');
      return;
    }

    setIsSubmitting(true);
    const clientOrderId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    try {
      const res = await api.orders.place({
        market: market.symbol,
        side,
        type: orderType,
        price: orderType === OrderType.LIMIT ? pScaled.toString() : undefined,
        quantity: qScaled > 0n ? qScaled.toString() : undefined,
        quoteQuantity: qqScaled > 0n ? qqScaled.toString() : undefined,
        postOnly: orderType === OrderType.LIMIT ? postOnly : undefined,
        timeInForce: ioc ? 'IOC' : 'GTC',
        clientOrderId,
      });

      if (res.order) {
        addOpenOrder(res.order);
        setSuccessMsg(`Order placed successfully! (${res.order.orderId.slice(0, 8)})`);
        setQuantity('');
        setQuoteQuantity('');

        // Refresh user balances
        api.wallet.getBalances().then((bRes) => {
          if (bRes.balances) {
            for (const b of bRes.balances) {
              updateBalance(b.asset, b.available, b.locked);
            }
          }
        }).catch(() => {});

        if (onOrderSubmitted) onOrderSubmitted();
      }
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code: string }).code)
          : err instanceof Error
          ? err.message
          : undefined;
      setErrorMsg(getRejectMessage(code));
    } finally {
      setIsSubmitting(false);
    }
  };

  const isBuy = side === Side.BUY;
  const isLimit = orderType === OrderType.LIMIT;

  // Compute live estimated total & fee
  let estTotalDisplay = '--';
  let feeDisplay = '--';
  try {
    if (isLimit) {
      const p = parseInputToScaled(price);
      const q = parseInputToScaled(quantity);
      if (p > 0n && q > 0n) {
        const notional = (p * q) / toScaled('1');
        const feeBps = BigInt(market.makerFeeBps);
        const fee = (notional * feeBps) / 10000n;
        estTotalDisplay = `${formatPrice(notional, 2)} ${market.quoteAsset}`;
        feeDisplay = `${formatPrice(fee, 4)} ${market.quoteAsset}`;
      }
    } else {
      if (isBuy && quoteQuantity) {
        const qq = parseInputToScaled(quoteQuantity);
        const feeBps = BigInt(market.takerFeeBps);
        const fee = (qq * feeBps) / 10000n;
        estTotalDisplay = `${formatPrice(qq, 2)} ${market.quoteAsset}`;
        feeDisplay = `${formatPrice(fee, 4)} ${market.quoteAsset}`;
      }
    }
  } catch {
    // Keep defaults
  }

  return (
    <div className="flex flex-col text-xs bg-bg select-none">
      <div className="px-4 py-2 font-semibold text-text border-b border-line">
        Place Order
      </div>

      <form onSubmit={handleSubmit} className="p-4 flex flex-col gap-4">
        {/* Buy / Sell Tabs */}
        <div className="grid grid-cols-2 gap-1 p-1 bg-surface border border-line rounded-xl">
          <button
            type="button"
            onClick={() => setSide(Side.BUY)}
            className={`py-2 rounded-lg font-semibold text-sm transition-all ${
              isBuy
                ? 'bg-up text-on-up shadow-sm'
                : 'text-muted hover:text-text'
            }`}
          >
            Buy
          </button>
          <button
            type="button"
            onClick={() => setSide(Side.SELL)}
            className={`py-2 rounded-lg font-semibold text-sm transition-all ${
              !isBuy
                ? 'bg-down text-on-down shadow-sm'
                : 'text-muted hover:text-text'
            }`}
          >
            Sell
          </button>
        </div>

        {/* Limit / Market Toggle */}
        <div className="flex gap-6 border-b border-line text-sm">
          <button
            type="button"
            onClick={() => {
              setOrderType(OrderType.LIMIT);
            }}
            className={`pb-2.5 font-medium transition-colors border-b-2 -mb-[1px] ${
              isLimit
                ? 'border-accent text-text font-semibold'
                : 'border-transparent text-muted hover:text-text'
            }`}
          >
            Limit
          </button>
          <button
            type="button"
            onClick={() => {
              setOrderType(OrderType.MARKET);
              setPostOnly(false);
            }}
            className={`pb-2.5 font-medium transition-colors border-b-2 -mb-[1px] ${
              !isLimit
                ? 'border-accent text-text font-semibold'
                : 'border-transparent text-muted hover:text-text'
            }`}
          >
            Market
          </button>
        </div>

        {/* Available Balance */}
        <div className="flex justify-between items-center text-xs">
          <span className="text-muted">Available</span>
          <span className="font-mono text-text font-medium">
            {isBuy
              ? `${formatBalance(availQuoteBig, 2)} ${market.quoteAsset}`
              : `${formatBalance(availBaseBig, 4)} ${market.baseAsset}`}
          </span>
        </div>

        {/* Price Input (for Limit) */}
        {isLimit && (
          <div className="flex flex-col gap-1.5">
            <label className="text-muted text-xs">Price</label>
            <div className="flex items-center px-3 py-2 bg-surface border border-line rounded-lg focus-within:border-accent">
              <input
                type="text"
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0.00"
                className="flex-1 bg-transparent border-none outline-none font-mono text-sm text-right text-text"
              />
              <span className="ml-2 text-muted font-medium text-xs">{market.quoteAsset}</span>
            </div>
          </div>
        )}

        {/* Quantity Input (for Limit and Sell Market) */}
        {(isLimit || !isBuy) && (
          <div className="flex flex-col gap-1.5">
            <label className="text-muted text-xs">Quantity</label>
            <div className="flex items-center px-3 py-2 bg-surface border border-line rounded-lg focus-within:border-accent">
              <input
                type="text"
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="0.00"
                className="flex-1 bg-transparent border-none outline-none font-mono text-sm text-right text-text"
              />
              <span className="ml-2 text-muted font-medium text-xs">{market.baseAsset}</span>
            </div>
          </div>
        )}

        {/* Amount to spend (for Buy Market) */}
        {!isLimit && isBuy && (
          <div className="flex flex-col gap-1.5">
            <label className="text-muted text-xs">Amount to spend</label>
            <div className="flex items-center px-3 py-2 bg-surface border border-line rounded-lg focus-within:border-accent">
              <input
                type="text"
                inputMode="decimal"
                value={quoteQuantity}
                onChange={(e) => setQuoteQuantity(e.target.value)}
                placeholder="0.00"
                className="flex-1 bg-transparent border-none outline-none font-mono text-sm text-right text-text"
              />
              <span className="ml-2 text-muted font-medium text-xs">{market.quoteAsset}</span>
            </div>
          </div>
        )}

        {/* Percentage Slider Buttons (25% / 50% / 75% / 100%) */}
        <div className="grid grid-cols-4 gap-2">
          {([25, 50, 75, 100] as const).map((pct) => (
            <button
              key={pct}
              type="button"
              onClick={() => handleSliderClick(pct)}
              className="py-1.5 border border-line rounded-md text-xs font-mono text-text2 hover:bg-surface2/60 transition-colors"
            >
              {pct}%
            </button>
          ))}
        </div>

        {/* Flags (Post-Only & IOC) */}
        {isLimit && (
          <div className="flex items-center gap-5 pt-1">
            <label className="flex items-center gap-2 cursor-pointer text-text2 text-xs">
              <input
                type="checkbox"
                checked={postOnly}
                onChange={() => {
                  setPostOnly(!postOnly);
                  if (!postOnly) setIoc(false);
                }}
                className="w-3.5 h-3.5 rounded accent-accent"
              />
              <span>Post-only</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-text2 text-xs">
              <input
                type="checkbox"
                checked={ioc}
                onChange={() => {
                  setIoc(!ioc);
                  if (!ioc) setPostOnly(false);
                }}
                className="w-3.5 h-3.5 rounded accent-accent"
              />
              <span>IOC</span>
            </label>
          </div>
        )}

        {/* Estimated Total & Fee */}
        <div className="flex flex-col gap-1.5 pt-3 border-t border-line text-xs text-muted">
          <div className="flex justify-between">
            <span>Est. total</span>
            <span className="font-mono text-text font-medium">{estTotalDisplay}</span>
          </div>
          <div className="flex justify-between">
            <span>Fee ({isLimit ? `maker ${market.makerFeeBps / 100}%` : `taker ${market.takerFeeBps / 100}%`})</span>
            <span className="font-mono text-text font-medium">{feeDisplay}</span>
          </div>
        </div>

        {/* Error / Success Notices */}
        {errorMsg && (
          <div className="p-2.5 rounded-lg bg-down-soft/40 border border-down/30 text-down text-xs">
            {errorMsg}
          </div>
        )}
        {successMsg && (
          <div className="p-2.5 rounded-lg bg-up-soft/40 border border-up/30 text-up text-xs font-medium">
            {successMsg}
          </div>
        )}

        {/* Submit Button */}
        <button
          type="submit"
          disabled={isSubmitting}
          className={`w-full py-3 rounded-xl font-semibold text-sm transition-all disabled:opacity-50 cursor-pointer ${
            isBuy
              ? 'bg-up text-on-up hover:brightness-105'
              : 'bg-down text-on-down hover:brightness-105'
          }`}
        >
          {isSubmitting
            ? 'Submitting...'
            : `${isBuy ? 'Buy' : 'Sell'} ${market.baseAsset}`}
        </button>
      </form>
    </div>
  );
}
