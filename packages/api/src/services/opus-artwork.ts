import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { createLogger } from '@nicotind/core';
import { ffmpegBinary } from './ffmpeg-path.js';

const log = createLogger('opus-artwork');

/**
 * Embedding cover art in Opus, and the ceiling our own reader imposes on it.
 *
 * **The file is not the hard part.** `opusenc --picture` writes a correct
 * `METADATA_BLOCK_PICTURE`: `opusinfo` reads a 730 KB cover back byte-exact and
 * `ffprobe` reports the right dimensions. What fails is `music-metadata`, the
 * library every read path in this app goes through — `extractEmbeddedPicture`
 * for the cover picker, and the scanner for `has_embedded_art`.
 *
 * Measured on opusenc output, same image each time:
 *
 * | cover bytes | music-metadata |
 * | --- | --- |
 * | 7,607 | reads it |
 * | 104,076 | reads it |
 * | 415,118 | reads it |
 * | 457,336 | reads it |
 * | 598,039 | reads it |
 * | **676,153** | **throws "Out of bounds access"** |
 * | 730,846 | throws |
 * | 886,362 | throws |
 *
 * The same 730 KB image embedded in an **mp3** reads fine, so this is specific
 * to Opus — consistent with a large comment spanning Ogg pages, which are
 * capped at 65,025 payload bytes each.
 *
 * A file the app cannot read is worse than no file: the picker shows nothing
 * and `has_embedded_art` says false, so the art is invisible while still
 * costing the bytes. Hence the cap below, chosen with margin under the
 * measured boundary rather than at it.
 */

/**
 * Largest cover we will embed, with margin under the ~600 KB point where
 * `music-metadata` starts throwing. Anything bigger is re-compressed first.
 */
export const MAX_EMBEDDED_PICTURE_BYTES = 512 * 1024;

/** Quality ladder tried, in order, when a cover is over the cap. */
const RECOMPRESS_QUALITY = [4, 6, 8] as const;

export interface PreparedPicture {
  /** Path to embed — the input itself when it was already small enough. */
  path: string;
  /** True when the image had to be re-compressed to fit. */
  recompressed: boolean;
  bytes: number;
}

/**
 * Ensure `coverPath` is small enough for the app to read back after embedding,
 * re-compressing into `scratchPath` when it is not.
 *
 * Re-compresses rather than downscales: the pixel dimensions are what a
 * listener sees when the cover is opened, and JPEG quality is the axis with
 * the most headroom — a 1000×1000 cover at q3 is 730 KB and visually identical
 * at q6.
 *
 * Returns the original untouched when it already fits, which is the common
 * case; only the outliers pay for a second encode. Returns **null** when even
 * the softest quality cannot get under the cap — an explicit "do not embed
 * this" the caller has to handle, rather than a path that fails later.
 */
export function preparePicture(coverPath: string, scratchPath: string): PreparedPicture | null {
  const bytes = statSync(coverPath).size;
  if (bytes <= MAX_EMBEDDED_PICTURE_BYTES) {
    return { path: coverPath, recompressed: false, bytes };
  }

  for (const q of RECOMPRESS_QUALITY) {
    try {
      execFileSync(
        ffmpegBinary(),
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          coverPath,
          '-q:v',
          String(q),
          '-y',
          scratchPath,
        ],
        { stdio: 'pipe' },
      );
    } catch (err) {
      log.warn({ err, coverPath, q }, 'cover re-compress failed');
      break;
    }
    const got = statSync(scratchPath).size;
    if (got <= MAX_EMBEDDED_PICTURE_BYTES) {
      log.debug({ coverPath, from: bytes, to: got, q }, 're-compressed an oversized cover');
      return { path: scratchPath, recompressed: true, bytes: got };
    }
  }

  // Still too big at the softest quality we are willing to use. Embedding it
  // would produce a file the app cannot read — silently invisible art that
  // still costs the bytes — so report the failure and let the caller skip it.
  log.warn(
    { coverPath, bytes, cap: MAX_EMBEDDED_PICTURE_BYTES },
    'cover too large to embed readably; leaving it out',
  );
  return null;
}

/**
 * Build the FLAC `METADATA_BLOCK_PICTURE` structure Vorbis comments carry, as
 * base64.
 *
 * Layout is fixed by the FLAC spec: big-endian type, then each of MIME and
 * description as a length-prefixed string, then width/height/depth/colours,
 * then the length-prefixed image data. Dimensions are written as **zero** —
 * they are advisory, every reader tested here ignores them in favour of the
 * real image header, and computing them would mean decoding the JPEG.
 */
export function pictureBlockBase64(data: Buffer, mimeType = 'image/jpeg'): string {
  const mime = Buffer.from(mimeType, 'ascii');
  const desc = Buffer.alloc(0);
  const b = Buffer.alloc(32 + mime.length + desc.length + data.length);
  let o = 0;
  b.writeUInt32BE(3, o);
  o += 4; // 3 = front cover
  b.writeUInt32BE(mime.length, o);
  o += 4;
  mime.copy(b, o);
  o += mime.length;
  b.writeUInt32BE(desc.length, o);
  o += 4;
  for (let i = 0; i < 4; i++) {
    b.writeUInt32BE(0, o);
    o += 4;
  } // w, h, depth, colours
  b.writeUInt32BE(data.length, o);
  o += 4;
  data.copy(b, o);
  return b.toString('base64');
}

/**
 * ffmetadata escaping: `=`, `;`, `#`, `\` and newline take a leading backslash.
 * Not optional here — base64 padding is `=`.
 */
const escapeFfmetadata = (s: string): string => s.replace(/[=;#\\\n]/g, (c) => '\\' + c);

/**
 * Attach `coverPath` to an existing `.opus` **without re-encoding it**.
 *
 * Measured, because the obvious routes do not work and one of them looks like
 * it does:
 *
 * - **`-vn` must stay** in the encoder. Dropping it does not attach a cover —
 *   ffmpeg re-encodes the JPEG as a **Theora video stream** inside the Ogg,
 *   which is worse than losing it.
 * - **The payload cannot go on the command line.** A 730 KB cover base64s to
 *   974,524 characters and `execFile` fails with `E2BIG`; Linux caps a single
 *   argv entry at 128 KB. Hence the ffmetadata file.
 * - **`-c:a copy` preserves the existing tags.** `-map_metadata 1` looks like
 *   it would replace them, and for a re-encode it does — but a stream copy
 *   carries the Opus comment header with the stream, so the picture merges in.
 *   Verified against a file carrying `COPYRIGHT`, which `readAudioTags` does
 *   not even model: it survives.
 *
 * Writes to a sibling temp and renames, so an interrupted run never leaves a
 * half-written library file. The temp is dot-prefixed for the same reason
 * `transcodeTempPathFor` is: a leaked one must not be scanned as a track.
 */
export function attachPictureToOpus(opusPath: string, coverPath: string): boolean {
  const dir = dirname(opusPath);
  const stem = basename(opusPath, extname(opusPath));
  const meta = join(dir, `.${stem}.nicotind-art.ffmeta`);
  const tmp = join(dir, `.${stem}.nicotind-art.opus`);
  const cleanup = () => {
    for (const p of [meta, tmp]) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* best effort */
      }
    }
  };

  try {
    const b64 = pictureBlockBase64(readFileSync(coverPath), mimeForCover(coverPath));
    writeFileSync(meta, ';FFMETADATA1\nMETADATA_BLOCK_PICTURE=' + escapeFfmetadata(b64) + '\n');
    execFileSync(
      ffmpegBinary(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        opusPath,
        '-f',
        'ffmetadata',
        '-i',
        meta,
        '-map',
        '0:a',
        '-map_metadata',
        '1',
        '-c:a',
        'copy',
        '-f',
        'ogg',
        '-y',
        tmp,
      ],
      { stdio: 'pipe' },
    );
    if (!existsSync(tmp) || statSync(tmp).size === 0) {
      cleanup();
      return false;
    }
    renameSync(tmp, opusPath);
    rmSync(meta, { force: true });
    return true;
  } catch (err) {
    // Never fatal: art is an enhancement, and the audio is already correct.
    log.warn({ err, opusPath }, 'could not attach cover art');
    cleanup();
    return false;
  }
}

/** Content type from a cover's extension; the block needs an accurate one. */
function mimeForCover(coverPath: string): string {
  const ext = extname(coverPath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}
