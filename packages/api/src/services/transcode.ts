import { spawn, execFileSync } from 'node:child_process';
import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { createLogger } from '@nicotind/core';
import type { TranscodeFormat } from './streaming-settings.js';
import { ffmpegBinary } from './ffmpeg-path.js';

const log = createLogger('transcode');

let ffmpegChecked = false;
let ffmpegPresent = false;

/** Whether an `ffmpeg` binary is on PATH. Cached after first probe. */
export function ffmpegAvailable(): boolean {
  if (ffmpegChecked) return ffmpegPresent;
  ffmpegChecked = true;
  try {
    execFileSync(ffmpegBinary(), ['-version'], { stdio: 'ignore' });
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
    const proc = spawn(ffmpegBinary(), args);
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

/**
 * Probe an audio file's bitrate (kbps) + codec via ffprobe. Used by
 * AcquireWatcher to fill the `· 320 kbps` chip on URL-acquire download cards
 * (see docs/download-pipeline.md → "Bitrate on download cards"). The probe
 * runs AFTER LibraryOrganizer's lossless→opus transcode, so the returned
 * values reflect what landed in the library (a downloaded FLAC shows as
 * 192 kbps Opus when transcoding is enabled, not the source bitrate).
 *
 * Returns `null` when:
 *   - ffmpeg/ffprobe is not on PATH (the rest of the pipeline gates on this);
 *   - the file is missing or not decodable (ffprobe exits non-zero).
 *
 * ffprobe is invoked via the same `ffmpegBinary()` helper `transcodeToFile`
 * uses, so a desktop-packaged ffmpeg is found too.
 *
 * Exported separately from `transcodeToFile` so the watcher can probe without
 * paying the cost of an actual transcode pass — only the first audio stream's
 * bit_rate + codec_name are read, no decode.
 */
export interface ProbeResult {
  bitRateKbps: number;
  /** Lowercase codec name reported by ffprobe (mp3, opus, flac, vorbis, aac). */
  codec: string;
}

export function probeAudioFile(absPath: string): ProbeResult | null {
  if (!ffmpegChecked) {
    ffmpegAvailable();
  }
  if (!ffmpegPresent) return null;
  try {
    // `ffprobe` ships with the same ffmpeg distribution we use for transcoding.
    const ffprobe = ffmpegBinary().replace(/ffmpeg$/, 'ffprobe');
    const out = execFileSync(
      ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=bit_rate,codec_name',
        '-of',
        'default=noprint_wrappers=1',
        absPath,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    )
      .toString()
      .trim();
    if (!out) return null;
    let bitRate: number | null = null;
    let codec: string | null = null;
    for (const line of out.split('\n')) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === 'bit_rate' && value && value !== 'N/A') {
        const parsed = parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) bitRate = Math.round(parsed / 1000);
      } else if (key === 'codec_name' && value) {
        codec = value.toLowerCase();
      }
    }
    if (bitRate == null || codec == null) return null;
    return { bitRateKbps: bitRate, codec };
  } catch {
    return null;
  }
}
