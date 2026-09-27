import { randomFillSync, randomUUID } from 'node:crypto';

/**
 * UUIDv7 — 48-bit big-endian Unix millisecond timestamp, then 74 random bits.
 *
 * Used for every primary key so that index inserts are append-mostly rather than random. At
 * 1.4B citizen rows and 150M events a day, random UUIDv4 keys would cause continuous B-tree page
 * splits and write amplification across every shard (docs/SCALING.md §4).
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);

  // 48-bit timestamp, big-endian, in bytes 0..5.
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;

  // Version 7 in the high nibble of byte 6; RFC 4122 variant in the top two bits of byte 8.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Milliseconds encoded in a UUIDv7, for cheap age checks without a timestamp column. */
export function uuidv7Timestamp(id: string): number {
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

export { randomUUID };
