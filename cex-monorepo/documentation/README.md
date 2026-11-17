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

### Phase 8: Messaging Layer & Engine Runner (`apps/engine/src/runner/`, `apps/api-gateway/src/engine/`)
- **EngineRunner Daemon**: Redis Streams consumer group daemon reading `engine.commands`, executing pure synchronous `Engine.process()`, pipelining replies to `engine.replies`, events to `engine.events`, and acknowledging (`XACK`) with automated stream trimming.
- **State Idempotency Window**: 24h / 1M-entry in-memory cache returning original `EngineReply` on duplicate `commandId` or `(userId, clientOrderId)` with zero double-fills or balance corruption.
- **Crash & Pending-Entries Recovery**: Drains unacknowledged `XPENDING` entries upon startup before consuming new messages, ensuring zero message loss across restarts.
- **Gateway EngineClient & Backpressure**: Gateway client with `send(command)`, queue backpressure monitoring (`XLEN` vs `MAX_QUEUE_LEN` returning 503 `EngineOverloadedError`), and background reply promise resolver with 2s timeout returning `{ status: 'PENDING' }` (202).
- **High-Throughput Integration Benchmark**: Processes **8,000–9,700 commands/sec** end-to-end on laptop over live Redis (exceeding the 3,000 cmd/sec target) with 0 unacknowledged entries on shutdown.

### Phase 9: API Gateway Trading Routes (`apps/api-gateway/src/routes/trading.ts`)
- **Order REST Routes**: `POST /api/v1/order` (Zod validation, tick/lot/minNotional pre-flight checks, 20 req/s/user rate limit, `EngineClient` dispatch, 201/202/422 status mapping), `DELETE /api/v1/order/:orderId` (cancel order, 403 NOT_OWNER, 404 ORDER_NOT_FOUND mapping), and `GET /api/v1/order/:orderId`.
- **Trading & Market Queries**: `GET /api/v1/markets` (active market configs), `GET /api/v1/depth` (live L2 depth snapshot), `GET /api/v1/orders/open` (open resting orders), `GET /api/v1/orders/history` (cursor-paginated), `GET /api/v1/trades/mine` (cursor-paginated user trade history), `GET /api/v1/balances` (available/locked balances), and simulated `POST /api/v1/wallet/deposit`.
- **MarketConfigCache**: In-memory and Redis (`marketcfg:{symbol}`) market caching synchronized from PostgreSQL.
- **OpenAPI 3.1 & Interactive Swagger UI**: Complete specification generated from Zod schemas served at `/docs/openapi.json` and interactive UI at `/docs`.
- **Telemetry & Slow-Request Warnings**: Detailed request logging with `requestId` and automatic warnings for requests exceeding 200 ms.
- **Live End-to-End Verification**: Complete lifecycle test (`sign in -> deposit -> place order (201) -> see in /orders/open -> cancel -> verify unlock`) passing against live EngineRunner, Redis, and PostgreSQL.

### Phase 10: Engine Persistence and Recovery (`apps/engine/src/persistence/`)
- **WAL Append-Only Journal**: Appends `{seq, commandId, ts, streamId, command, crc32}` records to `journal-<startSeq>.log` in `ENGINE_DATA_DIR` before pure execution. Supports configurable fsync (`ENGINE_FSYNC_MS` or `always`).
- **Atomic Snapshot Mechanism**: Serializes complete deterministic `EngineState` (`BookSnapshot`, `BalanceManagerSnapshot`, idempotency window, `engineSeq`, `lastStreamId`) to `snapshot-<seq>.tmp`, fsyncs, and atomically renames to `snapshot-<seq>.json`. Automatically retains the last 3 snapshots and deletes older snapshots.
- **Journal Rotation & Cleanup**: Rotates to a new journal segment per snapshot (`journal-<newStartSeq>.log`) and automatically deletes segments older than the 3rd newest snapshot.
- **Crash Recovery & Torn Tail Truncation**: Recovery scans for the newest valid snapshot, restores state, replays journal records with `seq > snapshot.seq`, detects torn tails and CRC32 mismatches, cleanly truncates corrupted trailing bytes to record boundaries, and runs `Engine.checkInvariants(state)` before resuming.
- **Stream Alignment**: Stores `lastStreamId` in snapshots and journals, enabling `EngineRunner` to resume consumer group processing without double-execution (guarded by the idempotency window).
- **Deterministic State SHA-256 Hash**: Cryptographic state hashing proving Invariant 7 (Determinism).
- **CLI Tools**: `engine:verify` (replays journal and prints state hash) and `engine:snapshot-now` (creates immediate atomic snapshot).
- **50-Moment Crash Simulation Verification**: Seeded 500-command workload subjected to 50 randomized crash points and torn write injections; verifies byte-identical state SHA-256 hash match against reference engine in all 50 runs with zero acknowledged orders lost (Invariant 10).
- **High-Throughput Replay Benchmark**: Replays journal records at **> 146,000 commands/sec** (far exceeding the 1,000,000 commands in < 60s requirement).

### Phase 11: DB Worker - Idempotent PostgreSQL Projection (`apps/db-worker/`)
- **`DbWorker` Consumer**: Consumer group `dbw` on Redis stream `engine.events` reading batches up to 500 events (or 50 ms block timeout), draining unacknowledged pending messages on startup before polling new events.
- **Transactional Atomic Projection (`EventProjector`)**: Projects entire event batches in a single atomic database transaction (`prisma.$transaction`), using raw parameterized SQL tagged templates with `ON CONFLICT` semantics.
- **Strict Invariant-Preserving Upserts**: Conditional updates where `engineSeq >= Order.engineSeq` and `lastEngineSeq >= Balance.lastEngineSeq` ensure that duplicate replays or out-of-order deliveries never regress newer order statuses or balances.
- **Full Relational Mirroring**:
  - `ORDER_*` $\to$ upserts `Order` with current lifecycle status (`NEW`, `OPEN`, `PARTIALLY_FILLED`, `FILLED`, `CANCELLED`, `REJECTED`) and cumulative filled quantities.
  - `TRADE` $\to$ inserts `Trade` with `ON CONFLICT (engineSeq, createdAt) DO NOTHING` into TimescaleDB-compatible hypertable.
  - `BALANCE_UPDATED` $\to$ conditionally updates `Balance` (`available`, `locked`, `lastEngineSeq`), inserts `LedgerEntry` with `ON CONFLICT (engineSeq, userId, asset, reason) DO NOTHING`, and links `Deposit` / `Withdrawal` rows via `refId` / `withdrawalId`.
  - `MARKET_STATUS` $\to$ updates active / halted market statuses.
- **Strict Acknowledgment**: Emits pipelined `XACK` only after database transaction commits successfully (never acknowledges uncommitted data).
- **Poison Queue & Dead-Letter Stream**: When an individual event is malformed or causes a transaction error, the worker isolates items, retries up to 3 attempts, moves poison events to `engine.events.dead` with error metadata, logs an alert, acknowledges them from the main stream, and increments `dbw_dead_events_total`.
- **Metrics Tracking**: Real-time telemetry tracking `dbw_lag_seconds`, `dbw_batch_size`, `dbw_events_total`, `dbw_dead_events_total`, and `dbw_batches_total`.
- **Disaster Recovery Rebuild Tool (`dbw:rebuild`)**: Administrative CLI script (`npm run dbw:rebuild`) truncating projection tables (`Order`, `Trade`, `LedgerEntry`, `Balance`) and replaying `engine.events` from `0-0` into PostgreSQL.
- **Verification & Acceptance**: Double replay test proving Invariant 8 (zero duplicate rows), crash recovery of pending entries, out-of-order delivery protection, poison event quarantine, and 100% balance reconciliation matching engine balances across users and assets.

### Phase 12: Market Data Service (`apps/market-data/`)
- **`MarketDataService` Consumer Daemon**: Consumer group `md` on Redis stream `engine.events`, maintaining full real-time order books, ticker aggregates, and candlestick charts with automated consumer recovery and unacknowledged pending entry handling.
- **In-Memory Book Mirror (`BookMirror`)**: Maintains full bid and ask depth ladders directly from `DEPTH_DELTA` events; writes top-50 snapshots with sequence numbers to Redis key `depth:{market}` after each batch.
- **Throttled Depth Feeds (`DepthThrottler`)**: Coalesces high-frequency price updates into 100 ms batches and publishes delta messages on Redis Pub/Sub `md:depth:{market}` with strictly increasing sequence numbers (`seq`).
- **Rolling 24h Ticker Statistics (`Rolling24hStats`)**: High-performance 1,440-minute circular buckets with automated 24-hour expiry; tracks high, low, base volume, quote volume, last price, price change, percentage change, trade count, best bid, and best ask. Published to `md:ticker:{market}` and cached in key `ticker:{market}`.
- **Real-Time Candlestick Tracking (`CandleManager`)**: Real-time OHLCV across `1m`, `5m`, `15m`, `1h`, `1d` intervals; in-progress candles published on `md:kline:{interval}:{market}` and cached in `kline:{interval}:{market}`; automatically emits finalized candles (`x: true`) at boundary transitions.
- **Private User Event Translation**: Transforms internal `ORDER_*` and `BALANCE_UPDATED` events into clean wire messages published on private Redis Pub/Sub channels `user:{userId}`.
- **Public REST Handlers in API Gateway**:
  - `GET /api/v1/depth`: Returns L2 depth snapshot up to limit from Redis.
  - `GET /api/v1/trades`: Returns recent executed trades from PostgreSQL.
  - `GET /api/v1/ticker`: Returns rolling 24h statistics for a single market or all markets.
  - `GET /api/v1/klines`: Queries TimescaleDB continuous aggregate views (`candle_1m`, `candle_5m`, etc.) and appends the active in-progress candle from Redis.
- **Verification & Acceptance Criteria**:
  - `/klines` and `/ticker` values match hand calculation across intra-bucket and boundary trades.
  - Depth snapshot + delta reconstruction equality test passes on 10,000 random events against the pure Engine book.
  - Monotonic sequence numbering verified under high-frequency throttled flushes.

### Phase 13: WebSocket Server (`apps/ws-server/`)
- **High-Performance `ws` Server**: WebSocket server on port 8080 (configurable via `WS_PORT`), with `perMessageDeflate: false` by default for minimal memory overhead and zero compression CPU spikes.
- **Connection & Subscription Manager (`ConnectionManager`)**: Manages per-connection state (`subscriptions`, `authenticated user`, `depthLastSeq`, `missedPongs`, rate counters). Maintains bidirectional mappings between topic channels (`depth@market`, `trade@market`, `ticker@market`, `kline_<interval>@market`, `user`) and sets of active sockets.
- **Protocol Message Validation & Dispatching**: Strict JSON framing supporting `SUBSCRIBE`, `UNSUBSCRIBE`, `AUTH`, and `PING`. Enforces a maximum of 50 subscriptions per connection, 20 messages/sec rate limiting, and structured error responses (`{ error: { code, message }, id }`).
- **Section 6.2 Depth Synchronization & Gap Detection**:
  - Delivers initial depth snapshot from Redis key `depth:{market}` upon subscription.
  - Forwards contiguous 100 ms throttled depth deltas.
  - Detects sequence gaps (`deltaSeq > lastSeq + 1n`) and triggers an automated point-to-point snapshot resync without disconnecting or disrupting other subscribers.
- **Private Stream & User Isolation**:
  - Access JWT verification via `JWT_ACCESS_SECRET`.
  - Associating connection identity strictly with token claims (`sub`).
  - Strict isolation: User A cannot subscribe to or receive User B's private `user` events (negative tests verified).
- **Backpressure Protection**: Monitors socket `bufferedAmount` against threshold (`MAX_BUFFERED_AMOUNT`), immediately terminating slow consumers with WebSocket close code `1013` (`Try Again Later`) to protect event-loop memory.
- **Keepalive & Heartbeat**: 20-second ping interval; automatically drops stale connections after 2 consecutive missed pongs.
- **Acceptance Criteria & Load Benchmark**:
  - All test suites passing, including the user isolation negative test.
  - 5,000 concurrent connected client load test completed with depth fan-out p99 latency of **3.03 ms** (far exceeding the < 250 ms requirement at > 1.6M messages/sec throughput), recorded in `docs/perf.md`.

### Phase 14: Wallet Operations, Admin Controls & Operational Oversight (`apps/api-gateway/`)
- **Simulated Wallet Deposit Lifecycle (`POST /api/v1/wallet/deposit`)**:
  - Validates active asset in database.
  - Enforces per-request deposit cap and 24-hour rolling limit against `DEV_DEPOSIT_MAX` (`100000000000` = 1,000 USDT in scaled $10^8$ BigInt units). Rejects violations with 422 `DEPOSIT_LIMIT_EXCEEDED` or `DAILY_DEPOSIT_LIMIT_EXCEEDED`.
  - Persists `Deposit` record in PostgreSQL.
  - Dispatches `DEPOSIT` command to `EngineRunner` and updates projected database balance.
- **Withdrawal Two-Phase Lifecycle (`POST /api/v1/wallet/withdraw`)**:
  - Creates `Withdrawal` in `PENDING` state.
  - Dispatches `WITHDRAW_REQUEST` command to `EngineRunner`, atomically locking the funds.
  - Immediate failure mapping: if engine rejects (e.g. `INSUFFICIENT_FUNDS`), marks `Withdrawal` as `REJECTED` and returns 422.
- **Deposit & Withdrawal History (`GET /api/v1/wallet/history`)**:
  - Authenticated query returning user's recent deposits and withdrawals with status and timestamps.
- **Admin Market Operations (`requireRole(Role.ADMIN)`)**:
  - `POST /api/v1/admin/markets`: Creates market in database, updates in-memory `MarketConfigCache` & Redis, dispatches `MARKET_CONFIG` to engine, logs `CREATE_MARKET` to `AuditLog`.
  - `PATCH /api/v1/admin/markets/:symbol`: Updates dynamic market parameters (fees, tick size, minNotional), updates cache, dispatches `MARKET_CONFIG`, logs `UPDATE_MARKET` to `AuditLog`.
  - `POST /api/v1/admin/markets/:symbol/halt`: Halts trading, dispatches `HALT_MARKET`, rejects new orders while continuing to accept cancellations, logs `HALT_MARKET` to `AuditLog`.
  - `POST /api/v1/admin/markets/:symbol/resume`: Resumes trading, dispatches `RESUME_MARKET`, logs `RESUME_MARKET` to `AuditLog`.
- **Admin Withdrawal Approvals & Rejections**:
  - `POST /api/v1/admin/withdrawals/:id/approve`: Validates `PENDING` status, dispatches `WITHDRAW_COMPLETE` to debit locked balance, marks `COMPLETED`, logs `APPROVE_WITHDRAWAL` to `AuditLog`.
  - `POST /api/v1/admin/withdrawals/:id/reject`: Validates `PENDING` status, dispatches `WITHDRAW_REJECT` to unlock and restore funds to available balance, marks `REJECTED`, logs `REJECT_WITHDRAWAL` to `AuditLog`.
- **Exchange Fee Analytics (`GET /api/v1/admin/fees`)**:
  - Aggregates accumulated fee revenues grouped by market from trade records, logs `VIEW_FEES` to `AuditLog`.
- **Strict Role-Based Access Control (RBAC)**:
  - Fastify `requireRole(Role.ADMIN)` hook rejects non-admin users with 403 `FORBIDDEN` on all administrative routes.
- **Audit Logging Guarantee**:
  - Every administrative action writes an `AuditLog` row recording `actorId`, `action`, target metadata, and before/after state snapshots.
- **Acceptance Criteria & Verification**:
  - Mixed deposit, withdrawal request, withdrawal rejection, withdrawal approval, and trading simulation verifying Invariant 2 (Conservation) across all assets ($totalDeposited - totalWithdrawn \equiv circulating$).
  - Full test suite passing across all 22 Phase 9/14 trading and administrative test cases.

### Phase 15: Frontend Foundation (`apps/web/`)
- **Next.js 14 App Router & Design System**:
  - Full modern Next.js 14 application in `@cex/web` configured with TypeScript, PostCSS, and Tailwind CSS.
  - Multi-theme design tokens matching `Designs/Kairos.html` across 4 color schemes: `night` (default dark institutional), `paper` (warm light), `mist` (cool light), and `dusk` (deep violet dark).
  - Typography configuration: `Inter` (sans), `Inter Tight` (display headings), and `IBM Plex Mono` (monospace financial figures and prices).
  - Interactive theme switcher (`ThemeSelector`) persisting user choice in `localStorage`.
- **Zero-Float Money Formatting (`src/lib/format.ts`)**:
  - `parseInputToScaled`: converts user decimal strings directly to scaled $10^8$ BigInts via `@cex/money`'s `toScaled`.
  - `formatPrice`, `formatQty`, `formatPct`, `formatBalance`: precision-aware formatting without IEEE 754 precision errors.
- **Typed API Gateway Client (`src/lib/api.ts`)**:
  - Full typed fetch wrapper supporting authentication, market data, order placement/cancellation, depth, klines, balance, deposit/withdrawal, and administrative endpoints.
  - In-memory access token storage with automatic 401 interception: invokes `/api/v1/auth/refresh` with credentials, rotates token, and transparently retries failed requests before redirecting to `/signin`.
- **Resilient WebSocket Client (`src/lib/ws.ts`)**:
  - Subscriptions with automatic resubscribe on reconnect (`depth@`, `trade@`, `ticker@`, `kline_*@`, and authenticated `user` stream).
  - Exponential backoff with random jitter (500 ms to 10 s).
  - Client-side depth sequence gap detection (`seq > lastSeq + 1n`) triggering point-to-point snapshot resync.
  - Heartbeat ping-pong keeping connections alive.
- **Zustand State Stores (`src/stores/`)**:
  - `useAuth`: reactive session state, signin/signup/signout actions, and token injection.
  - `useMarket`: active trading pair selection, market configs, and ticker caches.
  - `useBook`: order book depth ladders, cumulative totals, and live spread calculations.
  - `useOrders`: open resting orders, order status transition tracking, and execution history.
  - `useBalances`: per-asset available and locked balance tracking.
  - `useTheme`: reactive theme state and CSS attribute switching.
- **Base UI Kit (`src/components/ui/`)**:
  - Accessible, themed primitives: `Button` (with buy/sell/loading variants), `Input` (with prefix/suffix/mono options), `Tabs` (line and pill styles), `Table` (with monospace alignment), `Modal` (with backdrop blur and ESC close), `Toast` (with auto-dismiss), `Skeleton` (shimmering loaders).
- **Core Pages & Route Protection**:
  - `/` (`app/page.tsx`): Markets landing page with interactive market overview, live tickers, search filter, and sparkline graphics.
  - `/signin` (`app/signin/page.tsx`): Authenticated login page matching designs with order book artwork, field validation, and error states.
  - `/signup` (`app/signup/page.tsx`): Registration page with password complexity validation and redirect.
  - `AuthGuard` (`components/auth/AuthGuard.tsx`): Route protector managing authentication and RBAC checks.
- **Verification & Acceptance**:
  - 13 frontend tests passing in Vitest covering format math, API client token rotation, and Zustand stores.
  - Full static page prerendering and Next.js production build passing with 0 errors.

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
| **8** | Redis Streams Messaging | **Done** | Redis command/reply/event stream integration, engine runner, idempotency |
| **9** | Trading API | **Done** | Order placement, order cancellation, and book queries |
| **10**| Journal & Recovery | **Done** | Append-only WAL (`journal-*.log`), snapshots, crash recovery |
| **11**| DB Projection Worker | **Done** | `apps/db-worker` consuming stream events into PostgreSQL |
| **12**| Market Data Service | **Done** | `apps/market-data` depth mirror, 24h ticker, throttled feeds, and k-lines |
| **13**| WebSocket Fan-out | **Done** | `apps/ws-server` client subscriptions, depth resync, and 5k client load test |
| **14**| Wallet & Admin Operations | **Done** | Simulated ledger deposits/withdrawals, deposit limits, admin controls, audit logs |
| **15**| Frontend Foundation | **Done** | Next.js 14 App Router, design tokens, auth pages, typed API/WS clients, stores, and UI kit |
| **16**| Trading Terminal | **Next Up** | Candlestick charts, interactive depth ladder, order form, user open orders |
| **17**| History & Admin UI | **Pending** | Order history, balance modals, admin monitoring views |
| **18**| Verification & Resilience | **Pending** | Fuzz testing, chaos simulation, load tests with k6 |
| **19**| Observability & Deployment| **Pending** | Prometheus metrics, Grafana dashboards, Nginx reverse proxy |
| **20**| Release Readiness (`v1.0.0`)| **Pending** | End-to-end verification and demonstration scripts |

---

## 4. What's Next (Immediate Priorities)

1. **Phase 16: Trading Terminal (`apps/web/src/app/trade/[symbol]/page.tsx`)**:
   - `PriceChart`: lightweight-charts candlestick view with OHLCV data from `/api/v1/klines` and live `kline_*@` updates.
   - `OrderBook`: real-time top 20 asks and bids from `useBook`, depth ladder bars, spread row, and price click-to-fill.
   - `OrderPanel`: Buy/Sell tabs, Limit/Market toggle, scaled percentage slider (25/50/75/100) using `@cex/money`, Post-Only & IOC flags, client-side pre-flight validations, and loading/error states.
   - `UserTabs`: open resting orders with one-click cancellation, fill progress, order history, and live user balances.
   - `TickerHeader`: 24h high/low/volume/change statistics and connection badge.

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
