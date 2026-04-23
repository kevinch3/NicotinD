import { Injectable, signal } from '@angular/core';

export interface NetworkResult {
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

const DOWNLOADED_FOLDERS_KEY = 'nicotind:downloaded-folders';
const SEARCH_HISTORY_KEY = 'nicotind:search-history';

function loadDownloadedFolders(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(DOWNLOADED_FOLDERS_KEY) ?? '[]');
    return new Set<string>(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [],
    );
  } catch {
    return new Set<string>();
  }
}

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

@Injectable({ providedIn: 'root' })
export class SearchService {
  readonly query = signal('');
  readonly network = signal<NetworkResult[]>([]);
  readonly networkState = signal<'idle' | 'searching' | 'complete'>('idle');
  readonly downloading = signal(new Set<string>());
  readonly downloadedFolders = signal(loadDownloadedFolders());
  readonly canBrowse = signal(false);
  readonly autoSearch = signal(false);
  readonly history = signal(loadHistory());
  readonly openBrowserKey = signal<string | null>(null);

  setQuery(query: string): void {
    this.query.set(query);
  }

  setNetwork(network: NetworkResult[]): void {
    this.network.set(network);
  }

  setNetworkState(state: 'idle' | 'searching' | 'complete'): void {
    this.networkState.set(state);
  }

  addDownloading(key: string): void {
    this.downloading.update(s => new Set(s).add(key));
  }

  removeDownloading(key: string): void {
    this.downloading.update(s => {
      const updated = new Set(s);
      updated.delete(key);
      return updated;
    });
  }

  addDownloadedFolder(key: string): void {
    this.downloadedFolders.update(s => {
      const updated = new Set(s).add(key);
      if (updated.size > 500) {
        const [first] = updated;
        updated.delete(first);
      }
      localStorage.setItem(DOWNLOADED_FOLDERS_KEY, JSON.stringify(Array.from(updated)));
      return updated;
    });
  }

  setCanBrowse(v: boolean): void {
    this.canBrowse.set(v);
  }

  setAutoSearch(v: boolean): void {
    this.autoSearch.set(v);
  }

  addToHistory(query: string): void {
    const trimmed = query.trim();
    if (!trimmed) return;
    this.history.update(h => {
      const updated = [trimmed, ...h.filter(item => item !== trimmed)].slice(0, 10);
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  clearHistory(): void {
    localStorage.removeItem(SEARCH_HISTORY_KEY);
    this.history.set([]);
  }

  reset(): void {
    this.network.set([]);
    this.networkState.set('idle');
    this.canBrowse.set(false);
    this.downloading.set(new Set());
    this.openBrowserKey.set(null);
  }
}
