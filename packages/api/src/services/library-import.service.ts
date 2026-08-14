/**
 * Admin "Import music from folder" driver (docs/import.md). Runs a validated
 * server-side folder through the SAME pipeline a download takes — the fourth
 * caller of the organize → scan seam after AcquireWatcher, AddonJobPoller and
 * the download-review retag — chunk-wise so a 20k-file library import gets
 * bounded staging disk, real progress, and directory-granular retry.
 *
 * Staging-copy is mandatory even in move mode: the organizer CONSUMES its
 * inputs (moves them, rewrites tags in place, unlinks dup-skips), so the
 * user's originals are never handed to it directly. Move mode deletes an
 * original only after its chunk's scan succeeded AND its staged copy no
 * longer exists (= the organizer consumed it: placed in the library,
 * dup-skipped, or filed to the unsorted bucket — same as a download).
 */
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  statfsSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { createLogger } from '@nicotind/core';
import type {
  AcquireAlbumDestination,
  ImportJob,
  ImportJobDir,
  ImportJobSummary,
  ImportPreview,
  ImportSourceErrorCode,
} from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import type { CompletedDownloadFile } from './path-inference.js';
import type { OrganizeResult } from './library-organizer.js';
import { deriveAcquireAlbum } from './acquire-album.js';
import { recordAcquisition } from './acquisition-store.js';
import { getProcessingSettings } from './processing-settings.js';
import { recordReviewDecision, reviewHoldActive } from './download-review-store.js';
import {
  IMPORT_MAX_DEPTH,
  IMPORT_MAX_FILES,
  planImportChunks,
  scanImportSource,
  validateImportSource,
  type ImportChunk,
  type ImportScanResult,
} from './import-scan.js';
import {
  createImportJob,
  deleteImportJob,
  getImportJob,
  listImportDirs,
  listImportJobs,
  markImportDir,
  reconcileImportJobsOnBoot,
  updateImportJob,
  upsertImportDirs,
} from './import-job-store.js';

const log = createLogger('library-import');

/** Free-space headroom the destination filesystem must keep after an import. */
const IMPORT_DISK_MARGIN_BYTES = 500 * 1024 * 1024;
/** Chunk size in files — bounds staging disk usage and progress granularity. */
const IMPORT_CHUNK_TARGET_FILES = 200;

export class ImportSourceInvalidError extends Error {
  constructor(public code: ImportSourceErrorCode) {
    super(importSourceErrorMessage(code));
    this.name = 'ImportSourceInvalidError';
  }
}

export class ImportAlreadyRunningError extends Error {
  constructor() {
    super('An import is already running — wait for it to finish or cancel it first.');
    this.name = 'ImportAlreadyRunningError';
  }
}

export class ImportEmptySourceError extends Error {
  constructor() {
    super('The folder contains no audio files.');
    this.name = 'ImportEmptySourceError';
  }
}

export class ImportTooLargeError extends Error {
  constructor() {
    super(
      `The folder exceeds the import limits (${IMPORT_MAX_FILES.toLocaleString()} files / depth ${IMPORT_MAX_DEPTH}) — import it in smaller pieces.`,
    );
    this.name = 'ImportTooLargeError';
  }
}

export class ImportInsufficientSpaceError extends Error {
  constructor(
    public requiredBytes: number,
    public freeBytes: number,
  ) {
    super('Not enough free disk space in the music library for this import.');
    this.name = 'ImportInsufficientSpaceError';
  }
}

function importSourceErrorMessage(code: ImportSourceErrorCode): string {
  switch (code) {
    case 'NOT_FOUND':
      return 'That folder does not exist on the server.';
    case 'NOT_DIR':
      return 'That path is a file, not a folder.';
    case 'INSIDE_LIBRARY':
      return 'That folder is inside the music library — it is already scanned in place.';
    case 'CONTAINS_LIBRARY':
      return 'That folder contains the music library — pick the specific folder to import.';
    case 'INSIDE_DATA_DIR':
      return "That folder is inside NicotinD's data directory.";
    case 'CONTAINS_DATA_DIR':
      return "That folder contains NicotinD's data directory — pick the specific folder to import.";
  }
}

/** Subset of node:fs statfs result we need; injected so tests skip the real FS. */
export type StatfsFn = (path: string) => { bsize: number; blocks: number; bavail: number };

export interface LibraryImportServiceOptions {
  db: Database;
  /** Expanded (no `~`) data dir — staging lives under `<dataDir>/staging/import`. */
  dataDir: string;
  /** Expanded music dir — used for path validation + disk preflight only. */
  musicDir: string;
  /** The shared organizer's batch entry; mutates file.relativePath in place. */
  organizeBatch: (files: CompletedDownloadFile[]) => Promise<OrganizeResult>;
  scanIncremental: (relPaths: string[]) => Promise<void>;
  /** Live acquisition toggle — gates only the review-hold pre-approval. */
  acquisitionEnabled: () => boolean;
  /** Injected for tests; defaults to node:fs statfsSync. */
  statfs?: StatfsFn;
}

export function importStagingDir(dataDir: string, jobId: string): string {
  return join(dataDir, 'staging', 'import', jobId);
}

interface StagedFile {
  /** Original absolute path in the user's source folder. */
  src: string;
  /** Staged absolute path handed to the organizer. */
  dst: string;
  /** 'renamed' = original already moved into staging (same-device move mode). */
  mode: 'copied' | 'renamed';
}

export class LibraryImportService {
  private db: Database;
  private statfs: StatfsFn;
  /** In-memory single-flight + cancellation flags (checked between chunks). */
  private runningJobId: string | null = null;
  private cancelRequested = new Set<string>();

  constructor(private options: LibraryImportServiceOptions) {
    this.db = options.db;
    this.statfs = options.statfs ?? (statfsSync as unknown as StatfsFn);
    // Boot hygiene: fail orphaned jobs (their run loop died with the process),
    // roll their staged files back to the source (move mode), and sweep the
    // staging dirs of pruned rows.
    const { orphaned, pruned } = reconcileImportJobsOnBoot(this.db);
    for (const job of orphaned) {
      const staging = importStagingDir(this.options.dataDir, job.id);
      if (job.removeOriginals) this.rollbackStaging(staging, job.sourcePath);
      this.cleanupStaging(staging);
    }
    for (const id of pruned) {
      this.cleanupStaging(importStagingDir(this.options.dataDir, id));
    }
  }

  /** Read-only dry-run: validate + walk + disk numbers. Never creates a job. */
  preview(rawPath: string): ImportPreview {
    const validated = validateImportSource(rawPath, this.options.musicDir, this.options.dataDir);
    if (!validated.ok) throw new ImportSourceInvalidError(validated.code);
    const scan = scanImportSource(validated.realPath);
    const freeMusicFs = this.freeBytes(this.options.musicDir);
    const freeStagingFs = this.freeBytes(this.options.dataDir);
    const requiredBytes = scan.bytes + IMPORT_DISK_MARGIN_BYTES;
    const warnings: string[] = [];
    if (scan.truncated) {
      warnings.push(
        `The folder exceeds the import limits (${IMPORT_MAX_FILES.toLocaleString()} files / depth ${IMPORT_MAX_DEPTH}); the numbers below are a partial count and import will refuse this folder.`,
      );
    }
    if (scan.skippedSymlinks > 0) {
      warnings.push('Symbolic links are never followed — linked folders/files were skipped.');
    }
    return {
      sourcePath: validated.realPath,
      albumFolders: scan.dirs.length,
      files: scan.files,
      bytes: scan.bytes,
      unsupportedFiles: scan.unsupportedFiles,
      skippedSymlinks: scan.skippedSymlinks,
      truncated: scan.truncated,
      warnings,
      disk: {
        freeMusicFs,
        freeStagingFs,
        requiredBytes,
        sufficient: freeMusicFs === null || freeMusicFs >= requiredBytes,
      },
    };
  }

  /**
   * Validate, preflight, create the job and start the run loop. Returns the
   * job id; the import continues in the background.
   */
  submit(
    rawPath: string,
    opts: { removeOriginals?: boolean; startedBy?: string | null } = {},
  ): string {
    const busy = this.db
      .query<{ id: string }, []>(
        `SELECT id FROM import_jobs WHERE state IN ('queued', 'running') LIMIT 1`,
      )
      .get();
    if (busy) throw new ImportAlreadyRunningError();
    const validated = validateImportSource(rawPath, this.options.musicDir, this.options.dataDir);
    if (!validated.ok) throw new ImportSourceInvalidError(validated.code);
    const scan = scanImportSource(validated.realPath);
    if (scan.truncated) throw new ImportTooLargeError();
    if (scan.files === 0) throw new ImportEmptySourceError();
    const removeOriginals = opts.removeOriginals ?? false;
    this.preflightDisk(scan, validated.realPath, removeOriginals);

    const id = crypto.randomUUID();
    createImportJob(this.db, {
      id,
      sourcePath: validated.realPath,
      removeOriginals,
      filesTotal: scan.files,
      bytesTotal: scan.bytes,
      startedBy: opts.startedBy ?? null,
    });
    upsertImportDirs(
      this.db,
      id,
      scan.dirs.map((d) => ({ dir: d.dir, fileCount: d.files.length })),
    );
    void this.run(id, validated.realPath, scan, removeOriginals, opts.startedBy ?? null);
    return id;
  }

  /**
   * Copy mode always needs the full source size free on the destination fs.
   * A move whose source, staging AND library all share one device just renames
   * bytes around — only the headroom margin applies there.
   */
  private preflightDisk(
    scan: ImportScanResult,
    sourceRoot: string,
    removeOriginals: boolean,
  ): void {
    const free = this.freeBytes(this.options.musicDir);
    if (free === null) return;
    const sameDevice =
      removeOriginals &&
      this.sameDev(sourceRoot, this.options.musicDir) &&
      this.sameDev(sourceRoot, this.options.dataDir);
    const required = (sameDevice ? 0 : scan.bytes) + IMPORT_DISK_MARGIN_BYTES;
    if (free < required) throw new ImportInsufficientSpaceError(required, free);
  }

  private sameDev(a: string, b: string): boolean {
    try {
      return statSync(a).dev === statSync(b).dev;
    } catch {
      return false;
    }
  }

  private freeBytes(path: string): number | null {
    try {
      const st = this.statfs(path);
      return st.bavail * st.bsize;
    } catch {
      return null;
    }
  }

  /** Request cancellation; the in-flight chunk finishes its scan first. */
  cancel(jobId: string): boolean {
    const job = getImportJob(this.db, jobId);
    if (!job || (job.state !== 'running' && job.state !== 'queued')) return false;
    this.cancelRequested.add(jobId);
    return true;
  }

  /**
   * Re-run a finished (failed/cancelled/done) job — same id, same source.
   * Directories already marked 'done' are skipped, so an interrupted 20k-file
   * import resumes instead of restarting.
   */
  retry(jobId: string): string | null {
    const job = getImportJob(this.db, jobId);
    if (!job) return null;
    if (job.state === 'queued' || job.state === 'running') return jobId;
    if (this.runningJobId) throw new ImportAlreadyRunningError();
    const validated = validateImportSource(
      job.sourcePath,
      this.options.musicDir,
      this.options.dataDir,
    );
    if (!validated.ok) throw new ImportSourceInvalidError(validated.code);
    const scan = scanImportSource(validated.realPath);
    if (scan.truncated) throw new ImportTooLargeError();
    updateImportJob(this.db, jobId, {
      state: 'queued',
      stage: 'queued',
      error: null,
      currentDir: null,
    });
    upsertImportDirs(
      this.db,
      jobId,
      scan.dirs.map((d) => ({ dir: d.dir, fileCount: d.files.length })),
    );
    void this.run(jobId, validated.realPath, scan, job.removeOriginals, job.startedBy);
    return jobId;
  }

  /** Remove a finished job (row + mirror + staging dir). */
  delete(jobId: string): boolean {
    if (!deleteImportJob(this.db, jobId)) return false;
    this.cleanupStaging(importStagingDir(this.options.dataDir, jobId));
    return true;
  }

  getJob(jobId: string): ImportJob | null {
    return getImportJob(this.db, jobId);
  }

  getJobDirs(jobId: string): ImportJobDir[] {
    return listImportDirs(this.db, jobId);
  }

  listJobs(limit = 20): ImportJob[] {
    return listImportJobs(this.db, limit);
  }

  private async run(
    id: string,
    sourceRoot: string,
    scan: ImportScanResult,
    removeOriginals: boolean,
    startedBy: string | null,
  ): Promise<void> {
    this.runningJobId = id;
    const stagingRoot = importStagingDir(this.options.dataDir, id);
    const summary: ImportJobSummary = {
      imported: 0,
      skippedDuplicate: 0,
      unsorted: 0,
      failed: 0,
      removedOriginals: 0,
    };
    const destAlbums = new Map<string, AcquireAlbumDestination>();
    let filesDone = 0;
    let chunksFailed = 0;
    let chunksRun = 0;
    try {
      updateImportJob(this.db, id, { state: 'running' });
      // Retry contract: skip dirs a previous run already finished.
      const doneDirs = new Set(
        listImportDirs(this.db, id)
          .filter((d) => d.state === 'done')
          .map((d) => d.sourceDir),
      );
      const alreadyDone = scan.dirs.filter((d) => doneDirs.has(d.dir));
      filesDone = alreadyDone.reduce((n, d) => n + d.files.length, 0);
      const pending = scan.dirs.filter((d) => !doneDirs.has(d.dir));
      const chunks = planImportChunks(pending, IMPORT_CHUNK_TARGET_FILES);
      let cancelled = false;
      for (const chunk of chunks) {
        if (this.cancelRequested.has(id)) {
          cancelled = true;
          break;
        }
        chunksRun += 1;
        try {
          await this.runChunk(id, sourceRoot, stagingRoot, chunk, removeOriginals, startedBy, {
            summary,
            destAlbums,
          });
          for (const dir of chunk.dirs) markImportDir(this.db, id, dir.dir, 'done');
        } catch (err) {
          // One bad album folder must not sink a whole-library import: roll the
          // chunk's staged files back (move mode), mark its dirs failed, carry on.
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ id, err: msg, dirs: chunk.dirs.map((d) => d.dir) }, 'Import chunk failed');
          if (removeOriginals) this.rollbackStaging(stagingRoot, sourceRoot);
          this.cleanupStaging(stagingRoot);
          chunksFailed += 1;
          summary.failed += chunk.files;
          for (const dir of chunk.dirs) markImportDir(this.db, id, dir.dir, 'failed', msg);
        }
        filesDone += chunk.files;
        updateImportJob(this.db, id, {
          filesDone,
          summary,
          destAlbums: [...destAlbums.values()],
          currentDir: null,
        });
      }
      const albums = [...destAlbums.values()];
      const single = albums.length === 1 ? albums[0]! : null;
      if (cancelled) {
        if (removeOriginals) this.rollbackStaging(stagingRoot, sourceRoot);
        this.cleanupStaging(stagingRoot);
        updateImportJob(this.db, id, {
          state: 'cancelled',
          stage: 'error',
          error: 'Cancelled',
          summary,
          destAlbums: albums,
          currentDir: null,
        });
        return;
      }
      this.cleanupStaging(stagingRoot);
      if (chunksRun > 0 && chunksFailed === chunksRun) {
        updateImportJob(this.db, id, {
          state: 'failed',
          stage: 'error',
          error: 'Every folder failed to import — see the per-folder errors.',
          summary,
          destAlbums: albums,
          currentDir: null,
        });
        return;
      }
      // Nothing landed → an honest done-with-warning (mirrors acquire's
      // unfiledWarning) instead of a clean green "Done" over an empty result.
      const warning =
        summary.imported === 0
          ? 'Finished, but no tracks were added to your library — they may already exist or lack the artist/album metadata needed to file them.'
          : chunksFailed > 0
            ? `${chunksFailed} folder group(s) failed to import — see the per-folder errors.`
            : null;
      updateImportJob(this.db, id, {
        state: 'done',
        stage: 'done',
        error: warning,
        filesDone,
        summary,
        destAlbums: albums,
        currentDir: null,
        mirrorAlbum: single
          ? { artistName: single.albumArtist, albumTitle: single.albumTitle }
          : null,
      });
      log.info({ id, ...summary }, 'Import finished');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ id, err: msg }, 'Import failed');
      if (removeOriginals) this.rollbackStaging(stagingRoot, sourceRoot);
      this.cleanupStaging(stagingRoot);
      updateImportJob(this.db, id, {
        state: 'failed',
        stage: 'error',
        error: msg,
        summary,
        currentDir: null,
      });
    } finally {
      this.cancelRequested.delete(id);
      this.runningJobId = null;
    }
  }

  /** Stage → organize → provenance → review pre-approval → scan → move-mode deletion. */
  private async runChunk(
    id: string,
    sourceRoot: string,
    stagingRoot: string,
    chunk: ImportChunk,
    removeOriginals: boolean,
    startedBy: string | null,
    acc: { summary: ImportJobSummary; destAlbums: Map<string, AcquireAlbumDestination> },
  ): Promise<void> {
    updateImportJob(this.db, id, { stage: 'organizing', currentDir: chunk.dirs[0]?.dir ?? null });
    const staged: StagedFile[] = [];
    const files: CompletedDownloadFile[] = [];
    const originals: string[] = [];
    for (const dir of chunk.dirs) {
      for (const file of dir.files) {
        const src = join(sourceRoot, ...file.rel.split('/'));
        const dst = join(stagingRoot, ...file.rel.split('/'));
        try {
          mkdirSync(dirname(dst), { recursive: true });
          const mode = this.stageFile(src, dst, removeOriginals);
          staged.push({ src, dst, mode });
          files.push({
            username: `import:${id}`,
            directory: dir.dir,
            filename: dst,
          });
          originals.push(src);
        } catch (err) {
          // Vanished/unreadable file: count it and keep the chunk going.
          log.warn({ src, err }, 'Failed to stage file for import');
          acc.summary.failed += 1;
        }
      }
    }
    if (files.length === 0) return;

    const result = await this.options.organizeBatch(files);
    const relPaths: string[] = [];
    const acquiredAt = Date.now();
    for (let i = 0; i < files.length; i++) {
      const relPath = files[i]!.relativePath;
      if (!relPath) continue;
      relPaths.push(relPath);
      // Provenance points at the user's original file, not the staging copy.
      recordAcquisition(this.db, {
        relativePath: relPath,
        method: 'import',
        sourceRef: originals[i]!,
        stage: 'done',
        startedAt: acquiredAt,
        completedAt: acquiredAt,
      });
    }
    acc.summary.imported += Math.max(0, result.moved - result.deletedRelPaths.length);
    acc.summary.skippedDuplicate += result.skipped + result.dedupedBasenames.length;
    acc.summary.unsorted += result.unsorted;
    acc.summary.failed += result.failed;

    const chunkAlbums = new Map<string, AcquireAlbumDestination>();
    for (const relPath of relPaths) {
      const album = deriveAcquireAlbum(dirname(relPath));
      if (album) {
        chunkAlbums.set(album.albumId, album);
        acc.destAlbums.set(album.albumId, album);
      }
    }
    // Review-inbox bypass: imports keep the quarantine/enrichment gate, but an
    // admin bulk-importing their own library must not flood the hold-for-review
    // inbox. Pre-approving BEFORE the scan mints the rows keeps the
    // `reviewed_at >= created` predicate true; a later real download into the
    // same album still pends (its rows are created after this decision).
    if (
      reviewHoldActive(
        this.db,
        getProcessingSettings(this.db).holdForReview && this.options.acquisitionEnabled(),
      )
    ) {
      for (const album of chunkAlbums.values()) {
        recordReviewDecision(this.db, album.albumId, 'approved', `import:${startedBy ?? 'admin'}`);
      }
    }

    if (relPaths.length > 0) {
      updateImportJob(this.db, id, { stage: 'scanning' });
      await this.options.scanIncremental(relPaths);
    }

    // Disk-truth deletion (move mode): a staged copy that no longer exists was
    // consumed by the organizer — its content lives in the library, the dup
    // that replaced it, or the unsorted bucket — so the original is now
    // redundant. A staged copy still present means the organizer failed on it:
    // renamed originals go home, copied ones were never touched.
    for (const entry of staged) {
      const consumed = !existsSync(entry.dst);
      if (!removeOriginals) continue;
      if (consumed) {
        if (entry.mode === 'copied') {
          try {
            unlinkSync(entry.src);
          } catch (err) {
            log.warn({ src: entry.src, err }, 'Failed to remove original after import');
            continue;
          }
        }
        acc.summary.removedOriginals += 1;
      } else if (entry.mode === 'renamed') {
        try {
          mkdirSync(dirname(entry.src), { recursive: true });
          renameSync(entry.dst, entry.src);
        } catch (err) {
          log.warn({ src: entry.src, err }, 'Failed to restore original after failed organize');
        }
      }
    }
    if (removeOriginals) {
      const dirs = new Set(staged.map((s) => dirname(s.src)));
      for (const dir of dirs) this.pruneEmptySourceDirs(dir, sourceRoot);
    }
    this.cleanupStaging(stagingRoot);
  }

  /**
   * Move mode on one device renames the original into staging (no double
   * disk); everything else copies. COPYFILE_FICLONE reflinks where the
   * filesystem supports it and silently falls back to a full copy.
   */
  private stageFile(src: string, dst: string, removeOriginals: boolean): StagedFile['mode'] {
    if (removeOriginals && this.sameDev(dirname(src), dirname(dst))) {
      renameSync(src, dst);
      return 'renamed';
    }
    copyFileSync(src, dst, constants.COPYFILE_FICLONE);
    return 'copied';
  }

  /** Remove now-empty source directories, walking up but never past the root. */
  private pruneEmptySourceDirs(from: string, stopRoot: string): void {
    let cur = from;
    const stop = stopRoot.endsWith(sep) ? stopRoot : stopRoot + sep;
    while (cur.startsWith(stop)) {
      try {
        if (readdirSync(cur).length > 0) return;
        rmdirSync(cur);
      } catch {
        return;
      }
      cur = dirname(cur);
    }
  }

  /**
   * Move-mode crash/failure recovery: rename every file still in staging back
   * to its source-relative home (never clobbering a file that reappeared).
   * Copy-mode staging needs no rollback — originals were never touched.
   */
  private rollbackStaging(stagingRoot: string, sourceRoot: string): void {
    if (!existsSync(stagingRoot)) return;
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const target = join(sourceRoot, relative(stagingRoot, abs));
        if (existsSync(target)) continue;
        try {
          mkdirSync(dirname(target), { recursive: true });
          renameSync(abs, target);
        } catch (err) {
          log.warn({ staged: abs, target, err }, 'Failed to roll back staged import file');
        }
      }
    };
    walk(stagingRoot);
  }

  private cleanupStaging(stagingDir: string): void {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // Non-fatal; nothing downstream depends on staging dirs being gone.
    }
  }
}
