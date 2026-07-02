import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { PlaylistsApiService } from './api/playlists-api.service';
import type { PlaylistSummary, PlaylistDetail } from './api/api-types';

/**
 * Per-user playlists (web). Holds the summary list as a signal and drives the
 * global "Add to playlist" picker via `pendingSongIds` — any track row can call
 * `openPicker([songId])` and the modal mounted in the layout takes over.
 */
@Injectable({ providedIn: 'root' })
export class PlaylistService {
  private api = inject(PlaylistsApiService);

  readonly playlists = signal<PlaylistSummary[]>([]);
  readonly loaded = signal(false);

  /** Song ids awaiting a playlist choice; non-null opens the picker modal. */
  readonly pendingSongIds = signal<string[] | null>(null);

  async refresh(): Promise<void> {
    try {
      const res = await firstValueFrom(this.api.getPlaylists());
      this.playlists.set(res.playlists);
    } catch {
      // Non-fatal — leave the list empty.
    } finally {
      this.loaded.set(true);
    }
  }

  get(id: string): Promise<PlaylistDetail> {
    return firstValueFrom(this.api.getPlaylist(id));
  }

  async create(name: string, songIds?: string[]): Promise<PlaylistSummary> {
    const res = await firstValueFrom(this.api.createPlaylist(name, songIds));
    this.playlists.update((list) => [res.playlist, ...list]);
    return res.playlist;
  }

  /**
   * Generate a playlist from a seed (song / artist / starred set) via the Radio
   * scorer and prepend it to the list. Returns the created playlist.
   */
  async generate(
    seed: { songId?: string; artistId?: string; starred?: boolean },
    opts?: { name?: string; size?: number },
  ): Promise<PlaylistSummary> {
    const res = await firstValueFrom(this.api.generatePlaylist(seed, opts));
    this.playlists.update((list) => [res.playlist, ...list]);
    return res.playlist;
  }

  async addSongs(playlistId: string, songIds: string[]): Promise<void> {
    await firstValueFrom(this.api.updatePlaylist(playlistId, { add: songIds }));
    await this.refresh();
  }

  async removeSong(playlistId: string, songId: string): Promise<void> {
    await firstValueFrom(this.api.updatePlaylist(playlistId, { remove: [songId] }));
  }

  async rename(playlistId: string, name: string): Promise<void> {
    await firstValueFrom(this.api.updatePlaylist(playlistId, { name }));
    this.playlists.update((list) => list.map((p) => (p.id === playlistId ? { ...p, name } : p)));
  }

  async delete(playlistId: string): Promise<void> {
    await firstValueFrom(this.api.deletePlaylist(playlistId));
    this.playlists.update((list) => list.filter((p) => p.id !== playlistId));
  }

  // ─── Global "Add to playlist" picker ──────────────────────────────
  openPicker(songIds: string[]): void {
    if (!this.loaded()) void this.refresh();
    this.pendingSongIds.set(songIds);
  }

  closePicker(): void {
    this.pendingSongIds.set(null);
  }
}
