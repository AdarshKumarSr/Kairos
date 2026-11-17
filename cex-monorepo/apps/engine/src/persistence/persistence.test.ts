import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Command, MarketConfig, MarketStatus, Side } from '@cex/types';
import { Engine } from '../engine/engine.js';
import { computeCrc32 } from './crc32.js';
import { computeStateHash } from './hasher.js';
import { JournalReader, JournalWriter, parseJournalRecord, serializeJournalRecord } from './journal.js';
import { recoverEngine } from './recovery.js';
import { SnapshotManager } from './snapshot.js';

const TEST_MARKETS: MarketConfig[] = [
  {
    symbol: 'BTC-USDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    tickSize: '1000000', // 0.01 USDT
    lotSize: '10000', // 0.0001 BTC
    minNotional: '100000000', // 1 USDT
    makerFeeBps: 8,
    takerFeeBps: 10,
    status: MarketStatus.ACTIVE,
  },
  {
    symbol: 'ETH-USDT',
    baseAsset: 'ETH',
    quoteAsset: 'USDT',
    tickSize: '100000', // 0.001 USDT
    lotSize: '100000', // 0.001 ETH
    minNotional: '100000000', // 1 USDT
    makerFeeBps: 8,
    takerFeeBps: 10,
    status: MarketStatus.ACTIVE,
  },
];

// Seeded deterministic pseudo-random number generator (mulberry32)
function createRng(seed: number) {
  let s = seed;
  return function next(): number {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCommand(cmd: {
  type: Command['type'];
  commandId: string;
  userId?: string;
  ts?: number;
  payload: Record<string, string | boolean>;
}): Command {
  return {
    ts: cmd.ts ?? 1000,
    ...cmd,
  };
}

describe('Phase 10: Engine Persistence & Recovery', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cex-persistence-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  describe('1. CRC32 & Journal Serialization', () => {
    it('computes correct IEEE 802.3 CRC32 test vectors', () => {
      expect(computeCrc32('')).toBe(0);
      expect(computeCrc32('123456789')).toBe(3421780262);
      expect(computeCrc32('hello')).toBe(907060870);
    });

    it('serializes and parses journal records with matching CRC32', () => {
      const record = {
        seq: '42',
        commandId: 'cmd-test-1',
        ts: 1716380000000,
        streamId: '1716380000000-0',
        command: makeCommand({
          type: 'DEPOSIT',
          commandId: 'cmd-test-1',
          userId: 'usr-1',
          payload: { asset: 'USDT', amount: '10000000000' },
        }),
      };

      const line = serializeJournalRecord(record);
      expect(line.endsWith('\n')).toBe(true);

      const parsed = parseJournalRecord(line.trim());
      expect(parsed.error).toBeUndefined();
      expect(parsed.record?.seq).toBe('42');
      expect(parsed.record?.commandId).toBe('cmd-test-1');
      expect(parsed.record?.command.payload?.asset).toBe('USDT');
    });

    it('detects corrupted records and invalid CRC32', () => {
      const record = {
        seq: '42',
        commandId: 'cmd-test-1',
        ts: 1716380000000,
        streamId: '1716380000000-0',
        command: makeCommand({
          type: 'DEPOSIT',
          commandId: 'cmd-test-1',
          userId: 'usr-1',
          payload: { asset: 'USDT', amount: '10000000000' },
        }),
      };

      const line = serializeJournalRecord(record);
      // Flip one character in the payload
      const corruptedLine = line.replace('cmd-test-1', 'cmd-test-X');
      const parsed = parseJournalRecord(corruptedLine.trim());

      expect(parsed.record).toBeUndefined();
      expect(parsed.error).toContain('CRC32 mismatch');
    });

    it('detects torn tails and cleanly truncates partial writes on disk', () => {
      const writer = new JournalWriter({ dataDir: tempDir, startSeq: 1n, fsyncMs: 0 });

      // Write 3 complete records
      for (let i = 1; i <= 3; i++) {
        writer.append({
          seq: i.toString(),
          commandId: `cmd-${i}`,
          ts: 1000 + i,
          streamId: `stream-${i}`,
          command: makeCommand({
            type: 'DEPOSIT',
            commandId: `cmd-${i}`,
            userId: 'usr-1',
            payload: { asset: 'USDT', amount: '1000000000' },
          }),
        });
      }
      writer.close();

      const journalFile = path.join(tempDir, 'journal-1.log');
      const cleanFileSize = fs.statSync(journalFile).size;

      // Simulate torn write: append incomplete partial line
      fs.appendFileSync(journalFile, '{"seq":"4","commandId":"cmd-4","ts":1004,"streamId":');

      // Read journal with clean truncation
      const readResult = JournalReader.readJournal(journalFile, { truncateTornTail: true });
      expect(readResult.records).toHaveLength(3);
      expect(readResult.hasTornTail).toBe(true);
      expect(readResult.validByteLength).toBe(cleanFileSize);

      // Verify file is truncated back to exact clean byte size
      const truncatedSize = fs.statSync(journalFile).size;
      expect(truncatedSize).toBe(cleanFileSize);

      // Reading again should show clean file with no torn tail
      const secondRead = JournalReader.readJournal(journalFile);
      expect(secondRead.records).toHaveLength(3);
      expect(secondRead.hasTornTail).toBe(false);
    });
  });

  describe('2. Snapshot Mechanism & Determinism', () => {
    it('satisfies snapshot -> restore -> snapshot byte-identical determinism', () => {
      const state = Engine.createInitialState(TEST_MARKETS);

      // Populate state with balances and orders
      state.balanceManager.deposit('alice', 'USDT', 10000000000n); // 100 USDT
      state.balanceManager.deposit('bob', 'BTC', 200000000n); // 2 BTC

      // Place limit buy for alice
      Engine.process(
        state,
        makeCommand({
          type: 'PLACE_ORDER',
          commandId: 'cmd-ord-1',
          userId: 'alice',
          payload: {
            orderId: 'cmd-ord-1',
            market: 'BTC-USDT',
            side: Side.BUY,
            type: 'LIMIT',
            price: '5000000000000', // 50,000 USDT
            quantity: '100000000', // 1 BTC
          },
        }),
        { engineSeq: 1n, now: 1000 }
      );

      // Place limit sell for bob
      Engine.process(
        state,
        makeCommand({
          type: 'PLACE_ORDER',
          commandId: 'cmd-ord-2',
          userId: 'bob',
          payload: {
            orderId: 'cmd-ord-2',
            market: 'BTC-USDT',
            side: Side.SELL,
            type: 'LIMIT',
            price: '5200000000000', // 52,000 USDT
            quantity: '100000000', // 1 BTC
          },
        }),
        { engineSeq: 2n, now: 1001 }
      );

      const fixedTime = 1716380000000;
      const snap1 = Engine.snapshot(state, 2n, 'stream-2', fixedTime);

      const restored = Engine.restore(snap1);
      const snap2 = Engine.snapshot(restored.state, restored.engineSeq, restored.lastStreamId, fixedTime);

      expect(JSON.stringify(snap1)).toBe(JSON.stringify(snap2));
      expect(computeStateHash(state, 2n)).toBe(computeStateHash(restored.state, restored.engineSeq));
    });

    it('creates snapshot via SnapshotManager, keeps last 3, and cleans old segments', () => {
      const sm = new SnapshotManager({ dataDir: tempDir, keepSnapshots: 3 });
      const state = Engine.createInitialState(TEST_MARKETS);

      // Create 4 snapshots: at seq 100, 200, 300, 400
      // Also create dummy journal segments: 1..100, 101..200, 201..300, 301..400
      fs.writeFileSync(path.join(tempDir, 'journal-1.log'), '');
      fs.writeFileSync(path.join(tempDir, 'journal-101.log'), '');
      fs.writeFileSync(path.join(tempDir, 'journal-201.log'), '');
      fs.writeFileSync(path.join(tempDir, 'journal-301.log'), '');

      sm.createSnapshot(state, 100n, 'stream-100');
      sm.createSnapshot(state, 200n, 'stream-200');
      sm.createSnapshot(state, 300n, 'stream-300');
      sm.createSnapshot(state, 400n, 'stream-400');

      const snapshots = sm.findSnapshots();
      expect(snapshots).toHaveLength(3);
      expect(snapshots.map((s) => s.seq)).toEqual([400n, 300n, 200n]);

      // snapshot-100.json must be deleted
      expect(fs.existsSync(path.join(tempDir, 'snapshot-100.json'))).toBe(false);
      expect(fs.existsSync(path.join(tempDir, 'snapshot-200.json'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'snapshot-300.json'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'snapshot-400.json'))).toBe(true);

      // Oldest retained is 200. Journal-1.log (ending at 100) must be deleted
      expect(fs.existsSync(path.join(tempDir, 'journal-1.log'))).toBe(false);
      // journal-101 (ending at 200) is also <= 200 and covered by snapshot 200 -> deleted
      expect(fs.existsSync(path.join(tempDir, 'journal-101.log'))).toBe(false);
      // journal-201 and journal-301 are needed to replay beyond snapshot 200 -> retained
      expect(fs.existsSync(path.join(tempDir, 'journal-201.log'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'journal-301.log'))).toBe(true);
    });
  });

  describe('3. Engine Recovery Flow', () => {
    it('recovers engine state with snapshot and subsequent journal records', async () => {
      const state = Engine.createInitialState(TEST_MARKETS);
      state.balanceManager.deposit('trader-1', 'USDT', 5000000000000n);

      const sm = new SnapshotManager({ dataDir: tempDir });
      sm.createSnapshot(state, 10n, 'stream-10');

      // Append journal entries for seq 11 and 12
      const writer = new JournalWriter({ dataDir: tempDir, startSeq: 11n, fsyncMs: 0 });
      writer.append({
        seq: '11',
        commandId: 'cmd-11',
        ts: 2000,
        streamId: 'stream-11',
        command: makeCommand({
          type: 'DEPOSIT',
          commandId: 'cmd-11',
          userId: 'trader-2',
          payload: { asset: 'BTC', amount: '500000000' },
        }),
      });
      writer.append({
        seq: '12',
        commandId: 'cmd-12',
        ts: 2001,
        streamId: 'stream-12',
        command: makeCommand({
          type: 'PLACE_ORDER',
          commandId: 'cmd-12',
          userId: 'trader-1',
          payload: {
            orderId: 'cmd-12',
            market: 'BTC-USDT',
            side: Side.BUY,
            type: 'LIMIT',
            price: '6000000000000',
            quantity: '50000000',
          },
        }),
      });
      writer.close();

      const recovered = await recoverEngine({
        dataDir: tempDir,
        marketConfigs: TEST_MARKETS,
      });

      expect(recovered.engineSeq).toBe(12n);
      expect(recovered.lastStreamId).toBe('stream-12');
      expect(recovered.replayedCount).toBe(2);
      expect(recovered.fromSnapshotSeq).toBe(10n);

      const bal1 = recovered.state.balanceManager.get('trader-1', 'USDT');
      expect(bal1.locked).toBe(3000000000000n); // 60k * 0.5 = 30k USDT locked
      const bal2 = recovered.state.balanceManager.get('trader-2', 'BTC');
      expect(bal2.available).toBe(500000000n);
    });

    it('aborts startup if recovered state violates invariants', async () => {
      const state = Engine.createInitialState(TEST_MARKETS);
      state.balanceManager.deposit('trader-1', 'USDT', 1000000000n);

      const sm = new SnapshotManager({ dataDir: tempDir });
      sm.createSnapshot(state, 1n, 'stream-1');

      // Corrupt snapshot file directly: tamper balance without deposit (violates conservation)
      const snapFile = path.join(tempDir, 'snapshot-1.json');
      const raw = JSON.parse(fs.readFileSync(snapFile, 'utf-8'));
      raw.balances.balances[0][1].available = '999999999999999';
      fs.writeFileSync(snapFile, JSON.stringify(raw, null, 2));

      await expect(
        recoverEngine({
          dataDir: tempDir,
          marketConfigs: TEST_MARKETS,
        })
      ).rejects.toThrow('Conservation failed');
    });
  });

  describe('4. 50-Moment Crash Simulation Test (Invariants 7 & 10)', () => {
    it('verifies determinism (state hash equality) across 50 crash runs with zero lost orders', async () => {
      // 1. Generate deterministic pseudo-random workload of 500 commands
      const rng = createRng(42);
      const users = ['user_1', 'user_2', 'user_3', 'user_4', 'user_5', 'user_6'];
      const markets = ['BTC-USDT', 'ETH-USDT'];

      const commands: Command[] = [];

      // Initial funding for all users
      let cmdCount = 0;
      for (const u of users) {
        commands.push(
          makeCommand({
            type: 'DEPOSIT',
            commandId: `init_usdt_${++cmdCount}`,
            userId: u,
            payload: { asset: 'USDT', amount: '1000000000000' }, // 10,000 USDT
          })
        );
        commands.push(
          makeCommand({
            type: 'DEPOSIT',
            commandId: `init_btc_${++cmdCount}`,
            userId: u,
            payload: { asset: 'BTC', amount: '1000000000' }, // 10 BTC
          })
        );
        commands.push(
          makeCommand({
            type: 'DEPOSIT',
            commandId: `init_eth_${++cmdCount}`,
            userId: u,
            payload: { asset: 'ETH', amount: '10000000000' }, // 100 ETH
          })
        );
      }

      // Generate mixed trades, limit orders, market orders, and cancels
      const openOrderIds: Array<{ orderId: string; userId: string; market: string }> = [];

      while (commands.length < 500) {
        const u = users[Math.floor(rng() * users.length)]!;
        const m = markets[Math.floor(rng() * markets.length)]!;
        const isBtc = m === 'BTC-USDT';
        const actionType = rng();

        if (actionType < 0.65) {
          // Limit Order
          const side = rng() > 0.5 ? Side.BUY : Side.SELL;
          let price: bigint;
          let qty: bigint;

          if (isBtc) {
            // Price around 50,000 +/- 500 USDT (tick: 0.01 USDT = 1000000)
            const tickSteps = BigInt(Math.floor(rng() * 1000) - 500);
            price = 5000000000000n + tickSteps * 1000000n;
            // Qty 0.01 to 0.5 BTC (lot: 0.0001 BTC = 10000)
            const lots = BigInt(Math.floor(rng() * 50) + 1);
            qty = lots * 1000000n;
          } else {
            // ETH Price around 3,000 +/- 100 USDT
            const tickSteps = BigInt(Math.floor(rng() * 1000) - 500);
            price = 3000000000000n + tickSteps * 100000n;
            const lots = BigInt(Math.floor(rng() * 50) + 1);
            qty = lots * 10000000n;
          }

          const orderId = `ord_${++cmdCount}`;
          commands.push(
            makeCommand({
              type: 'PLACE_ORDER',
              commandId: orderId,
              userId: u,
              payload: {
                orderId,
                market: m,
                side,
                type: 'LIMIT',
                price: price.toString(),
                quantity: qty.toString(),
              },
            })
          );
          openOrderIds.push({ orderId, userId: u, market: m });
        } else if (actionType < 0.85 && openOrderIds.length > 0) {
          // Cancel an existing order
          const idx = Math.floor(rng() * openOrderIds.length);
          const toCancel = openOrderIds.splice(idx, 1)[0]!;
          commands.push(
            makeCommand({
              type: 'CANCEL_ORDER',
              commandId: `cancel_${++cmdCount}`,
              userId: toCancel.userId,
              payload: {
                market: toCancel.market,
                orderId: toCancel.orderId,
              },
            })
          );
        } else {
          // Deposit more funds
          const asset = rng() > 0.5 ? 'USDT' : isBtc ? 'BTC' : 'ETH';
          commands.push(
            makeCommand({
              type: 'DEPOSIT',
              commandId: `dep_${++cmdCount}`,
              userId: u,
              payload: {
                asset,
                amount: '100000000000',
              },
            })
          );
        }
      }

      // 2. Run Reference Engine to compute ground truth state hashes at every command
      const refState = Engine.createInitialState(TEST_MARKETS);
      const referenceHashes = new Map<number, string>();

      for (let i = 0; i < commands.length; i++) {
        const seq = BigInt(i + 1);
        Engine.process(refState, commands[i]!, { engineSeq: seq, now: 10000 + i });
        referenceHashes.set(i + 1, computeStateHash(refState, seq));
      }

      // 3. Choose 50 crash points distributed across the 500 commands
      const crashPoints: number[] = [];
      const step = Math.floor(500 / 50);
      for (let i = 1; i <= 50; i++) {
        crashPoints.push(Math.min(i * step, 500));
      }

      // 4. Run through crash points: engine writes to journal and takes snapshots,
      // crashes at crash point, restarts via recoverEngine, and asserts hash equality!
      let currentSeq = 0n;
      let lastCrashIndex = 0;

      const crashDataDir = path.join(tempDir, 'crash-engine');
      fs.mkdirSync(crashDataDir, { recursive: true });

      const snapshotManager = new SnapshotManager({ dataDir: crashDataDir });
      let journalWriter = new JournalWriter({
        dataDir: crashDataDir,
        startSeq: 1n,
        fsyncMs: 0, // Invariant 10: fsync after every batch/command
      });

      let liveState = Engine.createInitialState(TEST_MARKETS);

      for (let crashNum = 0; crashNum < crashPoints.length; crashNum++) {
        const targetCommandIndex = crashPoints[crashNum]!;

        // Process commands from lastCrashIndex up to targetCommandIndex
        for (let i = lastCrashIndex; i < targetCommandIndex; i++) {
          const cmd = commands[i]!;
          currentSeq++;

          // Invariant 10: Write to WAL journal before process/ack
          journalWriter.append({
            seq: currentSeq.toString(),
            commandId: cmd.commandId,
            ts: 10000 + i,
            streamId: `stream-${currentSeq}`,
            command: cmd,
          });

          // Engine pure process
          Engine.process(liveState, cmd, { engineSeq: currentSeq, now: 10000 + i });

          // Take periodic snapshot every 100 commands
          if (currentSeq % 100n === 0n) {
            journalWriter.fsync();
            snapshotManager.createSnapshot(liveState, currentSeq, `stream-${currentSeq}`);
            journalWriter.rotate(currentSeq + 1n);
          }
        }

        // --- SIMULATE CRASH at targetCommandIndex ---
        // Fsync to disk (simulates all acknowledged commands fsynced)
        journalWriter.fsync();

        // On every 5th crash, inject a torn tail to also verify crash recovery under torn write
        if (crashNum % 5 === 0 && crashNum > 0) {
          const currentLog = journalWriter.getSegmentPath();
          if (currentLog && fs.existsSync(currentLog)) {
            fs.appendFileSync(currentLog, '{"seq":"corrupted_torn_tail_incomplete');
          }
        }

        // Abruptly kill the writer (crash simulation)
        journalWriter.close();

        // RECOVERY: start a fresh engine process recovering solely from disk
        const recovered = await recoverEngine({
          dataDir: crashDataDir,
          marketConfigs: TEST_MARKETS,
          truncateTornTail: true,
        });

        // ASSERTIONS:
        // 1. Invariant 10: Zero acknowledged orders lost
        expect(recovered.engineSeq).toBe(BigInt(targetCommandIndex));

        // 2. Invariant 7: Determinism (SHA-256 state hash matches ground truth reference)
        const recoveredHash = computeStateHash(recovered.state, recovered.engineSeq);
        const expectedHash = referenceHashes.get(targetCommandIndex);
        expect(recoveredHash).toBe(expectedHash);

        // 3. Engine invariants hold (conservation, book integrity, non-negative, locks)
        Engine.checkInvariants(recovered.state);

        // Resume engine from recovered state for next crash iteration
        liveState = recovered.state;
        lastCrashIndex = targetCommandIndex;
        journalWriter = new JournalWriter({
          dataDir: crashDataDir,
          startSeq: currentSeq + 1n,
          fsyncMs: 0,
        });
      }

      journalWriter.close();
    });
  });

  describe('5. Journal Replay Speed Benchmark', () => {
    it('replays journal commands at > 16,666 commands/sec (1M commands in < 60s)', async () => {
      const benchDir = path.join(tempDir, 'bench-engine');
      fs.mkdirSync(benchDir, { recursive: true });

      const state = Engine.createInitialState(TEST_MARKETS);
      state.balanceManager.deposit('bench_trader', 'USDT', 1000000000000000n);

      const writer = new JournalWriter({ dataDir: benchDir, startSeq: 1n, fsyncMs: 0 });

      // Generate 10,000 journal records
      const count = 10000;
      for (let i = 1; i <= count; i++) {
        writer.append({
          seq: i.toString(),
          commandId: `bench_cmd_${i}`,
          ts: 1000 + i,
          streamId: `stream-${i}`,
          command: makeCommand({
            type: 'PLACE_ORDER',
            commandId: `bench_cmd_${i}`,
            userId: 'bench_trader',
            payload: {
              orderId: `bench_cmd_${i}`,
              market: 'BTC-USDT',
              side: Side.BUY,
              type: 'LIMIT',
              price: (5000000000000n + BigInt(i * 1000000)).toString(),
              quantity: '10000000',
            },
          }),
        });
      }
      writer.close();

      // Measure recovery / replay duration
      const start = performance.now();
      const recovered = await recoverEngine({
        dataDir: benchDir,
        marketConfigs: TEST_MARKETS,
      });
      const durationMs = performance.now() - start;

      const opsPerSec = Math.round((count / durationMs) * 1000);
      console.log(
        `Phase 10 Journal Replay Benchmark: ${opsPerSec.toLocaleString()} commands/sec (${durationMs.toFixed(1)} ms for ${count.toLocaleString()} commands)`
      );

      expect(recovered.engineSeq).toBe(BigInt(count));
      // Requirement: 1,000,000 commands under 60 s = 16,666 commands/sec
      expect(opsPerSec).toBeGreaterThanOrEqual(16666);
    });
  });
});
