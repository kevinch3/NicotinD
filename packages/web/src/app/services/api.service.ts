import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { SlskdUserTransferGroup } from '@nicotind/core';

// ─── Response types ─────────────────────────────────────────────────

export interface SetupStatus {
  needsSetup: boolean;
  tailscale: {
    available: boolean;
    connected: boolean;
    hostname?: string;
    ip?: string;
  };
}

export interface SetupResult {
  token: string;
  user: { id: string; username: string; role: string };
  tailscale: {
    available: boolean;
    connected: boolean;
    hostname?: string;
    ip?: string;
  };
}

export interface TailscaleStatus {
  available: boolean;
  connected: boolean;
  hostname?: string;
  ip?: string;
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
  coverArt?: string;
  songCount?: number;
  year?: number;
}

export interface AlbumDetail {
  id: string;
  name: string;
  artist: string;
  coverArt?: string;
  year?: number;
  song: Array<{ id: string; title: string; artist: string; duration?: number; track?: number; coverArt?: string }>;
}

export interface Song {
  id: string;
  title: string;
  artist: string;
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

export interface Playlist {
  id: string;
  name: string;
  songCount: number;
  duration: number;
  owner: string;
  public: boolean;
  created: string;
  changed: string;
  coverArt?: string;
}

export interface PlaylistDetail extends Playlist {
  entry?: Array<{
    id: string;
    title: string;
    artist: string;
    album: string;
    duration?: number;
    track?: number;
    coverArt?: string;
  }>;
}

export interface UserDir {
  name: string;
  fileCount: number;
  files: Array<{ filename: string; size: number; bitRate?: number; length?: number }>;
}

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

  // Downloads
  enqueueDownload(username: string, files: Array<{ filename: string; size: number }>) {
    return this.http.post<{ ok: boolean }>('/api/downloads', { username, files });
  }

  cancelAllDownloads() {
    return this.http.delete<{ ok: boolean }>('/api/downloads');
  }

  browseUser(username: string) {
    return this.http.get<UserDir[]>(`/api/users/${encodeURIComponent(username)}/browse`);
  }

  getDownloads() {
    return this.http.get<SlskdUserTransferGroup[]>('/api/downloads');
  }

  cancelDownload(username: string, id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/downloads/${username}/${id}`);
  }

  // Library
  getAlbums(type = 'newest', size = 40, offset = 0) {
    return this.http.get<Album[]>('/api/library/albums', { params: { type, size, offset } });
  }

  getAlbum(id: string) {
    return this.http.get<AlbumDetail>(`/api/library/albums/${id}`);
  }

  getArtists() {
    return this.http.get<Array<{ id: string; name: string; albumCount?: number }>>('/api/library/artists');
  }

  getRecentSongs(size = 50) {
    return this.http.get<Song[]>('/api/library/recent-songs', { params: { size } });
  }

  getSimilarSongs(id: string, size = 20) {
    return this.http.get<Array<{
      id: string; title: string; artist: string; album: string;
      duration?: number; coverArt?: string; genre?: string; year?: number;
    }>>(`/api/library/songs/${id}/similar`, { params: { size } });
  }

  deleteSong(id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/library/songs/${id}`);
  }

  fixSongMetadata(id: string) {
    return this.http.post<{ fixed: boolean; changes?: { title?: string; artist?: string; album?: string } }>(
      `/api/library/songs/${id}/fix-metadata`, {},
    );
  }

  // System
  getStatus() {
    return this.http.get<{ slskd: { healthy: boolean }; navidrome: { healthy: boolean } }>('/api/system/status');
  }

  triggerScan() {
    return this.http.post<{ ok: boolean }>('/api/system/scan', {});
  }

  getScanStatus() {
    return this.http.get<{ scanning: boolean; count: number }>('/api/system/scan/status');
  }

  restartService(service: 'slskd' | 'navidrome') {
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

  // Playlists
  getPlaylists() {
    return this.http.get<Playlist[]>('/api/playlists');
  }

  getPlaylist(id: string) {
    return this.http.get<PlaylistDetail>(`/api/playlists/${id}`);
  }

  createPlaylist(name: string, songIds?: string[]) {
    return this.http.post<{ id: string; name: string }>('/api/playlists', { name, songIds });
  }

  updatePlaylist(id: string, updates: { name?: string; songIdsToAdd?: string[]; songIndexesToRemove?: number[] }) {
    return this.http.put<{ ok: boolean }>(`/api/playlists/${id}`, updates);
  }

  deletePlaylist(id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/playlists/${id}`);
  }

  // Setup (public — no auth token)
  getSetupStatus() {
    return this.http.get<SetupStatus>('/api/setup/status');
  }

  completeSetup(data: {
    admin: { username: string; password: string };
    soulseek?: { username: string; password: string };
    tailscale?: { authKey: string };
  }) {
    return this.http.post<SetupResult>('/api/setup/complete', data);
  }

  // Admin
  getUsers() {
    return this.http.get<AdminUser[]>('/api/admin/users');
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

  // Tailscale
  getTailscaleStatus() {
    return this.http.get<TailscaleStatus>('/api/tailscale/status');
  }

  connectTailscale(authKey: string) {
    return this.http.post<TailscaleStatus>('/api/tailscale/connect', { authKey });
  }

  disconnectTailscale() {
    return this.http.post<{ ok: boolean }>('/api/tailscale/disconnect', {});
  }
}
