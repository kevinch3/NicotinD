import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { CompletedDownloadFile } from './path-inference.js';

const log = createLogger('ytdlp');

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma', '.alac', '.aiff', '.aif', '.ape',
  '.webm', // yt-dlp with bestaudio produces webm (opus in a WebM container)
]);

export interface AcquireJobProgress {
  done: number;
  total: number;
}

export type AcquireBackend = 'ytdlp' | 'spotdl';

export interface YtdlpConfig {
  /** When false the feature is off even if the binary is installed. */
  enabled: boolean;
  binaryPath: string;
  format: 'mp3' | 'opus' | 'bestaudio';
  extraArgs: string[];
}

export interface SpotdlConfig {
  /** When false the feature is off even if the binary is installed. */
  enabled: boolean;
  binaryPath: string;
}

export interface YtdlpServiceOptions {
  stagingBase: string;
  db: Database;
  ytdlp: YtdlpConfig;
  spotdl: SpotdlConfig;
  onComplete: (jobId: string, files: CompletedDownloadFile[]) => Promise<void>;
  onFailed: (jobId: string, error: string) => void;
  // Injectable process spawner. Defaults to node:child_process spawn; tests pass
  // a fake so they don't need a process-global `mock.module('node:child_process')`
  // (which would leak into other concurrently-running test files).
  spawn?: typeof spawn;
}

/** Cached availability check results. */
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

/**
 * Walk a directory tree and collect audio files as CompletedDownloadFile objects.
 * The `directory` field is set to the immediate parent folder name so that
 * LibraryOrganizer can infer artist/album from the yt-dlp output template path.
 */
function collectAudioFiles(stagingDir: string, jobId: string): CompletedDownloadFile[] {
  const files: CompletedDownloadFile[] = [];
  const walkDir = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try { stat = statSync(fullPath); } catch { continue; }
      if (stat.isDirectory()) {
        walkDir(fullPath);
      } else if (AUDIO_EXTENSIONS.has(extname(entry).toLowerCase())) {
        // Use path relative to stagingDir as the "directory" so LibraryOrganizer
        // sees a structured path it can parse for artist/album.
        const relativeDir = relative(stagingDir, dir);
        files.push({
          username: `acquire:${jobId}`,
          directory: relativeDir || '.',
          filename: fullPath,
        });
      }
    }
  };
  walkDir(stagingDir);
  return files;
}

/** Parse yt-dlp's --newline progress output: `[download]  45.2% of ...` */
function parseYtdlpProgress(line: string, current: AcquireJobProgress): AcquireJobProgress {
  const match = /\[download\]\s+([\d.]+)%/.exec(line);
  if (match) {
    const pct = parseFloat(match[1]!);
    if (!Number.isNaN(pct)) {
      return { done: Math.round(pct), total: 100 };
    }
  }
  // Playlist item counter: `[download] Downloading item 3 of 12`
  const itemMatch = /Downloading item (\d+) of (\d+)/.exec(line);
  if (itemMatch) {
    return { done: parseInt(itemMatch[1]!, 10), total: parseInt(itemMatch[2]!, 10) };
  }
  return current;
}

export class YtdlpService {
  private options: YtdlpServiceOptions;
  private activeProcs = new Map<string, ReturnType<typeof spawn>>();

  constructor(options: YtdlpServiceOptions) {
    this.options = options;
  }

  /**
   * Start a download job. Updates acquire_jobs state in the DB as the process
   * runs. Calls onComplete/onFailed when done.
   */
  async run(jobId: string, backend: AcquireBackend, url: string): Promise<void> {
    const stagingDir = join(this.options.stagingBase, jobId);
    mkdirSync(stagingDir, { recursive: true });

    this.updateState(jobId, 'running');

    const args = this.buildArgs(backend, url, stagingDir);
    const binaryPath = backend === 'ytdlp'
      ? this.options.ytdlp.binaryPath
      : this.options.spotdl.binaryPath;

    log.info({ jobId, backend, url }, 'Starting acquire job');

    const spawnFn = this.options.spawn ?? spawn;
    const proc = spawnFn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.activeProcs.set(jobId, proc);

    let progress: AcquireJobProgress = { done: 0, total: 100 };
    let stderrBuf = '';

    const onData = (data: Buffer) => {
      const text = data.toString();
      if (backend === 'ytdlp') {
        for (const line of text.split('\n')) {
          progress = parseYtdlpProgress(line, progress);
        }
        this.updateProgress(jobId, progress);
      }
      stderrBuf += text;
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      log.error({ jobId, err }, 'Acquire process error');
      this.activeProcs.delete(jobId);
      this.updateState(jobId, 'failed', err.message);
      this.options.onFailed(jobId, err.message);
    });

    proc.on('close', async (code) => {
      this.activeProcs.delete(jobId);
      if (code !== 0) {
        const msg = stderrBuf.slice(-2000);
        log.warn({ jobId, code }, 'Acquire process exited with non-zero code');
        this.updateState(jobId, 'failed', msg);
        this.options.onFailed(jobId, msg);
        return;
      }

      const completedFiles = collectAudioFiles(stagingDir, jobId);
      log.info({ jobId, fileCount: completedFiles.length }, 'Acquire job completed');

      this.updateState(jobId, 'done');

      try {
        await this.options.onComplete(jobId, completedFiles);
      } catch (err) {
        log.error({ jobId, err }, 'Post-acquire organize/scan failed');
      }

      // Clean up the staging dir after organize has moved the files.
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // Non-fatal; files have already been moved.
      }
    });
  }

  /** Send SIGTERM to a running job. */
  cancel(jobId: string): boolean {
    const proc = this.activeProcs.get(jobId);
    if (!proc) return false;
    proc.kill('SIGTERM');
    return true;
  }

  private buildArgs(backend: AcquireBackend, url: string, stagingDir: string): string[] {
    if (backend === 'spotdl') {
      // spotdl download <url> --output <dir>/%(artist)s/%(album)s/%(title)s.%(ext)s
      return [
        'download',
        url,
        '--output',
        join(stagingDir, '{artist}', '{album}', '{title}.{output-ext}'),
      ];
    }

    // yt-dlp
    const { format, extraArgs } = this.options.ytdlp;
    const outputTemplate = join(stagingDir, '%(artist)s', '%(album)s', '%(title)s.%(ext)s');

    const args = [
      url,
      '--extract-audio',
      '--audio-quality', '0',
      // Parse "Artist - Title" pattern from the video title. For most music
      // videos the title is the canonical "Artist - Track" string while
      // %(artist)s defaults to the channel/uploader name. When the title
      // contains no " - " this flag is a no-op, so it's always safe to pass.
      '--parse-metadata', 'title:%(artist)s - %(title)s',
      // Strip trailing "(Official Video)", "[HD]", etc. that yt-dlp carries
      // through from the video title into the track title after parsing.
      '--replace-in-metadata', 'title',
      '\\s*[\\(\\[](?:Official|Music|Lyric|HD|HQ|Video|Audio|Live|MV|PV|Clip|Full|Visualizer|ft\\.?|feat\\.?).*?[\\)\\]]\\s*$',
      '',
      '--embed-metadata',
      '--embed-thumbnail',
      '--output', outputTemplate,
      '--newline',
      '--no-warnings',
    ];

    if (format !== 'bestaudio') {
      args.push('--audio-format', format);
    }

    return [...args, ...extraArgs];
  }

  private updateState(jobId: string, state: string, error?: string): void {
    try {
      this.options.db.run(
        `UPDATE acquire_jobs SET state = ?, error = ? WHERE id = ?`,
        [state, error ?? null, jobId],
      );
    } catch (err) {
      log.warn({ jobId, err }, 'Failed to update acquire_jobs state');
    }
  }

  private updateProgress(jobId: string, progress: AcquireJobProgress): void {
    try {
      this.options.db.run(
        `UPDATE acquire_jobs SET progress = ? WHERE id = ?`,
        [JSON.stringify(progress), jobId],
      );
    } catch {
      // Non-fatal; progress is best-effort.
    }
  }
}
