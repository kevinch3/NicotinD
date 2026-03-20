import { NavidromeClient, type NavidromeClientOptions } from './client.js';
import { SystemApi } from './api/system.js';
import { BrowsingApi } from './api/browsing.js';
import { SearchApi } from './api/search.js';
import { MediaApi } from './api/media.js';
import { PlaylistsApi } from './api/playlists.js';

export class Navidrome {
  private client: NavidromeClient;

  public system: SystemApi;
  public browsing: BrowsingApi;
  public search: SearchApi;
  public media: MediaApi;
  public playlists: PlaylistsApi;

  constructor(options: NavidromeClientOptions) {
    this.client = new NavidromeClient(options);
    this.system = new SystemApi(this.client);
    this.browsing = new BrowsingApi(this.client);
    this.search = new SearchApi(this.client);
    this.media = new MediaApi(this.client);
    this.playlists = new PlaylistsApi(this.client);
  }
}

export { NavidromeClient } from './client.js';
export type { NavidromeClientOptions } from './client.js';
