import type { SearchResult3 } from '@nicotind/core';
import type { NavidromeClient } from '../client.js';

export class SearchApi {
  constructor(private client: NavidromeClient) {}

  async search3(
    query: string,
    options: {
      artistCount?: number;
      albumCount?: number;
      songCount?: number;
    } = {},
  ): Promise<SearchResult3> {
    const params: Record<string, string> = { query };
    if (options.artistCount !== undefined) params.artistCount = String(options.artistCount);
    if (options.albumCount !== undefined) params.albumCount = String(options.albumCount);
    if (options.songCount !== undefined) params.songCount = String(options.songCount);

    const res = await this.client.request<{ searchResult3: SearchResult3 }>('search3.view', params);
    return {
      artist: res.searchResult3.artist ?? [],
      album: res.searchResult3.album ?? [],
      song: res.searchResult3.song ?? [],
    };
  }
}
