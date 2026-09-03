import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ImportApiService } from './api/import-api.service';
import {
  buildUploadManifest,
  chunkRanges,
  uploadPercent,
  type DroppedFile,
} from '../lib/upload-plan';

/** Attempts per chunk before the whole upload fails. */
const CHUNK_ATTEMPTS = 3;

export interface UploadOptions {
  /** 0–99, bytes-weighted. Never 100: the commit is what completes an upload. */
  onProgress?: (percent: number) => void;
  /** Entries the allowlist dropped, so the card can say what it ignored. */
  onSkipped?: (paths: string[]) => void;
  signal?: AbortSignal;
}

export class NothingToUploadError extends Error {
  constructor() {
    super('Nothing in that drop is music.');
  }
}

/**
 * Drives a browser upload through `/api/import` (docs/import.md).
 *
 * Sequential rather than parallel on purpose: the server writes chunks at
 * absolute offsets into one staging directory, and the bottleneck is the
 * uplink, which concurrency does not widen. Sequential also makes the progress
 * number monotonic, which a parallel version would not be.
 */
@Injectable({ providedIn: 'root' })
export class ImportUploadService {
  private api = inject(ImportApiService);

  /**
   * Upload a drop and hand the resulting import job back. Resolves with the job
   * id once the server has accepted the commit — before that point nothing has
   * entered the library, so a failure here costs only staged bytes.
   */
  async upload(dropped: DroppedFile[], opts: UploadOptions = {}): Promise<string> {
    const plan = buildUploadManifest(dropped);
    if (plan.skipped.length > 0) opts.onSkipped?.(plan.skipped);
    // Refuse before opening a session: a session with no uploadable file would
    // be a staging directory nothing ever fills, swept 24h later.
    if (plan.files.length === 0) throw new NothingToUploadError();

    const { uploadId } = await firstValueFrom(
      this.api.createSession(plan.files.map((f) => ({ path: f.path, size: f.size }))),
    );

    // The server owns the chunk size — a client constant would silently disagree
    // the moment the cap moves, and every chunk would 400.
    const session = await firstValueFrom(this.api.getSession(uploadId));
    const already = new Map(session.files.map((f) => [f.path, f.received]));

    let sent = [...already.values()].reduce((n, v) => n + v, 0);
    for (const file of plan.files) {
      const received = already.get(file.path) ?? 0;
      for (const range of chunkRanges(file.size, session.chunkBytes, received)) {
        opts.signal?.throwIfAborted();
        await this.putWithRetry(uploadId, file, range.offset, range.end);
        sent += range.end - range.offset;
        opts.onProgress?.(uploadPercent(sent, plan.totalBytes));
      }
    }

    const { jobId } = await firstValueFrom(this.api.commit(uploadId));
    return jobId;
  }

  /** Abandon a session and the bytes staged under it. Best-effort. */
  async abort(uploadId: string): Promise<void> {
    try {
      await firstValueFrom(this.api.abort(uploadId));
    } catch {
      /* the server sweeps an abandoned session anyway */
    }
  }

  /**
   * A dropped connection mid-upload is the expected case on a phone, not an
   * exceptional one. Retrying the chunk is safe because writes are addressed by
   * absolute offset: a re-sent chunk rewrites the same bytes rather than
   * appending them again.
   */
  private async putWithRetry(
    uploadId: string,
    file: DroppedFile,
    offset: number,
    end: number,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
      try {
        const slice = file.blob.slice(offset, end);
        await firstValueFrom(this.api.putChunk(uploadId, file.path, offset, slice));
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }
}
