import { useAuthStore } from '@/stores/auth';

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
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export const api = {
  // Auth
  login: (username: string, password: string) =>
    request<{ token: string }>('/api/auth/login', {
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
      results: Array<{
        username: string;
        freeUploadSlots: boolean;
        uploadSpeed: number;
        files: Array<{ filename: string; size: number; bitRate?: number; length?: number }>;
      }>;
    }>(`/api/search/${searchId}/network`),

  // Downloads
  enqueueDownload: (username: string, files: Array<{ filename: string; size: number }>) =>
    request<{ ok: boolean }>('/api/downloads', {
      method: 'POST',
      body: JSON.stringify({ username, files }),
    }),
  getDownloads: () => request<unknown[]>('/api/downloads'),
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
};
