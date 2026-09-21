import { readFileSync, writeFileSync } from 'node:fs';
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

/** Current header gain in dB, or `null` when the file is not Ogg-Opus. */
export function readOutputGain(path: string): number | null {
  let buf: Buffer;
  try {
    // 64 KiB is far more than the first page needs and avoids loading a
    // whole track to read two bytes.
    buf = readFileSync(path).subarray(0, 65536);
  } catch {
    return null;
  }
  const page = firstOggPage(buf);
  if (!page) return null;
  return buf.readInt16LE(page.payloadAt + GAIN_OFFSET_IN_HEAD) / Q7_8_PER_DB;
}

/**
 * Write `gainDb` into the file's Opus header, leaving the audio untouched.
 *
 * Returns false rather than throwing when the file is not Ogg-Opus or cannot
 * be read — this runs over a whole library, and one odd file must not end the
 * pass.
 *
 * The write is a whole-file rewrite because the page CRC changes, but the
 * bytes that differ are exactly the two of gain and the four of CRC. Passing
 * `0` restores a file to unnormalized, which is what makes this reversible.
 */
export function writeOutputGain(path: string, gainDb: number): boolean {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    log.debug({ err, path }, 'could not read file for gain write');
    return false;
  }
  const page = firstOggPage(buf);
  if (!page) return false;

  const clamped = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, gainDb));
  const units = Math.round(clamped * Q7_8_PER_DB);
  buf.writeInt16LE(units, page.payloadAt + GAIN_OFFSET_IN_HEAD);

  // The CRC covers the whole page including the header we just changed, so it
  // has to be recomputed. A stale CRC makes the file corrupt to every decoder.
  const pageBuf = buf.subarray(page.start, page.start + page.length);
  buf.writeUInt32LE(oggPageCrc(pageBuf), page.start + 22);

  try {
    writeFileSync(path, buf);
    return true;
  } catch (err) {
    log.warn({ err, path }, 'could not write Opus header gain');
    return false;
  }
}
