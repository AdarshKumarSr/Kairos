import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import {
  Command,
  EngineReply,
  MarketConfig,
  MarketStatus,
  OrderType,
  Side,
} from '@cex/types';
import { Engine } from '../engine/engine.js';
import { EngineRunner } from './runner.js';
import {
  EngineClient,
  EngineOverloadedError,
} from '../../../api-gateway/src/engine/engine-client.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://:cex_dev_redis@127.0.0.1:6379';

const SOL_USDT: MarketConfig = {
  symbol: 'SOL_USDT',
  baseAsset: 'SOL',
  quoteAsset: 'USDT',
  tickSize: '1000000', // 0.01 (1e8)
  lotSize: '1000000', // 0.01 (1e8)
  minNotional: '500000000', // 5.00 USDT (1e8)
  makerFeeBps: 8,
  takerFeeBps: 10,
  status: MarketStatus.ACTIVE,
};

describe('Phase 8: Messaging Layer (Redis Streams) & EngineRunner', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const pong = await redis.ping();
    expect(pong).toBe('PONG');
  });

  afterAll(async () => {
    redis.disconnect();
  });

  it('1. 10,000 commands processed in order with throughput >= 3,000 cmd/sec', async () => {
    const testId = `t1_${Date.now()}`;
    const streamCmd = `test.cmd.${testId}`;
    const streamRep = `test.rep.${testId}`;
    const streamEvt = `test.evt.${testId}`;
    const group = `group_${testId}`;

    const state = Engine.createInitialState([SOL_USDT]);
    const runner = new EngineRunner(state, {
      redis,
      streamCommands: streamCmd,
      streamReplies: streamRep,
      streamEvents: streamEvt,
      groupName: group,
      consumerName: 'engine-1',
      batchSize: 500,
      blockMs: 200,
    });

    await runner.start();

    // Fund alice and bob
    state.balanceManager.deposit('alice', 'SOL', 10000000000000n);
    state.balanceManager.deposit('bob', 'USDT', 100000000000000n);

    const numCommands = 10_000;
    const pipeline = redis.pipeline();

    // Prepare 10,000 commands
    for (let i = 0; i < numCommands; i++) {
      const isAlice = i % 2 === 0;
      const cmd: Command = {
        commandId: `bench-cmd-${i}`,
        type: 'PLACE_ORDER',
        userId: isAlice ? 'alice' : 'bob',
        ts: i,
        payload: {
          orderId: `bench-ord-${i}`,
          market: 'SOL_USDT',
          side: isAlice ? Side.SELL : Side.BUY,
          type: OrderType.LIMIT,
          price: isAlice ? '15000000000' : '14000000000',
          quantity: '100000000', // 1 SOL
        },
      };
      pipeline.xadd(streamCmd, '*', 'command', JSON.stringify(cmd), 'commandId', cmd.commandId);
    }

    const tStart = performance.now();
    await pipeline.exec();

    // Wait until runner processes all 10,000 commands
    while (runner.getSeq() < BigInt(numCommands)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const durationMs = performance.now() - tStart;
    const throughput = (numCommands / (durationMs / 1000));
    console.log(
      `Phase 8 End-to-End Benchmark: ${Math.round(throughput).toLocaleString()} commands/sec (${durationMs.toFixed(1)} ms for ${numCommands.toLocaleString()} commands)`
    );

    expect(runner.getSeq()).toBe(BigInt(numCommands));
    expect(throughput).toBeGreaterThanOrEqual(3000);

    // Verify replies stream count
    const replyCount = await redis.xlen(streamRep);
    expect(replyCount).toBe(numCommands);

    // Verify events stream has entries
    const eventCount = await redis.xlen(streamEvt);
    expect(eventCount).toBeGreaterThan(0);

    // Verify no unacknowledged pending entries remain
    const pendingInfo = await redis.xpending(streamCmd, group);
    const unacked = pendingInfo[0] as number;
    expect(unacked).toBe(0);

    await runner.stop();

    // Cleanup streams
    await redis.del(streamCmd, streamRep, streamEvt);
  });

  it('2. Idempotency: duplicate commandId returns the original reply without re-execution', async () => {
    const testId = `t2_${Date.now()}`;
    const streamCmd = `test.cmd.${testId}`;
    const streamRep = `test.rep.${testId}`;
    const streamEvt = `test.evt.${testId}`;
    const group = `group_${testId}`;

    const state = Engine.createInitialState([SOL_USDT]);
    const runner = new EngineRunner(state, {
      redis,
      streamCommands: streamCmd,
      streamReplies: streamRep,
      streamEvents: streamEvt,
      groupName: group,
      consumerName: 'engine-1',
      blockMs: 200,
    });

    const client = new EngineClient({
      pubRedis: redis,
      subRedis: new Redis(REDIS_URL, { maxRetriesPerRequest: null }),
      streamCommands: streamCmd,
      streamReplies: streamRep,
    });

    await runner.start();
    await client.start();

    // Deposit command
    const depCmd: Command = {
      commandId: 'idemp-dep-1',
      type: 'DEPOSIT',
      userId: 'alice',
      ts: 1000,
      payload: { asset: 'USDT', amount: '50000000000' }, // 500 USDT
    };

    // First send
    const reply1 = await client.send(depCmd);
    expect(reply1.status).toBe('OK');
    expect(reply1.commandId).toBe('idemp-dep-1');
    expect(reply1.balance?.available).toBe('50000000000');

    // Second send with EXACT SAME commandId
    const reply2 = await client.send(depCmd);
    expect(reply2.status).toBe('OK');
    expect(reply2.commandId).toBe('idemp-dep-1');
    expect(reply2.engineSeq).toBe(reply1.engineSeq); // Exact same engineSeq returned!
    expect(reply2.balance?.available).toBe('50000000000');

    // Balance in engine is NOT doubled (still 500 USDT, not 1000 USDT)
    const aliceBal = state.balanceManager.get('alice', 'USDT');
    expect(aliceBal.available).toBe(50000000000n);

    await client.close();
    await runner.stop();
    await redis.del(streamCmd, streamRep, streamEvt);
  });

  it('3. Pending-entries recovery: crash after read but before ack is recovered on restart', async () => {
    const testId = `t3_${Date.now()}`;
    const streamCmd = `test.cmd.${testId}`;
    const streamRep = `test.rep.${testId}`;
    const streamEvt = `test.evt.${testId}`;
    const group = `group_${testId}`;

    // Create stream and group manually
    await redis.xgroup('CREATE', streamCmd, group, '$', 'MKSTREAM');

    // Alice deposits 100 USDT
    const cmd1: Command = {
      commandId: 'crash-cmd-1',
      type: 'DEPOSIT',
      userId: 'alice',
      ts: 1000,
      payload: { asset: 'USDT', amount: '10000000000' },
    };

    await redis.xadd(streamCmd, '*', 'command', JSON.stringify(cmd1), 'commandId', cmd1.commandId);

    // Simulate crash: "engine-1" reads the command into its PEL (Pending Entries List) but never ACKs it
    const readUnacked = (await redis.xreadgroup(
      'GROUP',
      group,
      'engine-1',
      'COUNT',
      1,
      'STREAMS',
      streamCmd,
      '>'
    )) as [string, [string, string[]][]][] | null;

    expect(readUnacked).toBeDefined();
    expect(readUnacked![0]![1].length).toBe(1);

    // Confirm that 1 entry is pending unacknowledged
    let pending = await redis.xpending(streamCmd, group);
    expect(pending[0]).toBe(1);

    // Now start a fresh EngineRunner (simulating restart after crash)
    const state = Engine.createInitialState([SOL_USDT]);
    const runner = new EngineRunner(state, {
      redis,
      streamCommands: streamCmd,
      streamReplies: streamRep,
      streamEvents: streamEvt,
      groupName: group,
      consumerName: 'engine-1',
      blockMs: 200,
    });

    await runner.start();

    // Wait briefly for pending recovery to process and ACK the unacknowledged entry
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Confirm unacknowledged count is now 0!
    pending = await redis.xpending(streamCmd, group);
    expect(pending[0]).toBe(0);

    // Confirm balance was credited
    const bal = state.balanceManager.get('alice', 'USDT');
    expect(bal.available).toBe(10000000000n);

    // Confirm reply was emitted
    const repEntries = await redis.xrange(streamRep, '-', '+');
    expect(repEntries.length).toBe(1);

    await runner.stop();
    await redis.del(streamCmd, streamRep, streamEvt);
  });

  it('4. Gateway timeout path returns 202 PENDING when engine does not reply in time', async () => {
    const testId = `t4_${Date.now()}`;
    const streamCmd = `test.cmd.${testId}`;
    const streamRep = `test.rep.${testId}`;

    const client = new EngineClient({
      pubRedis: redis,
      subRedis: new Redis(REDIS_URL, { maxRetriesPerRequest: null }),
      streamCommands: streamCmd,
      streamReplies: streamRep,
      defaultTimeoutMs: 100, // 100ms timeout for test
    });

    await client.start();

    const cmd: Command = {
      commandId: 'timeout-cmd-1',
      type: 'PLACE_ORDER',
      userId: 'alice',
      ts: 1000,
      payload: {
        orderId: 't-1',
        market: 'SOL_USDT',
        side: Side.BUY,
        type: OrderType.LIMIT,
        price: '14000000000',
        quantity: '100000000',
      },
    };

    // No runner running on streamCmd!
    const res = await client.send(cmd);
    expect(res.status).toBe('PENDING');
    expect(res.commandId).toBe('timeout-cmd-1');

    await client.close();
    await redis.del(streamCmd, streamRep);
  });

  it('5. Gateway backpressure: rejects with EngineOverloadedError when queue length >= MAX_QUEUE_LEN', async () => {
    const testId = `t5_${Date.now()}`;
    const streamCmd = `test.cmd.${testId}`;
    const streamRep = `test.rep.${testId}`;

    const client = new EngineClient({
      pubRedis: redis,
      subRedis: new Redis(REDIS_URL, { maxRetriesPerRequest: null }),
      streamCommands: streamCmd,
      streamReplies: streamRep,
      maxQueueLen: 3, // very low queue threshold for testing backpressure
    });

    await client.start();

    // Push 3 commands to reach maxQueueLen
    for (let i = 0; i < 3; i++) {
      await redis.xadd(streamCmd, '*', 'command', '{}', 'commandId', `fill-${i}`);
    }

    const cmd: Command = {
      commandId: 'overflow-cmd',
      type: 'DEPOSIT',
      userId: 'alice',
      ts: 1000,
      payload: { asset: 'USDT', amount: '100' },
    };

    await expect(client.send(cmd)).rejects.toThrow(EngineOverloadedError);

    await client.close();
    await redis.del(streamCmd, streamRep);
  });

  it('6. Clean shutdown: no unacknowledged entries remain after runner stops', async () => {
    const testId = `t6_${Date.now()}`;
    const streamCmd = `test.cmd.${testId}`;
    const streamRep = `test.rep.${testId}`;
    const streamEvt = `test.evt.${testId}`;
    const group = `group_${testId}`;

    const state = Engine.createInitialState([SOL_USDT]);
    const runner = new EngineRunner(state, {
      redis,
      streamCommands: streamCmd,
      streamReplies: streamRep,
      streamEvents: streamEvt,
      groupName: group,
      consumerName: 'engine-1',
      blockMs: 200,
    });

    await runner.start();

    // Send 50 commands
    const pipe = redis.pipeline();
    for (let i = 0; i < 50; i++) {
      const cmd: Command = {
        commandId: `clean-${i}`,
        type: 'DEPOSIT',
        userId: `user-${i}`,
        ts: i,
        payload: { asset: 'USDT', amount: '100000000' },
      };
      pipe.xadd(streamCmd, '*', 'command', JSON.stringify(cmd), 'commandId', cmd.commandId);
    }
    await pipe.exec();

    while (runner.getSeq() < 50n) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // Stop runner cleanly
    await runner.stop();

    // Verify unacked is exactly 0
    const pending = await redis.xpending(streamCmd, group);
    expect(pending[0]).toBe(0);

    await redis.del(streamCmd, streamRep, streamEvt);
  });

  it(
    '7. EngineRunner with persistence: journals commands, takes snapshots, and recovers exact state on restart',
    async () => {
      const testId = `t7_${Date.now()}`;
      const streamCmd = `test.cmd.${testId}`;
      const streamRep = `test.rep.${testId}`;
      const streamEvt = `test.evt.${testId}`;
      const group = `group_${testId}`;
      const consumer = `consumer_${testId}`;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cex-runner-persistence-test-'));

      try {
        const state = Engine.createInitialState([SOL_USDT]);
        const runner = new EngineRunner(state, {
          redis,
          streamCommands: streamCmd,
          streamReplies: streamRep,
          streamEvents: streamEvt,
          groupName: group,
          consumerName: consumer,
          blockMs: 50,
          dataDir: tempDir,
          fsyncMs: 0,
          snapshotEveryN: 10,
          enableJournal: true,
        });

      await runner.start();

      // Submit 25 deposit commands in 3 batches: 10, 10, 5
      const sendBatch = async (start: number, end: number) => {
        const pipe = redis.pipeline();
        for (let i = start; i <= end; i++) {
          const cmd: Command = {
            commandId: `persist-dep-${i}`,
            type: 'DEPOSIT',
            userId: `user-${i}`,
            ts: Date.now() + i,
            payload: { asset: 'USDT', amount: (100000000n * BigInt(i)).toString() },
          };
          pipe.xadd(streamCmd, '*', 'command', JSON.stringify(cmd), 'commandId', cmd.commandId);
        }
        await pipe.exec();
      };

      await sendBatch(1, 10);
      while (runner.getSeq() < 10n) {
        await new Promise((r) => setTimeout(r, 50));
      }

      await sendBatch(11, 20);
      while (runner.getSeq() < 20n) {
        await new Promise((r) => setTimeout(r, 50));
      }

      await sendBatch(21, 25);
      while (runner.getSeq() < 25n) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(runner.getSeq()).toBe(25n);

      // Verify snapshots were taken at seq 10 and 20
      expect(fs.existsSync(path.join(tempDir, 'snapshot-10.json'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, 'snapshot-20.json'))).toBe(true);

      // Stop runner
      await runner.stop();

      // RESTART via createWithRecovery
      const recoveredRunner = await EngineRunner.createWithRecovery({
        redis,
        streamCommands: streamCmd,
        streamReplies: streamRep,
        streamEvents: streamEvt,
        groupName: group,
        consumerName: consumer,
        blockMs: 50,
        dataDir: tempDir,
        fsyncMs: 0,
      });

      expect(recoveredRunner.getSeq()).toBe(25n);
      const recoveredState = recoveredRunner.getState();
      const bal25 = recoveredState.balanceManager.get('user-25', 'USDT');
      expect(bal25.available).toBe(2500000000n);

      // Start recovered runner and process 5 more commands
      await recoveredRunner.start();

      const pipe2 = redis.pipeline();
      for (let i = 26; i <= 30; i++) {
        const cmd: Command = {
          commandId: `persist-dep-${i}`,
          type: 'DEPOSIT',
          userId: `user-${i}`,
          ts: Date.now() + i,
          payload: { asset: 'USDT', amount: (100000000n * BigInt(i)).toString() },
        };
        pipe2.xadd(streamCmd, '*', 'command', JSON.stringify(cmd), 'commandId', cmd.commandId);
      }
      await pipe2.exec();

      while (recoveredRunner.getSeq() < 30n) {
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(recoveredRunner.getSeq()).toBe(30n);

      await recoveredRunner.stop();
    } finally {
      await redis.del(streamCmd, streamRep, streamEvt);
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    }
  }, 20000);
});
