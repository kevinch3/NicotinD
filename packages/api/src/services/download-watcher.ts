import { createLogger } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { Navidrome } from '@nicotind/navidrome-client';

const log = createLogger('download-watcher');

export class DownloadWatcher {
  private slskd: Slskd;
  private navidrome: Navidrome;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private knownCompleted = new Set<string>();
  private scanDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private scanDebounceMs: number;

  constructor(
    slskd: Slskd,
    navidrome: Navidrome,
    options: { intervalMs?: number; scanDebounceMs?: number } = {},
  ) {
    this.slskd = slskd;
    this.navidrome = navidrome;
    this.intervalMs = options.intervalMs ?? 5_000;
    this.scanDebounceMs = options.scanDebounceMs ?? 10_000;
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
    try {
      const downloads = await this.slskd.transfers.getDownloads();
      let newCompletions = false;

      for (const [username, transfers] of Object.entries(downloads)) {
        for (const transfer of transfers) {
          const key = `${username}:${transfer.filename}`;
          if (transfer.state === 'Completed, Succeeded' && !this.knownCompleted.has(key)) {
            this.knownCompleted.add(key);
            newCompletions = true;
            log.info({ username, filename: transfer.filename }, 'Download completed');
          }
        }
      }

      if (newCompletions) {
        this.debouncedScan();
      }
    } catch (err) {
      log.error({ err }, 'Error checking downloads');
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
