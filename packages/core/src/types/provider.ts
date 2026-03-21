export type ProviderType = 'local' | 'network';

export interface SearchProviderResult {
  artists: Array<{ id: string; name: string; albumCount?: number }>;
  albums: Array<{ id: string; name: string; artist: string; year?: number; coverArt?: string }>;
  songs: Array<{
    id: string;
    title: string;
    artist: string;
    album: string;
    duration?: number;
    bitRate?: number;
    coverArt?: string;
  }>;
}

export interface NetworkPollResult {
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

export interface ISearchProvider {
  readonly name: string;
  readonly type: ProviderType;

  /** Search — local providers return results, network providers return searchId for polling */
  search(query: string): Promise<{
    results: SearchProviderResult | null;
    searchId?: string;
  }>;

  /** Poll async results (network providers only) */
  pollResults?(searchId: string): Promise<NetworkPollResult>;

  /** Cancel an in-progress search */
  cancelSearch?(searchId: string): Promise<void>;

  /** Delete/cleanup a search */
  deleteSearch?(searchId: string): Promise<void>;

  /** Download files (network providers only) */
  download?(username: string, files: Array<{ filename: string; size: number }>): Promise<void>;

  /** Health check */
  isAvailable(): Promise<boolean>;
}
