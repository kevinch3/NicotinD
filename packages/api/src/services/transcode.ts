import { spawn, execFileSync } from 'node:child_process';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { createLogger } from '@nicotind/core';
import type { TranscodeFormat } from './streaming-settings.js';

const log = createLogger('transcode');

let ffmpegChecked = false;
let ffmpegPresent = false;

/** Whether an `ffmpeg` binary is on PATH. Cached after first probe. */
export function ffmpegAvailable(): boolean {
  if (ffmpegChecked) return ffmpegPresent;
  ffmpegChecked = true;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    ffmpegPresent = true;
  } catch {
    ffmpegPresent = false;
    log.warn('ffmpeg not found on PATH — transcoding disabled, serving original files');
  }
  return ffmpegPresent;
}

/** Reset the cached probe (tests only). */
export function _resetFfmpegProbe(): void {
  ffmpegChecked = false;
  ffmpegPresent = false;
}

export type TranscodeFmt = Exclude<TranscodeFormat, 'original'>;

const FORMAT_ARGS: Record<
  TranscodeFmt,
  { args: (kbps: number) => string[]; contentType: string; ext: string }
> = {
  mp3: {
    args: (k) => ['-c:a', 'libmp3lame', '-b:a', `${k}k`, '-f', 'mp3'],
    contentType: 'audio/mpeg',
    ext: 'mp3',
  },
  opus: {
    args: (k) => ['-c:a', 'libopus', '-b:a', `${k}k`, '-f', 'ogg'],
    contentType: 'audio/ogg',
    ext: 'opus',
  },
  aac: {
    args: (k) => ['-c:a', 'aac', '-b:a', `${k}k`, '-f', 'adts'],
    contentType: 'audio/aac',
    ext: 'aac',
  },
};

/** File extension for a transcoded copy of a given format (drives the cache filename). */
export function transcodeExt(format: TranscodeFmt): string {
  return FORMAT_ARGS[format].ext;
}

/** Content-Type to advertise for a transcoded stream (Bun's by-extension sniff is unreliable for `.aac`). */
export function transcodeContentType(format: TranscodeFmt): string {
  return FORMAT_ARGS[format].contentType;
}

/**
 * Karaoke / vocal-mute filter: center-channel cancellation. Each output channel
 * becomes the L−R difference, so anything mixed dead-center (typically the lead
 * vocal) cancels while stereo-panned instruments survive. Deterministic and
 * dependency-free — imperfect (reverb/backing vocals leak; a mono downmix
 * collapses toward silence) but this is the intended vocal-mute behaviour that
 * was never actually wired into the transcode args.
 */
const VOCAL_REMOVAL_FILTER = 'pan=stereo|c0=c0-c1|c1=c1-c0';

/**
 * Transcode the whole file to `outPath` and return only once it's complete.
 * Writes to a sibling temp file then atomically renames, so a reader never sees
 * a half-written cache entry. The on-disk file enables HTTP **range** support,
 * which is what makes seeking work on transcoded streams. Pass `vocalRemoval`
 * to apply the center-channel cancellation filter (karaoke / `?vocals=off`).
 */
export function transcodeToFile(
  absPath: string,
  outPath: string,
  format: TranscodeFmt,
  kbps: number,
  vocalRemoval = false,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const spec = FORMAT_ARGS[format];
    const tmp = `${outPath}.tmp-${process.pid}-${Date.now()}`;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      absPath,
      '-vn',
      ...(vocalRemoval ? ['-af', VOCAL_REMOVAL_FILTER] : []),
      ...spec.args(kbps),
      tmp,
    ];
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      cleanupTmp(tmp);
      reject(err);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        try {
          renameSync(tmp, outPath);
          resolve();
        } catch (err) {
          cleanupTmp(tmp);
          reject(err as Error);
        }
      } else {
        cleanupTmp(tmp);
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

function cleanupTmp(tmp: string): void {
  try {
    if (existsSync(tmp)) unlinkSync(tmp);
  } catch {
    /* best-effort */
  }
}
