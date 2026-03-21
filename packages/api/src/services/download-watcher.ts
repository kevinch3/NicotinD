import { createLogger } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { Navidrome } from '@nicotind/navidrome-client';
import { MetadataFixer } from './metadata-fixer.js';
import type { CompletedDownloadFile } from './metadata-fixer.js';

const log = createLogger('download-watcher');

interface DownloadWatcherOptions {
  intervalMs?: number;
  scanDebounceMs?: number;
  musicDir?: string;
  metadataFixEnabled?: boolean;
  metadataFixMinScore?: number;
  metadataFixer?: { processCompletedDownloads: (files: CompletedDownloadFile[]) => Promise<void> };
}

export class DownloadWatcher {
  private slskd: Slskd;
  private navidrome: Navidrome;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private knownCompleted = new Set<string>();
  private scanDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private scanDebounceMs: number;
  private metadataFixer: {
    processCompletedDownloads: (files: CompletedDownloadFile[]) => Promise<void>;
  };
  private checking = false;

  constructor(slskd: Slskd, navidrome: Navidrome, options: DownloadWatcherOptions = {}) {
    this.slskd = slskd;
    this.navidrome = navidrome;
    this.intervalMs = options.intervalMs ?? 5_000;
    this.scanDebounceMs = options.scanDebounceMs ?? 10_000;
    this.metadataFixer =
      options.metadataFixer ??
      new MetadataFixer({
        musicDir: options.musicDir ?? '~/Music',
        enabled: options.metadataFixEnabled ?? true,
        minScore: options.metadataFixMinScore ?? 85,
      });
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
            const key = `${group.username}:${file.filename}`;
            if (file.state === 'Completed, Succeeded' && !this.knownCompleted.has(key)) {
              this.knownCompleted.add(key);
              newCompletions = true;
              completedFiles.push({
                username: group.username,
                directory: dir.directory,
                filename: file.filename,
              });
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
      try {
        log.info('Triggering Navidrome library scan');
        await this.navidrome.system.startScan();
      } catch (err) {
        log.error({ err }, 'Failed to trigger scan');
      }
    }, this.scanDebounceMs);
  }
}
