import type { ISearchProvider, ProviderType, SearchProviderResult } from '@nicotind/core';
import type { Navidrome } from '@nicotind/navidrome-client';

export class NavidromeSearchProvider implements ISearchProvider {
  readonly name = 'navidrome';
  readonly type: ProviderType = 'local';

  constructor(private navidrome: Navidrome) {}

  async search(query: string): Promise<{ results: SearchProviderResult | null }> {
    const res = await this.navidrome.search.search3(query, {
      artistCount: 10,
      albumCount: 10,
      songCount: 20,
    });

    return {
      results: {
        artists: res.artist ?? [],
        albums: res.album ?? [],
        songs: res.song ?? [],
      },
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      return await this.navidrome.system.ping();
    } catch {
      return false;
    }
  }
}
