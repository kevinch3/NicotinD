import { create } from 'zustand';

interface LocalResults {
  artists: Array<{ id: string; name: string; albumCount?: number }>;
  albums: Array<{ id: string; name: string; artist: string; coverArt?: string; year?: number }>;
  songs: Array<{ id: string; title: string; artist: string; album: string; duration?: number; coverArt?: string }>;
}

interface NetworkResult {
  username: string;
  freeUploadSlots: number;
  uploadSpeed: number;
  queueLength?: number;
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
  downloadedFolders: Set<string>;   // keyed as "username:directoryPath"
  canBrowse: boolean;
  autoSearch: boolean;
  history: string[];
  similarTo: { title: string; artist: string } | null;
  similarResults: Array<{ id: string; title: string; artist: string; album: string; duration?: number; coverArt?: string }>;

  setQuery: (query: string) => void;
  setLocal: (local: LocalResults | null) => void;
  setNetwork: (network: NetworkResult[]) => void;
  setNetworkState: (state: 'idle' | 'searching' | 'complete') => void;
  addDownloading: (key: string) => void;
  removeDownloading: (key: string) => void;
  addDownloadedFolder: (key: string) => void;
  setCanBrowse: (v: boolean) => void;
  setAutoSearch: (v: boolean) => void;
  addToHistory: (query: string) => void;
  clearHistory: () => void;
  reset: () => void;
  setSimilar: (meta: { title: string; artist: string }, results: Array<{ id: string; title: string; artist: string; album: string; duration?: number; coverArt?: string }>) => void;
  clearSimilar: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: '',
  local: null,
  network: [],
  networkState: 'idle',
  downloading: new Set(),
  downloadedFolders: new Set(),
  canBrowse: false,
  autoSearch: false,
  history: (() => { try { return JSON.parse(localStorage.getItem('nicotind:search-history') ?? '[]') as string[]; } catch { return []; } })(),
  similarTo: null,
  similarResults: [],

  setQuery: (query) => set({ query }),
  setLocal: (local) => set({ local }),
  setNetwork: (network) => set({ network }),
  setNetworkState: (networkState) => set({ networkState }),
  addDownloading: (key) => set((s) => ({ downloading: new Set(s.downloading).add(key) })),
  removeDownloading: (key) => set((s) => {
    const updated = new Set(s.downloading);
    updated.delete(key);
    return { downloading: updated };
  }),
  addDownloadedFolder: (key) => set((s) => ({ downloadedFolders: new Set(s.downloadedFolders).add(key) })),
  setCanBrowse: (canBrowse) => set({ canBrowse }),
  setAutoSearch: (autoSearch) => set({ autoSearch }),

  addToHistory: (query) => set((s) => {
    const trimmed = query.trim();
    if (!trimmed) return s;
    const updated = [trimmed, ...s.history.filter((h) => h !== trimmed)].slice(0, 10);
    localStorage.setItem('nicotind:search-history', JSON.stringify(updated));
    return { history: updated };
  }),

  clearHistory: () => {
    localStorage.removeItem('nicotind:search-history');
    set({ history: [] });
  },

  reset: () => set({ local: null, network: [], networkState: 'idle', canBrowse: false, downloading: new Set(), downloadedFolders: new Set(), similarTo: null, similarResults: [] }),

  setSimilar: (similarTo, similarResults) => set({ similarTo, similarResults }),
  clearSimilar: () => set({ similarTo: null, similarResults: [] }),
}));
