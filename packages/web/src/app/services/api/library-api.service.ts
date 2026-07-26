import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { type Observable, of, map, catchError, tap } from 'rxjs';
import { createCachedObservable } from '../../lib/cached-observable';
import type {
  SongAcquisition,
  BpmAnalysisResult,
  GenreSuggestion,
  LicenceSuggestion,
  LyricsDto,
  MetadataCandidate,
  ApplyMetadataRequest,
  CoverCandidatesResponse,
  ApplyCoverRequest,
  LibraryFilter,
  ArtistInfoResponse,
} from '@nicotind/core';
import { serializeLibraryFilter, isEmptyLibraryFilter } from '@nicotind/core';
import type { Album, AlbumDetail, Song, ProvenanceRecord, ArtistIdentityResult } from './api-types';
import type { LibraryFragmentReport } from './api-types';

type QueryParams = Record<string, string | number | boolean | string[]>;

/** Merge the standardized filter's query params into a request's params. */
function withFilter(params: QueryParams, filter?: LibraryFilter): QueryParams {
  return filter ? { ...params, ...serializeLibraryFilter(filter) } : params;
}

/** Library reads/writes: albums, artists, songs, genres, lyrics, metadata fixes. */
@Injectable({ providedIn: 'root' })
export class LibraryApiService {
  private http = inject(HttpClient);

  getAlbums(
    type = 'newest',
    size = 40,
    offset = 0,
    opts: { includeHidden?: boolean; classification?: string; filter?: LibraryFilter } = {},
  ) {
    const params: QueryParams = { type, size, offset };
    if (opts.includeHidden) params['includeHidden'] = true;
    if (opts.classification) params['classification'] = opts.classification;
    return this.http.get<Album[]>('/api/library/albums', {
      params: withFilter(params, opts.filter),
    });
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
    return this.http
      .post<{
        albumId: string;
        artistId: string;
        artist: string;
        album: string;
        year: number | null;
        movedSongs: number;
        coverUpdated: boolean;
        releaseTypeUpdated: boolean;
      }>(`/api/library/albums/${id}/metadata`, body)
      .pipe(
        // A metadata fix re-points songs to a corrected artist: the server
        // inserts the new library_artists row and prunes the orphaned old one
        // (applyMetadataFix), so the cached artists list is stale (issue #237).
        tap(() => this.invalidateLibraryReads()),
      );
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
    return this.http.post<{ ok: boolean }>(`/api/library/sync`, {}).pipe(
      // A full resync rebuilds library_artists/library_genres, so the cached
      // artists/genres lists are stale afterwards (issue #237, same shape as #210).
      tap(() => this.invalidateLibraryReads()),
    );
  }
  /**
   * Library fragmentation report (admin). Three classes of defects that turn
   * "all tracks are present" into "album never surfaces":
   *  1. duplicate-albums (same release, distinct artist spellings → alias fix);
   *  2. hidden-by-classification (rows the default Albums grid omits);
   *  3. mis-split (one-track-per-title clusters; existing audit re-emitted).
   * Consumed by the Admin → Library panel and the `scripts/check-fragments.ts`
   * CLI gate. → `docs/library-scanner.md` "Fragmentation diagnostic".
   */
  getFragments(): Observable<LibraryFragmentReport> {
    return this.http.get<LibraryFragmentReport>(`/api/library/fragments`);
  }
  /**
   * User-corrected artist identity (admin): mark a compound one act, force-split it,
   * merge a spelling variant into another artist, or rename this artist to a
   * corrected spelling/name. Permanent source='user' authority; the server runs the
   * rescan synchronously and returns 200 once the change has landed.
   */
  /** Current effective genres for an artist + any user override (issue #187 A3). */
  artistGenre(id: string) {
    return this.http.get<{
      artist: string;
      current: string[];
      override: { genres: string[]; source: string; note: string | null } | null;
    }>(`/api/library/artists/${encodeURIComponent(id)}/genre`);
  }

  /** Genre weight distribution for the radar visualization (issue #222). */
  artistGenreDistribution(id: string) {
    return this.http.get<{
      artist: string;
      trackCount: number;
      genreCount: number;
      slices: Array<{ genre: string; count: number; weight: number }>;
    }>(`/api/library/artists/${encodeURIComponent(id)}/genre-distribution`);
  }

  /** Replace the primary genre for every track by this artist. Runs a sync rescan. */
  setArtistGenre(id: string, genres: string, note?: string) {
    return this.http
      .post<{ ok: boolean; genres: string[]; resynced: boolean }>(
        `/api/library/artists/${encodeURIComponent(id)}/genre`,
        { genres, note },
      )
      .pipe(
        // Server ran a sync rescan — the cached artists/genres lists are stale,
        // drop them or the Genres tab keeps showing the old aggregate counts
        // (issue #210; mirrors the fix on fixArtistIdentity).
        tap(() => this.invalidateLibraryReads()),
      );
  }

  clearArtistGenre(id: string) {
    return this.http
      .delete<{ ok: boolean; removed: boolean }>(
        `/api/library/artists/${encodeURIComponent(id)}/genre`,
      )
      .pipe(
        // Same as setArtistGenre: a clear also re-scans, so the cached lists are stale.
        tap(() => this.invalidateLibraryReads()),
      );
  }

  /** Force a re-fetch of this artist's bio/links from Discogs (curator; issue #195). */
  refreshArtistInfo(id: string) {
    return this.http.post<ArtistInfoResponse>(
      `/api/library/artists/${encodeURIComponent(id)}/refresh-info`,
      {},
    );
  }

  /**
   * Silent one-shot auto-fetch (issue #213). Fires from the web on first
   * artist-page visit when `metaExists=false`. Auth-gated on the server (any
   * role), not curator-gated; never surfaces a 409/502 — the response is
   * always `{ bio, urls }` so the caller never has to branch on status.
   * The server tombstones on a confident miss, so a repeat visit won't
   * re-query (the auto-fetch is naturally a one-shot per artist).
   */
  autoFetchArtistInfo(id: string) {
    return this.http.post<ArtistInfoResponse>(
      `/api/library/artists/${encodeURIComponent(id)}/auto-fetch-info`,
      {},
    );
  }

  /** Hand-edit an artist's bio/links — locks the background task out (curator). */
  setArtistInfo(id: string, bio: string | null, urls: string[]) {
    return this.http.put<ArtistInfoResponse>(
      `/api/library/artists/${encodeURIComponent(id)}/info`,
      {
        bio,
        urls,
      },
    );
  }

  fixArtistIdentity(
    body:
      | { rawName: string; decision: 'single' }
      | { rawName: string; decision: 'split'; members: string[] }
      | { rawName: string; mergeInto: string }
      | { rawName: string; rename: string },
  ): Observable<ArtistIdentityResult> {
    return this.http.post<ArtistIdentityResult>(`/api/library/artists/identity`, body).pipe(
      // The server re-scanned synchronously, so the cached artists/genres lists
      // are now stale — drop them or the artists grid keeps showing the old name
      // after a rename/merge/split (the bug this whole flow exists to fix).
      tap(() => this.invalidateLibraryReads()),
    );
  }

  getAlbum(id: string) {
    return this.http.get<AlbumDetail>(`/api/library/albums/${id}`);
  }

  // Stable, whole-library reads that the library page re-fetches on every visit.
  // Cached (shared + replayed) so tab-switching / re-navigation doesn't re-hit
  // the network; invalidated on library changes via invalidateLibraryReads().
  private artistsCache = createCachedObservable(() =>
    this.http.get<Array<{ id: string; name: string; albumCount?: number }>>('/api/library/artists'),
  );
  private genresCache = createCachedObservable(() =>
    this.http.get<Array<{ value: string; songCount: number; albumCount: number }>>(
      '/api/library/genres',
    ),
  );

  getArtists(filter?: LibraryFilter) {
    // The cache is the unfiltered fast path; filtered reads always hit the API.
    if (!filter || isEmptyLibraryFilter(filter)) return this.artistsCache.get();
    return this.http.get<Array<{ id: string; name: string; albumCount?: number }>>(
      '/api/library/artists',
      { params: withFilter({}, filter) },
    );
  }

  /** Drop cached artist/genre lists so the next read re-fetches (call after a
   * download lands or a delete that could change the artist/genre set). */
  invalidateLibraryReads(): void {
    this.artistsCache.invalidate();
    this.genresCache.invalidate();
  }

  getArtist(id: string) {
    return this.http.get<{
      artist: {
        id: string;
        name: string;
        albumCount: number;
        coverArt?: string;
        bio: string | null;
        urls: string[];
        // Issue #213: `false` means *never fetched*; the web fires a one-shot
        // auto-fetch in that case. `true && bio=null` is a tombstone (confident
        // miss) and must NOT trigger another fetch. `manualOverride=true` means
        // a curator edit — auto-fetch must not touch it.
        metaExists: boolean;
        manualOverride: boolean;
      };
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
  getSingles(type = 'newest', size = 60, offset = 0, filter?: LibraryFilter) {
    return this.http.get<Album[]>('/api/library/singles', {
      params: withFilter({ type, size, offset }, filter),
    });
  }

  getCompilations(type = 'newest', size = 500, offset = 0, filter?: LibraryFilter) {
    return this.http.get<Album[]>('/api/library/compilations', {
      params: withFilter({ type, size, offset }, filter),
    });
  }

  getArtistAppearsOn(id: string) {
    return this.http.get<Album[]>(`/api/library/artists/${id}/appears-on`);
  }

  // Paginated individual songs for one artist (the artist page's lazy "Songs" tab).
  getArtistSongs(
    id: string,
    size = 60,
    offset = 0,
    opts: { sort?: 'newest' | 'title' | 'album'; filter?: LibraryFilter } = {},
  ) {
    const params: QueryParams = { size, offset };
    if (opts.sort) params['sort'] = opts.sort;
    return this.http.get<Song[]>(`/api/library/artists/${id}/songs`, {
      params: withFilter(params, opts.filter),
    });
  }

  getGenres() {
    return this.genresCache.get();
  }

  getSongsByGenre(genre: string, count = 100) {
    return this.http.get<Song[]>('/api/library/genres/songs', { params: { genre, count } });
  }

  // Paginated flat listing of every landed song (the Library "Songs" tab).
  // Mirrors getArtistSongs but spans the whole library.
  getAllSongs(
    size = 60,
    offset = 0,
    opts: {
      sort?: 'newest' | 'title' | 'album';
      filter?: LibraryFilter;
      q?: string;
    } = {},
  ) {
    const params: QueryParams = { size, offset };
    if (opts.sort) params['sort'] = opts.sort;
    const q = opts.q?.trim();
    if (q) params['q'] = q;
    return this.http.get<Song[]>('/api/library/songs', {
      params: withFilter(params, opts.filter),
    });
  }

  getRadioNext(seedId: string, exclude: string[], count = 10) {
    return this.http.get<Song[]>('/api/radio/next', {
      params: { seedId, exclude: exclude.join(','), count },
    });
  }

  /** Filter-seeded radio (no seed song): start a "vibe" from a LibraryFilter. */
  getFilterRadio(filter: LibraryFilter, exclude: string[], count = 20) {
    return this.http.get<Song[]>('/api/radio/next', {
      params: withFilter({ exclude: exclude.join(','), count }, filter),
    });
  }

  /** Fetch a single song (incl. stored bpm/genre) by id; 404 → null. */
  getSong(id: string) {
    return this.http.get<Song>(`/api/library/songs/${id}`);
  }

  getSongProvenance(id: string) {
    return this.http.get<ProvenanceRecord[]>(`/api/library/songs/${id}/provenance`);
  }

  // ─── Likes (per-user "Liked Songs" playlist) ──────────────────────
  /** The ids of the user's liked songs — hydrates every heart's state at once. */
  getLikedIds() {
    return this.http.get<{ ids: string[] }>('/api/library/liked-ids');
  }

  likeSong(id: string) {
    return this.http.post<{ liked: boolean }>(`/api/library/songs/${id}/like`, {});
  }

  unlikeSong(id: string) {
    return this.http.delete<{ liked: boolean }>(`/api/library/songs/${id}/like`);
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
    return this.http
      .post<{ ok: boolean; genre: string }>(`/api/library/songs/${id}/genre`, {
        genre,
      })
      .pipe(
        // The server refreshes library_genres counts synchronously
        // (setSongGenres/appendSongGenres), so the cached Genres tab is stale
        // otherwise — the exact #210 shape for a per-song genre write (issue #237).
        tap(() => this.invalidateLibraryReads()),
      );
  }

  /** Detect a licence (read-only): file tag first, then MusicBrainz. */
  getLicenceSuggestion(id: string) {
    return this.http.get<LicenceSuggestion>(`/api/library/songs/${id}/licence-suggestion`);
  }

  /** Set (or clear, via '' / 'unknown') a song's licence (curator). */
  setLicence(id: string, licence: string) {
    return this.http.post<{ ok: boolean; licence: string | null }>(
      `/api/library/songs/${id}/licence`,
      { licence },
    );
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
    return this.http
      .post<{ ok: boolean; deletedCount: number }>('/api/library/songs/bulk-delete', {
        ids,
      })
      .pipe(
        // A bulk delete triggers a server-side runSync (rebuilds the aggregates),
        // and can drop an artist's last song or empty a genre — so the cached
        // artists/genres lists are stale afterwards (issue #237).
        tap(() => this.invalidateLibraryReads()),
      );
  }

  deleteAlbum(id: string) {
    return this.http
      .delete<{
        ok: boolean;
        deletedCount: number;
        failedCount: number;
        failed: Array<{ id: string; error: string }>;
      }>(`/api/library/albums/${id}`)
      .pipe(
        // The delete prunes the orphaned artist row and any now-empty genre row
        // (pruneOrphanArtist + library_genres cleanup), so the cached
        // artists/genres lists must be dropped or they keep showing them (issue #237).
        tap(() => this.invalidateLibraryReads()),
      );
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

  /** Tokenized, accent-insensitive song search for pickers (e.g. playlist "add song"). */
  searchSongsAutocomplete(q: string, limit = 8) {
    return this.http.get<Song[]>('/api/library/songs/autocomplete', { params: { q, limit } });
  }
}
