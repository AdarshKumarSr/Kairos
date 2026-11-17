import { z } from 'zod';
import { Side, OrderType } from '@cex/types';

export const placeOrderSchema = z
  .object({
    market: z.string().min(1, 'Market symbol is required'),
    side: z.nativeEnum(Side),
    type: z.nativeEnum(OrderType),
    price: z.string().regex(/^\d+$/, 'Price must be a positive integer in scaled 1e8 units').optional(),
    quantity: z.string().regex(/^\d+$/, 'Quantity must be a positive integer in scaled 1e8 units').optional(),
    quoteQuantity: z.string().regex(/^\d+$/, 'Quote quantity must be a positive integer in scaled 1e8 units').optional(),
    postOnly: z.boolean().optional().default(false),
    ioc: z.boolean().optional().default(false),
    clientOrderId: z.string().max(64).optional(),
  })
  .superRefine((val, ctx) => {
    // 1. Flag validations (Section 4.2)
    if (val.postOnly && val.ioc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['postOnly'],
        message: 'postOnly and ioc are mutually exclusive',
      });
    }

    if (val.type === OrderType.MARKET && val.postOnly) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['postOnly'],
        message: 'Market orders cannot have postOnly=true',
      });
    }

    // 2. LIMIT order parameter requirements
    if (val.type === OrderType.LIMIT) {
      if (!val.price || BigInt(val.price) <= 0n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['price'],
          message: 'Limit order requires a positive price',
        });
      }
      if (!val.quantity || BigInt(val.quantity) <= 0n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['quantity'],
          message: 'Limit order requires a positive quantity',
        });
      }
    }

    // 3. MARKET order parameter requirements
    if (val.type === OrderType.MARKET) {
      if (val.side === Side.BUY) {
        const hasQuote = val.quoteQuantity && BigInt(val.quoteQuantity) > 0n;
        const hasBase = val.quantity && BigInt(val.quantity) > 0n;
        if (!hasQuote && !hasBase) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['quoteQuantity'],
            message: 'Market BUY requires quoteQuantity (or quantity)',
          });
        }
      } else {
        if (!val.quantity || BigInt(val.quantity) <= 0n) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['quantity'],
            message: 'Market SELL requires quantity',
          });
        }
      }
    }
  });

export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;

export const orderIdParamSchema = z.object({
  orderId: z.string().min(1, 'Order ID is required'),
});

export const openOrdersQuerySchema = z.object({
  market: z.string().optional(),
});

export const paginationQuerySchema = z.object({
  market: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const depthQuerySchema = z.object({
  market: z.string().min(1, 'Market symbol is required'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const depositSchema = z.object({
  asset: z.string().min(1, 'Asset is required'),
  amount: z.string().regex(/^\d+$/, 'Amount must be a positive integer in scaled 1e8 units'),
});

export const withdrawSchema = z.object({
  asset: z.string().min(1, 'Asset is required'),
  amount: z.string().regex(/^\d+$/, 'Amount must be a positive integer in scaled 1e8 units'),
});

export const marketSymbolParamSchema = z.object({
  symbol: z.string().min(1, 'Market symbol is required'),
});

export const withdrawalIdParamSchema = z.object({
  id: z.string().min(1, 'Withdrawal ID is required'),
});

export const createMarketSchema = z.object({
  symbol: z.string().min(1, 'Symbol is required'),
  baseAsset: z.string().min(1, 'Base asset is required'),
  quoteAsset: z.string().min(1, 'Quote asset is required'),
  tickSize: z.string().regex(/^\d+$/, 'Tick size must be scaled integer'),
  lotSize: z.string().regex(/^\d+$/, 'Lot size must be scaled integer'),
  minNotional: z.string().regex(/^\d+$/, 'Min notional must be scaled integer'),
  makerFeeBps: z.coerce.number().int().min(0).max(1000).default(8),
  takerFeeBps: z.coerce.number().int().min(0).max(1000).default(10),
});

export const updateMarketSchema = z.object({
  tickSize: z.string().regex(/^\d+$/).optional(),
  lotSize: z.string().regex(/^\d+$/).optional(),
  minNotional: z.string().regex(/^\d+$/).optional(),
  makerFeeBps: z.coerce.number().int().min(0).max(1000).optional(),
  takerFeeBps: z.coerce.number().int().min(0).max(1000).optional(),
});

export const publicTradesQuerySchema = z.object({
  market: z.string().min(1, 'Market symbol is required'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const tickerQuerySchema = z.object({
  market: z.string().optional(),
});

export const klinesQuerySchema = z.object({
  market: z.string().min(1, 'Market symbol is required'),
  interval: z.enum(['1m', '5m', '15m', '1h', '1d']).default('15m'),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
});
