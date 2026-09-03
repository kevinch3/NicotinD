import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

/** Per-file progress the server reads back off disk, so a resume survives a restart. */
export interface UploadFileState {
  path: string;
  size: number;
  received: number;
}

export interface UploadSessionState {
  state: string;
  files: UploadFileState[];
  /** The server's own chunk cap — never hardcode it client-side. */
  chunkBytes: number;
}

/**
 * Browser-upload import lane. Mirrors `routes/import-upload.ts` (mounted at
 * `/api/import`).
 *
 * Distinct from the admin server-path lane at `/api/admin/import`: this one is
 * `requireAcquirer` and stays reachable when acquisition is switched off, since
 * a streaming-only install is the deployment most likely to need it.
 */
@Injectable({ providedIn: 'root' })
export class ImportApiService {
  private http = inject(HttpClient);

  createSession(files: { path: string; size: number }[]) {
    return this.http.post<{ uploadId: string; skipped: string[] }>('/api/import/uploads', {
      files,
    });
  }

  /**
   * One chunk, raw body. `path`/`offset` ride the query string so the body stays
   * exactly the bytes — no multipart framing for the server to buffer or parse.
   */
  putChunk(uploadId: string, path: string, offset: number, blob: Blob) {
    const q = `path=${encodeURIComponent(path)}&offset=${offset}`;
    return this.http.put<{ received: number }>(
      `/api/import/uploads/${encodeURIComponent(uploadId)}/chunk?${q}`,
      blob,
    );
  }

  getSession(uploadId: string) {
    return this.http.get<UploadSessionState>(`/api/import/uploads/${encodeURIComponent(uploadId)}`);
  }

  commit(uploadId: string) {
    return this.http.post<{ jobId: string }>(
      `/api/import/uploads/${encodeURIComponent(uploadId)}/commit`,
      {},
    );
  }

  abort(uploadId: string) {
    return this.http.delete<{ ok: boolean }>(`/api/import/uploads/${encodeURIComponent(uploadId)}`);
  }
}
