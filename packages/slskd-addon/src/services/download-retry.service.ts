import { createLogger } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import type { Database } from 'bun:sqlite';
import { getDatabase } from '../db.js';

const log = createLogger('download-retry');

// slskd transfer states that mean the transfer died mid-flight or was rejected.
// We do NOT retry 'Completed, Cancelled' — that's a deliberate user action.
const RETRYABLE_SUFFIXES = ['Errored', 'TimedOut', 'Rejected'];

function isRetryable(state: string): boolean {
  return RETRYABLE_SUFFIXES.some((s) => state === `Completed, ${s}`);
}

interface RetryRow {
  attempts: number;
  last_attempt: number | null;
  gave_up: number;
}

export interface DownloadRetryOptions {
  db?: Database;
  intervalMs?: number;
  /** Max automatic re-enqueue attempts before a transfer is frozen as Error. */
  maxAttempts?: number;
  /** Minimum delay between attempts for the same transfer. */
  cooldownMs?: number;
  /** Called once per tick after the retry sweep — lets the fallback layer act on given-up transfers. */
  onSweep?: () => Promise<void> | void;
}

/**
 * Self-healing reconciler. Polls slskd for failed transfers and re-enqueues
 * them — slskd keeps the partial `.incomplete` file and resumes it, so a
 * truncated download continues rather than restarting. Attempts are capped per
 * transfer; once exhausted the transfer is left in Error for cross-peer fallback
 * (AlbumFallbackService) or a manual retry to pick up.
 */
export class DownloadRetryService {
  private slskd: Slskd;
  private db: Database;
  private intervalMs: number;
  private maxAttempts: number;
  private cooldownMs: number;
  private onSweep?: () => Promise<void> | void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  constructor(slskd: Slskd, options: DownloadRetryOptions = {}) {
    this.slskd = slskd;
    this.db = options.db ?? getDatabase();
    this.intervalMs = options.intervalMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.onSweep = options.onSweep;
  }

  start(): void {
    if (this.timer) return;
    log.info(
      { intervalMs: this.intervalMs, maxAttempts: this.maxAttempts },
      'Starting download retry reconciler',
    );
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    void this.sweep();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One reconciliation pass. Public so tests can drive it deterministically. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      let downloads;
      try {
        downloads = await this.slskd.transfers.getDownloads();
      } catch (err) {
        log.debug({ err }, 'getDownloads failed during retry sweep');
        return;
      }

      const hiddenIds = this.hiddenIds();
      const now = Date.now();

      for (const group of downloads) {
        for (const dir of group.directories) {
          for (const file of dir.files) {
            const key = `${group.username}::${file.filename}`;

            // Clean up the retry record once a transfer finally succeeds.
            if (file.state === 'Completed, Succeeded') {
              this.db.run('DELETE FROM transfer_retries WHERE transfer_key = ?', [key]);
              continue;
            }

            if (!isRetryable(file.state)) continue;
            if (hiddenIds.has(file.id)) continue;

            const row = this.getRow(key);
            if (row?.gave_up) continue;

            const attempts = row?.attempts ?? 0;
            if (attempts >= this.maxAttempts) {
              this.markGaveUp(key);
              log.warn({ key, attempts }, 'Auto-retry exhausted — leaving transfer in Error');
              continue;
            }

            // Space out attempts so we don't hammer an offline peer.
            if (row?.last_attempt && now - row.last_attempt < this.cooldownMs) continue;

            await this.retry(group.username, file.id, file.filename, file.size, key, attempts);
          }
        }
      }
    } finally {
      this.sweeping = false;
    }

    if (this.onSweep) {
      try {
        await this.onSweep();
      } catch (err) {
        log.warn({ err }, 'onSweep hook failed');
      }
    }
  }

  private async retry(
    username: string,
    id: string,
    filename: string,
    size: number,
    key: string,
    attempts: number,
  ): Promise<void> {
    // Clear the dead transfer record first, then re-enqueue. slskd resumes the
    // partial `.incomplete` file rather than starting over.
    await this.slskd.transfers.cancel(username, id).catch(() => {});
    try {
      await this.slskd.transfers.enqueue(username, [{ filename, size }]);
    } catch (err) {
      log.warn({ key, err }, 'Re-enqueue failed; will retry next sweep');
      // Still record the attempt so the cooldown + cap apply.
    }
    this.recordAttempt(key, username, filename, attempts + 1);
    log.info({ key, attempt: attempts + 1 }, 'Re-enqueued failed transfer');
  }

  private hiddenIds(): Set<string> {
    const rows = this.db.query('SELECT id FROM hidden_transfers').all() as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  private getRow(key: string): RetryRow | undefined {
    return this.db
      .query('SELECT attempts, last_attempt, gave_up FROM transfer_retries WHERE transfer_key = ?')
      .get(key) as RetryRow | undefined;
  }

  private recordAttempt(key: string, username: string, filename: string, attempts: number): void {
    this.db.run(
      `INSERT INTO transfer_retries (transfer_key, username, filename, attempts, last_attempt, gave_up)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(transfer_key) DO UPDATE SET attempts = excluded.attempts, last_attempt = excluded.last_attempt`,
      [key, username, filename, attempts, Date.now()],
    );
  }

  private markGaveUp(key: string): void {
    this.db.run('UPDATE transfer_retries SET gave_up = 1 WHERE transfer_key = ?', [key]);
  }
}
