import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import {
  createLogger,
  parseSpotdlPlaylistTitle,
  parseSpotdlTrackEvent,
  parseYtdlpPlaylistTitle,
  parseYtdlpProgress,
  parseYtdlpTrackEvent,
  type AcquireProgress,
  type DownloaderTrackEvent,
} from '@nicotind/core';

const log = createLogger('acquire-process');

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
  '.alac',
  '.aiff',
  '.aif',
  '.ape',
  '.webm', // yt-dlp with bestaudio produces webm (opus in a WebM container)
]);

/**
 * The downloader-stdout parsers moved to **@nicotind/addon-sdk**
 * (`downloader-output.ts`): only an addon spawns yt-dlp or spotDL now, so only
 * an addon can see the stream they parse. Re-exported here so core's existing
 * callers and tests resolve unchanged — the same one-directional
 * core → addon-sdk shim the rest of the phase-4 split uses.
 */
export type { AcquireProgress, DownloaderTrackEvent, DownloaderTrackStatus } from '@nicotind/core';
/**
 * Local alias so this file's own option types keep their historical name
 * without resolving to the DOM's `TrackEvent` global (see the SDK's note).
 */
type TrackEvent = DownloaderTrackEvent;

export {
  parseSpotdlPlaylistTitle,
  parseSpotdlProgress,
  parseSpotdlTrackEvent,
  parseYtdlpPlaylistTitle,
  parseYtdlpProgress,
  parseYtdlpTrackEvent,
} from '@nicotind/core';

/**
 * Environment for probing/spawning the external downloaders. A GUI-launched
 * desktop app (Electron) inherits a minimal PATH — macOS apps get
 * `/usr/bin:/bin:...` without `/opt/homebrew/bin`, and Linux launchers often
 * miss `~/.local/bin` — exactly where brew/pip put yt-dlp and spotdl. The
 * bundled ffmpeg's dir goes FIRST so the downloaders' own ffmpeg lookup finds
 * it even when no system ffmpeg exists.
 */
export function acquireEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const existing = (base.PATH ?? '').split(':').filter(Boolean);
  const prepend: string[] = [];
  const ffmpeg = base.NICOTIND_FFMPEG_PATH?.trim();
  if (ffmpeg) prepend.push(dirname(ffmpeg));
  prepend.push('/opt/homebrew/bin', '/usr/local/bin');
  if (base.HOME) prepend.push(join(base.HOME, '.local/bin'));
  const missing = prepend.filter((dir) => !existing.includes(dir));
  return { ...base, PATH: [...missing, ...existing].join(':') };
}

/** Cached binary availability check results (keyed by binary path). */
const binaryCache = new Map<string, boolean>();

export function isBinaryAvailable(
  binaryPath: string,
  probeArgs: string[] = ['--version'],
  exec: typeof execFileSync = execFileSync,
): boolean {
  if (binaryCache.has(binaryPath)) return binaryCache.get(binaryPath)!;
  try {
    exec(binaryPath, probeArgs, { stdio: 'ignore', env: acquireEnv() });
    binaryCache.set(binaryPath, true);
    return true;
  } catch {
    binaryCache.set(binaryPath, false);
    return false;
  }
}

/**
 * Drop a cached availability result. Called when a plugin (re)initializes so
 * a binary installed or a path reconfigured while the app runs is re-probed
 * instead of staying "unavailable" for the process lifetime.
 */
export function invalidateBinaryCache(binaryPath?: string): void {
  if (binaryPath === undefined) binaryCache.clear();
  else binaryCache.delete(binaryPath);
}

/** Reset binary availability cache (tests only). */
export function _resetBinaryCache(): void {
  binaryCache.clear();
}

/** Walk a directory tree and collect absolute paths of audio files. */
export function collectAudioPaths(stagingDir: string): string[] {
  const paths: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(fullPath);
      else if (AUDIO_EXTENSIONS.has(extname(entry).toLowerCase())) paths.push(fullPath);
    }
  };
  walk(stagingDir);
  return paths;
}

export interface RunAcquireOptions {
  binaryPath: string;
  args: string[];
  stagingDir: string;
  /** Translate a line of process output into progress (defaults to yt-dlp parser). */
  parseProgress?: (line: string, current: AcquireProgress) => AcquireProgress;
  onProgress?: (progress: AcquireProgress) => void;
  /** Called at most once when a playlist title is detected in output. */
  onLabel?: (label: string) => void;
  /**
   * Called once per track-status transition detected in output (NOT
   * single-shot, unlike `onLabel` — fires many times over a job's life as
   * spotdl/yt-dlp report each track starting, finishing, or being skipped).
   */
  /**
   * Fires once per parsed track-event line, with the FULL event — `path`
   * included when the marker carried one. Callers must forward the whole
   * event to `emitTrack`; dropping `path` at this seam disables playlist
   * materialization downstream (the acquire_job_tracks insert needs it).
   */
  onTrack?: (event: TrackEvent) => void;
  /**
   * Extra env-var layer to merge into the spawn env. Used by spotDL to
   * forward SPOTIPY_CLIENT_ID / SPOTIPY_CLIENT_SECRET (from the spotify
   * plugin's stored config) so its Spotify metadata calls use the user's
   * own rate limits. Undefined → only `acquireEnv()` augmentation applies.
   */
  extraEnv?: NodeJS.ProcessEnv;
  /** Injectable spawner (tests pass a fake to avoid process-global module mocks). */
  spawn?: typeof spawn;
}

export interface RunningAcquire {
  /** Resolves with the absolute paths of staged audio files; rejects on failure. */
  done: Promise<string[]>;
  /** Send SIGTERM. Returns true if a process was signalled. */
  cancel: () => boolean;
}

/**
 * Spawn an external downloader (yt-dlp / spotdl), stream its output into the
 * progress callback, and on success collect the audio files it produced under
 * `stagingDir`. This is the shared engine the resolve-capable plugins use; it
 * holds no job/DB/ingest state — that belongs to the host (AcquireWatcher).
 */
export function runAcquireProcess(opts: RunAcquireOptions): RunningAcquire {
  const spawnFn = opts.spawn ?? spawn;
  const parseProgress = opts.parseProgress ?? parseYtdlpProgress;
  // Build the env in layers: PATH augmentation first (acquireEnv), then any
  // plugin-supplied extras on top (Spotify creds, …). The last write of a
  // given key wins, matching POSIX `env -e` semantics.
  const env = opts.extraEnv ? { ...acquireEnv(), ...opts.extraEnv } : acquireEnv();
  const proc = spawnFn(opts.binaryPath, opts.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  let progress: AcquireProgress = { done: 0, total: 100 };
  let stderrBuf = '';
  let labelEmitted = false;
  // yt-dlp's actual failure reasons are `ERROR:` lines that get buried under
  // pages of download-progress output; keep them so the stored error is the
  // real cause, not a truncated progress tail.
  const errorLines: string[] = [];

  const onData = (data: Buffer) => {
    const text = data.toString();
    for (const line of text.split('\n')) {
      progress = parseProgress(line, progress);
      if (line.startsWith('ERROR:')) errorLines.push(line.trim());
      if (!labelEmitted && opts.onLabel) {
        const title = parseYtdlpPlaylistTitle(line) ?? parseSpotdlPlaylistTitle(line);
        if (title) {
          labelEmitted = true;
          opts.onLabel(title);
        }
      }
      if (opts.onTrack) {
        // Not single-shot — every matching line fires a callback, unlike
        // the label above.
        const event = parseSpotdlTrackEvent(line) ?? parseYtdlpTrackEvent(line);
        if (event) opts.onTrack(event);
      }
    }
    opts.onProgress?.(progress);
    stderrBuf += text;
  };

  const done = new Promise<string[]>((resolve, reject) => {
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (err) => {
      log.error({ err, binary: opts.binaryPath }, 'Acquire process error');
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    proc.on('close', (code) => {
      // yt-dlp exits non-zero when ANY playlist item failed — even with
      // --ignore-errors, and even after successfully downloading every other
      // item. So the exit code alone can't decide success: if audio files
      // landed, it's a (partial) success worth ingesting. Only a run that
      // produced nothing AND exited non-zero is a real failure.
      const paths = collectAudioPaths(opts.stagingDir);
      if (paths.length === 0 && code !== 0) {
        const detail = errorLines.length
          ? errorLines.slice(-5).join('\n')
          : stderrBuf.slice(-2000) || `process exited with code ${code}`;
        reject(new Error(detail));
        return;
      }
      resolve(paths);
    });
  });

  return {
    done,
    cancel: () => {
      proc.kill('SIGTERM');
      return true;
    },
  };
}
