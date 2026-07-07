import { spawn } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';
import { extname } from 'node:path';
import { createLogger } from '@nicotind/core';
import { isLossless } from './library-track-select.js';
import { getMusicMetadata } from './music-metadata-loader.js';

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
    const proc = spawn('ffmpeg', args, { stdio: 'ignore' });
    proc.on('error', (err) => {
      cleanup(tmpPath);
      reject(err);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        cleanup(tmpPath);
        reject(new Error(`ffmpeg exited with code ${code} transcoding ${absPath}`));
        return;
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

function cleanup(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}
