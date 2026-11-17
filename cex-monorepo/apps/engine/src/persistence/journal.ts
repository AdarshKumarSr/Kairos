import fs from 'node:fs';
import path from 'node:path';
import { computeCrc32 } from './crc32.js';
import { JournalRecord, JournalWriterOptions, ReadJournalResult } from './types.js';

export function serializeJournalRecord(record: Omit<JournalRecord, 'crc32'>): string {
  const payloadObj = {
    seq: record.seq,
    commandId: record.commandId,
    ts: record.ts,
    streamId: record.streamId,
    command: record.command,
  };
  const payloadJson = JSON.stringify(payloadObj);
  const crc = computeCrc32(payloadJson);
  return JSON.stringify({ ...payloadObj, crc32: crc }) + '\n';
}

export function parseJournalRecord(line: string): { record?: JournalRecord; error?: string } {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch (err: unknown) {
    return { error: `Invalid JSON: ${(err as Error).message}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { error: 'Record is not an object' };
  }
  if (typeof parsed.seq !== 'string' || typeof parsed.commandId !== 'string') {
    return { error: 'Missing or invalid seq/commandId' };
  }
  if (typeof parsed.crc32 !== 'number') {
    return { error: 'Missing or invalid crc32' };
  }

  const payloadObj = {
    seq: parsed.seq,
    commandId: parsed.commandId,
    ts: parsed.ts,
    streamId: parsed.streamId,
    command: parsed.command,
  };
  const computedCrc = computeCrc32(JSON.stringify(payloadObj));
  if (computedCrc !== parsed.crc32) {
    return { error: `CRC32 mismatch: expected ${parsed.crc32}, got ${computedCrc}` };
  }

  return { record: parsed as JournalRecord };
}

export class JournalWriter {
  private readonly dataDir: string;
  private readonly fsyncMs: number | 'always';
  private fd: number | null = null;
  private currentPath: string | null = null;
  private currentStartSeq: bigint;
  private fsyncTimer: NodeJS.Timeout | null = null;
  private pendingSync = false;
  private closed = false;

  constructor(options: JournalWriterOptions) {
    this.dataDir = options.dataDir;
    this.fsyncMs = options.fsyncMs ?? 50;
    this.currentStartSeq = options.startSeq ?? 1n;

    fs.mkdirSync(this.dataDir, { recursive: true });
    this.openSegment(this.currentStartSeq);

    if (typeof this.fsyncMs === 'number' && this.fsyncMs > 0) {
      this.fsyncTimer = setInterval(() => {
        this.fsync();
      }, this.fsyncMs);
      if (typeof this.fsyncTimer.unref === 'function') {
        this.fsyncTimer.unref();
      }
    }
  }

  private openSegment(startSeq: bigint): void {
    if (this.fd !== null) {
      this.fsync();
      fs.closeSync(this.fd);
      this.fd = null;
    }
    this.currentStartSeq = startSeq;
    this.currentPath = path.join(this.dataDir, `journal-${startSeq}.log`);
    this.fd = fs.openSync(this.currentPath, 'a');
  }

  public getSegmentPath(): string | null {
    return this.currentPath;
  }

  public getStartSeq(): bigint {
    return this.currentStartSeq;
  }

  public append(record: Omit<JournalRecord, 'crc32'>): void {
    if (this.closed || this.fd === null) {
      throw new Error('Cannot append to closed JournalWriter');
    }

    const line = serializeJournalRecord(record);
    const buf = Buffer.from(line, 'utf-8');
    fs.writeSync(this.fd, buf);
    this.pendingSync = true;

    if (this.fsyncMs === 'always' || this.fsyncMs === 0) {
      this.fsync();
    }
  }

  public fsync(): void {
    if (this.fd !== null && this.pendingSync) {
      try {
        fs.fsyncSync(this.fd);
      } catch (err: unknown) {
        // Ignored if file handle already closed
      }
      this.pendingSync = false;
    }
  }

  public rotate(newStartSeq: bigint): void {
    if (this.closed) return;
    this.openSegment(newStartSeq);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.fsyncTimer) {
      clearInterval(this.fsyncTimer);
      this.fsyncTimer = null;
    }

    this.fsync();
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

export class JournalReader {
  /**
   * Reads records from a journal file line by line with CRC verification.
   * If a torn tail or corrupted line is encountered, safely stops and optionally truncates the file.
   */
  static readJournal(
    filePath: string,
    options?: { truncateTornTail?: boolean }
  ): ReadJournalResult {
    if (!fs.existsSync(filePath)) {
      return {
        records: [],
        validByteLength: 0,
        hasTornTail: false,
      };
    }

    const buf = fs.readFileSync(filePath);
    const records: JournalRecord[] = [];
    let lineStart = 0;
    let validOffset = 0;

    for (let i = 0; i <= buf.length; i++) {
      if (i === buf.length || buf[i] === 0x0a) {
        if (i === buf.length && lineStart === i) {
          validOffset = i;
          break;
        }

        let lineEnd = i;
        if (lineEnd > lineStart && buf[lineEnd - 1] === 0x0d) {
          lineEnd--;
        }

        const lineBuf = buf.subarray(lineStart, lineEnd);
        const lineStr = lineBuf.toString('utf-8').trim();

        if (lineStr.length === 0) {
          lineStart = i + 1;
          validOffset = i === buf.length ? i : i + 1;
          continue;
        }

        const { record, error } = parseJournalRecord(lineStr);
        if (error) {
          if (options?.truncateTornTail !== false) {
            fs.truncateSync(filePath, validOffset);
          }
          return {
            records,
            validByteLength: validOffset,
            hasTornTail: true,
            tornError: error,
          };
        }

        records.push(record!);
        validOffset = i === buf.length ? i : i + 1;
        lineStart = i + 1;
      }
    }

    return {
      records,
      validByteLength: validOffset,
      hasTornTail: false,
    };
  }

  /**
   * Finds all journal files in dataDir, sorted ascending by startSeq.
   */
  static listJournals(dataDir: string): Array<{ file: string; startSeq: bigint }> {
    if (!fs.existsSync(dataDir)) return [];

    const files = fs.readdirSync(dataDir);
    const journals: Array<{ file: string; startSeq: bigint }> = [];

    const regex = /^journal-(\d+)\.log$/;
    for (const f of files) {
      const match = regex.exec(f);
      if (match && match[1]) {
        journals.push({
          file: path.join(dataDir, f),
          startSeq: BigInt(match[1]),
        });
      }
    }

    return journals.sort((a, b) => (a.startSeq < b.startSeq ? -1 : a.startSeq > b.startSeq ? 1 : 0));
  }
}
