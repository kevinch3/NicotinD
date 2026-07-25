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
 *
 * Integrity checks beyond `exit 0`:
 *   - `-xerror` and `-fflags +discardcorrupt` so ffmpeg fails fast on a
 *     damaged/truncated source rather than silently producing a partial output
 *   - a post-write ffprobe of the temp file compared against the source
 *     duration; a "successful" output shorter than the source (within tolerance)
 *     is rejected. This is the defense against the "track plays 1-2 s, then
 *     the seek bar hits 100 % and the queue advances" bug — the browser was
 *     receiving a syntactically-valid but too-short media file and treating
 *     it as the full track.
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
      '-fflags',
      '+discardcorrupt',
      '-err_detect',
      'explode',
      '-xerror',
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
    proc.on('close', async (code) => {
      if (code !== 0) {
        cleanupTmp(tmp);
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      // ffmpeg exited 0, but that's not a proof of completeness. Validate the
      // output's duration against the source so a truncated source can never
      // yield a too-short (but valid-container) cache entry. The check is
      // best-effort: a missing ffprobe / unreadable source duration skips it
      // rather than failing the transcode (the `+discardcorrupt`/`-xerror`
      // flags above already turn obvious damage into a non-zero exit).
      try {
        const ok = await validateTranscodeOutput(absPath, tmp);
        if (!ok) {
          cleanupTmp(tmp);
          reject(
            new Error(
              `transcode output failed duration check: source ${absPath} produced suspiciously short output at ${tmp}`,
            ),
          );
          return;
        }
      } catch (err) {
        // Probe failure (no ffprobe, unreadable file, etc.) — log but do not
        // fail the transcode. ffmpeg's exit 0 + the strict flags are usually
        // enough to trust the file.
        log.debug({ err, absPath }, 'transcode output duration probe skipped');
      }
      try {
        renameSync(tmp, outPath);
        resolve();
      } catch (err) {
        cleanupTmp(tmp);
        reject(err as Error);
      }
    });
  });
}

/**
 * Source/output duration comparison. Returns `true` when the output is
 * acceptably complete (>= source minus tolerance), `false` when it is
 * suspiciously short and the cache entry should be discarded. Any error
 * (probe missing, source unreadable) resolves to `true` so we don't fail
 * healthy transcodes on a transient probe problem.
 *
 * Tolerance: 1.0 s. This absorbs tiny CBR/VBR framing drift between
 * libmp3lame / libopus / aac and music-metadata's duration parse, while
 * still flagging the "plays 1-2 s" failure (a 1.8 s output for a 240 s
 * source is 238 s short, way outside the tolerance).
 */
export const TRANSCODE_DURATION_TOLERANCE_SEC = 1.0;

export function transcodeOutputIsAcceptable(
  sourceSec: number | null,
  outputSec: number | null,
): boolean {
  if (sourceSec == null || outputSec == null) return true; // best-effort
  if (!Number.isFinite(outputSec) || outputSec <= 0) return false;
  return outputSec >= sourceSec - TRANSCODE_DURATION_TOLERANCE_SEC;
}

export async function validateTranscodeOutput(
  sourcePath: string,
  outputPath: string,
): Promise<boolean> {
  const [src, out] = await Promise.all([
    readSourceDurationSec(sourcePath),
    readOutputDurationSec(outputPath),
  ]);
  return transcodeOutputIsAcceptable(src, out);
}

async function readSourceDurationSec(absPath: string): Promise<number | null> {
  try {
    const { getMusicMetadata } = await import('./music-metadata-loader.js');
    const mm = await getMusicMetadata();
    if (!mm) return null;
    const meta = await mm.parseFile(absPath, { duration: true, skipCovers: true });
    return meta.format.duration ?? null;
  } catch {
    return null;
  }
}

async function readOutputDurationSec(absPath: string): Promise<number | null> {
  if (!ffmpegPresent) return null;
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
