import { useAuthStore } from '@/stores/auth';
import type { SlskdUserTransferGroup } from '@nicotind/core';

const BASE = '';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = useAuthStore.getState().token;
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (res.status === 401) {
    useAuthStore.getState().logout();
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const errorMsg = (body as { error?: string }).error ?? `Request failed: ${res.status}`;

    // Kick out disabled users
    if (res.status === 403 && errorMsg === 'Account disabled') {
      useAuthStore.getState().logout();
    }

    throw new Error(errorMsg);
  }

  return res.json() as Promise<T>;
}

// Public request helper (no auth token)
async function publicRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

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

export const api = {
  // Auth
  login: (username: string, password: string) =>
    request<{ token: string; user: { id: string; username: string; role: string } }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  register: (username: string, password: string) =>
    request<{ token: string; user: { id: string; username: string; role: string } }>(
      '/api/auth/register',
      { method: 'POST', body: JSON.stringify({ username, password }) },
    ),

  // Search
  search: (q: string) =>
    request<{
      searchId: string;
      local: {
        artists: Array<{ id: string; name: string; albumCount?: number }>;
        albums: Array<{ id: string; name: string; artist: string; coverArt?: string; songCount?: number; year?: number }>;
        songs: Array<{ id: string; title: string; artist: string; album: string; duration?: number; coverArt?: string; track?: number }>;
      };
      network: null;
      networkAvailable?: boolean;
      errors?: string[];
    }>(`/api/search?q=${encodeURIComponent(q)}`),

  pollNetwork: (searchId: string) =>
    request<{
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
    }>(`/api/search/${searchId}/network`),
  cancelSearch: (searchId: string) =>
    request<{ ok: boolean }>(`/api/search/${searchId}/cancel`, { method: 'PUT' }),
  deleteSearch: (searchId: string) =>
    request<{ ok: boolean }>(`/api/search/${searchId}`, { method: 'DELETE' }),

  // Downloads
  enqueueDownload: (username: string, files: Array<{ filename: string; size: number }>) =>
    request<{ ok: boolean }>('/api/downloads', {
      method: 'POST',
      body: JSON.stringify({ username, files }),
    }),
  cancelAllDownloads: () =>
    request<{ ok: boolean }>('/api/downloads', { method: 'DELETE' }),
  browseUser: (username: string) =>
    request<Array<{
      name: string;
      fileCount: number;
      files: Array<{ filename: string; size: number; bitRate?: number; length?: number }>;
    }>>(`/api/users/${encodeURIComponent(username)}/browse`),
  getDownloads: () => request<SlskdUserTransferGroup[]>('/api/downloads'),
  cancelDownload: (username: string, id: string) =>
    request<{ ok: boolean }>(`/api/downloads/${username}/${id}`, { method: 'DELETE' }),

  // Library
  getAlbums: (type = 'newest', size = 40, offset = 0) =>
    request<Array<{ id: string; name: string; artist: string; coverArt?: string; songCount?: number; year?: number }>>(
      `/api/library/albums?type=${type}&size=${size}&offset=${offset}`,
    ),
  getAlbum: (id: string) =>
    request<{ id: string; name: string; artist: string; coverArt?: string; song: Array<{ id: string; title: string; artist: string; duration?: number; track?: number; coverArt?: string }> }>(
      `/api/library/albums/${id}`,
    ),
  getArtists: () =>
    request<Array<{ id: string; name: string; albumCount?: number }>>(
      '/api/library/artists',
    ),

  // System
  getStatus: () =>
    request<{ slskd: { healthy: boolean }; navidrome: { healthy: boolean } }>('/api/system/status'),
  triggerScan: () =>
    request<{ ok: boolean }>('/api/system/scan', { method: 'POST' }),
  getScanStatus: () =>
    request<{ scanning: boolean; count: number }>('/api/system/scan/status'),
  restartService: (service: 'slskd' | 'navidrome') =>
    request<{ ok: boolean }>(`/api/system/restart/${service}`, { method: 'POST' }),
  getServiceLogs: (service: string, lines = 100) =>
    request<{ logs: string[]; hint?: string }>(`/api/system/logs/${service}?lines=${lines}`),

  // Settings
  getSoulseekSettings: () =>
    request<{
      username: string;
      configured: boolean;
      connected: boolean;
      listeningPort?: number;
      enableUPnP?: boolean;
    }>('/api/settings/soulseek'),
  saveSoulseekSettings: (
    username: string,
    password?: string,
    network?: { listeningPort: number; enableUPnP: boolean },
  ) =>
    request<{ ok: boolean; message: string; connected?: boolean; username?: string }>(
      '/api/settings/soulseek',
      {
        method: 'PUT',
        body: JSON.stringify({ username, password, ...network }),
      },
    ),
  getSoulseekStatus: () =>
    request<{ configured: boolean; connected: boolean; username: string | null }>('/api/settings/soulseek/status'),

  // Library management
  getRecentSongs: (size = 50) =>
    request<Array<{
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
    }>>(`/api/library/recent-songs?size=${size}`),
  getSimilarSongs: (id: string, size = 20) =>
    request<Array<{
      id: string;
      title: string;
      artist: string;
      album: string;
      duration?: number;
      coverArt?: string;
      genre?: string;
      year?: number;
    }>>(`/api/library/songs/${id}/similar?size=${size}`),
  deleteSong: (id: string) =>
    request<{ ok: boolean }>(`/api/library/songs/${id}`, { method: 'DELETE' }),
  fixSongMetadata: (id: string) =>
    request<{ fixed: boolean; changes?: { title?: string; artist?: string; album?: string } }>(
      `/api/library/songs/${id}/fix-metadata`,
      { method: 'POST' },
    ),

  // Playlists
  getPlaylists: () =>
    request<Array<{
      id: string;
      name: string;
      songCount: number;
      duration: number;
      owner: string;
      public: boolean;
      created: string;
      changed: string;
      coverArt?: string;
    }>>('/api/playlists'),
  getPlaylist: (id: string) =>
    request<{
      id: string;
      name: string;
      songCount: number;
      duration: number;
      owner: string;
      public: boolean;
      created: string;
      changed: string;
      coverArt?: string;
      entry?: Array<{
        id: string;
        title: string;
        artist: string;
        album: string;
        duration?: number;
        track?: number;
        coverArt?: string;
      }>;
    }>(`/api/playlists/${id}`),
  createPlaylist: (name: string, songIds?: string[]) =>
    request<{ id: string; name: string }>('/api/playlists', {
      method: 'POST',
      body: JSON.stringify({ name, songIds }),
    }),
  updatePlaylist: (id: string, updates: { name?: string; songIdsToAdd?: string[]; songIndexesToRemove?: number[] }) =>
    request<{ ok: boolean }>(`/api/playlists/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),
  deletePlaylist: (id: string) =>
    request<{ ok: boolean }>(`/api/playlists/${id}`, { method: 'DELETE' }),

  // Setup
  getSetupStatus: () => publicRequest<SetupStatus>('/api/setup/status'),
  completeSetup: (data: {
    admin: { username: string; password: string };
    soulseek?: { username: string; password: string };
    tailscale?: { authKey: string };
  }) =>
    publicRequest<SetupResult>('/api/setup/complete', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Admin
  getUsers: () =>
    request<Array<{ id: string; username: string; role: string; status: string; created_at: string }>>('/api/admin/users'),
  updateUserRole: (id: string, role: 'admin' | 'user') =>
    request<{ ok: boolean }>(`/api/admin/users/${id}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    }),
  updateUserStatus: (id: string, status: 'active' | 'disabled') =>
    request<{ ok: boolean }>(`/api/admin/users/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    }),
  resetUserPassword: (id: string, password: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}/password`, {
      method: 'PUT',
      body: JSON.stringify({ password }),
    }),
  deleteUser: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' }),

  // Tailscale
  getTailscaleStatus: () => request<TailscaleStatus>('/api/tailscale/status'),
  connectTailscale: (authKey: string) =>
    request<TailscaleStatus>('/api/tailscale/connect', {
      method: 'POST',
      body: JSON.stringify({ authKey }),
    }),
  disconnectTailscale: () =>
    request<{ ok: boolean }>('/api/tailscale/disconnect', { method: 'POST' }),
};
