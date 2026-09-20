import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
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
