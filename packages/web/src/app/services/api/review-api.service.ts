import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { IdentifyOutcome, IdentifyResult } from '@nicotind/core';
import type { ReviewQueueAlbum } from './api-types';

/**
 * Download inbox triage (issue #411): the curator-facing review queue —
 * list/approve/discard quarantine-held albums, fingerprint-identify a
 * mis-tagged track (or a whole album's worth), and retag tracks in place.
 * Mirrors `routes/download-review.ts` (mounted at `/api/review`).
 */
@Injectable({ providedIn: 'root' })
export class ReviewApiService {
  private http = inject(HttpClient);

  getQueue() {
    return this.http.get<{ albums: ReviewQueueAlbum[] }>('/api/review/queue');
  }

  getCount() {
    return this.http.get<{ pending: number }>('/api/review/count');
  }

  /** `landed`/`timedOut`/`pendingTasks`/`pendingSongCount` reflect whether the
   *  approved album's songs are already visible in the library (issue #708) —
   *  the approve decision itself always succeeds regardless. */
  approve(albumId: string) {
    return this.http.post<{
      ok: boolean;
      landed?: boolean;
      timedOut?: boolean;
      pendingTasks?: string[];
      pendingSongCount?: number;
    }>(`/api/review/albums/${encodeURIComponent(albumId)}/approve`, {});
  }

  discard(albumId: string) {
    return this.http.post<{ ok: boolean; deletedCount: number }>(
      `/api/review/albums/${encodeURIComponent(albumId)}/discard`,
      {},
    );
  }

  /** Bulk approve (#808): decisions land in one transactional request; landing
   *  happens in the background — never any `landed` claim. */
  approveAll(albumIds: string[]) {
    return this.http.post<{ approved: string[]; notFound: string[] }>(
      '/api/review/albums/approve-all',
      { albumIds },
    );
  }

  /** Bulk discard (#808): one request, deletes run sequentially server-side. */
  discardAll(albumIds: string[]) {
    return this.http.post<{ discarded: string[]; notFound: string[]; failed: string[] }>(
      '/api/review/albums/discard-all',
      { albumIds },
    );
  }

  identifySong(id: string) {
    return this.http.post<{ result: IdentifyResult | null; outcome: IdentifyOutcome }>(
      `/api/review/songs/${encodeURIComponent(id)}/identify`,
      {},
    );
  }

  identifyAlbum(id: string) {
    return this.http.post<{
      perTrack: Array<{ songId: string; result: IdentifyResult | null; outcome: IdentifyOutcome }>;
      vote: { artist: string; album: string; votes: number; total: number } | null;
    }>(`/api/review/albums/${encodeURIComponent(id)}/identify`, {});
  }

  retagTracks(albumId: string, tracks: Array<{ id: string; title?: string; artist?: string }>) {
    return this.http.post<{
      updated: number;
      failed: Array<{ id: string; error: string }>;
      rescanned: boolean;
    }>(`/api/review/albums/${encodeURIComponent(albumId)}/tracks`, { tracks });
  }
}
