import { createLogger } from '@nicotind/core';
import type { Slskd } from '@nicotind/slskd-client';
import { TransferPoller, type PolledCompletion } from '@nicotind/slskd-addon';
import type { CompletedDownloadFile } from './path-inference.js';
import { LibraryOrganizer } from './library-organizer.js';
import { AcoustIdLookup } from './acoustid-lookup.js';
import { getDatabase } from '../db.js';
import { recordAcquisition } from './acquisition-store.js';
import {
  backfillDirectJobAlbum,
  jobMetaForTransfer,
  markItemCompleted,
  markItemOrganized,
  markItemsScanned,
  recomputeStage,
  transferKeyFor,
} from './acquisition-job-store.js';
import { applyJobMetadataPrefill } from './job-metadata-prefill.js';

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
  /**
   * Explicit DB handle (testing). Defaults to the module-level `getDatabase()`.
   * Injecting one keeps watcher DB access isolated from the global singleton,
   * which bun's concurrent test files otherwise clobber (see project memory).
   */
  db?: import('bun:sqlite').Database;
}

/**
 * The organize → provenance → scan → job-bookkeeping pipeline for completed
 * Soulseek downloads. The slskd transfer polling itself moved to the addon
 * package's `TransferPoller` (#488) — this class composes it and owns
 * everything downstream of a completion.
 */
export class DownloadWatcher {
  private injectedDb?: import('bun:sqlite').Database;
  private pollerInstance: TransferPoller | null = null;
  private pollerOptions: { intervalMs: number; rootDir: string | null };
  private slskd: Slskd;
  private scanDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private scanDebounceMs: number;
  private musicDir: string | null;
  private libraryOrganizer: {
    organizeBatch: (files: CompletedDownloadFile[]) => Promise<unknown>;
  };
  private pendingScanFiles: CompletedDownloadFile[] = [];
  private scan?: (relPaths: string[]) => Promise<void> | void;

  constructor(slskd: Slskd, options: DownloadWatcherOptions = {}) {
    this.injectedDb = options.db;
    this.scanDebounceMs = options.scanDebounceMs ?? 10_000;
    this.musicDir = options.musicDir ? this.expandDir(options.musicDir) : null;
    // No jobLookup here: production always injects the shared organizer built
    // in index.ts (which carries the album_jobs lookup), and per-file
    // acquisition-job metadata (file.jobMeta) now covers the canonical-name
    // decision anyway. A duplicate lookup here was dead code drifting from the
    // real one.
    this.libraryOrganizer =
      options.libraryOrganizer ??
      new LibraryOrganizer({
        musicDir: options.musicDir ?? '~/Music',
        stagingDir: options.stagingDir,
        acoustid: options.acoustidApiKey ? new AcoustIdLookup(options.acoustidApiKey) : undefined,
        unsortedRoot: options.unsortedRoot,
        preferFlacSkipMp3: options.preferFlacSkipMp3,
      });
    this.scan = options.scan;
    this.slskd = slskd;
    // Poller construction is deferred to first use: the module-level
    // `getDatabase()` fallback must stay lazy (the old watcher never touched
    // the DB at construction, and tests rely on that).
    this.pollerOptions = {
      intervalMs: options.intervalMs ?? 5_000,
      rootDir: options.musicDir ?? null,
    };
  }

  private poller(): TransferPoller {
    this.pollerInstance ??= new TransferPoller(this.slskd, {
      db: () => this.getDb(),
      intervalMs: this.pollerOptions.intervalMs,
      rootDir: this.pollerOptions.rootDir,
      onCompleted: (files) => this.handleCompletions(files),
    });
    return this.pollerInstance;
  }

  start(): void {
    log.info('Starting download watcher');
    this.poller().start();
  }

  stop(): void {
    this.poller().stop();
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

  /** One poll+pipeline pass (tests drive this directly). */
  private async check(): Promise<void> {
    await this.poller().check();
  }

  private async handleCompletions(polled: PolledCompletion[]): Promise<void> {
    const completedFiles: CompletedDownloadFile[] = [];
    for (const c of polled) {
      const fileData: CompletedDownloadFile = {
        username: c.username,
        directory: c.directory,
        filename: c.filename,
        relativePath: c.relativePath,
        directoryFileCount: c.directoryFileCount,
        jobMeta: this.resolveJobMeta(c.username, c.filename),
      };
      this.markJobItemCompleted(c.username, c.filename);
      completedFiles.push(fileData);
      this.pendingScanFiles.push(fileData);
    }

    try {
      const orgResult = (await this.libraryOrganizer.organizeBatch(completedFiles)) as
        { dedupedBasenames?: string[] } | undefined;
      // Drop completed_downloads rows for files auto-dedupe removed from disk,
      // so the canonical tables don't reference vanished duplicates.
      for (const basename of orgResult?.dedupedBasenames ?? []) {
        this.poller().deleteByBasename(basename);
      }
    } catch (err) {
      log.warn({ err }, 'Library organization step failed');
    }
    // organizeBatch mutates file.relativePath to the post-move path; persist
    // so the scan and back-fill see the final on-disk location.
    const acquiredAt = Date.now();
    for (const file of completedFiles) {
      if (file.relativePath) {
        this.poller().updateRelativePath(
          file.username,
          file.directory,
          file.filename,
          file.relativePath,
        );
        // Record acquisition provenance keyed on the final path (== library_songs.path).
        this.recordSlskdAcquisition(file.relativePath, file.username, acquiredAt);
        this.markJobItemOrganized(file);
      }
    }
    this.debouncedScan();
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
    await this.markJobItemsScanned(relPaths, files);
  }

  /**
   * After the incremental scan, attach the freshly-minted song ids to the
   * batch's acquisition-job items and re-derive each touched job's stage
   * (scanning → processing/done). Best-effort: job bookkeeping must never
   * break the scan that already happened.
   */
  private async markJobItemsScanned(
    relPaths: string[],
    files: CompletedDownloadFile[],
  ): Promise<void> {
    try {
      const db = this.getDb();
      const pathToSongId = new Map<string, string>();
      for (const relPath of relPaths) {
        const row = db
          .query<{ id: string }, [string]>('SELECT id FROM library_songs WHERE path = ?')
          .get(relPath);
        if (row) pathToSongId.set(relPath, row.id);
      }
      if (pathToSongId.size) markItemsScanned(db, pathToSongId);
      // Pre-fill genre/year from the job's hunt-time Lidarr metadata so the
      // enrichment queue never re-derives what the hunt already knew.
      if (this.musicDir) {
        await applyJobMetadataPrefill(db, files, { musicDir: this.musicDir });
      }
      const jobIds = new Set(
        files.map((f) => f.jobMeta?.jobId).filter((id): id is string => Boolean(id)),
      );
      // Direct grabs have no canonical metadata — now that their files landed,
      // re-point the job's artist/album to the album they actually landed in so
      // the feed row + "Open in Library" deep-link resolve (issue #223). No-op
      // for every other kind (they carry authoritative hunt metadata).
      for (const jobId of jobIds) backfillDirectJobAlbum(db, jobId);
      for (const jobId of jobIds) recomputeStage(db, jobId);
    } catch (err) {
      log.warn({ err }, 'Failed to mark acquisition job items scanned');
    }
  }

  /** Best-effort acquisition-job lookup for a completing transfer. */
  private resolveJobMeta(username: string, filename: string) {
    try {
      return jobMetaForTransfer(this.getDb(), username, filename);
    } catch {
      return null;
    }
  }

  private markJobItemCompleted(username: string, filename: string): void {
    try {
      markItemCompleted(this.getDb(), transferKeyFor(username, filename));
    } catch {
      // Non-fatal: job bookkeeping must never break the watcher.
    }
  }

  private markJobItemOrganized(file: CompletedDownloadFile): void {
    if (!file.relativePath) return;
    try {
      markItemOrganized(
        this.getDb(),
        transferKeyFor(file.username, file.filename),
        file.relativePath,
      );
    } catch {
      // Non-fatal.
    }
  }

  /** Injected DB handle if provided (tests), else the module-level singleton. */
  private getDb(): import('bun:sqlite').Database {
    return this.injectedDb ?? getDatabase();
  }

  /** Best-effort acquisition provenance for a completed Soulseek file. */
  private recordSlskdAcquisition(relativePath: string, username: string, acquiredAt: number): void {
    try {
      recordAcquisition(this.getDb(), {
        relativePath,
        method: 'slskd',
        sourceRef: username,
        stage: 'done',
        startedAt: acquiredAt,
        completedAt: acquiredAt,
      });
    } catch {
      // Non-fatal: DB may not be available (recordAcquisition also swallows).
    }
  }

  private expandDir(dir: string): string {
    if (dir.startsWith('~')) {
      return (process.env.HOME ?? '/root') + dir.slice(1);
    }
    return dir;
  }
}
