export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface UserSettings {
  userId: string;
  theme: 'light' | 'dark' | 'system';
  defaultSearchFilters: SearchFilters;
}

export interface SearchFilters {
  minBitrate?: number;
  fileTypes?: string[];
}

export interface UnifiedSearchResult {
  local: LocalSearchResult;
  network: NetworkSearchResult | null;
  searchId: string;
}

export interface LocalSearchResult {
  artists: Array<{ id: string; name: string; albumCount: number }>;
  albums: Array<{ id: string; name: string; artist: string; year?: number; coverArt?: string }>;
  songs: Array<{
    id: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    bitRate: number;
    coverArt?: string;
  }>;
}

export interface NetworkSearchResult {
  state: 'searching' | 'complete';
  responseCount: number;
  results: Array<{
    username: string;
    freeUploadSlots: number;
    uploadSpeed: number;
    files: Array<{
      filename: string;
      size: number;
      bitRate?: number;
      length?: number;
    }>;
  }>;
}

export interface SystemStatus {
  nicotind: { version: string; uptime: number };
  slskd: { healthy: boolean; connected: boolean; username?: string };
  navidrome: { healthy: boolean; scanning: boolean; songCount?: number };
}

export interface JwtPayload {
  sub: string;
  username: string;
  role: 'admin' | 'user';
  iat: number;
  exp: number;
}
