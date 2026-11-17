# Project Status & Progress Tracker

> **Documentation Index**
> - **[cex.md](./cex.md)**: Master product, architecture, and engineering specification (The Blueprint).
> - **[agent.md](./agent.md)**: Guidelines, rules, and invariants for human and AI contributors.
> - **[README.md](./README.md)**: Current build status, completed deliverables, and pending roadmap (This Document).

---

## 1. Executive Summary

**Kairos CEX** is a high-performance spot centralized cryptocurrency exchange built with strict TypeScript, an in-memory deterministic matching engine, and an event-driven microservices monorepo.

This document tracks **what has been built so far** and **what is pending** across the 21-phase implementation roadmap.

---

## 2. What Has Been Built (Completed Milestones)

### Phase 1: Monorepo Foundation & TypeScript Configuration
- **Workspace Architecture**: Configured npm workspaces containing `packages/*` and `apps/*`.
- **Strict TypeScript Setup**: Shared `tsconfig.base.json` with strict `NodeNext` module resolution, declaration generation, and exact optional properties.
- **Shared Package `@cex/types`**: Type definitions, core enums (`Side`, `OrderType`, `OrderStatus`, `RejectCode`, `MarketStatus`), and API data transfer objects.
- **Shared Package `@cex/config`**: Zod-validated environment configuration (`loadConfig()`) failing fast on invalid variables.

### Phase 2: Database Schema & Hypertable Setup (`@cex/db`)
- **Prisma ORM**: Relational models for `User`, `RefreshToken`, `Order`, `Trade`, `LedgerEntry`, `Market`, `Asset`, and `AuditLog`.
- **TimescaleDB Integration**: PostgreSQL 16 + TimescaleDB migrations configured with time-series hypertable support for high-throughput trade history.
- **Database Seeding**: Canonical assets (`USDT`, `SOL`, `BTC`, `ETH`), initial markets, and seeded administrator accounts.

### Phase 3: High-Precision Scaled Money Math (`@cex/money`)
- **Zero Float Rule**: Pure BigInt arithmetic with an internal scale of $10^8$ preventing IEEE 754 precision errors.
- **Safe Math Functions**: Scaled arithmetic operations including ceiling fee calculations (`mulDivCeil`), quote budgeting, buy-limit locking, and decimal string wire serialization.
- **Extensive Property Tests**: Fast-check fuzz testing validating mathematical conservation invariants.

### Phase 4: Authentication & API Gateway (`apps/api-gateway`)
- **Fastify Framework**: Stateless API Gateway featuring Helmet, CORS, and cookie parser.
- **Security & Password Hashing**: `argon2id` cryptographic hashing for user credentials.
- **Token Lifecycle**: 15-minute access JWTs and rotating 7-day refresh tokens stored securely as hashes with family reuse detection.
- **Auth Endpoints**: Signup, login, token refresh, and logout routes with Zod schema validation and rate limiting.

### Phase 5: Order-Book Data Structure (`apps/engine/src/book/`)
- **DoublyLinkedList<T>**: $O(1)$ node insertion and removal with direct node pointers, iteration, and size management.
- **SortedPriceLevels**: Bids sorted descending (highest first) and asks sorted ascending (lowest first) with binary search lookup and insertion.
- **Book Core**: $O(1)$ indexed cancellations via map + list node, partial fill reductions, depth ladders, and total resting quantity tracking.
- **Deterministic Serialization**: `Book.snapshot()` and `Book.restore()` providing byte-identical state replication for crash recovery.
- **Property-Based Testing & Benchmark**: 1,000-run `fast-check` suite verifying Invariant 11 (quantity conservation), sorting invariants, index consistency, and a 100,000 add + 100,000 cancel benchmark running in < 1,000 ms.

### Phase 6: Matching Engine Core (`apps/engine/src/engine/`)
- **Pure Synchronous `Engine.process()`**: Invariant-locked deterministic execution containing zero I/O, `Date.now()`, or `Math.random()`.
- **Validation Engine**: Strict market status, price tick, lot size, minNotional, flag combinations (Section 4.2), and balance approval checks.
- **Unified Parameterized Matcher**: Single matching loop covering LIMIT, MARKET (quoteQuantity budget for BUY), post-only checks, and Self-Trade Prevention (STP `CANCEL_TAKER`).
- **Complete Event Emission**: Emits `ORDER_ACCEPTED`, `TRADE`, `ORDER_PLACED`, `ORDER_UPDATED`, `ORDER_CANCELLED`, `ORDER_REJECTED`, and `DEPTH_DELTA` events with strictly increasing sequence numbers.
- **Market Control Operations**: Handling `CANCEL_ORDER`, `HALT_MARKET`, `RESUME_MARKET`, and dynamic `MARKET_CONFIG` updates.
- **Table-Driven Verification & Fuzzing**: 15 test suites covering sweeps, time priority FIFO, thin books, IOC cancels, and a 100,000-command seeded fuzz run confirming $best\_bid < best\_ask$ and zero crossed books.
- **High-Throughput Benchmark**: Achieves **> 184,000 orders/sec** in-process on laptop (exceeding the 100,000 orders/sec threshold).

### Phase 7: Balances, Locking, Fees, and Settlement (`apps/engine/src/balance/`)
- **In-Memory Balance Sheet (`BalanceManager`)**: Authoritative in-engine balance manager tracking per-user, per-asset available and locked balances, cumulative deposits/withdrawals, and accumulated exchange fee reserves.
- **Atomic Lock Lifecycle & Price-Improvement Refunds**: Pre-trade locking on order placement (base for SELL, quote via `mulDivCeil` for BUY limit, quoteQuantity for BUY market). Trade settlement directly decrements locked balances, credits bought assets net of fees, and refunds buyer quote locks when filled at price improvement.
- **Exchange-Favoring Ceiling Fees**: Strictly adheres to Invariant 8 / Section 5.3 with `mulDivCeil` ensuring zero fractional deficit on any fill.
- **Continuous Invariant Verification (`Engine.checkInvariants(state)`)**: Enforces:
  1. Book orderliness ($best\_bid < best\_ask$).
  2. Conservation per asset: $totalDeposited - totalWithdrawn \equiv \sum(available + locked) + fee$.
  3. Lock consistency: $user.locked \equiv \sum(order locks) + \sum(withdrawal locks)$.
- **100,000-Command Invariant Fuzz Verification**: 100,000 randomized operations (deposits, limit/market orders, cancellations) verifying all 3 invariants at *every single step*.
- **Section 5.3 Worked Example Verification**: Exact-to-the-unit replication of Section 5.3 worked example (Alice & Bob 10 SOL @ 142.50 fill, maker/taker fee splits, price-improvement refund, and fee reserves).

### Logging Infrastructure (`@cex/logger` & `logs/`)
- **Winston Transition**: Complete migration from Pino to Winston structured JSON logging.
- **Data Protection & Redaction**: Automatic recursive redaction of sensitive credentials (`passwords`, `tokens`, `cookies`, `secrets`, `API keys`).
- **Specialized Loggers**:
  - `apilogs.ts`: Request/response telemetry, status codes, response times, and automated warnings for slow requests (> 200 ms).
  - `errorlogs.ts`: Error capture with stack trace extraction, error codes, and request context.
  - `debuglogs.ts`: Deep diagnostic and trace logging for internal services.

---

## 3. Current Phase Status

| Phase | Description | Status | Deliverables |
|:-----:|:------------|:------:|:-------------|
| **0** | Dev Infrastructure | In Progress | Docker Compose (`docker-compose.dev.yml`), local env files |
| **1** | Monorepo & Types | **Done** | `@cex/types`, `@cex/config`, root workspace config |
| **2** | Database & Hypertables | **Done** | `@cex/db`, Prisma schemas, TimescaleDB migrations |
| **3** | Money Math | **Done** | `@cex/money`, $10^8$ BigInt scaling, property tests |
| **4** | Authentication | **Done** | `apps/api-gateway`, JWT rotation, argon2id, rate limiting |
| **—** | Logging System | **Done** | `@cex/logger`, Winston, `apilogs.ts`, `errorlogs.ts`, `debuglogs.ts` |
| **5** | Order-Book Structure | **Done** | Price-level linked lists, limit order books, FIFO queues, snapshots |
| **6** | Matching Logic | **Done** | Pure synchronous engine matching, maker execution, STP, 184k ops/s |
| **7** | Balances & Fees | **Done** | In-memory balance sheet, fee deductions, lock invariants |
| **8** | Redis Streams Messaging | **Pending** | Redis command/reply/event stream integration & engine runner |
| **9** | Trading API | **Pending** | Order placement, order cancellation, and book queries |
| **10**| Journal & Recovery | **Pending** | Append-only WAL (`journal-*.log`), snapshots, crash recovery |
| **11**| DB Projection Worker | **Pending** | `apps/db-worker` consuming stream events into PostgreSQL |
| **12**| Market Data Service | **Pending** | `apps/market-data` ticker, rolling statistics, and k-lines |
| **13**| WebSocket Fan-out | **Pending** | `apps/ws-server` client subscriptions and depth pushes |
| **14**| Wallet & Admin Operations | **Pending** | Simulated ledger deposits/withdrawals, admin controls |
| **15**| Frontend Foundation | **Pending** | Next.js 14 App Router layout, Tailwind CSS, Zustand |
| **16**| Trading Terminal | **Pending** | Candlestick charts, interactive depth ladder, order form |
| **17**| History & Admin UI | **Pending** | Order history, balance modals, admin monitoring views |
| **18**| Verification & Resilience | **Pending** | Fuzz testing, chaos simulation, load tests with k6 |
| **19**| Observability & Deployment| **Pending** | Prometheus metrics, Grafana dashboards, Nginx reverse proxy |
| **20**| Release Readiness (`v1.0.0`)| **Pending** | End-to-end verification and demonstration scripts |

---

## 4. What's Next (Immediate Priorities)

1. **Phase 8: Messaging Layer (Redis Streams) & Engine Runner (`apps/engine/src/runner/`)**:
   - Redis command/reply/event stream integration.
   - Deterministic event loop reading from stream, dispatching through `Engine.process()`, writing events to output stream and replies.
   - Backpressure and 202 accepted timeouts.

---

## 5. Development Commands

```bash
# Build all packages and apps
npm run build

# Run static type checks across all packages, apps, and test files
npm run typecheck

# Lint codebase
npm run lint

# Run unit and integration tests
npm test
```
