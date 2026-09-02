import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type { StemStatus } from './api-types';

/**
 * Karaoke stem prepare/status endpoint (issue #603). `prepare` is the
 * idempotent "make sure this stem exists" call; `status` never enqueues.
 */
@Injectable({ providedIn: 'root' })
export class StemApiService {
  private readonly http = inject(HttpClient);

  prepare(songId: string): Observable<StemStatus> {
    return this.http.post<StemStatus>(`/api/stream/${encodeURIComponent(songId)}/stem`, {});
  }

  status(songId: string): Observable<StemStatus> {
    return this.http.get<StemStatus>(`/api/stream/${encodeURIComponent(songId)}/stem`);
  }
}
