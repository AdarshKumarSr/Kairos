import type { Command, MarketConfig } from '@cex/types';
import type { EngineSnapshot, EngineState } from '../engine/types.js';

export interface JournalRecord {
  seq: string;
  commandId: string;
  ts: number;
  streamId: string;
  command: Command;
  crc32: number;
}

export interface JournalWriterOptions {
  dataDir: string;
  startSeq?: bigint | undefined;
  fsyncMs?: number | 'always' | undefined;
}

export interface ReadJournalResult {
  records: JournalRecord[];
  validByteLength: number;
  hasTornTail: boolean;
  tornError?: string | undefined;
}

export interface SnapshotManagerOptions {
  dataDir: string;
  keepSnapshots?: number | undefined;
}

export interface RecoveryOptions {
  dataDir: string;
  marketConfigs?: MarketConfig[] | undefined;
  seedFromDb?: boolean | undefined;
  truncateTornTail?: boolean | undefined;
}

export interface RecoveryResult {
  state: EngineState;
  engineSeq: bigint;
  lastStreamId: string;
  replayedCount: number;
  truncatedTail: boolean;
  fromSnapshotSeq: bigint | null;
}

export type { EngineSnapshot, EngineState };
