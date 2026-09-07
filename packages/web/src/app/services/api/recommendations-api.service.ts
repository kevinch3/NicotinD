import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type { ExcludedSong, FeedbackKind } from './api-types';

/**
 * Per-listener recommendation feedback: explicit "don't recommend this" votes,
 * their undo, and the variety votes the radio chip logs. Every endpoint is
 * scoped to the caller server-side and takes no user id.
 */
@Injectable({ providedIn: 'root' })
export class RecommendationsApiService {
  private http = inject(HttpClient);

  feedback(
    songId: string,
    kind: FeedbackKind,
    context?: Record<string, unknown>,
  ): Observable<{ id: number }> {
    return this.http.post<{ id: number }>('/api/recommendations/feedback', {
      songId,
      kind,
      context,
    });
  }

  getExcluded(): Observable<{ excluded: ExcludedSong[] }> {
    return this.http.get<{ excluded: ExcludedSong[] }>('/api/recommendations/excluded');
  }

  restore(songId: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(
      `/api/recommendations/excluded/${encodeURIComponent(songId)}`,
    );
  }
}
