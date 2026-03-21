import type { Playlist } from '@nicotind/core';
import type { NavidromeClient } from '../client.js';

export class PlaylistsApi {
  constructor(private client: NavidromeClient) {}

  async list(): Promise<Playlist[]> {
    const res = await this.client.request<{ playlists: { playlist: Playlist[] } }>(
      'getPlaylists.view',
    );
    return res.playlists.playlist ?? [];
  }

  async get(id: string): Promise<Playlist> {
    const res = await this.client.request<{ playlist: Playlist }>('getPlaylist.view', { id });
    return res.playlist;
  }

  async create(name: string, songIds?: string[]): Promise<Playlist> {
    const params: Record<string, string | string[]> = { name };
    if (songIds?.length) {
      params.songId = songIds;
    }
    const res = await this.client.request<{ playlist: Playlist }>(
      'createPlaylist.view',
      params,
    );
    return res.playlist;
  }

  async update(id: string, updates: { name?: string; songIdsToAdd?: string[]; songIndexesToRemove?: number[] }): Promise<void> {
    const params: Record<string, string | string[]> = { playlistId: id };
    if (updates.name) params.name = updates.name;
    if (updates.songIdsToAdd?.length) params.songIdToAdd = updates.songIdsToAdd;
    if (updates.songIndexesToRemove?.length) params.songIndexToRemove = updates.songIndexesToRemove.map(String);
    await this.client.request('updatePlaylist.view', params);
  }

  async delete(id: string): Promise<void> {
    await this.client.request('deletePlaylist.view', { id });
  }
}
