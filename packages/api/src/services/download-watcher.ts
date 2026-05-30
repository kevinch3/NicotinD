import { createLogger } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { Navidrome } from '@nicotind/navidrome-client';
import { basename, join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import type { CompletedDownloadFile } from './path-inference.js';
import { AutoPlaylistService } from './auto-playlist.service.js';
import { LibraryOrganizer } from './library-organizer.js';
import { AcoustIdLookup } from './acoustid-lookup.js';
import { getDatabase } from '../db.js';

const log = createLogger('download-watcher');

interface DownloadWatcherOptions {
  intervalMs?: number;
  scanDebounceMs?: number;
  musicDir?: string;
  stagingDir?: string;
  acoustidApiKey?: string;
  /** Absolute path for the unsortable-files bucket. Defaults to <musicDir>/Unsorted (visible to Navidrome). */
  unsortedRoot?: string;
  /** Pre-built organizer (testing). */
  libraryOrganizer?: { organizeBatch: (files: CompletedDownloadFile[]) => Promise<unknown> };
  autoPlaylist?: { processBatch: (files: CompletedDownloadFile[]) => Promise<void> };
  /** Fired after each post-download Navidrome scan; used to drive the canonical-DB sync. */
  onScanComplete?: () => Promise<void> | void;
}

export class DownloadWatcher {
  private slskd: Slskd;
  private navidrome: Navidrome;
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
  private pendingPlaylistFiles: CompletedDownloadFile[] = [];
  private autoPlaylist: {
    processBatch: (files: CompletedDownloadFile[]) => Promise<void>;
    migrateNavidromeIds?: () => Promise<void>;
  };
  private onScanComplete?: () => Promise<void> | void;

  constructor(slskd: Slskd, navidrome: Navidrome, options: DownloadWatcherOptions = {}) {
    this.slskd = slskd;
    this.navidrome = navidrome;
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
      });
    this.autoPlaylist =
      options.autoPlaylist ??
      new AutoPlaylistService(navidrome, this.musicDir ?? '', undefined, getDatabase());
    this.onScanComplete = options.onScanComplete;
  }

  start(): void {
    if (this.timer) return;
    log.info({ intervalMs: this.intervalMs }, 'Starting download watcher');

    this.timer = setInterval(() => this.check(), this.intervalMs);
    // Run immediately on start
    this.check();
    // Startup scan: removes ghost records left by deleted/moved files
    void this.navidrome.system.startScan().catch((err) => {
      log.warn({ err }, 'Startup library scan failed');
    });
    // One-time background migration: back-fill navidrome_id for existing downloads
    void this.autoPlaylist.migrateNavidromeIds?.().catch((err) => {
      log.warn({ err }, 'navidrome_id migration failed');
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.scanDebounceTimer) {
      clearTimeout(this.scanDebounceTimer);
      this.scanDebounceTimer = null;
      if (this.pendingPlaylistFiles.length > 0) {
        const files = this.pendingPlaylistFiles.splice(0);
        void this.autoPlaylist.processBatch(files).catch((err) => {
          log.warn({ err }, 'Auto-playlist flush on stop failed');
        });
      }
    }
    log.info('Download watcher stopped');
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
            const transferId = typeof file.id === 'string' && file.id.length > 0
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
            const transferId = typeof file.id === 'string' && file.id.length > 0
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
              this.pendingPlaylistFiles.push(fileData);
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
          await this.libraryOrganizer.organizeBatch(completedFiles);
        } catch (err) {
          log.warn({ err }, 'Library organization step failed');
        }
        // organizeBatch mutates file.relativePath to the post-move path; persist
        // so auto-playlist resolution and back-fill see the location Navidrome indexes.
        for (const file of completedFiles) {
          if (file.relativePath) {
            this.updateRelativePath(file.username, file.directory, file.filename, file.relativePath);
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
      const filesToProcess = this.pendingPlaylistFiles.splice(0);
      try {
        log.info('Triggering Navidrome library scan');
        await this.navidrome.system.startScan(true);
      } catch (err) {
        log.error({ err }, 'Failed to trigger scan');
      }
      try {
        await this.autoPlaylist.processBatch(filesToProcess);
      } catch (err) {
        log.error({ err }, 'Auto-playlist processing failed');
      }
      if (this.onScanComplete) {
        try {
          await this.onScanComplete();
        } catch (err) {
          log.error({ err }, 'onScanComplete handler failed');
        }
      }
    }, this.scanDebounceMs);
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
