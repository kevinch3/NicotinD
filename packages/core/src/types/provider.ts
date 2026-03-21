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

export interface NetworkFile {
  filename: string; // full file path, e.g. "Music\\Babasonicos\\Repuesto de Fe\\01 - Impacto.mp3"
  size: number;
  bitRate?: number;
  length?: number;
}

export interface NetworkPollResult {
  state: 'searching' | 'complete';
  responseCount: number;
  results: Array<{
    username: string;
    freeUploadSlots: number;
    uploadSpeed: number;
    queueLength?: number;
    files: NetworkFile[];
  }>;
  canBrowse?: boolean;
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

export interface BrowseDirectory {
  name: string; // full directory path, e.g. "Music\\Babasonicos\\Repuesto de Fe"
  fileCount: number;
  files: NetworkFile[];
}

export interface IBrowseProvider {
  readonly name: string;
  browseUser(username: string): Promise<BrowseDirectory[]>;
}

export class BrowseUnavailableError extends Error {
  constructor() {
    super('browse provider not available');
    this.name = 'BrowseUnavailableError';
  }
}
