import type { Artist, Album, Song } from '@nicotind/core';
import type { NavidromeClient } from '../client.js';

export class BrowsingApi {
  constructor(private client: NavidromeClient) {}

  async getArtists(): Promise<Artist[]> {
    const res = await this.client.request<{ artists: { index: Array<{ artist: Artist[] }> } }>(
      'getArtists.view',
    );
    return res.artists.index.flatMap((idx) => idx.artist ?? []);
  }

  async getArtist(id: string): Promise<{ artist: Artist; albums: Album[] }> {
    const res = await this.client.request<{ artist: Artist & { album: Album[] } }>(
      'getArtist.view',
      { id },
    );
    const { album, ...artist } = res.artist;
    return { artist, albums: album ?? [] };
  }

  async getAlbum(id: string): Promise<{ album: Album; songs: Song[] }> {
    const res = await this.client.request<{ album: Album & { song: Song[] } }>('getAlbum.view', {
      id,
    });
    const { song, ...album } = res.album;
    return { album, songs: song ?? [] };
  }

  async getSong(id: string): Promise<Song> {
    const res = await this.client.request<{ song: Song }>('getSong.view', { id });
    return res.song;
  }

  async getAlbumList(
    type: 'newest' | 'random' | 'frequent' | 'recent' | 'starred' | 'alphabeticalByName',
    size = 20,
    offset = 0,
  ): Promise<Album[]> {
    const res = await this.client.request<{ albumList2: { album: Album[] } }>(
      'getAlbumList2.view',
      { type, size: String(size), offset: String(offset) },
    );
    return res.albumList2.album ?? [];
  }

  async getGenres(): Promise<Array<{ value: string; songCount: number; albumCount: number }>> {
    const res = await this.client.request<{
      genres: { genre: Array<{ value: string; songCount: number; albumCount: number }> };
    }>('getGenres.view');
    return res.genres.genre ?? [];
  }

  async getRandomSongs(size = 10): Promise<Song[]> {
    const res = await this.client.request<{ randomSongs: { song: Song[] } }>(
      'getRandomSongs.view',
      { size: String(size) },
    );
    return res.randomSongs.song ?? [];
  }

  async getSongsByGenre(
    genre: string,
    count = 50,
    offset = 0,
  ): Promise<Song[]> {
    const res = await this.client.request<{ songsByGenre: { song?: Song[] } }>(
      'getSongsByGenre.view',
      { genre, count: String(count), offset: String(offset) },
    );
    return res.songsByGenre.song ?? [];
  }
}
