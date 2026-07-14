import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { SlskdUserTransferGroup, AcquireJob, AcquisitionJobView } from '@nicotind/core';
import type {
  BrowseJobResult,
  DiscographyResult,
  HuntResult,
  FolderCandidate,
  AlbumJob,
  UntrackedDownload,
} from './api-types';

/** Acquisition: slskd transfers/browse, URL-acquire jobs, and the album hunt. */
@Injectable({ providedIn: 'root' })
export class DownloadsApiService {
  private http = inject(HttpClient);

  enqueueDownload(username: string, files: Array<{ filename: string; size: number }>) {
    return this.http.post<{ ok: boolean }>('/api/downloads', { username, files });
  }

  cancelAllDownloads() {
    return this.http.delete<{ ok: boolean }>('/api/downloads');
  }

  cancelAllFinished() {
    return this.http.delete<{ ok: boolean }>('/api/downloads/finished');
  }

  startBrowse(username: string) {
    return this.http.get<{ jobId: string; state: string }>(
      `/api/users/${encodeURIComponent(username)}/browse`,
    );
  }

  pollBrowse(username: string, jobId: string) {
    return this.http.get<BrowseJobResult>(
      `/api/users/${encodeURIComponent(username)}/browse/${encodeURIComponent(jobId)}`,
    );
  }

  getDownloads() {
    return this.http.get<SlskdUserTransferGroup[]>('/api/downloads');
  }

  cancelDownload(username: string, id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/downloads/${username}/${id}`);
  }

  retryDownloads(items: Array<{ username: string; id: string }>) {
    return this.http.post<{ ok: boolean; retried: number }>('/api/downloads/retry', { items });
  }

  getUploads() {
    return this.http.get<SlskdUserTransferGroup[]>('/api/uploads');
  }

  /** Unified acquisition-job feed (every download method, with pipeline stage). */
  getAcquisitionJobs() {
    return this.http.get<AcquisitionJobView[]>('/api/downloads/jobs');
  }

  // URL acquisition jobs (yt-dlp / spotdl)
  getAcquireJobs() {
    return this.http.get<AcquireJob[]>('/api/acquire/jobs');
  }

  deleteAcquireJob(id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/acquire/jobs/${id}`);
  }

  retryAcquireJob(id: string) {
    return this.http.post<{ jobId: string }>(`/api/acquire/jobs/${id}/retry`, {});
  }

  // Discography
  getArtistDiscography(artistId: string) {
    return this.http.get<DiscographyResult>(`/api/discography/artists/${artistId}`);
  }

  huntAlbum(
    lidarrAlbumId: number,
    overrides: { artistName?: string; albumTitle?: string; skewSearch?: boolean } = {},
  ) {
    return this.http.post<HuntResult>(`/api/discography/albums/${lidarrAlbumId}/hunt`, overrides);
  }

  // Phase-1 of the two-phase hunt: fires base queries only and returns whether
  // skew variants are needed (bestBasePct < threshold).
  huntAlbumBase(
    lidarrAlbumId: number,
    overrides: { artistName?: string; albumTitle?: string; skewSearch?: boolean } = {},
  ) {
    return this.http.post<HuntResult & { skewNeeded: boolean }>(
      `/api/discography/albums/${lidarrAlbumId}/hunt/base`,
      overrides,
    );
  }

  // §C1/§F2 fallback: when no whole-album folder exists, hunt each track
  // individually and enqueue the best match. Returns per-track outcome.
  huntAlbumTracks(lidarrAlbumId: number, artistName: string) {
    return this.http.post<{ requested: number; enqueued: number; misses: string[] }>(
      `/api/discography/albums/${lidarrAlbumId}/hunt-tracks`,
      { artistName },
    );
  }

  // Phase-2 of the two-phase hunt: fires skew-variant queries and returns
  // their candidates independently (frontend merges with base results).
  huntAlbumSkew(
    lidarrAlbumId: number,
    overrides: { artistName?: string; albumTitle?: string } = {},
  ) {
    return this.http.post<{ candidates: FolderCandidate[] }>(
      `/api/discography/albums/${lidarrAlbumId}/hunt/skew`,
      overrides,
    );
  }

  // Enqueues the chosen folder candidate and records an album job so failed
  // tracks can be recovered from the supplied alternate candidates.
  // `replace` (admin re-hunt) supersedes the album's prior active job so the
  // server's one-download-per-album guard allows a deliberate re-acquisition.
  huntDownload(
    lidarrAlbumId: number,
    payload: {
      selected: {
        username: string;
        directory: string;
        files: Array<{ filename: string; size: number }>;
      };
      alternates: Array<{
        username: string;
        directory: string;
        files: Array<{ filename: string; size: number }>;
      }>;
      // The local album being completed, so the server filters out tracks already
      // on disk even when the canonical artist/title diverges from the local tags.
      localAlbumId?: string;
    },
    replace = false,
  ) {
    return this.http.post<{ ok: boolean; queued: number; alreadyComplete?: boolean }>(
      `/api/discography/albums/${lidarrAlbumId}/hunt-download`,
      payload,
      { params: replace ? { replace: 'true' } : {} },
    );
  }

  // Album hunt jobs — for the "incomplete albums" surface. Defaults to the
  // incomplete ones (exhausted + still-active).
  listAlbumJobs(state: 'incomplete' | 'exhausted' | 'active' | 'done' | 'all' = 'incomplete') {
    return this.http.get<{ jobs: AlbumJob[] }>('/api/discography/jobs', { params: { state } });
  }

  // Completed downloads with no relative_path (predate the library organizer).
  getUntrackedDownloads(limit = 200) {
    return this.http.get<{ total: number; rows: UntrackedDownload[] }>('/api/library/untracked', {
      params: { limit: String(limit) },
    });
  }
}
