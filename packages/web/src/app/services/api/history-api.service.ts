import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type { RecentPlay } from './api-types';

/**
 * Listening-history reads. The *write* side deliberately does not live here —
 * events go through `ListeningQueueService`, which owns the durable buffer and
 * the retry policy that offline playback depends on.
 *
 * Every endpoint is scoped to the authenticated caller server-side and takes no
 * user id, so there is nothing to pass and nothing to get wrong.
 */
@Injectable({ providedIn: 'root' })
export class HistoryApiService {
  private http = inject(HttpClient);

  /** The caller's recently listened tracks, newest first. Live songs only. */
  getRecentPlays(limit = 20): Observable<RecentPlay[]> {
    return this.http.get<RecentPlay[]>('/api/history/recent', { params: { limit } });
  }
}
