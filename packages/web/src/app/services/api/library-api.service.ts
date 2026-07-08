import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { type Observable, of, map, catchError } from 'rxjs';
import { createCachedObservable } from '../../lib/cached-observable';
import type {
  SongAcquisition,
  BpmAnalysisResult,
  GenreSuggestion,
  LyricsDto,
  MetadataCandidate,
  ApplyMetadataRequest,
  CoverCandidatesResponse,
  ApplyCoverRequest,
} from '@nicotind/core';
import type { Album, AlbumDetail, Song, ProvenanceRecord } from './api-types';

/** Library reads/writes: albums, artists, songs, genres, lyrics, metadata fixes. */
@Injectable({ providedIn: 'root' })
export class LibraryApiService {
  private http = inject(HttpClient);

  getAlbums(
    type = 'newest',
    size = 40,
    offset = 0,
    opts: { includeHidden?: boolean; classification?: string } = {},
  ) {
    const params: Record<string, string | number | boolean> = { type, size, offset };
    if (opts.includeHidden) params['includeHidden'] = true;
    if (opts.classification) params['classification'] = opts.classification;
    return this.http.get<Album[]>('/api/library/albums', { params });
  }

  hideAlbum(id: string) {
    return this.http.post<{ ok: boolean }>(`/api/library/albums/${id}/hide`, {});
  }
  unhideAlbum(id: string) {
    return this.http.post<{ ok: boolean }>(`/api/library/albums/${id}/unhide`, {});
  }
  reclassifyAlbum(
    id: string,
    classification: 'album' | 'ep' | 'single' | 'compilation' | 'unknown',
  ) {
    return this.http.post<{ ok: boolean }>(`/api/library/albums/${id}/reclassify`, {
      classification,
    });
  }
  clearAlbumOverride(id: string) {
    return this.http.post<{ ok: boolean }>(`/api/library/albums/${id}/clear-override`, {});
  }
  /** Re-fetch better cover/year/release-type for one album from Lidarr (admin). */
  optimizeAlbumMetadata(id: string) {
    return this.http.post<{
      matched: boolean;
      coverUpdated: boolean;
      yearUpdated: boolean;
      releaseTypeUpdated: boolean;
    }>(`/api/library/albums/${id}/optimize-metadata`, {});
  }
  /**
   * Search Lidarr/MusicBrainz for candidate releases to fix an album's metadata
   * (admin). `q` overrides the default "<artist> <album>" query — needed when the
   * stored artist is wrong and poisons it.
   */
  getMetadataCandidates(id: string, q?: string) {
    const qs = q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
    return this.http.get<{
      album: { id: string; name: string; artist: string };
      query: string;
      candidates: MetadataCandidate[];
    }>(`/api/library/albums/${id}/metadata-candidates${qs}`);
  }
  /** Apply a user-confirmed metadata correction (candidate or free-text; admin). */
  applyMetadata(id: string, body: ApplyMetadataRequest) {
    return this.http.post<{
      albumId: string;
      artistId: string;
      artist: string;
      album: string;
      year: number | null;
      movedSongs: number;
      coverUpdated: boolean;
      releaseTypeUpdated: boolean;
    }>(`/api/library/albums/${id}/metadata`, body);
  }
  /**
   * Cover candidates for an album (admin): the current cover, Lidarr
   * alternatives (when configured), and per-track embedded art. `q` overrides
   * the Lidarr lookup query.
   */
  getCoverCandidates(id: string, q?: string) {
    const qs = q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
    return this.http.get<CoverCandidatesResponse>(
      `/api/library/albums/${id}/cover-candidates${qs}`,
    );
  }
  /** Apply only the album cover (admin) — by URL or an album track's embedded art. */
  applyCover(id: string, body: ApplyCoverRequest) {
    return this.http.post<{ ok: boolean }>(`/api/library/albums/${id}/cover`, body);
  }
  /** Upload a custom cover image for an album (admin); converted + written as the folder cover. */
  uploadAlbumCover(id: string, file: File) {
    const form = new FormData();
    form.append('image', file);
    return this.http.put<{ ok: boolean }>(`/api/library/albums/${id}/cover`, form);
  }
  /** Upload a custom artist portrait (admin); overrides auto artwork + placeholder. */
  uploadArtistImage(id: string, file: File) {
    const form = new FormData();
    form.append('image', file);
    return this.http.put<{ ok: boolean }>(`/api/library/artists/${id}/image`, form);
  }
  /** Use one of the artist's album covers as the portrait (admin). */
  setArtistImageFromAlbum(id: string, albumId: string) {
    return this.http.post<{ ok: boolean }>(`/api/library/artists/${id}/image/from-album`, {
      albumId,
    });
  }
  /** Remove the manual artist-image override → revert to auto/placeholder (admin). */
  resetArtistImage(id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/library/artists/${id}/image`);
  }
  /** Library-wide metadata optimization (admin). `all` re-verifies every album. */
  optimizeAllMetadata(all = false) {
    return this.http.post<{
      ok: boolean;
      albums: number;
      matched: number;
      coversUpdated: number;
      yearsUpdated: number;
      releaseTypesUpdated: number;
    }>(`/api/admin/metadata-optimize${all ? '?all=1' : ''}`, {});
  }
  resyncLibrary() {
    return this.http.post<{ ok: boolean }>(`/api/library/sync`, {});
  }

  getAlbum(id: string) {
    return this.http.get<AlbumDetail>(`/api/library/albums/${id}`);
  }

  // Stable, whole-library reads that the library page re-fetches on every visit.
  // Cached (shared + replayed) so tab-switching / re-navigation doesn't re-hit
  // the network; invalidated on library changes via invalidateLibraryReads().
  private artistsCache = createCachedObservable(() =>
    this.http.get<Array<{ id: string; name: string; albumCount?: number }>>(
      '/api/library/artists',
    ),
  );
  private genresCache = createCachedObservable(() =>
    this.http.get<Array<{ value: string; songCount: number; albumCount: number }>>(
      '/api/library/genres',
    ),
  );

  getArtists() {
    return this.artistsCache.get();
  }

  /** Drop cached artist/genre lists so the next read re-fetches (call after a
   * download lands or a delete that could change the artist/genre set). */
  invalidateLibraryReads(): void {
    this.artistsCache.invalidate();
    this.genresCache.invalidate();
  }

  getArtist(id: string) {
    return this.http.get<{
      artist: { id: string; name: string; albumCount: number; coverArt?: string };
      albums: Album[];
      singlesAndEps: Album[];
    }>(`/api/library/artists/${id}`);
  }

  /** Resolve an artist name → local artist id (null when not in the library). */
  resolveArtistIdByName(name: string): Observable<string | null> {
    return this.http.get<{ id: string }>('/api/library/artists/by-name', { params: { name } }).pipe(
      map((r) => r.id),
      catchError(() => of(null)),
    );
  }

  // Dedicated singles & EPs listing (kept out of the main Albums grid).
  getSingles(type = 'newest', size = 60, offset = 0) {
    return this.http.get<Album[]>('/api/library/singles', { params: { type, size, offset } });
  }

  getCompilations(type = 'newest', size = 500, offset = 0) {
    return this.http.get<Album[]>('/api/library/compilations', { params: { type, size, offset } });
  }

  getArtistAppearsOn(id: string) {
    return this.http.get<Album[]>(`/api/library/artists/${id}/appears-on`);
  }

  // Paginated individual songs for one artist (the artist page's lazy "Songs" tab).
  getArtistSongs(
    id: string,
    size = 60,
    offset = 0,
    opts: { sort?: 'newest' | 'title' | 'album'; starred?: boolean } = {},
  ) {
    const params: Record<string, string | number | boolean> = { size, offset };
    if (opts.sort) params['sort'] = opts.sort;
    if (opts.starred) params['starred'] = true;
    return this.http.get<Song[]>(`/api/library/artists/${id}/songs`, { params });
  }

  getGenres() {
    return this.genresCache.get();
  }

  getSongsByGenre(genre: string, count = 100) {
    return this.http.get<Song[]>('/api/library/genres/songs', { params: { genre, count } });
  }

  getRecentSongs(size = 50) {
    return this.http.get<Song[]>('/api/library/recent-songs', { params: { size } });
  }

  getRadioNext(seedId: string, exclude: string[], count = 10) {
    return this.http.get<Song[]>('/api/radio/next', {
      params: { seedId, exclude: exclude.join(','), count },
    });
  }

  /** Fetch a single song (incl. stored bpm/genre) by id; 404 → null. */
  getSong(id: string) {
    return this.http.get<Song>(`/api/library/songs/${id}`);
  }

  getSongProvenance(id: string) {
    return this.http.get<ProvenanceRecord[]>(`/api/library/songs/${id}/provenance`);
  }

  /** Acquisition provenance (how/where-from/when); null when unrecorded. */
  getSongAcquisition(id: string) {
    return this.http.get<SongAcquisition | null>(`/api/library/songs/${id}/acquisition`);
  }

  /** On-demand BPM analysis: returns a tag value or freshly analyzed tempo. */
  analyzeSong(id: string) {
    return this.http.post<BpmAnalysisResult>(`/api/library/songs/${id}/analyze`, {});
  }

  /** Genre verification against Lidarr/MusicBrainz (read-only suggestion). */
  getGenreSuggestion(id: string) {
    return this.http.get<GenreSuggestion>(`/api/library/songs/${id}/genre-suggestion`);
  }

  /** Apply a genre to a song (admin); writes the tag + updates the library. */
  applyGenre(id: string, genre: string) {
    return this.http.post<{ ok: boolean; genre: string }>(`/api/library/songs/${id}/genre`, {
      genre,
    });
  }

  /** Stored lyrics for a song; null when none have been fetched yet. */
  getLyrics(id: string) {
    return this.http.get<LyricsDto | null>(`/api/library/songs/${id}/lyrics`);
  }

  /** Fetch lyrics on demand from an enabled source; null when none found. */
  fetchLyrics(id: string, force = false) {
    return this.http.post<LyricsDto | null>(`/api/library/songs/${id}/lyrics/fetch`, { force });
  }

  /** Save user-edited lyrics (admin); marks them customized + writes the tag. */
  saveLyrics(id: string, plain: string) {
    return this.http.put<LyricsDto>(`/api/library/songs/${id}/lyrics`, { plain });
  }

  /** Reset a song's lyrics (admin); drops the stored row. */
  deleteLyrics(id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/library/songs/${id}/lyrics`);
  }

  getSimilarSongs(id: string, size = 20) {
    return this.http.get<
      Array<{
        id: string;
        title: string;
        artist: string;
        album: string;
        duration?: number;
        coverArt?: string;
        genre?: string;
        year?: number;
      }>
    >(`/api/library/songs/${id}/similar`, { params: { size } });
  }

  deleteSongs(ids: string[]) {
    return this.http.post<{ ok: boolean; deletedCount: number }>('/api/library/songs/bulk-delete', {
      ids,
    });
  }

  deleteAlbum(id: string) {
    return this.http.delete<{
      ok: boolean;
      deletedCount: number;
      failedCount: number;
      failed: Array<{ id: string; error: string }>;
    }>(`/api/library/albums/${id}`);
  }

  getDuplicates() {
    return this.http.get<
      Array<
        Array<{
          id: string;
          title: string;
          artist: string;
          album: string;
          duration?: number;
          bitRate?: number;
          suffix?: string;
          path: string;
          coverArt?: string;
        }>
      >
    >('/api/library/duplicates');
  }
}
