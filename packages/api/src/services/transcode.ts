import { spawn, execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
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

const FORMAT_ARGS: Record<
  Exclude<TranscodeFormat, 'original'>,
  { args: (kbps: number) => string[]; contentType: string }
> = {
  mp3: {
    args: (k) => ['-c:a', 'libmp3lame', '-b:a', `${k}k`, '-f', 'mp3'],
    contentType: 'audio/mpeg',
  },
  opus: {
    args: (k) => ['-c:a', 'libopus', '-b:a', `${k}k`, '-f', 'ogg'],
    contentType: 'audio/ogg',
  },
  aac: { args: (k) => ['-c:a', 'aac', '-b:a', `${k}k`, '-f', 'adts'], contentType: 'audio/aac' },
};

export interface TranscodeStream {
  body: ReadableStream<Uint8Array>;
  contentType: string;
}

/**
 * Spawn ffmpeg to transcode a file on the fly, streaming stdout. No seeking /
 * range support — transcoded streams are sequential. Returns a web
 * ReadableStream suitable for a Hono Response.
 */
export function transcodeFile(
  absPath: string,
  format: Exclude<TranscodeFormat, 'original'>,
  kbps: number,
): TranscodeStream {
  const spec = FORMAT_ARGS[format];
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    absPath,
    '-vn',
    ...spec.args(kbps),
    'pipe:1',
  ];
  const proc = spawn('ffmpeg', args);
  proc.on('error', (err) => log.error({ err, absPath }, 'ffmpeg spawn failed'));
  proc.stderr.on('data', (d: Buffer) => log.debug({ msg: d.toString() }, 'ffmpeg'));
  // Node Readable (stdout) → web ReadableStream for the Response body.
  const body = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
  return { body, contentType: spec.contentType };
}
