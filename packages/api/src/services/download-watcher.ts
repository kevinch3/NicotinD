import { createLogger } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import { basename, join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import type { CompletedDownloadFile } from './path-inference.js';
import { LibraryOrganizer } from './library-organizer.js';
import { AcoustIdLookup } from './acoustid-lookup.js';
import { getDatabase } from '../db.js';
import { normalizeArtistForGrouping, normalizeForGrouping } from './album-grouping.js';

const log = createLogger('download-watcher');

interface DownloadWatcherOptions {
  intervalMs?: number;
  scanDebounceMs?: number;
  musicDir?: string;
  stagingDir?: string;
  acoustidApiKey?: string;
  /** Absolute path for the unsortable-files bucket. Defaults to <musicDir>/Unsorted. */
  unsortedRoot?: string;
  /** Drop an incoming MP3 when a FLAC of the same track is already in the album folder. */
  preferFlacSkipMp3?: boolean;
  /** Pre-built organizer (testing). */
  libraryOrganizer?: { organizeBatch: (files: CompletedDownloadFile[]) => Promise<unknown> };
  /**
   * Native scan hook: called after a batch is organized, with the post-move
   * relative paths. Runs the LibraryScanner incrementally (and curation), so the
   * canonical tables reflect the new files synchronously — no external scanner.
   */
  scan?: (relPaths: string[]) => Promise<void> | void;
}

export class DownloadWatcher {
  private slskd: Slskd;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private knownCompleted = new Set<string>();
  private scanDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private scanDebounceMs: number;
  private musicDir: string | null;
  private libraryOrganizer: {
    organizeBatch: (files: CompletedDownloadFile[]) => Promise<unknown>;
  };
  private checking = false;
  private pendingScanFiles: CompletedDownloadFile[] = [];
  private scan?: (relPaths: string[]) => Promise<void> | void;

  constructor(slskd: Slskd, options: DownloadWatcherOptions = {}) {
    this.slskd = slskd;
    this.intervalMs = options.intervalMs ?? 5_000;
    this.scanDebounceMs = options.scanDebounceMs ?? 10_000;
    this.musicDir = options.musicDir ? this.expandDir(options.musicDir) : null;
    this.libraryOrganizer =
      options.libraryOrganizer ??
      new LibraryOrganizer({
        musicDir: options.musicDir ?? '~/Music',
        stagingDir: options.stagingDir,
        acoustid: options.acoustidApiKey ? new AcoustIdLookup(options.acoustidApiKey) : undefined,
        unsortedRoot: options.unsortedRoot,
        preferFlacSkipMp3: options.preferFlacSkipMp3,
        // Name a hunted album's folder after its Lidarr canonical title so every
        // edition/re-hunt consolidates into one <Artist>/<album> dir.
        jobLookup: (directory) => {
          const db = getDatabase();

          // 1. Exact match on the primary peer directory recorded at hunt time.
          const exact = db
            .query<{ artist_name: string | null; album_title: string | null }, [string]>(
              `SELECT artist_name, album_title FROM album_jobs
               WHERE directory = ? AND album_title IS NOT NULL
               ORDER BY created_at DESC LIMIT 1`,
            )
            .get(directory);
          if (exact) return { artist: exact.artist_name, album: exact.album_title };

          // 2. Fuzzy match for fallback/alternate peer directories. Soulseek peers
          // use their own folder names (e.g. "Kiss Me Once (2014)") which won't
          // match the primary job's directory exactly but should map to the same
          // canonical album so their tracks land in one folder, not a duplicate.
          // Extract probable artist/album from the last two path segments and
          // compare against active jobs after normalizing both sides.
          const segments = directory.replace(/\\/g, '/').split('/').filter(Boolean);
          if (segments.length < 2) return null;
          const candidateAlbum = segments[segments.length - 1]!;
          const candidateArtist = segments[segments.length - 2]!;
          const normAlbum = normalizeForGrouping(candidateAlbum);
          const normArtist = normalizeArtistForGrouping(candidateArtist);

          const activeJobs = db
            .query<{ artist_name: string; album_title: string }, []>(
              `SELECT artist_name, album_title FROM album_jobs
               WHERE state = 'active' AND artist_name IS NOT NULL AND album_title IS NOT NULL
               ORDER BY created_at DESC LIMIT 50`,
            )
            .all();

          for (const job of activeJobs) {
            if (
              normalizeForGrouping(job.album_title) === normAlbum &&
              normalizeArtistForGrouping(job.artist_name) === normArtist
            ) {
              return { artist: job.artist_name, album: job.album_title };
            }
          }

          return null;
        },
      });
    this.scan = options.scan;
  }

  start(): void {
    if (this.timer) return;
    log.info({ intervalMs: this.intervalMs }, 'Starting download watcher');

    // Pre-populate knownCompleted from the DB so a container restart doesn't
    // replay every historical "Completed, Succeeded" transfer through organizeBatch,
    // which would produce hundreds of "Could not locate file on disk" warnings
    // and risk placing fallback files under incorrect album folder names.
    this.seedKnownCompleted();

    this.timer = setInterval(() => this.check(), this.intervalMs);
    // Run immediately on start
    this.check();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.scanDebounceTimer) {
      clearTimeout(this.scanDebounceTimer);
      this.scanDebounceTimer = null;
      if (this.pendingScanFiles.length > 0) {
        const files = this.pendingScanFiles.splice(0);
        void this.runScan(files);
      }
    }
    log.info('Download watcher stopped');
  }

  private seedKnownCompleted(): void {
    try {
      const rows = getDatabase()
        .query<{ transfer_key: string }, []>('SELECT transfer_key FROM completed_downloads')
        .all();
      for (const row of rows) {
        this.knownCompleted.add(row.transfer_key);
      }
      if (rows.length) {
        log.info({ count: rows.length }, 'Seeded known completions from DB');
      }
    } catch {
      // DB may not be ready yet; the watcher will still work correctly, it just
      // won't skip historical transfers on this boot.
    }
  }

  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;

    try {
      const downloads = await this.slskd.transfers.getDownloads();
      let newCompletions = false;
      const completedFiles: CompletedDownloadFile[] = [];

      // Prune keys that slskd no longer tracks so the Set stays bounded
      const currentKeys = new Set<string>();
      for (const group of downloads) {
        for (const dir of group.directories) {
          for (const file of dir.files) {
            const transferId =
              typeof file.id === 'string' && file.id.length > 0
                ? file.id
                : `${dir.directory}:${file.filename}`;
            currentKeys.add(`${group.username}:${transferId}`);
          }
        }
      }
      for (const key of this.knownCompleted) {
        if (!currentKeys.has(key)) this.knownCompleted.delete(key);
      }

      for (const group of downloads) {
        for (const dir of group.directories) {
          for (const file of dir.files) {
            const transferId =
              typeof file.id === 'string' && file.id.length > 0
                ? file.id
                : `${dir.directory}:${file.filename}`;
            const key = `${group.username}:${transferId}`;
            if (file.state === 'Completed, Succeeded' && !this.knownCompleted.has(key)) {
              this.knownCompleted.add(key);
              newCompletions = true;
              const relativePath = this.resolveRelativePath(dir.directory, file.filename);
              const fileData: CompletedDownloadFile = {
                username: group.username,
                directory: dir.directory,
                filename: file.filename,
                relativePath,
                directoryFileCount: dir.fileCount,
              };
              completedFiles.push(fileData);
              this.pendingScanFiles.push(fileData);
              this.recordCompletedDownload(
                key,
                group.username,
                dir.directory,
                file.filename,
                this.parseCompletedAt(file.endedAt),
                relativePath,
              );
              log.info({ username: group.username, filename: file.filename }, 'Download completed');
            }
          }
        }
      }

      if (newCompletions) {
        try {
          const orgResult = (await this.libraryOrganizer.organizeBatch(completedFiles)) as
            | { dedupedBasenames?: string[] }
            | undefined;
          // Drop completed_downloads rows for files auto-dedupe removed from disk,
          // so the canonical tables don't reference vanished duplicates.
          for (const basename of orgResult?.dedupedBasenames ?? []) {
            getDatabase().run('DELETE FROM completed_downloads WHERE basename = ?', [basename]);
          }
        } catch (err) {
          log.warn({ err }, 'Library organization step failed');
        }
        // organizeBatch mutates file.relativePath to the post-move path; persist
        // so the scan and back-fill see the final on-disk location.
        for (const file of completedFiles) {
          if (file.relativePath) {
            this.updateRelativePath(
              file.username,
              file.directory,
              file.filename,
              file.relativePath,
            );
          }
        }
        this.debouncedScan();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('Unable to connect') || msg.includes('ConnectionRefused')) {
        log.debug('slskd not reachable, skipping download check');
      } else {
        log.error({ err }, 'Error checking downloads');
      }
    } finally {
      this.checking = false;
    }
  }

  private debouncedScan(): void {
    if (this.scanDebounceTimer) {
      clearTimeout(this.scanDebounceTimer);
    }

    this.scanDebounceTimer = setTimeout(async () => {
      const filesToProcess = this.pendingScanFiles.splice(0);
      await this.runScan(filesToProcess);
    }, this.scanDebounceMs);
  }

  /** Index a freshly-organized batch into the canonical library tables. */
  private async runScan(files: CompletedDownloadFile[]): Promise<void> {
    if (!this.scan) return;
    const relPaths = files.map((f) => f.relativePath).filter((p): p is string => Boolean(p));
    if (relPaths.length === 0) return;
    try {
      log.info({ count: relPaths.length }, 'Scanning newly organized files into library');
      await this.scan(relPaths);
    } catch (err) {
      log.error({ err }, 'Library scan after download failed');
    }
  }

  private parseCompletedAt(endedAt?: string): number {
    if (!endedAt) return Date.now();
    const parsed = Date.parse(endedAt);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  private recordCompletedDownload(
    transferKey: string,
    username: string,
    directory: string,
    filename: string,
    completedAt: number,
    relativePath: string | null,
  ): void {
    try {
      const db = getDatabase();
      const fileBasename = basename(filename.replace(/\\/g, '/')).toLowerCase();

      db.run(
        `INSERT OR IGNORE INTO completed_downloads
          (transfer_key, username, directory, filename, relative_path, basename, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [transferKey, username, directory, filename, relativePath, fileBasename, completedAt],
      );
    } catch {
      log.warn('recordCompletedDownload: DB not ready or write failed');
    }
  }

  private updateRelativePath(
    username: string,
    directory: string,
    filename: string,
    relativePath: string,
  ): void {
    try {
      getDatabase().run(
        `UPDATE completed_downloads SET relative_path = ?
         WHERE username = ? AND directory = ? AND filename = ?`,
        [relativePath, username, directory, filename],
      );
    } catch {
      // Non-fatal: DB may not be available
    }
  }

  private resolveRelativePath(directory: string, filename: string): string | null {
    if (!this.musicDir) return null;

    const normalizedFilename = filename.replace(/\\/g, '/');
    const normalizedDirectory = directory.replace(/\\/g, '/');
    const filenameParts = normalizedFilename.split('/').filter(Boolean);
    const directoryParts = normalizedDirectory.split('/').filter(Boolean);
    const baseName = filenameParts[filenameParts.length - 1] ?? basename(normalizedFilename);

    // slskd uses only the leaf segment of the remote path as the local folder name
    const leafDirectory = directoryParts[directoryParts.length - 1];

    const candidates = [
      join(this.musicDir, ...filenameParts),
      join(this.musicDir, ...directoryParts, baseName),
      ...(leafDirectory ? [join(this.musicDir, leafDirectory, baseName)] : []),
      join(this.musicDir, baseName),
    ];

    if (this.isAbsolutePath(normalizedFilename)) {
      candidates.unshift(normalizedFilename);
    }

    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;

      const relPath = relative(this.musicDir, candidate).replace(/\\/g, '/');
      if (!relPath || relPath.startsWith('../') || relPath === '..') continue;
      return relPath;
    }

    return null;
  }

  private expandDir(dir: string): string {
    if (dir.startsWith('~')) {
      return join(process.env.HOME ?? '/root', dir.slice(1));
    }
    return dir;
  }

  private isAbsolutePath(p: string): boolean {
    return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
  }
}
