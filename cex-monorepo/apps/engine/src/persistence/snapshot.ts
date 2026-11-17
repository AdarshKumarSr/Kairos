import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../engine/engine.js';
import type { EngineSnapshot, EngineState } from '../engine/types.js';
import { JournalReader } from './journal.js';
import type { SnapshotManagerOptions } from './types.js';

export class SnapshotManager {
  private readonly dataDir: string;
  private readonly keepSnapshots: number;

  constructor(options: SnapshotManagerOptions) {
    this.dataDir = options.dataDir;
    this.keepSnapshots = options.keepSnapshots ?? 3;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  public getDataDir(): string {
    return this.dataDir;
  }

  /**
   * Serializes full EngineState, writes to snapshot-<seq>.tmp,
   * fsyncs, and atomically renames to snapshot-<seq>.json.
   * Then prunes snapshots older than the 3 newest, and deletes old journal segments.
   */
  public createSnapshot(
    state: EngineState,
    engineSeq: bigint,
    lastStreamId: string
  ): string {
    const snapshot = Engine.snapshot(state, engineSeq, lastStreamId, Date.now());
    const json = JSON.stringify(snapshot, null, 2);

    const tmpPath = path.join(this.dataDir, `snapshot-${engineSeq}.tmp`);
    const finalPath = path.join(this.dataDir, `snapshot-${engineSeq}.json`);

    const fd = fs.openSync(tmpPath, 'w');
    fs.writeSync(fd, json, 0, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    if (fs.existsSync(finalPath)) {
      fs.unlinkSync(finalPath);
    }
    fs.renameSync(tmpPath, finalPath);

    this.pruneOldSnapshotsAndJournals();

    return finalPath;
  }

  /**
   * Lists all snapshot-*.json files sorted descending by sequence number.
   */
  public findSnapshots(): Array<{ file: string; seq: bigint }> {
    if (!fs.existsSync(this.dataDir)) return [];

    const files = fs.readdirSync(this.dataDir);
    const snapshots: Array<{ file: string; seq: bigint }> = [];
    const regex = /^snapshot-(\d+)\.json$/;

    for (const f of files) {
      const match = regex.exec(f);
      if (match && match[1]) {
        snapshots.push({
          file: path.join(this.dataDir, f),
          seq: BigInt(match[1]),
        });
      }
    }

    return snapshots.sort((a, b) => (a.seq > b.seq ? -1 : a.seq < b.seq ? 1 : 0));
  }

  /**
   * Loads the newest valid snapshot.
   * If a snapshot file is corrupted, tries the next newest.
   */
  public findLatestSnapshot(): { file: string; seq: bigint; snapshot: EngineSnapshot } | null {
    const snapshots = this.findSnapshots();

    for (const snap of snapshots) {
      try {
        const raw = fs.readFileSync(snap.file, 'utf-8');
        const parsed = JSON.parse(raw) as EngineSnapshot;
        if (parsed && typeof parsed.engineSeq === 'string' && Array.isArray(parsed.markets)) {
          return {
            file: snap.file,
            seq: snap.seq,
            snapshot: parsed,
          };
        }
      } catch (err: unknown) {
        // Corrupted snapshot; try earlier snapshot
      }
    }

    return null;
  }

  /**
   * Retains the last `keepSnapshots` (default 3) snapshots and deletes older ones.
   * Also deletes journal segments whose entries are strictly older than the 3rd newest snapshot.
   */
  public pruneOldSnapshotsAndJournals(): void {
    const snapshots = this.findSnapshots();
    if (snapshots.length <= this.keepSnapshots) {
      return;
    }

    // Keep the newest N snapshots; delete older ones
    const toDeleteSnapshots = snapshots.slice(this.keepSnapshots);
    for (const snap of toDeleteSnapshots) {
      try {
        fs.unlinkSync(snap.file);
      } catch (err: unknown) {
        // Ignored
      }
    }

    // The oldest retained snapshot is at index (keepSnapshots - 1)
    const oldestRetained = snapshots[this.keepSnapshots - 1];
    if (!oldestRetained) return;

    const oldestRetainedSeq = oldestRetained.seq;
    const journals = JournalReader.listJournals(this.dataDir);

    for (let i = 0; i < journals.length - 1; i++) {
      const current = journals[i];
      const next = journals[i + 1];
      if (current && next) {
        // If the next segment starts at <= oldestRetainedSeq + 1n,
        // then all records in current are <= oldestRetainedSeq and are already in the snapshot.
        if (next.startSeq <= oldestRetainedSeq + 1n) {
          try {
            fs.unlinkSync(current.file);
          } catch (err: unknown) {
            // Ignored
          }
        }
      }
    }
  }
}
