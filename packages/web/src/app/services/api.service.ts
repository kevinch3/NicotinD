import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { SlskdUserTransferGroup } from '@nicotind/core';

// ─── Response types ─────────────────────────────────────────────────

export interface SetupStatus {
  needsSetup: boolean;
}

export interface SetupResult {
  token: string;
  user: { id: string; username: string; role: string };
}

export interface AuthResult {
  token: string;
  user: { id: string; username: string; role: string };
}

export interface SearchResult {
  searchId: string;
  local: {
    artists: Array<{ id: string; name: string; albumCount?: number }>;
    albums: Array<{ id: string; name: string; artist: string; coverArt?: string; songCount?: number; year?: number }>;
    songs: Array<{ id: string; title: string; artist: string; album: string; duration?: number; coverArt?: string; track?: number }>;
  };
  network: null;
  networkAvailable?: boolean;
  errors?: string[];
}

export interface NetworkResults {
  state: 'searching' | 'complete';
  responseCount: number;
  canBrowse?: boolean;
  results: Array<{
    username: string;
    freeUploadSlots: number;
    uploadSpeed: number;
    queueLength?: number;
    files: Array<{
      filename: string;
      size: number;
      bitRate?: number;
      length?: number;
      title?: string;
      artist?: string;
      album?: string;
      trackNumber?: string;
    }>;
  }>;
}

export interface Album {
  id: string;
  name: string;
  artist: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  year?: number;
  classification?: 'album' | 'single' | 'compilation' | 'unknown';
  hidden?: boolean;
}

export interface AlbumDetail {
  id: string;
  name: string;
  artist: string;
  artistId?: string;
  coverArt?: string;
  year?: number;
  song: Array<{ id: string; title: string; artist: string; artistId?: string; albumId?: string; duration?: number; track?: number; coverArt?: string }>;
}

export interface ProvenanceRecord {
  action: string;
  detail: {
    from?: string;
    to?: string;
    kept?: string;
    mb_recording_id?: string;
    mb_release_id?: string;
    mb_album_title?: string;
    mb_artist_name?: string;
    reason?: string;
  };
  appliedAt: number;
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album: string;
  albumId: string;
  duration?: number;
  track?: number;
  coverArt?: string;
  path: string;
  bitRate: number;
  size: number;
  created: string;
}

export interface StreamingSettings {
  transcodeEnabled: boolean;
  format: 'mp3' | 'opus' | 'aac';
  maxBitRate: number;
  forceTranscode: boolean;
  ffmpegAvailable?: boolean;
}

export interface UserDir {
  name: string;
  fileCount: number;
  files: Array<{ filename: string; size: number; bitRate?: number; length?: number }>;
}

export type BrowseJobResult =
  | { state: 'pending' }
  | { state: 'complete'; dirs: UserDir[] }
  | { state: 'error'; error: string };

export interface AdminUser {
  id: string;
  username: string;
  role: string;
  status: string;
  created_at: string;
}

// ─── Service ────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  // Auth
  login(username: string, password: string) {
    return this.http.post<AuthResult>('/api/auth/login', { username, password });
  }

  register(username: string, password: string) {
    return this.http.post<AuthResult>('/api/auth/register', { username, password });
  }

  getRegistrationStatus() {
    return this.http.get<{ enabled: boolean }>('/api/auth/registration-status');
  }

  // Search
  search(q: string) {
    return this.http.get<SearchResult>('/api/search', { params: { q } });
  }

  pollNetwork(searchId: string) {
    return this.http.get<NetworkResults>(`/api/search/${searchId}/network`);
  }

  cancelSearch(searchId: string) {
    return this.http.put<{ ok: boolean }>(`/api/search/${searchId}/cancel`, {});
  }

  deleteSearch(searchId: string) {
    return this.http.delete<{ ok: boolean }>(`/api/search/${searchId}`);
  }

  // Catalog (metadata-driven) search — Lidarr/MusicBrainz lookup.
  catalogSearch(q: string) {
    return this.http.get<CatalogSearchResult>('/api/catalog/search', { params: { q } });
  }

  // Resolves a searched album into a real Lidarr album id (adding the artist on
  // demand) so the album-hunt flow can run against its canonical tracklist.
  catalogResolve(payload: {
    foreignAlbumId: string;
    artistMbid: string;
    artistName: string;
    albumTitle: string;
  }) {
    return this.http.post<CatalogResolveResult>('/api/catalog/resolve', payload);
  }

  // Downloads
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
    return this.http.get<{ jobId: string; state: string }>(`/api/users/${encodeURIComponent(username)}/browse`);
  }

  pollBrowse(username: string, jobId: string) {
    return this.http.get<BrowseJobResult>(`/api/users/${encodeURIComponent(username)}/browse/${encodeURIComponent(jobId)}`);
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

  // Library
  getAlbums(type = 'newest', size = 40, offset = 0, opts: { includeHidden?: boolean; classification?: string } = {}) {
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
  reclassifyAlbum(id: string, classification: 'album' | 'single' | 'compilation' | 'unknown') {
    return this.http.post<{ ok: boolean }>(`/api/library/albums/${id}/reclassify`, { classification });
  }
  clearAlbumOverride(id: string) {
    return this.http.post<{ ok: boolean }>(`/api/library/albums/${id}/clear-override`, {});
  }
  resyncLibrary() {
    return this.http.post<{ ok: boolean }>(`/api/library/sync`, {});
  }

  getAlbum(id: string) {
    return this.http.get<AlbumDetail>(`/api/library/albums/${id}`);
  }

  getArtists() {
    return this.http.get<Array<{ id: string; name: string; albumCount?: number }>>('/api/library/artists');
  }

  getArtist(id: string) {
    return this.http.get<{ artist: { id: string; name: string; albumCount: number; coverArt?: string }; albums: Album[] }>(
      `/api/library/artists/${id}`,
    );
  }

  getGenres() {
    return this.http.get<Array<{ value: string; songCount: number; albumCount: number }>>('/api/library/genres');
  }

  getSongsByGenre(genre: string, count = 100) {
    return this.http.get<Song[]>('/api/library/genres/songs', { params: { genre, count } });
  }

  getRecentSongs(size = 50) {
    return this.http.get<Song[]>('/api/library/recent-songs', { params: { size } });
  }

  getSongProvenance(id: string) {
    return this.http.get<ProvenanceRecord[]>(`/api/library/songs/${id}/provenance`);
  }

  getSimilarSongs(id: string, size = 20) {
    return this.http.get<Array<{
      id: string; title: string; artist: string; album: string;
      duration?: number; coverArt?: string; genre?: string; year?: number;
    }>>(`/api/library/songs/${id}/similar`, { params: { size } });
  }

  deleteSongs(ids: string[]) {
    return this.http.post<{ ok: boolean; deletedCount: number }>('/api/library/songs/bulk-delete', { ids });
  }

  deleteAlbum(id: string) {
    return this.http.delete<{ ok: boolean; deletedCount: number; failedCount: number; failed: Array<{ id: string; error: string }> }>(
      `/api/library/albums/${id}`,
    );
  }

  getDuplicates() {
    return this.http.get<Array<Array<{
      id: string; title: string; artist: string; album: string;
      duration?: number; bitRate?: number; suffix?: string; path: string; coverArt?: string;
    }>>>('/api/library/duplicates');
  }

  // System
  getStatus() {
    return this.http.get<{ slskd: { healthy: boolean } }>('/api/system/status');
  }

  triggerScan() {
    return this.http.post<{ ok: boolean }>('/api/system/scan', {});
  }

  getScanStatus() {
    return this.http.get<{ scanning: boolean; count: number }>('/api/system/scan/status');
  }

  restartService(service: 'slskd') {
    return this.http.post<{ ok: boolean }>(`/api/system/restart/${service}`, {});
  }

  getServiceLogs(service: string, lines = 100) {
    return this.http.get<{ logs: string[]; hint?: string }>(`/api/system/logs/${service}`, { params: { lines } });
  }

  // Settings
  getSoulseekSettings() {
    return this.http.get<{
      username: string; configured: boolean; connected: boolean;
      listeningPort?: number; enableUPnP?: boolean;
    }>('/api/settings/soulseek');
  }

  saveSoulseekSettings(username: string, password?: string, network?: { listeningPort: number; enableUPnP: boolean }) {
    return this.http.put<{ ok: boolean; message: string; connected?: boolean; username?: string }>(
      '/api/settings/soulseek',
      { username, password, ...network },
    );
  }

  getSoulseekStatus() {
    return this.http.get<{ configured: boolean; connected: boolean; username: string | null }>('/api/settings/soulseek/status');
  }

  toggleSoulseekConnection() {
    return this.http.post<{ connected: boolean }>('/api/settings/soulseek/toggle', {});
  }

  getShares() {
    return this.http.get<{ directories: string[] }>('/api/settings/shares');
  }

  addShare(path: string) {
    return this.http.post<{ ok: boolean }>('/api/settings/shares', { path });
  }

  removeShare(path: string) {
    return this.http.delete<{ ok: boolean }>(`/api/settings/shares/${encodeURIComponent(path)}`);
  }

  rescanShares() {
    return this.http.post<{ ok: boolean }>('/api/settings/shares/rescan', {});
  }

  // Streaming / transcoding
  getStreamingSettings() {
    return this.http.get<StreamingSettings>('/api/settings/streaming');
  }

  saveStreamingSettings(patch: Partial<StreamingSettings>) {
    return this.http.put<StreamingSettings>('/api/settings/streaming', patch);
  }

  // Setup (public — no auth token)
  getSetupStatus() {
    return this.http.get<SetupStatus>('/api/setup/status');
  }

  completeSetup(data: {
    admin: { username: string; password: string };
    soulseek?: { username: string; password: string };
  }) {
    return this.http.post<SetupResult>('/api/setup/complete', data);
  }

  // Admin
  getUsers() {
    return this.http.get<AdminUser[]>('/api/admin/users');
  }

  createUser(username: string, password: string) {
    return this.http.post<AdminUser>('/api/admin/users', { username, password });
  }

  updateUserRole(id: string, role: 'admin' | 'user') {
    return this.http.put<{ ok: boolean }>(`/api/admin/users/${id}/role`, { role });
  }

  updateUserStatus(id: string, status: 'active' | 'disabled') {
    return this.http.put<{ ok: boolean }>(`/api/admin/users/${id}/status`, { status });
  }

  resetUserPassword(id: string, password: string) {
    return this.http.put<{ ok: boolean }>(`/api/admin/users/${id}/password`, { password });
  }

  deleteUser(id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/admin/users/${id}`);
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
      selected: { username: string; directory: string; files: Array<{ filename: string; size: number }> };
      alternates: Array<{ username: string; directory: string; files: Array<{ filename: string; size: number }> }>;
    },
    replace = false,
  ) {
    return this.http.post<{ ok: boolean; queued: number }>(
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

export interface AlbumJob {
  id: number;
  lidarrAlbumId: number | null;
  artistName: string | null;
  albumTitle: string | null;
  username: string;
  directory: string;
  state: string;
  fallbackAttempts: number;
  createdAt: number;
}

export interface UntrackedDownload {
  transferKey: string;
  username: string;
  directory: string;
  filename: string;
  basename: string;
  completedAt: number;
}

export interface DiscographyTrack {
  lidarrId: number;
  title: string;
  trackNumber: string;
  duration: number;
  hasFile: boolean;
}

export interface DiscographyAlbum {
  lidarrId: number;
  foreignAlbumId: string;
  title: string;
  releaseDate?: string;
  albumType: string;
  secondaryTypes: string[];
  totalTracks: number;
  localTrackCount: number;
  status: 'present' | 'partial' | 'missing';
  localAlbumId?: string;
  coverArtUrl?: string;
  tracks: DiscographyTrack[];
}

export interface DiscographyResult {
  artistId: string;
  lidarrId: number;
  mbid: string;
  albums: DiscographyAlbum[];
}

export interface HuntFile {
  filename: string;
  size: number;
  bitRate?: number;
}

export interface FolderCandidate {
  directory: string;
  username: string;
  files: HuntFile[];
  matchedTracks: number;
  totalTracks: number;
  matchPct: number;
  format: string;
  estimatedSizeMb: number;
  isLive: boolean;
  freeUploadSlots: number;
  queueLength: number;
  uploadSpeed: number;
}

export interface HuntResult {
  candidates: FolderCandidate[];
  totalTracks: number;
  skewNeeded?: boolean;
}

export interface CatalogArtist {
  mbid: string;
  name: string;
  imageUrl?: string;
  type?: string;
}

export interface CatalogAlbum {
  foreignAlbumId: string;
  title: string;
  artistName: string;
  artistMbid: string;
  year?: string;
  albumType: string;
  secondaryTypes: string[];
  coverUrl?: string;
  trackCount: number;
}

export interface CatalogSearchResult {
  artists: CatalogArtist[];
  albums: CatalogAlbum[];
}

export interface CatalogResolveResult {
  lidarrAlbumId: number;
  totalTracks: number;
  title: string;
  artistName: string;
}
