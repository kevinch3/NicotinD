import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createLogger } from '@nicotind/core';

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

export interface AcquireProgress {
  done: number;
  total: number;
}

/** Cached binary availability check results (keyed by binary path). */
const binaryCache = new Map<string, boolean>();

export function isBinaryAvailable(binaryPath: string): boolean {
  if (binaryCache.has(binaryPath)) return binaryCache.get(binaryPath)!;
  try {
    execFileSync(binaryPath, ['--version'], { stdio: 'ignore' });
    binaryCache.set(binaryPath, true);
    return true;
  } catch {
    binaryCache.set(binaryPath, false);
    return false;
  }
}

/** Reset binary availability cache (tests only). */
export function _resetBinaryCache(): void {
  binaryCache.clear();
}

/** Parse yt-dlp's --newline progress output: `[download]  45.2% of ...` */
export function parseYtdlpProgress(line: string, current: AcquireProgress): AcquireProgress {
  const match = /\[download\]\s+([\d.]+)%/.exec(line);
  if (match) {
    const pct = parseFloat(match[1]!);
    if (!Number.isNaN(pct)) return { done: Math.round(pct), total: 100 };
  }
  // Playlist item counter: `[download] Downloading item 3 of 12`
  const itemMatch = /Downloading item (\d+) of (\d+)/.exec(line);
  if (itemMatch) {
    return { done: parseInt(itemMatch[1]!, 10), total: parseInt(itemMatch[2]!, 10) };
  }
  return current;
}

/**
 * Extract a playlist title from a yt-dlp output line, if present.
 * yt-dlp emits: `[download] Downloading playlist: My Playlist Title`
 */
export function parseYtdlpPlaylistTitle(line: string): string | null {
  const m = /\[download\] Downloading playlist:\s+(.+)/.exec(line);
  return m ? m[1]!.trim() : null;
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
  const proc = spawnFn(opts.binaryPath, opts.args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let progress: AcquireProgress = { done: 0, total: 100 };
  let stderrBuf = '';
  let labelEmitted = false;

  const onData = (data: Buffer) => {
    const text = data.toString();
    for (const line of text.split('\n')) {
      progress = parseProgress(line, progress);
      if (!labelEmitted && opts.onLabel) {
        const title = parseYtdlpPlaylistTitle(line);
        if (title) {
          labelEmitted = true;
          opts.onLabel(title);
        }
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
      if (code !== 0) {
        reject(new Error(stderrBuf.slice(-2000) || `process exited with code ${code}`));
        return;
      }
      resolve(collectAudioPaths(opts.stagingDir));
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
