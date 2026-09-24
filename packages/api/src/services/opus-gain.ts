import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createLogger } from '@nicotind/core';

const log = createLogger('opus-gain');

/**
 * Loudness normalization by editing the Opus header, not the audio.
 *
 * **Why the header and not a filter.** Baking a `loudnorm` gain into the encode
 * changes the samples, which flattens `library_songs.loudness` — and
 * `computeEnergy` maps that column (−25 LUFS → 0, −7 → 1) into the descriptor
 * radio runs on. Normalizing that way would silently destroy the recommender's
 * own input while appearing to work.
 *
 * RFC 7845 §5.1 defines `output_gain` in the `OpusHead` packet, and requires
 * **decoders** to apply it. So the gain rides in 2 bytes of header: the audio
 * is untouched, the descriptor survives, the target stays re-tunable forever,
 * and the 7,774 files already in Opus can be normalized today without any
 * conversion machinery.
 *
 * **What this edits.** `OpusHead` sits in the payload of the first Ogg page.
 * Bytes 16–17 of it are `output_gain`, a signed little-endian 16-bit value in
 * Q7.8 dB — so 256 units is +1 dB. Changing them invalidates the page's CRC,
 * which is why {@link oggPageCrc} exists: a page whose CRC does not match is a
 * corrupt file to every decoder, and getting that wrong would be the worst
 * possible outcome for a "lossless" operation.
 *
 * Nothing here decodes or re-encodes. A file this touches differs from its
 * original in exactly six bytes: two of gain and four of page CRC.
 */

/** RFC 7845: `output_gain` is Q7.8 dB, so one dB is 256 units. */
const Q7_8_PER_DB = 256;

/**
 * The range the field can hold. Q7.8 in a signed 16-bit field is ±128 dB, far
 * wider than anything a real track needs; the clamp exists so a corrupt
 * loudness reading cannot produce a silent or deafening file.
 */
const MIN_GAIN_DB = -32;
const MAX_GAIN_DB = 32;

/** Byte offset of `output_gain` within the `OpusHead` packet. */
const GAIN_OFFSET_IN_HEAD = 16;

/**
 * dB of gain that moves `measuredLufs` to `targetLufs`.
 *
 * Returns `null` when the measurement is missing or implausible rather than
 * guessing. A track with no loudness reading must be left alone: writing a
 * gain computed from a default would be a confident wrong answer, and the one
 * thing worse than an unnormalized track is a normalized-to-nothing one.
 */
export function gainForTarget(
  measuredLufs: number | null | undefined,
  targetLufs: number,
): number | null {
  if (measuredLufs == null || !Number.isFinite(measuredLufs)) return null;
  // Real integrated loudness for music sits roughly between −40 and 0 LUFS.
  // Outside that the reading is a probe failure, not a quiet record.
  if (measuredLufs > 0 || measuredLufs < -60) return null;
  const raw = targetLufs - measuredLufs;
  return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, raw));
}

/**
 * Ogg's CRC32: polynomial 0x04c11db7, MSB-first, no reflection, init 0, no
 * final xor — deliberately none of the common CRC32 variants, which is why
 * this is written out rather than reached for from a library.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

/** CRC over a whole Ogg page, with its own CRC field treated as zero. */
export function oggPageCrc(page: Buffer): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    // Bytes 22-25 are the CRC field itself, which is zeroed for the sum.
    const b = i >= 22 && i <= 25 ? 0 : page[i]!;
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ b]!) >>> 0;
  }
  return crc >>> 0;
}

interface FirstPage {
  /** Offset of the page start in the file. */
  start: number;
  /** Total page length, header plus payload. */
  length: number;
  /** Offset of the page's payload in the file. */
  payloadAt: number;
}

/**
 * Locate the first Ogg page, the one carrying `OpusHead`.
 *
 * Returns `null` for anything that is not an Ogg-Opus file rather than
 * throwing: callers run this over a whole library and a stray `.opus` that is
 * secretly something else must be skipped, not fatal.
 */
function firstOggPage(buf: Buffer): FirstPage | null {
  if (buf.length < 27 || buf.toString('ascii', 0, 4) !== 'OggS') return null;
  const segments = buf[26]!;
  const headerLength = 27 + segments;
  if (buf.length < headerLength) return null;
  let payloadLength = 0;
  for (let i = 0; i < segments; i++) payloadLength += buf[27 + i]!;
  const payloadAt = headerLength;
  if (buf.length < payloadAt + payloadLength) return null;
  if (buf.toString('ascii', payloadAt, payloadAt + 8) !== 'OpusHead') return null;
  return { start: 0, length: headerLength + payloadLength, payloadAt };
}

/**
 * Bytes pulled off the front of a file. An Ogg page caps at 65,307 bytes
 * (27 header + 255 lacing + 65,025 payload), so one read covers the first page
 * whatever its size.
 */
const HEAD_BYTES = 65_536;

/**
 * Read the first {@link HEAD_BYTES} of a file, or `null` if it cannot be read.
 *
 * A descriptor rather than `readFileSync`, because `readFileSync(p).subarray(…)`
 * loads the **whole track** and then throws almost all of it away. Over a
 * library that is 43.8 GiB of reads to inspect 2 bytes per file, and it is
 * synchronous, so it blocks the event loop long enough for health checks to
 * time out and the container to be marked unhealthy. Measured, not theorised.
 */
function readHead(path: string): { buf: Buffer; bytes: number } | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const bytes = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return { buf, bytes };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Current header gain in dB, or `null` when the file is not Ogg-Opus. */
export function readOutputGain(path: string): number | null {
  const head = readHead(path);
  if (!head) return null;
  const page = firstOggPage(head.buf.subarray(0, head.bytes));
  if (!page) return null;
  return head.buf.readInt16LE(page.payloadAt + GAIN_OFFSET_IN_HEAD) / Q7_8_PER_DB;
}

/**
 * Write `gainDb` into the file's Opus header, leaving the audio untouched.
 *
 * Returns false rather than throwing when the file is not Ogg-Opus or cannot
 * be read — this runs over a whole library, and one odd file must not end the
 * pass.
 *
 * **Six bytes are read-modify-written in place**, not a whole-file rewrite.
 * Both live in the first Ogg page, so the file is opened once, its head read,
 * and two short `writeSync`s land at fixed offsets. Rewriting the container to
 * change a gain would move 43.8 GiB across a library to alter 46 KB of it.
 *
 * Passing `0` restores a file to unnormalized, which is what makes this
 * reversible.
 */
export function writeOutputGain(path: string, gainDb: number): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r+');
  } catch (err) {
    log.debug({ err, path }, 'could not open file for gain write');
    return false;
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const bytes = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const page = firstOggPage(buf.subarray(0, bytes));
    if (!page) return false;

    const clamped = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, gainDb));
    const units = Math.round(clamped * Q7_8_PER_DB);
    const gainAt = page.payloadAt + GAIN_OFFSET_IN_HEAD;
    buf.writeInt16LE(units, gainAt);

    // The CRC covers the whole page including the byte just changed, so it has
    // to be recomputed. A stale CRC makes the file corrupt to every decoder —
    // it is the one thing this must not get wrong.
    const crcAt = page.start + 22;
    buf.writeUInt32LE(oggPageCrc(buf.subarray(page.start, page.start + page.length)), crcAt);

    // The two byte ranges that actually differ, written where they sit.
    writeSync(fd, buf, gainAt, 2, gainAt);
    writeSync(fd, buf, crcAt, 4, crcAt);
    return true;
  } catch (err) {
    log.warn({ err, path }, 'could not write Opus header gain');
    return false;
  } finally {
    closeSync(fd);
  }
}

/** The largest possible Ogg page: 27 header + 255 lacing + 255 × 255 payload. */
const MAX_OGG_PAGE_BYTES = 27 + 255 + 255 * 255;

/** Header-type flag on the last page of a logical stream. */
const OGG_EOS = 0x04;

/** Opus granule positions always count 48 kHz samples (RFC 7845 §4). */
const OPUS_GRANULE_RATE = 48_000;

/** Byte offset of `pre_skip` (uint16 LE) within the `OpusHead` packet. */
const PRE_SKIP_OFFSET_IN_HEAD = 10;

/**
 * The complete, CRC-valid page that ends exactly at the end of `tail`, or
 * `null`. Scans back over `OggS` matches because the pattern can also occur
 * inside compressed audio.
 */
function lastOggPage(tail: Buffer): Buffer | null {
  let at = tail.lastIndexOf('OggS');
  while (at >= 0) {
    if (at + 27 <= tail.length && tail[at + 4] === 0) {
      const segments = tail[at + 26]!;
      let length = 27 + segments;
      if (at + length <= tail.length) {
        for (let i = 0; i < segments; i++) length += tail[at + 27 + i]!;
        if (at + length === tail.length) {
          const page = tail.subarray(at, at + length);
          if (page.readUInt32LE(22) === oggPageCrc(page)) return page;
        }
      }
    }
    at = at > 0 ? tail.lastIndexOf('OggS', at - 1) : -1;
  }
  return null;
}

/**
 * Playable duration of an Ogg-Opus file read in-process: the last page's
 * granule position minus the `OpusHead` pre-skip, over 48 kHz (RFC 7845 §4).
 * Replaces an ffprobe spawn on the lossless encode's validation (#1305).
 *
 * - `undefined`: not Ogg-Opus at all (no `OggS` + `OpusHead` first page), so
 *   the caller should use another probe.
 * - `null`: Ogg-Opus, but the duration cannot be trusted: a first page whose
 *   CRC fails, no complete CRC-valid page ending at EOF (truncated, or trailing
 *   bytes), a last page without the end-of-stream flag or from another logical
 *   stream, or an unset granule. The encode validation **fails closed** on it,
 *   because a pass there deletes the original.
 */
export async function readOggOpusDurationSec(path: string): Promise<number | null | undefined> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    const { bytesRead: headBytes } = await fh.read(head, 0, head.length, 0);
    const first = firstOggPage(head.subarray(0, headBytes));
    if (!first) return undefined;
    const firstPage = head.subarray(first.start, first.start + first.length);
    if (firstPage.readUInt32LE(22) !== oggPageCrc(firstPage)) return null;
    const serial = firstPage.readUInt32LE(14);
    const preSkip = head.readUInt16LE(first.payloadAt + PRE_SKIP_OFFSET_IN_HEAD);

    const tailLength = Math.min(size, MAX_OGG_PAGE_BYTES);
    const tail = Buffer.alloc(tailLength);
    const { bytesRead: tailBytes } = await fh.read(tail, 0, tailLength, size - tailLength);
    if (tailBytes !== tailLength) return null;
    const last = lastOggPage(tail);
    if (!last) return null;
    if ((last[5]! & OGG_EOS) === 0 || last.readUInt32LE(14) !== serial) return null;
    const granule = last.readBigInt64LE(6);
    if (granule < 0n) return null;
    return Number(granule - BigInt(preSkip)) / OPUS_GRANULE_RATE;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}
