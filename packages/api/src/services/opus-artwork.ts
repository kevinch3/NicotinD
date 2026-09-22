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

/**
 * Longest-edge caps tried, in order, each paired with the whole quality ladder.
 *
 * `null` comes first and means "leave the pixel dimensions alone", so a cover
 * that is merely saved at a wasteful quality is fixed without ever resampling
 * — the common case, and unchanged from before.
 *
 * The later entries exist because quality is the *weaker* axis once an image
 * is large in **dimensions**: there is a point past which no quality setting
 * reaches the cap, and the ladder used to exhaust there and drop the art
 * entirely. Measured on a real 3000×3000 cover this was dropping (#1252):
 *
 * | | native | 1500px | 1000px |
 * | --- | --- | --- | --- |
 * | q4 | 982 KB | 348 KB | 175 KB |
 * | q8 | **605 KB — over the cap** | 198 KB | 102 KB |
 *
 * Note that 1500px q4 is both smaller *and* better-looking than native q8: at
 * any realistic display size q8's artifacts show more than the resample does.
 * So once a cover is over the cap, downscaling dominates pushing quality — the
 * old ladder spent its entire budget on the weaker axis and then gave up.
 */
const RECOMPRESS_EDGE = [null, 1500, 1000] as const;

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
 * Tries quality before dimensions: the pixel dimensions are what a listener
 * sees when the cover is opened, so a cover that only needs a gentler quality
 * keeps its full size — a 1000×1000 cover at q3 is 730 KB and visually
 * identical at q6. Only when no quality reaches the cap does it start capping
 * the longest edge, because past a certain size quality alone cannot get there
 * at all. See {@link RECOMPRESS_EDGE}.
 *
 * Returns the original untouched when it already fits, which is the common
 * case; only the outliers pay for a second encode. Returns **null** when
 * nothing on either ladder gets under the cap — an explicit "do not embed
 * this" the caller has to handle, rather than a path that fails later.
 */
export function preparePicture(
  coverPath: string,
  scratchPath: string,
  maxBytes: number | null = MAX_EMBEDDED_PICTURE_BYTES,
): PreparedPicture | null {
  const bytes = statSync(coverPath).size;
  // `null` means the target container's reader imposes no ceiling we could
  // measure — mp3 reads a 6.5 MB cover back byte-exact where Ogg throws above
  // ~600 KB. Re-compressing there would degrade a cover for a reason that does
  // not apply to it, so the cap travels with the format rather than the module.
  if (maxBytes === null || bytes <= maxBytes) {
    return { path: coverPath, recompressed: false, bytes };
  }

  for (const edge of RECOMPRESS_EDGE) {
    for (const q of RECOMPRESS_QUALITY) {
      const args = ['-hide_banner', '-loglevel', 'error', '-i', coverPath];
      if (edge !== null) {
        // Bounding the box by the source's own dimensions is what keeps this
        // from UPSCALING a cover that is already small on one axis, and
        // `decrease` caps the longest edge whatever the orientation — a plain
        // `scale=w:-2` would only ever cap the width and do nothing to a tall
        // image.
        args.push(
          '-vf',
          `scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease:flags=lanczos`,
        );
      }
      args.push('-q:v', String(q), '-y', scratchPath);

      try {
        execFileSync(ffmpegBinary(), args, { stdio: 'pipe' });
      } catch (err) {
        // A failure here is about the input, not the setting, so trying the
        // remaining eight combinations would just be eight more failures.
        log.warn({ err, coverPath, q, edge }, 'cover re-compress failed');
        return null;
      }
      const got = statSync(scratchPath).size;
      if (got <= maxBytes) {
        log.debug({ coverPath, from: bytes, to: got, q, edge }, 're-compressed an oversized cover');
        return { path: scratchPath, recompressed: true, bytes: got };
      }
    }
  }

  // Nothing on either ladder fits. Embedding it would produce a file the app
  // cannot read — silently invisible art that still costs the bytes — so
  // report the failure and let the caller skip it.
  log.warn(
    { coverPath, bytes, cap: maxBytes },
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
 * - **`-c:a copy` preserves the existing *scalar* tags.** `-map_metadata 1`
 *   looks like it would replace them, and for a re-encode it does — but a
 *   stream copy carries the Opus comment header with the stream, so the picture
 *   merges in. Verified against a file carrying `COPYRIGHT`, which
 *   `readAudioTags` does not even model: it survives.
 * - **An existing picture does NOT survive**, and that exception is easy to
 *   inherit wrongly from the line above. ffmpeg surfaces
 *   `METADATA_BLOCK_PICTURE` as an attached-picture *stream*, so `-map 0:a`
 *   excludes it and the cover is gone. This function never notices because it
 *   always writes a picture of its own — but any caller merging some *other*
 *   field into an existing file must re-write the current picture into the
 *   ffmetadata or silently strip it. Measured: adding only a
 *   `MUSICBRAINZ_TRACKID` took a file from `pics=1` to `pics=0` while title,
 *   artist and album came through untouched.
 *
 * Writes to a sibling temp and renames, so an interrupted run never leaves a
 * half-written library file. The temp is dot-prefixed for the same reason
 * `transcodeTempPathFor` is: a leaked one must not be scanned as a track.
 */
export function attachPictureToOpus(opusPath: string, coverPath: string): boolean {
  try {
    return attachPictureDataToOpus(opusPath, readFileSync(coverPath), mimeForCover(coverPath));
  } catch (err) {
    log.warn({ err, opusPath }, 'could not attach cover art');
    return false;
  }
}

/** {@link attachPictureToOpus} for image bytes already in memory. */
export function attachPictureDataToOpus(opusPath: string, data: Buffer, mimeType: string): boolean {
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
    const b64 = pictureBlockBase64(data, mimeType);
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

/**
 * The first picture embedded in an Ogg file, or `null` when it has none.
 *
 * Exists so a caller that rewrites the container can put the picture back —
 * the trap described on {@link attachPictureToOpus}, which every tag write hit
 * until #1280. Read through ffmpeg rather than music-metadata, because the
 * latter throws on an Ogg picture above ~600 KB, and a picture we cannot read
 * is one the rewrite would silently drop.
 *
 * **Throws** when a picture is present but could not be extracted, so the
 * caller refuses the write instead of stripping it. The picture comes back as
 * a front cover with no description; the type and description of a
 * `METADATA_BLOCK_PICTURE` are not carried.
 */
export function readOggPicture(path: string): { data: Buffer; mimeType: string } | null {
  const streams = execFileSync(
    ffmpegBinary().replace(/ffmpeg$/, 'ffprobe'),
    [
      '-v',
      'error',
      '-select_streams',
      'v',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      path,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  if (streams === '') return null;
  const data = execFileSync(
    ffmpegBinary(),
    ['-v', 'error', '-i', path, '-map', '0:v:0', '-c', 'copy', '-f', 'image2pipe', '-'],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  );
  if (data.length === 0) throw new Error('embedded picture present but empty');
  const isPng = data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { data, mimeType: isPng ? 'image/png' : 'image/jpeg' };
}

/** Content type from a cover's extension; the block needs an accurate one. */
function mimeForCover(coverPath: string): string {
  const ext = extname(coverPath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}
