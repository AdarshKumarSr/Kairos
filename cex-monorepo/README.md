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
| **Logging Infrastructure** | `@cex/logger` (Winston), structured JSON logs, secret redaction, `apilogs.ts`, `errorlogs.ts`, `debuglogs.ts` | ✅ Completed |
| **Phase 5–7: Matching Engine Core** | In-memory order books, synchronous matching logic, and live balances | ⏳ Next Up |
| **Phase 8–10: Messaging & Engine Journal** | Redis Streams runner, WAL append-only journal, and snapshot recovery | ⏳ Pending |
| **Phase 11–13: Data & WebSockets** | DB projection worker, market data ticker, and WebSocket fan-out | ⏳ Pending |
| **Phase 14–17: UI & Admin Tools** | Next.js 14 trading terminal (`apps/web`), wallet modals, admin controls | ⏳ Pending |
| **Phase 18–20: Verification & Release** | Chaos testing, load tests (k6), Prometheus/Grafana dashboards, v1.0.0 | ⏳ Pending |

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
