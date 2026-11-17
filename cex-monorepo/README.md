# Kairos CEX

A high-performance spot centralized cryptocurrency exchange built with strict TypeScript, an in-memory deterministic matching engine, and event-driven microservices.

---

## 📚 Documentation

The project documentation is organized under the [`documentation/`](./documentation/) directory:

- **[`cex.md`](./documentation/cex.md)**: Master engineering and architecture specification (The locked design choices, invariants, and 21-phase plan).
- **[`agent.md`](./documentation/agent.md)**: Development guidelines, coding standards, and invariant checklists.
- **[`README.md`](./documentation/README.md)**: Detailed project progress tracker and roadmap status.

---

## 🚀 Current Project Status

| Phase / Area | Description | Status |
|:---|:---|:---:|
| **Phase 1: Monorepo Foundation** | npm workspaces, `@cex/types`, `@cex/config`, TypeScript `NodeNext` | ✅ Completed |
| **Phase 2: Database Layer** | `@cex/db`, Prisma models, PostgreSQL 16 + TimescaleDB migrations | ✅ Completed |
| **Phase 3: Money Math** | `@cex/money`, zero-float $10^8$ BigInt scaled monetary calculations | ✅ Completed |
| **Phase 4: Authentication** | `apps/api-gateway`, Fastify, argon2id hashing, rotating JWT pairs | ✅ Completed |
| **Phase 5: Order-Book Structure** | `apps/engine`, $O(1)$ linked lists, sorted price levels, deterministic snapshots | ✅ Completed |
| **Phase 6: Matching Engine Core** | Pure synchronous engine matching, maker/taker execution, STP, 184k ops/s | ✅ Completed |
| **Phase 7: Balances & Settlement** | In-memory balance manager, atomic locking, ceiling fees, price-improvement refunds | ✅ Completed |
| **Logging Infrastructure** | `@cex/logger` (Winston), structured JSON logs, secret redaction, `apilogs.ts`, `errorlogs.ts`, `debuglogs.ts` | ✅ Completed |
| **Phase 8: Messaging Layer** | Redis Streams runner (`engine.commands`/`replies`/`events`), gateway client & backpressure | ✅ Completed |
| **Phase 9: API Gateway Trading Routes** | Order endpoints (`POST /order`, `DELETE /order/:id`), open orders, depth, balance queries | ✅ Completed |
| **Phase 10: Journal & Recovery** | WAL append-only journal (`journal-*.log`), state snapshots, and crash recovery | ✅ Completed |
| **Phase 11: DB Worker (Idempotent Projection)** | PostgreSQL mirror worker for engine events, atomic transactions, poison queue, rebuild CLI | ✅ Completed |
| **Phase 12: Market Data Service** | `apps/market-data`, rolling 24h stats, depth mirror, throttled feeds, and k-lines | ✅ Completed |
| **Phase 13: WebSockets** | `apps/ws-server`, client subscriptions, live book and trade streams, depth resync | ✅ Completed |
| **Phase 14: Wallet & Admin Controls** | Simulated ledger deposits/withdrawals, deposit limits, admin controls, audit logs | ✅ Completed |
| **Phase 15: Frontend Foundation** | Next.js 14 App Router, design tokens, auth flows, typed API/WS clients, stores, and UI kit | ✅ Completed |
| **Phase 16: Trading Terminal** | Responsive trading terminal (`/trade/[symbol]`), TradingView lightweight-charts, depth ladder, BigInt slider order panel, live user tabs | ✅ Completed |
| **Phase 17: History & Admin UI** | `/wallet` ledger balances & modals, `/orders` history & CSV export, `/admin` market halt/fee controls & audit logs | ✅ Completed |
| **Phase 18–20: Verification & Release** | Chaos testing, load tests (k6), Prometheus/Grafana dashboards, v1.0.0 | ⏳ Next Up |

---

## 🛠️ Quick Start

### Prerequisites
- Node.js 20 LTS
- npm 10+
- Docker & Docker Compose (for local Postgres/TimescaleDB and Redis)

### Commands

```bash
# Install dependencies
npm install

# Build all packages and apps
npm run build

# Run type check across workspace
npm run typecheck

# Lint workspace
npm run lint

# Run unit tests
npm test
```
