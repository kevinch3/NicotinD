/**
 * Browser-upload sessions for the import lane (docs/import.md).
 *
 * The existing import flow takes a path the *server* can already read. That is
 * useless from a phone, and it is why import has been API-only. This service is
 * the missing half: it accepts a manifest, takes the bytes in bounded chunks,
 * and lands them in a staging directory that `LibraryImportService.submitStaged`
 * then ingests through the normal organize → scan → quarantine pipeline.
 *
 * Two deliberate choices:
 *
 * - **Chunked, not whole-file.** A 16 MiB cap keeps every request under Bun's
 *   128 MB default body limit, so the upload lane never has to widen
 *   `maxRequestBodySize` for every other route in the app. Resume falls out of
 *   it for free.
 * - **Disk is the progress ledger.** Per-file `received` is read back with
 *   `statSync`, never stored. A resume therefore survives a server restart, and
 *   there is no second source of truth to drift from the bytes on disk.
 */
import { Database } from 'bun:sqlite';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  statfsSync,
  truncateSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { ArchiveError, safeArchivePath } from './import-archive.js';
// One allowlist, three consumers (client filter, server enforcement, tests) —
// two copies drift into "the browser uploaded it and the server threw it away".
import { createLogger, isUploadableName } from '@nicotind/core';

const log = createLogger('import-upload');

/** One request's worth of bytes. Under Bun's 128 MB default body cap on purpose. */
export const IMPORT_UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;

/** Headroom demanded on the staging filesystem beyond the manifest's own size. */
export const IMPORT_UPLOAD_DISK_MARGIN_BYTES = 500 * 1024 * 1024;

/** Abandoned sessions are swept after this long without a write. */
export const IMPORT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export class UploadPathRejectedError extends Error {
  readonly code = 'UPLOAD_PATH_REJECTED' as const;
  constructor(path: string) {
    super(`Refusing an upload path: ${path}`);
  }
}

export class UploadEmptyManifestError extends Error {
  readonly code = 'UPLOAD_EMPTY_MANIFEST' as const;
  constructor() {
    super('No uploadable audio files in this selection.');
  }
}

/**
 * A single chunk exceeded its bound — either the per-request cap or what the
 * manifest declared for that file. Distinct from `UploadTooLargeError` because
 * they are different failures with different fixes: this one means the client
 * sent too much in one request (413), the other means the host has no room
 * (507). Collapsing them returned "Insufficient Storage" for a disk that was
 * fine, which is the kind of confidently-wrong answer that costs an hour.
 */
export class ChunkTooLargeError extends Error {
  readonly code = 'UPLOAD_CHUNK_TOO_LARGE' as const;
  constructor(
    readonly receivedBytes: number,
    readonly limitBytes: number,
  ) {
    super('That upload chunk was larger than allowed.');
  }
}

export class UploadTooLargeError extends Error {
  readonly code = 'UPLOAD_TOO_LARGE' as const;
  constructor(
    readonly requiredBytes: number,
    readonly freeBytes: number,
  ) {
    super('Not enough free space to stage this upload.');
  }
}

export interface UploadManifestFile {
  /** Path relative to the dropped folder, posix separators. Untrusted. */
  path: string;
  size: number;
}

export interface CreateUploadResult {
  uploadId: string;
  /** Manifest entries dropped by the allowlist, echoed so the UI can say so. */
  skipped: string[];
}

export interface UploadFileState {
  path: string;
  size: number;
  received: number;
}

export interface UploadState {
  files: UploadFileState[];
  state: string;
}

/** Same injected shape `LibraryImportService` uses, so tests stub one way. */
export type StatfsFn = (path: string) => { bsize: number; blocks: number; bavail: number };

export interface ImportUploadServiceOptions {
  db: Database;
  dataDir: string;
  musicDir: string;
  statfs?: StatfsFn;
}

/** `<dataDir>/staging/upload/<uploadId>` — a sibling of the import staging root. */
export function uploadStagingDir(dataDir: string, uploadId: string): string {
  return join(dataDir, 'staging', 'upload', uploadId);
}

/**
 * Refuse a stream past `cap` bytes, counting the running total rather than any
 * single buffer — a body arrives in arbitrarily-sized pieces, so checking one
 * chunk's length would let N small ones through.
 */
function capBytes(cap: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.byteLength;
      if (seen > cap) {
        cb(new ChunkTooLargeError(seen, cap));
        return;
      }
      cb(null, chunk);
    },
  });
}

export class ImportUploadService {
  private db: Database;
  private statfs: StatfsFn;

  constructor(private options: ImportUploadServiceOptions) {
    this.db = options.db;
    this.statfs = options.statfs ?? statfsSync;
  }

  sessionDir(uploadId: string): string {
    return uploadStagingDir(this.options.dataDir, uploadId);
  }

  /**
   * Validate a manifest, reserve the session directory, and preflight the
   * staging filesystem — all before a single byte is accepted, because
   * discovering "no room" after a 5 GB upload is the worst possible ordering.
   */
  create(userId: string | null, files: UploadManifestFile[]): CreateUploadResult {
    const uploadId = crypto.randomUUID();
    const dir = this.sessionDir(uploadId);

    const kept: UploadManifestFile[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      // Validate the path first: an unsafe path is a refusal, never a skip.
      // Silently dropping `../../etc/passwd` would hide a hostile client.
      try {
        safeArchivePath(dir, f.path);
      } catch (err) {
        if (err instanceof ArchiveError) throw new UploadPathRejectedError(f.path);
        throw err;
      }
      if (isUploadableName(f.path)) kept.push({ path: f.path, size: Math.max(0, f.size) });
      else skipped.push(f.path);
    }
    if (kept.length === 0) throw new UploadEmptyManifestError();

    const totalBytes = kept.reduce((n, f) => n + f.size, 0);
    this.preflightDisk(totalBytes);

    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    this.db.run(
      `INSERT INTO import_uploads (id, user_id, manifest_json, total_bytes, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      [uploadId, userId, JSON.stringify(kept), totalBytes, now, now],
    );
    return { uploadId, skipped };
  }

  /**
   * Write one chunk at an absolute offset. Absolute rather than append-only so a
   * re-sent chunk (which is what a resuming client does when it cannot know
   * whether the last one landed) rewrites the same bytes instead of duplicating
   * them.
   */
  async writeChunk(
    uploadId: string,
    relPath: string,
    offset: number,
    body: Uint8Array | ReadableStream<Uint8Array>,
  ): Promise<number> {
    const manifest = this.manifest(uploadId);
    if (!manifest) throw new UploadPathRejectedError(relPath);
    const declared = manifest.find((f) => f.path === relPath);
    if (!declared) throw new UploadPathRejectedError(relPath);

    // Two bounds collapse into one (#921). The chunk cap keeps a single request
    // small; the manifest's declared size keeps the *file* within what `create`
    // preflighted disk for — writing past it would make that reservation a lie.
    // Whichever is tighter wins.
    if (offset > declared.size) throw new ChunkTooLargeError(offset, declared.size);
    const cap = Math.min(IMPORT_UPLOAD_CHUNK_BYTES, declared.size - offset);

    const dest = safeArchivePath(this.sessionDir(uploadId), relPath);
    mkdirSync(dirname(dest), { recursive: true });
    const existed = existsSync(dest);
    const out = createWriteStream(dest, { flags: existed ? 'r+' : 'w', start: offset });
    const src =
      body instanceof Uint8Array
        ? Readable.from([Buffer.from(body)])
        : Readable.fromWeb(body as never);

    try {
      await pipeline(src, capBytes(cap), out);
    } catch (err) {
      // A refused chunk must leave nothing behind, or `state()` reports a
      // `received` that includes bytes the server rejected and the client
      // resumes from a position that was never accepted.
      this.truncateTo(dest, offset, existed);
      throw err;
    }
    this.touch(uploadId);
    return this.receivedBytes(dest);
  }

  /** Roll a failed write back to where the chunk started. */
  private truncateTo(dest: string, offset: number, existed: boolean): void {
    try {
      if (!existed && offset === 0) rmSync(dest, { force: true });
      else truncateSync(dest, offset);
    } catch (err) {
      log.warn({ dest, err }, 'Failed to roll back a rejected chunk');
    }
  }

  /**
   * Per-file progress, read back off disk so it survives a restart. Returns null
   * for an unknown session so a caller can 404 rather than invent an empty one.
   */
  state(uploadId: string): UploadState | null {
    const row = this.db
      .query<{ manifest_json: string; state: string }, [string]>(
        `SELECT manifest_json, state FROM import_uploads WHERE id = ?`,
      )
      .get(uploadId);
    if (!row) return null;
    const manifest = JSON.parse(row.manifest_json) as UploadManifestFile[];
    const dir = this.sessionDir(uploadId);
    return {
      state: row.state,
      files: manifest.map((f) => ({
        path: f.path,
        size: f.size,
        received: this.receivedBytes(join(dir, ...f.path.split('/'))),
      })),
    };
  }

  /** Drop a session and everything staged under it. */
  abort(uploadId: string): boolean {
    const dir = this.sessionDir(uploadId);
    rmSync(dir, { recursive: true, force: true });
    const res = this.db.run(`DELETE FROM import_uploads WHERE id = ?`, [uploadId]);
    return res.changes > 0;
  }

  /** Mark a session consumed by an import job; the bytes are the job's now. */
  markCommitted(uploadId: string, jobId: string): void {
    this.db.run(
      `UPDATE import_uploads SET state = 'committed', job_id = ?, updated_at = ? WHERE id = ?`,
      [jobId, Date.now(), uploadId],
    );
  }

  /**
   * Sweep sessions abandoned mid-upload. Bounded by `updated_at`, which every
   * chunk bumps, so a slow but live upload is never swept out from under itself.
   */
  sweepStale(now = Date.now()): number {
    const cutoff = now - IMPORT_UPLOAD_TTL_MS;
    const rows = this.db
      .query<{ id: string }, [number]>(
        `SELECT id FROM import_uploads WHERE state = 'open' AND updated_at < ?`,
      )
      .all(cutoff);
    for (const r of rows) {
      try {
        this.abort(r.id);
      } catch (err) {
        log.warn({ id: r.id, err }, 'Failed to sweep a stale upload session');
      }
    }
    return rows.length;
  }

  private manifest(uploadId: string): UploadManifestFile[] | null {
    const row = this.db
      .query<{ manifest_json: string }, [string]>(
        `SELECT manifest_json FROM import_uploads WHERE id = ? AND state = 'open'`,
      )
      .get(uploadId);
    return row ? (JSON.parse(row.manifest_json) as UploadManifestFile[]) : null;
  }

  private touch(uploadId: string): void {
    this.db.run(`UPDATE import_uploads SET updated_at = ? WHERE id = ?`, [Date.now(), uploadId]);
  }

  private receivedBytes(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  /**
   * The staging filesystem must hold the whole upload. Note this is `dataDir`,
   * not `musicDir` — the import job's own preflight covers the library side
   * later, and the two can be different mounts.
   */
  private preflightDisk(totalBytes: number): void {
    let free: number;
    try {
      const st = this.statfs(this.options.dataDir);
      free = st.bavail * st.bsize;
    } catch {
      return; // Unknowable free space is not a reason to refuse.
    }
    const required = totalBytes + IMPORT_UPLOAD_DISK_MARGIN_BYTES;
    if (free < required) throw new UploadTooLargeError(required, free);
  }
}
