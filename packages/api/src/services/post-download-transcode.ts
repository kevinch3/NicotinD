import { spawn } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';
import { extname } from 'node:path';
import { createLogger } from '@nicotind/core';
import { isLossless } from './library-track-select.js';

const log = createLogger('post-download-transcode');

export { isLossless };

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
