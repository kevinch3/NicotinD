import { createLogger } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { Navidrome } from '@nicotind/navidrome-client';
import { basename, join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { MetadataFixer } from './metadata-fixer.js';
import type { CompletedDownloadFile } from './metadata-fixer.js';
import { AutoPlaylistService } from './auto-playlist.service.js';
import { getDatabase } from '../db.js';

const log = createLogger('download-watcher');

interface DownloadWatcherOptions {
  intervalMs?: number;
  scanDebounceMs?: number;
  musicDir?: string;
  metadataFixEnabled?: boolean;
  metadataFixMinScore?: number;
  metadataFixer?: { processCompletedDownloads: (files: CompletedDownloadFile[]) => Promise<void> };
  autoPlaylist?: { processBatch: (files: CompletedDownloadFile[]) => Promise<void> };
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
  private metadataFixer: {
    processCompletedDownloads: (files: CompletedDownloadFile[]) => Promise<void>;
  };
  private checking = false;
  private pendingPlaylistFiles: CompletedDownloadFile[] = [];
  private autoPlaylist: { processBatch: (files: CompletedDownloadFile[]) => Promise<void> };

  constructor(slskd: Slskd, navidrome: Navidrome, options: DownloadWatcherOptions = {}) {
    this.slskd = slskd;
    this.navidrome = navidrome;
    this.intervalMs = options.intervalMs ?? 5_000;
    this.scanDebounceMs = options.scanDebounceMs ?? 10_000;
    this.musicDir = options.musicDir ? this.expandDir(options.musicDir) : null;
    this.metadataFixer =
      options.metadataFixer ??
      new MetadataFixer({
        musicDir: options.musicDir ?? '~/Music',
        enabled: options.metadataFixEnabled ?? true,
        minScore: options.metadataFixMinScore ?? 85,
      });
    this.autoPlaylist = options.autoPlaylist ?? new AutoPlaylistService(navidrome);
  }

  start(): void {
    if (this.timer) return;
    log.info({ intervalMs: this.intervalMs }, 'Starting download watcher');

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
          await this.metadataFixer.processCompletedDownloads(completedFiles);
        } catch (err) {
          log.warn({ err }, 'Metadata fix step failed');
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
        await this.navidrome.system.startScan();
      } catch (err) {
        log.error({ err }, 'Failed to trigger scan');
      }
      try {
        await this.autoPlaylist.processBatch(filesToProcess);
      } catch (err) {
        log.error({ err }, 'Auto-playlist processing failed');
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
      // Database may not be initialized in unit tests or early startup.
    }
  }

  private resolveRelativePath(directory: string, filename: string): string | null {
    if (!this.musicDir) return null;

    const normalizedFilename = filename.replace(/\\/g, '/');
    const normalizedDirectory = directory.replace(/\\/g, '/');
    const filenameParts = normalizedFilename.split('/').filter(Boolean);
    const directoryParts = normalizedDirectory.split('/').filter(Boolean);
    const baseName = filenameParts[filenameParts.length - 1] ?? basename(normalizedFilename);

    const candidates = [
      join(this.musicDir, ...filenameParts),
      join(this.musicDir, ...directoryParts, baseName),
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
