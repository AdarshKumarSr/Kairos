import { Engine } from '../engine/engine.js';
import { EngineState } from '../engine/types.js';
import { JournalReader } from './journal.js';
import { SnapshotManager } from './snapshot.js';
import { RecoveryOptions, RecoveryResult } from './types.js';

/**
 * Recovers engine state from disk according to Section 3.6:
 * 1. Load latest valid snapshot if exists.
 * 2. If no snapshot, start empty (or seed from Postgres if seedFromDb=true) and write snapshot 0.
 * 3. Replay journal entries with seq > snapshot.seq.
 * 4. Stop at first record failing CRC (truncate torn tail cleanly).
 * 5. Verify engine invariants (conservation, no crossed book, lock consistency).
 * 6. Abort startup on invariant failure.
 */
export async function recoverEngine(options: RecoveryOptions): Promise<RecoveryResult> {
  const { dataDir, marketConfigs, seedFromDb = false, truncateTornTail = true } = options;
  const snapshotManager = new SnapshotManager({ dataDir });

  let state: EngineState;
  let engineSeq = 0n;
  let lastStreamId = '0';
  let fromSnapshotSeq: bigint | null = null;

  // 1. Look for newest valid snapshot
  const latestSnapshot = snapshotManager.findLatestSnapshot();
  if (latestSnapshot) {
    const restored = Engine.restore(latestSnapshot.snapshot);
    state = restored.state;
    engineSeq = restored.engineSeq;
    lastStreamId = restored.lastStreamId;
    fromSnapshotSeq = latestSnapshot.seq;

    // Register any newly configured markets not present in snapshot
    if (marketConfigs) {
      for (const cfg of marketConfigs) {
        if (!state.markets.has(cfg.symbol)) {
          Engine.registerMarket(state, cfg);
        }
      }
    }
  } else {
    // 2. Start empty
    state = Engine.createInitialState(marketConfigs);
    engineSeq = 0n;
    lastStreamId = '0';

    if (seedFromDb) {
      try {
        const { prisma } = await import('@cex/db');
        const balances = await prisma.balance.findMany({ include: { asset: true } });
        for (const b of balances) {
          const avail = BigInt(b.available.toString());
          if (avail > 0n) {
            state.balanceManager.deposit(b.userId, b.asset.symbol, avail);
          }
        }
      } catch (err: unknown) {
        // If DB not connected or available, continue with empty state
      }

      // Write initial snapshot 0
      snapshotManager.createSnapshot(state, 0n, '0');
      fromSnapshotSeq = 0n;
    }
  }

  // 3. Scan and replay journal files in sequential order
  const journals = JournalReader.listJournals(dataDir);
  let replayedCount = 0;
  let truncatedTail = false;

  for (const journal of journals) {
    const { records, hasTornTail } = JournalReader.readJournal(journal.file, {
      truncateTornTail,
    });
    if (hasTornTail) {
      truncatedTail = true;
    }

    for (const record of records) {
      const recordSeq = BigInt(record.seq);
      if (recordSeq <= engineSeq) {
        continue; // Already included in snapshot
      }

      // Pure in-memory replay
      Engine.process(state, record.command, {
        engineSeq: recordSeq,
        now: record.ts,
      });

      engineSeq = recordSeq;
      lastStreamId = record.streamId;
      replayedCount++;
    }

    if (hasTornTail) {
      // Cleanly stop replaying at first torn/corrupt record
      break;
    }
  }

  // 4. Verify invariants; refuse to start if failed
  Engine.checkInvariants(state);

  return {
    state,
    engineSeq,
    lastStreamId,
    replayedCount,
    truncatedTail,
    fromSnapshotSeq,
  };
}
