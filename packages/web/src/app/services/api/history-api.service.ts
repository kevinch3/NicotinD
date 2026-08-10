import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type { ListeningStats, PrivacyState, RecentPlay, StatsPeriod } from './api-types';

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

  /** Aggregates over the caller's log for one period. */
  getStats(period: StatsPeriod): Observable<ListeningStats> {
    return this.http.get<ListeningStats>('/api/history/stats', { params: { period } });
  }

  /** What this instance stores about the caller, and what they can change. */
  getPrivacy(): Observable<PrivacyState> {
    return this.http.get<PrivacyState>('/api/privacy');
  }

  /** The caller's own listening-history opt-out. */
  setHistoryConsent(enabled: boolean): Observable<PrivacyState> {
    return this.http.put<PrivacyState>('/api/privacy/history-consent', { enabled });
  }

  /** Right of access (Art. 15) — everything tied to the caller. */
  exportMyData(): Observable<unknown> {
    return this.http.get('/api/privacy/export');
  }

  /** Right to erasure (Art. 17), scoped to the listening log. */
  deleteMyHistory(): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>('/api/privacy/history');
  }
}
