import { create } from 'zustand';

interface LocalResults {
  artists: Array<{ id: string; name: string; albumCount?: number }>;
  albums: Array<{ id: string; name: string; artist: string; coverArt?: string; year?: number }>;
  songs: Array<{ id: string; title: string; artist: string; album: string; duration?: number; coverArt?: string }>;
}

interface NetworkResult {
  username: string;
  freeUploadSlots: boolean;
  uploadSpeed: number;
  files: Array<{
    filename: string;
    size: number;
    bitRate?: number;
    length?: number;
    title?: string;
    artist?: string;
    album?: string;
    trackNumber?: string;
  }>;
}

interface SearchState {
  query: string;
  local: LocalResults | null;
  network: NetworkResult[];
  networkState: 'idle' | 'searching' | 'complete';
  downloading: Set<string>;

  setQuery: (query: string) => void;
  setLocal: (local: LocalResults | null) => void;
  setNetwork: (network: NetworkResult[]) => void;
  setNetworkState: (state: 'idle' | 'searching' | 'complete') => void;
  addDownloading: (key: string) => void;
  reset: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: '',
  local: null,
  network: [],
  networkState: 'idle',
  downloading: new Set(),

  setQuery: (query) => set({ query }),
  setLocal: (local) => set({ local }),
  setNetwork: (network) => set({ network }),
  setNetworkState: (networkState) => set({ networkState }),
  addDownloading: (key) => set((s) => ({ downloading: new Set(s.downloading).add(key) })),
  reset: () => set({ local: null, network: [], networkState: 'idle' }),
}));
