#!/usr/bin/env node
import { recoverEngine } from '../persistence/recovery.js';
import { SnapshotManager } from '../persistence/snapshot.js';

function parseArgs(): { dataDir: string } {
  const args = process.argv.slice(2);
  let dataDir = process.env.ENGINE_DATA_DIR ?? './data/engine';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) {
      dataDir = args[i + 1]!;
      i++;
    }
  }
  return { dataDir };
}

async function main(): Promise<void> {
  const { dataDir } = parseArgs();
  console.log(`[engine:snapshot-now] Triggering immediate snapshot for: ${dataDir}`);

  try {
    const recovered = await recoverEngine({
      dataDir,
      truncateTornTail: true,
    });

    const snapshotManager = new SnapshotManager({ dataDir });
    const snapPath = snapshotManager.createSnapshot(
      recovered.state,
      recovered.engineSeq,
      recovered.lastStreamId
    );

    console.log(`[engine:snapshot-now] Successfully created snapshot at seq ${recovered.engineSeq.toString()}:`);
    console.log(`  Path: ${snapPath}`);
    process.exit(0);
  } catch (err: unknown) {
    console.error(`[engine:snapshot-now] FAILED:`, err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[engine:snapshot-now] Unhandled error:', err);
  process.exit(1);
});
