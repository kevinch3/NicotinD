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

  approve(albumId: string) {
    return this.http.post<{ ok: boolean }>(
      `/api/review/albums/${encodeURIComponent(albumId)}/approve`,
      {},
    );
  }

  discard(albumId: string) {
    return this.http.post<{ ok: boolean; deletedCount: number }>(
      `/api/review/albums/${encodeURIComponent(albumId)}/discard`,
      {},
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
