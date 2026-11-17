import zlib from 'node:zlib';

// Precomputed IEEE 802.3 table fallback
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

/**
 * Standard IEEE 802.3 CRC32 checksum.
 * Returns an unsigned 32-bit integer.
 */
export function computeCrc32(data: string | Buffer | Uint8Array): number {
  if (typeof (zlib as { crc32?: unknown }).crc32 === 'function') {
    return (zlib.crc32 as (data: string | Buffer | Uint8Array) => number)(data) >>> 0;
  }

  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]!;
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
