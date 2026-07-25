import { execFileSync, spawn } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';
import { extname } from 'node:path';
import { createLogger } from '@nicotind/core';
import { isLossless } from './library-track-select.js';
import { getMusicMetadata } from './music-metadata-loader.js';
import { ffmpegAvailable, transcodeOutputIsAcceptable } from './transcode.js';
import { ffmpegBinary } from './ffmpeg-path.js';

const log = createLogger('post-download-transcode');

export { isLossless };

// Containers that hold either lossy AAC or lossless ALAC — the extension alone
// can't tell, only the codec inside can.
const AMBIGUOUS_CONTAINERS = new Set(['m4a', 'm4b', 'mp4']);

/**
 * Codec-aware lossless check. Unambiguous extensions are decided without IO
 * (`isLossless`); `.m4a`-family files are probed with music-metadata because
 * ALAC (Apple Lossless) ships in the exact same container as lossy AAC.
 * Browsers cannot decode ALAC at all (Firefox surfaces
 * NS_ERROR_DOM_MEDIA_METADATA_ERR), so missing it here means a file the web
 * player can only play while server transcoding is enabled. Unreadable or
 * unparseable files answer `false` — the pipeline then leaves them untouched.
 */
export async function isLosslessFile(absPath: string): Promise<boolean> {
  const ext = extname(absPath).toLowerCase().replace(/^\./, '');
  if (isLossless(ext)) return true;
  if (!AMBIGUOUS_CONTAINERS.has(ext)) return false;
  try {
    const mm = await getMusicMetadata();
    if (!mm) return false;
    const meta = await mm.parseFile(absPath, { duration: false, skipCovers: true });
    return meta.format.lossless === true;
  } catch {
    return false;
  }
}

/**
 * Transcode a lossless file to Opus **in place**, replacing the original.
 *
 * Used both by the download pipeline (before a file enters the library, so the
 * scanner only ever sees the final `.opus` path) and by the existing-library
 * conversion job. Lossy files are never touched — callers gate on
 * {@link isLossless}. Tags are carried via `-map_metadata 0`; the organizer
 * re-writes canonical tags afterward regardless.
 *
 * Returns the new absolute path (same dir + basename, `.opus` extension). On any
 * ffmpeg failure the original is left untouched and the call throws.
 *
 * Integrity (same contract as the streaming transcode in `./transcode.ts`):
 *   - `-xerror` + `+discardcorrupt` so a damaged source fails fast
 *   - post-write ffprobe vs music-metadata source duration; an obviously
 *     truncated output is rejected without renaming, so the library never
 *     ingests a too-short file. This file ends up IN the library (not just
 *     in a cache) so a corrupt short file here is a worse failure mode than
 *     the streaming equivalent — the user can't tell a single track in the
 *     library is short without playing it.
 */
export function transcodeToOpus(absPath: string, bitRate = 128): Promise<string> {
  const ext = extname(absPath);
  const base = ext ? absPath.slice(0, -ext.length) : absPath;
  const destPath = `${base}.opus`;
  // Distinct temp name so an interrupted run never half-writes the destination
  // (which may equal absPath only if the source were already .opus — excluded).
  const tmpPath = `${base}.nicotind-transcode.opus`;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-fflags',
    '+discardcorrupt',
    '-err_detect',
    'explode',
    '-xerror',
    '-i',
    absPath,
    '-vn',
    '-map_metadata',
    '0',
    '-c:a',
    'libopus',
    '-b:a',
    `${bitRate}k`,
    '-f',
    'ogg',
    tmpPath,
  ];
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(ffmpegBinary(), args, { stdio: 'ignore' });
    proc.on('error', (err) => {
      cleanup(tmpPath);
      reject(err);
    });
    proc.on('close', async (code) => {
      if (code !== 0) {
        cleanup(tmpPath);
        reject(new Error(`ffmpeg exited with code ${code} transcoding ${absPath}`));
        return;
      }
      // Exit 0 isn't enough — ffmpeg can succeed on a truncated source and
      // produce a valid-but-short Opus file that the browser will play for
      // 1-2 s then "end". Validate before swapping the library file.
      try {
        const ok = await validateOpusOutput(absPath, tmpPath);
        if (!ok) {
          cleanup(tmpPath);
          reject(
            new Error(
              `Opus output failed duration check: source ${absPath} produced suspiciously short output at ${tmpPath}`,
            ),
          );
          return;
        }
      } catch (err) {
        // Best-effort: a missing probe is a no-op pass (the strict flags above
        // already turn obvious damage into a non-zero exit).
        log.debug({ err, absPath }, 'post-download transcode output duration probe skipped');
      }
      try {
        // Promote temp → final, then drop the original. If dest === source path
        // (impossible here since ext changed) we'd skip the unlink.
        renameSync(tmpPath, destPath);
        if (absPath !== destPath) rmSync(absPath, { force: true });
        log.debug({ from: absPath, to: destPath, bitRate }, 'transcoded lossless → opus');
        resolve(destPath);
      } catch (err) {
        cleanup(tmpPath);
        reject(err as Error);
      }
    });
  });
}

/**
 * Source/output duration comparison for the ingest-time Opus transcode. The
 * streaming helper (`validateTranscodeOutput` in `./transcode.ts`) does the
 * same job but imports `music-metadata` dynamically; we re-implement the
 * probe call here to avoid a circular import.
 */
async function validateOpusOutput(sourcePath: string, outputPath: string): Promise<boolean> {
  if (!ffmpegAvailable()) return true; // ffmpeg missing → strict flags also off, trust the exit
  const [src, out] = await Promise.all([
    readSourceDurationSec(sourcePath),
    readOutputDurationSec(outputPath),
  ]);
  return transcodeOutputIsAcceptable(src, out);
}

async function readSourceDurationSec(absPath: string): Promise<number | null> {
  try {
    const mm = await getMusicMetadata();
    if (!mm) return null;
    const meta = await mm.parseFile(absPath, { duration: true, skipCovers: true });
    return meta.format.duration ?? null;
  } catch {
    return null;
  }
}

async function readOutputDurationSec(absPath: string): Promise<number | null> {
  try {
    const ffprobe = ffmpegBinary().replace(/ffmpeg$/, 'ffprobe');
    const out = execFileSync(
      ffprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        absPath,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    )
      .toString()
      .trim();
    const sec = Number(out);
    return Number.isFinite(sec) ? sec : null;
  } catch {
    return null;
  }
}

function cleanup(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}
