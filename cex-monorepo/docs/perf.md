# Performance Benchmarks & Load Figures (`docs/perf.md`)

This document tracks the recorded performance figures and load benchmarks across the Kairos CEX core components.

---

## 1. Summary of Component Benchmarks

| Component / Subsystem | Benchmark Requirement | Measured Throughput / Latency | Status |
|:---|:---|:---|:---:|
| **Phase 5: Order Book Structure** | 100k adds + 100k cancels < 1,000 ms | **398 ms** (502,512 ops/sec) | ✅ Pass |
| **Phase 6: Pure Engine Matching Core** | $\ge$ 100,000 orders/sec in-process | **138,083 orders/sec** (724 ms for 100k orders) | ✅ Pass |
| **Phase 8: Redis Streams Runner** | $\ge$ 3,000 commands/sec end-to-end | **4,207–9,700 commands/sec** over live Redis | ✅ Pass |
| **Phase 10: Journal Replay Recovery** | 1M commands in < 60s ($\ge$ 16,666 cmd/s) | **89,742–146,000 commands/sec** | ✅ Pass |
| **Phase 11: PostgreSQL Event Projection** | Zero balance divergence under load | **100% balance reconciliation** (0 error) | ✅ Pass |
| **Phase 12: Market Data Reconstruction** | 10,000 random event book equality | **100% exact ladder equality** | ✅ Pass |
| **Phase 13: WebSocket Client Fan-Out** | 5,000 clients depth p99 < 250 ms | **p99 = 3.03 ms** (1,612,019 msgs/sec) | ✅ Pass |

---

## 2. Phase 13: WebSocket Server Load Benchmark

### Test Configuration
- **Concurrency**: 5,000 concurrent connected WebSocket client sockets
- **Topic**: `depth@SOL_USDT` L2 order book depth updates
- **Payload**: Full JSON depth update with bid and ask price ladders
- **Criterion**: Depth broadcast p99 latency under **250 ms**

### Results

```
=== Phase 13 WebSocket Fan-Out Benchmark (5,000 Clients) ===
Total broadcast time: 3.10 ms
p50 latency:          1.86 ms
p90 latency:          2.78 ms
p95 latency:          2.92 ms
p99 latency:          3.03 ms
Throughput:           1,612,019 messages/sec
```

### Observations
1. **Low Memory & Fast Fan-Out**: Single-process Node.js event-loop fan-out via `ConnectionManager` delivers depth deltas to all 5,000 clients in ~3 ms.
2. **Backpressure Safety**: Sockets exceeding buffer limits (`ws.bufferedAmount > MAX_BUFFERED_AMOUNT`) are cleanly dropped with code `1013` before memory exhausts.
3. **Resync Isolation**: Depth sequence gaps trigger point-to-point snapshot resync without affecting unaffected subscriber sockets.
