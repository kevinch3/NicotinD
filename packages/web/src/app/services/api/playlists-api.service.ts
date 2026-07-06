import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { PlaylistSummary, PlaylistDetail } from './api-types';

/** Playlist CRUD (per-user). */
@Injectable({ providedIn: 'root' })
export class PlaylistsApiService {
  private http = inject(HttpClient);

  getPlaylists() {
    return this.http.get<{ playlists: PlaylistSummary[] }>('/api/playlists');
  }

  getPlaylist(id: string) {
    return this.http.get<PlaylistDetail>(`/api/playlists/${id}`);
  }

  createPlaylist(name: string, songIds?: string[], description?: string) {
    return this.http.post<{ playlist: PlaylistSummary }>('/api/playlists', {
      name,
      songIds,
      description,
    });
  }

  updatePlaylist(
    id: string,
    patch: {
      name?: string;
      description?: string;
      add?: string[];
      remove?: string[];
      reorder?: string[];
    },
  ) {
    return this.http.put<{ ok: boolean }>(`/api/playlists/${id}`, patch);
  }

  deletePlaylist(id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/playlists/${id}`);
  }

  /**
   * Generate a playlist from a seed (a song, an artist, or the starred set),
   * scored by the same engine that powers Radio. Returns the created, editable
   * user playlist.
   */
  generatePlaylist(
    seed: { songId?: string; artistId?: string; starred?: boolean },
    opts?: { name?: string; size?: number },
  ) {
    return this.http.post<{ playlist: PlaylistSummary }>('/api/playlists/generate', {
      seed,
      name: opts?.name,
      size: opts?.size,
    });
  }
}
