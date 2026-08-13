import { createLogger } from '@nicotind/addon-sdk';
import type { Slskd } from '@nicotind/slskd-client';
import type { Database } from 'bun:sqlite';
import { basename, join, relative } from 'node:path';
import { existsSync } from 'node:fs';

const log = createLogger('transfer-poller');

/** One newly-completed slskd transfer, with its local path resolved. */
export interface PolledCompletion {
  transferKey: string;
  username: string;
  directory: string;
  filename: string;
  directoryFileCount: number;
  relativePath: string | null;
  completedAt: number;
}

export interface TransferPollerOptions {
  /**
   * A db carrying the `completed_downloads` table (api's or the addon's). A
   * getter keeps resolution lazy — the api's module singleton may not exist at
   * construction time, and every db use here is individually best-effort.
   */
  db: Database | (() => Database);
  intervalMs?: number;
  /** Where slskd lands completed files locally (path resolution root). */
  rootDir?: string | null;
  onCompleted: (files: PolledCompletion[]) => void | Promise<void>;
}

/**
 * The slskd transfer-polling half of the old DownloadWatcher (#488): watches
 * `transfers.getDownloads()` for fresh `Completed, Succeeded` files, resolves
 * each to a local path under `rootDir`, records it in `completed_downloads`
 * (restart dedupe), and hands batches to `onCompleted`. Everything after that
 * (organize → provenance → scan → job bookkeeping) is the consumer's business —
 * api's DownloadWatcher during the transition, the addon job engine after it.
 */
export class TransferPoller {
  private slskd: Slskd;
  private dbSource: Database | (() => Database);
  private intervalMs: number;
  private rootDir: string | null;
  private onCompleted: (files: PolledCompletion[]) => void | Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private knownCompleted = new Set<string>();
  private checking = false;

  constructor(slskd: Slskd, options: TransferPollerOptions) {
    this.slskd = slskd;
    this.dbSource = options.db;
    this.intervalMs = options.intervalMs ?? 5_000;
    this.rootDir = options.rootDir ? expandDir(options.rootDir) : null;
    this.onCompleted = options.onCompleted;
  }

  start(): void {
    if (this.timer) return;
    log.info({ intervalMs: this.intervalMs }, 'Starting transfer poller');
    // Pre-populate from the DB so a restart doesn't replay every historical
    // completion through the consumer (organizer warnings, misplaced files).
    this.seedKnownCompleted();
    this.timer = setInterval(() => this.check(), this.intervalMs);
    void this.check();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll pass. Public so consumers/tests can drive it deterministically. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const downloads = await this.slskd.transfers.getDownloads();
      const completed: PolledCompletion[] = [];

      // Prune keys slskd no longer tracks so the Set stays bounded.
      const currentKeys = new Set<string>();
      for (const group of downloads) {
        for (const dir of group.directories) {
          for (const file of dir.files) {
            currentKeys.add(`${group.username}:${transferId(dir.directory, file)}`);
          }
        }
      }
      for (const key of this.knownCompleted) {
        if (!currentKeys.has(key)) this.knownCompleted.delete(key);
      }

      for (const group of downloads) {
        for (const dir of group.directories) {
          for (const file of dir.files) {
            const key = `${group.username}:${transferId(dir.directory, file)}`;
            if (file.state !== 'Completed, Succeeded' || this.knownCompleted.has(key)) continue;
            this.knownCompleted.add(key);
            const relativePath = this.resolveRelativePath(dir.directory, file.filename);
            const completion: PolledCompletion = {
              transferKey: key,
              username: group.username,
              directory: dir.directory,
              filename: file.filename,
              directoryFileCount: dir.fileCount,
              relativePath,
              completedAt: parseCompletedAt(file.endedAt),
            };
            this.recordCompletedDownload(completion);
            completed.push(completion);
            log.info({ username: group.username, filename: file.filename }, 'Download completed');
          }
        }
      }

      if (completed.length) await this.onCompleted(completed);
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

  private db(): Database {
    return typeof this.dbSource === 'function' ? this.dbSource() : this.dbSource;
  }

  /** Persist the post-organize path so restarts and back-fills see it. */
  updateRelativePath(
    username: string,
    directory: string,
    filename: string,
    relativePath: string,
  ): void {
    try {
      this.db().run(
        `UPDATE completed_downloads SET relative_path = ?
         WHERE username = ? AND directory = ? AND filename = ?`,
        [relativePath, username, directory, filename],
      );
    } catch {
      // Non-fatal: DB may not be available.
    }
  }

  /** Drop rows for files removed from disk (auto-dedupe cleanup). */
  deleteByBasename(fileBasename: string): void {
    try {
      this.db().run('DELETE FROM completed_downloads WHERE basename = ?', [fileBasename]);
    } catch {
      // Non-fatal: DB may not be available.
    }
  }

  private seedKnownCompleted(): void {
    try {
      const rows = this.db()
        .query<{ transfer_key: string }, []>('SELECT transfer_key FROM completed_downloads')
        .all();
      for (const row of rows) this.knownCompleted.add(row.transfer_key);
      if (rows.length) log.info({ count: rows.length }, 'Seeded known completions from DB');
    } catch {
      // DB may not be ready yet; the poller still works, it just won't skip
      // historical transfers on this boot.
    }
  }

  private recordCompletedDownload(c: PolledCompletion): void {
    try {
      const fileBasename = basename(c.filename.replace(/\\/g, '/')).toLowerCase();
      this.db().run(
        `INSERT OR IGNORE INTO completed_downloads
          (transfer_key, username, directory, filename, relative_path, basename, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          c.transferKey,
          c.username,
          c.directory,
          c.filename,
          c.relativePath,
          fileBasename,
          c.completedAt,
        ],
      );
    } catch {
      log.warn('recordCompletedDownload: DB not ready or write failed');
    }
  }

  private resolveRelativePath(directory: string, filename: string): string | null {
    if (!this.rootDir) return null;

    const normalizedFilename = filename.replace(/\\/g, '/');
    const normalizedDirectory = directory.replace(/\\/g, '/');
    const filenameParts = normalizedFilename.split('/').filter(Boolean);
    const directoryParts = normalizedDirectory.split('/').filter(Boolean);
    const baseName = filenameParts[filenameParts.length - 1] ?? basename(normalizedFilename);

    // slskd uses only the leaf segment of the remote path as the local folder name
    const leafDirectory = directoryParts[directoryParts.length - 1];

    const candidates = [
      join(this.rootDir, ...filenameParts),
      join(this.rootDir, ...directoryParts, baseName),
      ...(leafDirectory ? [join(this.rootDir, leafDirectory, baseName)] : []),
      join(this.rootDir, baseName),
    ];

    if (isAbsolutePath(normalizedFilename)) {
      candidates.unshift(normalizedFilename);
    }

    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const relPath = relative(this.rootDir, candidate).replace(/\\/g, '/');
      if (!relPath || relPath.startsWith('../') || relPath === '..') continue;
      return relPath;
    }

    return null;
  }
}

function transferId(directory: string, file: { id?: unknown; filename: string }): string {
  return typeof file.id === 'string' && file.id.length > 0
    ? file.id
    : `${directory}:${file.filename}`;
}

function parseCompletedAt(endedAt?: string): number {
  if (!endedAt) return Date.now();
  const parsed = Date.parse(endedAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function expandDir(dir: string): string {
  if (dir.startsWith('~')) return join(process.env.HOME ?? '/root', dir.slice(1));
  return dir;
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}
