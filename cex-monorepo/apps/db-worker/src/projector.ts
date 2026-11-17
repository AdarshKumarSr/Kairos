import type { Prisma, PrismaClient } from '@cex/db';
import type { Event } from '@cex/types';
import type { ProjectedBatchSummary } from './types.js';

export function mapToLedgerReason(
  rawReason: string
): 'DEPOSIT' | 'WITHDRAWAL' | 'TRADE' | 'FEE' | 'LOCK' | 'UNLOCK' | 'ADJUSTMENT' {
  const upper = rawReason.toUpperCase();
  switch (upper) {
    case 'DEPOSIT':
      return 'DEPOSIT';
    case 'WITHDRAWAL':
      return 'WITHDRAWAL';
    case 'TRADE':
      return 'TRADE';
    case 'FEE':
      return 'FEE';
    case 'LOCK':
    case 'WITHDRAW_REQUEST':
      return 'LOCK';
    case 'UNLOCK':
    case 'CANCEL_ORDER':
    case 'ORDER_REJECTED':
    case 'WITHDRAW_REJECT':
      return 'UNLOCK';
    case 'ADJUSTMENT':
      return 'ADJUSTMENT';
    default:
      return 'ADJUSTMENT';
  }
}

export interface EventProjectorOptions {
  autoCreateUsers?: boolean;
  autoCreateAssets?: boolean;
}

export class EventProjector {
  private assetCache = new Map<string, string>();
  private userCache = new Set<string>();
  private readonly autoCreateUsers: boolean;
  private readonly autoCreateAssets: boolean;

  constructor(options: EventProjectorOptions = {}) {
    this.autoCreateUsers = options.autoCreateUsers ?? false;
    this.autoCreateAssets = options.autoCreateAssets ?? false;
  }

  public async init(prisma: PrismaClient): Promise<void> {
    const assets = await prisma.asset.findMany();
    for (const a of assets) {
      this.assetCache.set(a.symbol, a.id);
    }
    const users = await prisma.user.findMany({ select: { id: true } });
    for (const u of users) {
      this.userCache.add(u.id);
    }
  }

  public async getAssetId(
    tx: Prisma.TransactionClient,
    symbol: string
  ): Promise<string> {
    const cached = this.assetCache.get(symbol);
    if (cached) return cached;

    const found = await tx.asset.findUnique({
      where: { symbol },
    });

    if (found) {
      this.assetCache.set(symbol, found.id);
      return found.id;
    }

    if (this.autoCreateAssets) {
      const created = await tx.asset.upsert({
        where: { symbol },
        update: {},
        create: {
          symbol,
          name: symbol,
          decimals: 8,
        },
      });
      this.assetCache.set(symbol, created.id);
      return created.id;
    }

    throw new Error(`Asset '${symbol}' not found in database`);
  }

  public async projectBatch(
    tx: Prisma.TransactionClient,
    events: Event[]
  ): Promise<ProjectedBatchSummary> {
    const summary: ProjectedBatchSummary = {
      ordersUpserted: 0,
      tradesInserted: 0,
      balancesUpserted: 0,
      ledgerEntriesInserted: 0,
      depositsUpserted: 0,
      withdrawalsUpserted: 0,
      eventsProcessed: 0,
    };

    for (const event of events) {
      await this.projectSingleEvent(tx, event, summary);
      summary.eventsProcessed++;
    }

    return summary;
  }

  private async projectSingleEvent(
    tx: Prisma.TransactionClient,
    event: Event,
    summary: ProjectedBatchSummary
  ): Promise<void> {
    const engineSeq = BigInt(event.engineSeq);
    const createdAt = new Date(event.ts);
    const d = event.data as Record<string, unknown>;

    switch (event.type) {
      case 'ORDER_ACCEPTED':
      case 'ORDER_PLACED':
      case 'ORDER_UPDATED':
      case 'ORDER_CANCELLED':
      case 'ORDER_REJECTED': {
        const orderId = String(d.orderId ?? '');
        const userId = String(d.userId ?? '');

        // If orderId or userId is missing, skip non-actionable order events
        if (!orderId || !userId || userId === 'unknown') {
          return;
        }

        if (this.autoCreateUsers && !this.userCache.has(userId)) {
          await tx.$executeRaw`
            INSERT INTO "User" ("id", "email", "passwordHash", "updatedAt")
            VALUES (${userId}, ${userId || 'user'} || '@cex.local', 'dummy_hash', NOW())
            ON CONFLICT ("id") DO NOTHING;
          `;
          this.userCache.add(userId);
        }

        const clientOrderId = d.clientOrderId ? String(d.clientOrderId) : null;
        const market = String(d.market ?? '');
        const side = (d.side ? String(d.side) : 'BUY') as 'BUY' | 'SELL';
        const type = (d.type ? String(d.type) : 'LIMIT') as 'LIMIT' | 'MARKET';
        const price =
          d.price !== undefined && d.price !== null && d.price !== ''
            ? BigInt(String(d.price))
            : null;
        const quantity =
          d.quantity !== undefined && d.quantity !== null && d.quantity !== ''
            ? BigInt(String(d.quantity))
            : 0n;
        const quoteQuantity =
          d.quoteQuantity !== undefined &&
          d.quoteQuantity !== null &&
          d.quoteQuantity !== ''
            ? BigInt(String(d.quoteQuantity))
            : null;
        const filledQuantity =
          d.filledQuantity !== undefined &&
          d.filledQuantity !== null &&
          d.filledQuantity !== ''
            ? BigInt(String(d.filledQuantity))
            : 0n;

        let status: 'NEW' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED' =
          'NEW';
        if (event.type === 'ORDER_ACCEPTED') {
          status = 'NEW';
        } else if (event.type === 'ORDER_PLACED') {
          status = 'OPEN';
        } else if (event.type === 'ORDER_CANCELLED') {
          status = 'CANCELLED';
        } else if (event.type === 'ORDER_REJECTED') {
          status = 'REJECTED';
        } else if (event.type === 'ORDER_UPDATED') {
          status =
            filledQuantity >= quantity && quantity > 0n
              ? 'FILLED'
              : 'PARTIALLY_FILLED';
        }
        if (d.status) {
          status = String(d.status) as typeof status;
        }

        const postOnly = Boolean(d.postOnly ?? false);
        const ioc = Boolean(d.ioc ?? false);
        const rejectReason = d.reason
          ? String(d.reason)
          : d.code
            ? String(d.code)
            : null;
        const updatedAt = createdAt;

        await tx.$executeRaw`
          INSERT INTO "Order" (
            "id", "clientOrderId", "userId", "market", "side", "type",
            "price", "quantity", "quoteQuantity", "filledQuantity",
            "status", "postOnly", "ioc", "rejectReason", "engineSeq",
            "createdAt", "updatedAt"
          )
          VALUES (
            ${orderId}, ${clientOrderId}, ${userId}, ${market},
            ${side}::"OrderSide", ${type}::"OrderType",
            ${price}, ${quantity}, ${quoteQuantity}, ${filledQuantity},
            ${status}::"OrderStatus", ${postOnly}, ${ioc}, ${rejectReason}, ${engineSeq},
            ${createdAt}, ${updatedAt}
          )
          ON CONFLICT ("id") DO UPDATE SET
            "filledQuantity" = CASE WHEN EXCLUDED."engineSeq" >= "Order"."engineSeq" THEN EXCLUDED."filledQuantity" ELSE "Order"."filledQuantity" END,
            "status" = CASE WHEN EXCLUDED."engineSeq" >= "Order"."engineSeq" THEN EXCLUDED."status" ELSE "Order"."status" END,
            "rejectReason" = CASE WHEN EXCLUDED."engineSeq" >= "Order"."engineSeq" THEN COALESCE(EXCLUDED."rejectReason", "Order"."rejectReason") ELSE "Order"."rejectReason" END,
            "engineSeq" = CASE WHEN EXCLUDED."engineSeq" >= "Order"."engineSeq" THEN EXCLUDED."engineSeq" ELSE "Order"."engineSeq" END,
            "updatedAt" = CASE WHEN EXCLUDED."engineSeq" >= "Order"."engineSeq" THEN EXCLUDED."updatedAt" ELSE "Order"."updatedAt" END,
            "clientOrderId" = COALESCE("Order"."clientOrderId", EXCLUDED."clientOrderId"),
            "price" = COALESCE(EXCLUDED."price", "Order"."price"),
            "quantity" = CASE WHEN "Order"."quantity" = 0 THEN EXCLUDED."quantity" ELSE "Order"."quantity" END,
            "quoteQuantity" = COALESCE(EXCLUDED."quoteQuantity", "Order"."quoteQuantity");
        `;

        summary.ordersUpserted++;
        break;
      }

      case 'TRADE': {
        const tradeId = String(
          d.tradeId ?? d.id ?? `trade-${event.engineSeq}`
        );
        const market = String(d.market);
        const price = BigInt(String(d.price));
        const quantity = BigInt(String(d.quantity));
        const makerOrderId = String(d.makerOrderId);
        const takerOrderId = String(d.takerOrderId);
        const makerUserId = String(d.makerUserId);
        const takerUserId = String(d.takerUserId);
        const takerSide = (d.takerSide ? String(d.takerSide) : 'BUY') as
          | 'BUY'
          | 'SELL';
        const makerFee = BigInt(String(d.makerFee ?? '0'));
        const takerFee = BigInt(String(d.takerFee ?? '0'));

        await tx.$executeRaw`
          INSERT INTO "Trade" (
            "id", "createdAt", "engineSeq", "market", "price", "quantity",
            "makerOrderId", "takerOrderId", "makerUserId", "takerUserId",
            "takerSide", "makerFee", "takerFee"
          )
          VALUES (
            ${tradeId}, ${createdAt}, ${engineSeq}, ${market}, ${price}, ${quantity},
            ${makerOrderId}, ${takerOrderId}, ${makerUserId}, ${takerUserId},
            ${takerSide}::"OrderSide", ${makerFee}, ${takerFee}
          )
          ON CONFLICT ("engineSeq", "createdAt") DO NOTHING;
        `;

        summary.tradesInserted++;
        break;
      }

      case 'BALANCE_UPDATED': {
        const userId = String(d.userId);
        const asset = String(d.asset);
        const available = BigInt(String(d.available));
        const locked = BigInt(String(d.locked));
        const rawDelta =
          d.delta !== undefined && d.delta !== null ? String(d.delta) : undefined;
        const delta = rawDelta ? BigInt(rawDelta) : 0n;
        const rawReason = String(d.reason ?? 'ADJUSTMENT');
        const refId = d.refId ? String(d.refId) : undefined;
        const withdrawalId = d.withdrawalId ? String(d.withdrawalId) : undefined;

        if (this.autoCreateUsers && !this.userCache.has(userId)) {
          await tx.$executeRaw`
            INSERT INTO "User" ("id", "email", "passwordHash", "updatedAt")
            VALUES (${userId}, ${userId || 'user'} || '@cex.local', 'dummy_hash', NOW())
            ON CONFLICT ("id") DO NOTHING;
          `;
          this.userCache.add(userId);
        }

        const assetId = await this.getAssetId(tx, asset);

        // 1. Upsert Balance conditionally on engineSeq
        await tx.$executeRaw`
          INSERT INTO "Balance" ("id", "userId", "assetId", "available", "locked", "lastEngineSeq")
          VALUES (
            gen_random_uuid()::text,
            ${userId},
            ${assetId},
            ${available},
            ${locked},
            ${engineSeq}
          )
          ON CONFLICT ("userId", "assetId") DO UPDATE SET
            "available" = CASE WHEN EXCLUDED."lastEngineSeq" >= "Balance"."lastEngineSeq" THEN EXCLUDED."available" ELSE "Balance"."available" END,
            "locked" = CASE WHEN EXCLUDED."lastEngineSeq" >= "Balance"."lastEngineSeq" THEN EXCLUDED."locked" ELSE "Balance"."locked" END,
            "lastEngineSeq" = CASE WHEN EXCLUDED."lastEngineSeq" >= "Balance"."lastEngineSeq" THEN EXCLUDED."lastEngineSeq" ELSE "Balance"."lastEngineSeq" END;
        `;
        summary.balancesUpserted++;

        // 2. Insert LedgerEntry (idempotent ON CONFLICT DO NOTHING)
        const mappedReason = mapToLedgerReason(rawReason);
        const ledgerRefId = refId ?? withdrawalId ?? null;

        await tx.$executeRaw`
          INSERT INTO "LedgerEntry" (
            "id", "userId", "asset", "delta", "reason", "refId", "engineSeq", "createdAt"
          )
          VALUES (
            gen_random_uuid()::text,
            ${userId},
            ${asset},
            ${delta},
            ${mappedReason}::"LedgerReason",
            ${ledgerRefId},
            ${engineSeq},
            ${createdAt}
          )
          ON CONFLICT ("engineSeq", "userId", "asset", "reason") DO NOTHING;
        `;
        summary.ledgerEntriesInserted++;

        // 3. Link Deposits & Withdrawals
        if (rawReason === 'DEPOSIT' && refId) {
          const depositAmount = delta > 0n ? delta : available;
          await tx.$executeRaw`
            INSERT INTO "Deposit" ("id", "userId", "asset", "amount", "createdAt")
            VALUES (${refId}, ${userId}, ${asset}, ${depositAmount}, ${createdAt})
            ON CONFLICT ("id") DO NOTHING;
          `;
          summary.depositsUpserted++;
        }

        if (withdrawalId) {
          const withdrawAmount = delta < 0n ? -delta : delta > 0n ? delta : 0n;
          if (rawReason === 'WITHDRAW_REQUEST') {
            await tx.$executeRaw`
              INSERT INTO "Withdrawal" ("id", "userId", "asset", "amount", "status", "createdAt")
              VALUES (${withdrawalId}, ${userId}, ${asset}, ${withdrawAmount}, 'PENDING'::"WithdrawStatus", ${createdAt})
              ON CONFLICT ("id") DO UPDATE SET "status" = 'PENDING'::"WithdrawStatus";
            `;
            summary.withdrawalsUpserted++;
          } else if (rawReason === 'WITHDRAWAL') {
            await tx.$executeRaw`
              UPDATE "Withdrawal"
              SET "status" = 'COMPLETED'::"WithdrawStatus", "decidedAt" = ${createdAt}
              WHERE "id" = ${withdrawalId};
            `;
            summary.withdrawalsUpserted++;
          } else if (rawReason === 'WITHDRAW_REJECT') {
            await tx.$executeRaw`
              UPDATE "Withdrawal"
              SET "status" = 'REJECTED'::"WithdrawStatus", "decidedAt" = ${createdAt}
              WHERE "id" = ${withdrawalId};
            `;
            summary.withdrawalsUpserted++;
          }
        }
        break;
      }

      case 'MARKET_STATUS': {
        const market = String(d.market ?? '');
        const status = String(d.status ?? 'ACTIVE') as
          | 'ACTIVE'
          | 'HALTED'
          | 'DELISTED';
        if (market) {
          await tx.$executeRaw`
            UPDATE "Market"
            SET "status" = ${status}::"MarketStatus"
            WHERE "symbol" = ${market};
          `;
        }
        break;
      }

      case 'DEPTH_DELTA':
      default:
        // No-op for depth deltas or unrecognized events
        break;
    }
  }
}
