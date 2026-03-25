import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useSearchStore } from '@/stores/search';
import { useTransferStore } from '@/stores/transfers';
import { getSingleDownloadLabel, getFolderDownloadLabel, BUTTON_CLASSES } from '@/lib/downloadStatus';
import { FolderBrowser } from '@/components/FolderBrowser';
import { groupByDirectory } from '@/lib/folderUtils';
import { useNavigateAndSearch } from '@/hooks/useNavigateAndSearch';

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

interface FlatFile {
  username: string;
  freeUploadSlots: number;
  uploadSpeed: number;
  queueLength?: number;
  filename: string;
  size: number;
  bitRate?: number;
  length?: number;
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: string;
}

const ALLOWED_EXTENSIONS = ['.mp3', '.ogg'];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getHighlightTerms(query: string) {
  return Array.from(
    new Set(
      query
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    ),
  ).sort((a, b) => b.length - a.length);
}

function highlightText(text: string, terms: string[]): ReactNode {
  if (!terms.length) return text;

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(
        <span key={`text-${key++}`}>
          {text.slice(lastIndex, match.index)}
        </span>,
      );
    }

    nodes.push(
      <mark
        key={`match-${key++}`}
        className="rounded bg-amber-400/20 px-0.5 text-zinc-100"
      >
        {match[0]}
      </mark>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(
      <span key={`text-${key++}`}>
        {text.slice(lastIndex)}
      </span>,
    );
  }

  return nodes.length > 0 ? nodes : text;
}

function extractName(filepath: string) {
  const parts = filepath.split(/[\\/]/);
  return parts[parts.length - 1];
}

function getFilenameStem(filepath: string) {
  return extractName(filepath).replace(/\.[^/.]+$/, '');
}

function getDisplayTitle(file: Pick<FlatFile, 'filename' | 'title'>) {
  return file.title ?? getFilenameStem(file.filename);
}

function getDisplaySubtitle(file: Pick<FlatFile, 'artist' | 'album'>) {
  const parts = [file.artist, file.album].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '';
}

function flattenAndFilter(results: NetworkResult[]): FlatFile[] {
  const flat: FlatFile[] = [];
  for (const result of results) {
    // Some users might have 0 speed if unknown or just starting, don't filter them out entirely
    for (const file of result.files) {
      if (file.size === 0) continue; // skip 0-byte directory stubs
      const ext = file.filename.slice(file.filename.lastIndexOf('.')).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext)) continue;
      flat.push({
        username: result.username,
        freeUploadSlots: result.freeUploadSlots,
        uploadSpeed: result.uploadSpeed,
        queueLength: result.queueLength,
        filename: file.filename,
        size: file.size,
        bitRate: file.bitRate,
        length: file.length,
        title: file.title,
        artist: file.artist,
        album: file.album,
        trackNumber: file.trackNumber,
      });
    }
  }
  // Sort by speed descending, penalise by queue length, then alphabetically
  flat.sort(
    (a, b) =>
      b.uploadSpeed - a.uploadSpeed ||
      (a.queueLength ?? 0) - (b.queueLength ?? 0) ||
      getDisplayTitle(a).localeCompare(getDisplayTitle(b)) ||
      a.filename.localeCompare(b.filename),
  );
  return flat;
}

export function SearchPage() {
  // Persistent state (survives tab navigation)
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const network = useSearchStore((s) => s.network);
  const setNetwork = useSearchStore((s) => s.setNetwork);
  const networkState = useSearchStore((s) => s.networkState);
  const setNetworkState = useSearchStore((s) => s.setNetworkState);
  const downloading = useSearchStore((s) => s.downloading);
  const addDownloading = useSearchStore((s) => s.addDownloading);
  const downloadedFolders = useSearchStore((s) => s.downloadedFolders);
  const addDownloadedFolder = useSearchStore((s) => s.addDownloadedFolder);
  const canBrowse = useSearchStore((s) => s.canBrowse);
  const setCanBrowse = useSearchStore((s) => s.setCanBrowse);
  const getStatus = useTransferStore((s) => s.getStatus);

  const autoSearch = useSearchStore((s) => s.autoSearch);
  const setAutoSearch = useSearchStore((s) => s.setAutoSearch);
  const history = useSearchStore((s) => s.history);
  const clearHistory = useSearchStore((s) => s.clearHistory);

  // Ephemeral state (resets on remount — that's fine)
  const [loading, setLoading] = useState(false);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [networkAvailable, setNetworkAvailable] = useState(true);
  const [networkConnected, setNetworkConnected] = useState<boolean | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'tracks' | 'folders'>('tracks');
  const [openBrowserKey, setOpenBrowserKey] = useState<string | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const token = useAuthStore((s) => s.token);
  const navigateAndSearch = useNavigateAndSearch();

  // Check Soulseek network status on mount
  useEffect(() => {
    api.getSoulseekStatus()
      .then((s) => setNetworkConnected(s.connected))
      .catch(() => setNetworkConnected(false));
  }, []);

  // Cancel + delete the active slskd search (fire-and-forget, errors are non-fatal)
  const cleanupSearch = useCallback((id: string) => {
    api.cancelSearch(id).catch(() => {});
    api.deleteSearch(id).catch(() => {});
  }, []);

  // Poll network results (only if slskd was reachable)
  useEffect(() => {
    if (!searchId || networkState === 'complete' || !networkAvailable) return;

    const interval = setInterval(async () => {
      try {
        const res = await api.pollNetwork(searchId);
        setNetwork(res.results);
        if (res.canBrowse !== undefined) setCanBrowse(res.canBrowse);
        if (res.state === 'complete') {
          setNetworkState('complete');
        }
      } catch {
        setNetworkState('complete');
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [searchId, networkState, networkAvailable]);

  // Cleanup search on unmount
  useEffect(() => {
    return () => {
      if (searchId) cleanupSearch(searchId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchId]);

  function handleStopSearch() {
    if (searchId) cleanupSearch(searchId);
    setNetworkState('complete');
  }

  const executeSearch = useCallback(async () => {
    if (!query.trim()) return;

    useSearchStore.getState().addToHistory(query.trim());

    // Cancel any running search before starting a new one
    const prevId = searchId;
    if (prevId) cleanupSearch(prevId);

    setLoading(true);
    useSearchStore.getState().reset();
    setErrors([]);
    setSearchError(null);
    setDownloadError(null);
    setNetworkAvailable(true);

    try {
      const res = await api.search(query.trim());
      setSearchId(res.searchId);
      setErrors(res.errors ?? []);
      setNetworkAvailable(res.networkAvailable ?? false);
      setNetworkState(res.networkAvailable ? 'searching' : 'complete');
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [query, searchId, cleanupSearch, setNetworkState]);

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    void executeSearch();
  }, [executeSearch]);

  // Auto-search effect — triggers when autoSearch flag is set (e.g. from navigateAndSearch)
  useEffect(() => {
    if (autoSearch && query.trim()) {
      setAutoSearch(false);
      void executeSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Intentionally omitting executeSearch from deps: we only want to trigger on autoSearch flag transitions
  }, [autoSearch]);

  async function handleDownload(username: string, file: { filename: string; size: number }) {
    if (file.size === 0) return; // skip 0-byte directory stubs (Soulseek peer artifact)
    const key = `${username}:${file.filename}`;
    addDownloading(key);
    try {
      await api.enqueueDownload(username, [file]);
      setDownloadError(null);
    } catch (err) {
      const removeDownloading = useSearchStore.getState().removeDownloading;
      removeDownloading(key);
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    }
  }

  function formatDuration(seconds?: number) {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function formatSize(bytes: number) {
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    return `${(bytes / 1_000).toFixed(0)} KB`;
  }

  function formatSpeed(bytesPerSec: number) {
    if (bytesPerSec >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`;
    return `${(bytesPerSec / 1_000).toFixed(0)} KB/s`;
  }

  const highlightTerms = getHighlightTerms(query);
  const flatNetwork = flattenAndFilter(network);
  const hasNetwork = flatNetwork.length > 0;

  return (
    <div className="max-w-4xl mx-auto px-3 py-4 md:px-6 md:py-8">
      {/* Search bar */}
      <form onSubmit={handleSearch} className="mb-4">
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
            placeholder="Search for music..."
            className="w-full px-5 py-4 text-lg rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition"
          />
          <button
            type="submit"
            disabled={loading}
            className="absolute right-3 top-1/2 -translate-y-1/2 px-4 py-2 rounded-lg bg-zinc-700 text-zinc-200 text-sm font-medium hover:bg-zinc-600 transition disabled:opacity-50"
          >
            {loading ? 'Searching...' : 'Search'}
          </button>

          {searchFocused && history.length > 0 && !query && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden z-10">
              <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
                <span className="text-xs text-zinc-500 font-medium">Recent searches</span>
                <button onClick={clearHistory} className="text-xs text-zinc-600 hover:text-zinc-400 transition">Clear all</button>
              </div>
              {history.map((h) => (
                <button
                  key={h}
                  onClick={() => navigateAndSearch(h)}
                  className="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition"
                >
                  {h}
                </button>
              ))}
            </div>
          )}
        </div>
      </form>

      {/* Network status indicator */}
      {networkConnected !== null && (
        <div className="flex items-center gap-2 mb-6">
          <span className={`inline-block w-2 h-2 rounded-full ${networkConnected ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
          <span className="text-xs text-zinc-500">
            {networkConnected ? 'Soulseek network available' : 'Soulseek unavailable'}
          </span>
        </div>
      )}

      {/* Errors / warnings */}
      {searchError && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-red-950/50 border border-red-900/50">
          <p className="text-sm text-red-400">{searchError}</p>
        </div>
      )}
      {downloadError && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-red-950/50 border border-red-900/50 flex items-center justify-between">
          <p className="text-sm text-red-400">{downloadError}</p>
          <button
            onClick={() => setDownloadError(null)}
            className="text-red-500 hover:text-red-300 text-lg font-medium"
          >
            ×
          </button>
        </div>
      )}
      {errors.length > 0 && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-amber-950/50 border border-amber-900/50 space-y-1">
          {errors.map((err, i) => (
            <p key={i} className="text-sm text-amber-400">{err}</p>
          ))}
        </div>
      )}

      {/* Loading spinner */}
      {loading && (
        <div className="text-center py-12">
          <span className="inline-block w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
          <p className="text-zinc-500 text-sm mt-3">Searching...</p>
        </div>
      )}

      {/* No results message */}
      {!loading && !hasNetwork && networkState === 'complete' && query.trim() && (
        <div className="text-center py-12">
          <p className="text-zinc-500">No results found for "{query}"</p>
        </div>
      )}

      {/* Searching indicator */}
      {networkState === 'searching' && !loading && (
        <div className="flex items-center gap-2 px-1 py-2 text-xs text-zinc-500">
          <span className="inline-block w-3 h-3 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
          Searching Soulseek...
          {flatNetwork.length > 0 && (
            <span>{flatNetwork.length} tracks</span>
          )}
          <button
            onClick={handleStopSearch}
            className="text-zinc-500 hover:text-zinc-300 transition"
          >
            Stop
          </button>
        </div>
      )}

      {/* Network results */}
      {hasNetwork && (
        <section>
          {/* Track / Folder toggle */}
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={() => setViewMode('tracks')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                viewMode === 'tracks'
                  ? 'bg-zinc-700 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Tracks
            </button>
            <button
              onClick={() => setViewMode('folders')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                viewMode === 'folders'
                  ? 'bg-zinc-700 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              Folders
            </button>
          </div>

          {viewMode === 'tracks' && (
            <>
              {flatNetwork.map((file) => {
                const key = `${file.username}:${file.filename}`;
                const title = getDisplayTitle(file);
                const subtitle = getDisplaySubtitle(file);
                return (
                  <div
                    key={key}
                    className="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-zinc-800/50 transition"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-zinc-300 truncate">{highlightText(title, highlightTerms)}</p>
                          {subtitle && (
                            <p className="text-xs text-zinc-500 truncate">
                              {highlightText(subtitle, highlightTerms)}
                            </p>
                          )}
                        </div>
                        {file.length ? (
                          <span className="shrink-0 pt-0.5 text-xs text-zinc-600">
                            {formatDuration(file.length)}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-600 truncate">
                        {file.bitRate ? `${file.bitRate} kbps` : 'Unknown bitrate'}
                        {file.bitRate || file.length ? ' · ' : ''}
                        {formatSize(file.size)}
                        {' · '}
                        <span className="text-emerald-600">{formatSpeed(file.uploadSpeed)}</span>
                        {file.queueLength != null && file.queueLength > 0 && (
                          <span className="text-zinc-600"> · {file.queueLength} queued</span>
                        )}
                      </p>
                    </div>
                    {(() => {
                      const { label, variant, disabled } = getSingleDownloadLabel(
                        file.username, file.filename,
                        downloading.has(`${file.username}:${file.filename}`),
                        getStatus,
                      );
                      return (
                        <button
                          onClick={() => handleDownload(file.username, { filename: file.filename, size: file.size })}
                          disabled={disabled}
                          className={`px-3 py-1 rounded-md text-xs font-medium transition ${BUTTON_CLASSES[variant]} ${disabled ? 'cursor-default' : ''}`}
                        >
                          {label}
                        </button>
                      );
                    })()}
                  </div>
                );
              })}
            </>
          )}

          {viewMode === 'folders' && (
            <>
              {groupByDirectory(flatNetwork).map((group) => {
                const browserKey = `${group.username}::${group.directory}`;
                const isOpen = openBrowserKey === browserKey;
                const dirBasename = group.directory.split(/[\\/]/).at(-1) ?? group.directory;

                // Pre-map with username — network file objects don't carry it themselves.
                // Filter size=0 stubs so the Done check in getFolderDownloadLabel sees only
                // downloadable files (stubs are never enqueued and never appear in the store).
                const folderFiles = group.files
                  .filter((f) => f.size > 0)
                  .map((f) => ({ username: group.username, filename: f.filename }));
                const isFolderQueued = downloadedFolders.has(`${group.username}:${group.directory}`);
                const folderBtn = getFolderDownloadLabel(folderFiles, isFolderQueued, getStatus);

                return (
                  <div key={browserKey} className="mb-1">
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-zinc-800/50 transition">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-zinc-300 truncate">
                          <span
                            className="cursor-pointer hover:underline hover:text-zinc-100 transition"
                            onClick={() => navigateAndSearch(dirBasename)}
                          >
                            {dirBasename}
                          </span>
                        </p>
                        <p className="text-[11px] text-zinc-600 truncate">
                          {group.username}
                          {group.bitRate ? ` · ${group.bitRate} kbps` : ''}
                          {` · ${group.files.length} files`}
                        </p>
                      </div>
                      <button
                        onClick={async () => {
                          const validFiles = group.files.filter((f) => f.size > 0);
                          addDownloadedFolder(`${group.username}:${group.directory}`);
                          for (const f of validFiles) addDownloading(`${group.username}:${f.filename}`);
                          try {
                            await api.enqueueDownload(
                              group.username,
                              validFiles.map((f) => ({ filename: f.filename, size: f.size })),
                            );
                            setDownloadError(null);
                          } catch (err) {
                            const removeDownloading = useSearchStore.getState().removeDownloading;
                            for (const f of validFiles) removeDownloading(`${group.username}:${f.filename}`);
                            setDownloadError(err instanceof Error ? err.message : 'Folder download failed');
                          }
                        }}
                        disabled={folderBtn.disabled || folderFiles.length === 0}
                        className={`px-2 py-1 rounded text-xs font-medium transition shrink-0 ${BUTTON_CLASSES[folderBtn.variant]} ${folderBtn.disabled ? 'cursor-default' : ''}`}
                      >
                        {folderBtn.label}
                      </button>
                      {canBrowse && (
                        <button
                          onClick={() => setOpenBrowserKey(isOpen ? null : browserKey)}
                          className="px-2 py-1 rounded text-xs text-zinc-500 hover:text-zinc-300 transition shrink-0"
                        >
                          {isOpen ? 'Close' : 'Browse library'}
                        </button>
                      )}
                    </div>

                    {isOpen && (
                      <div className="mx-3 mb-2">
                        <FolderBrowser
                          username={group.username}
                          matchedPath={group.directory}
                          fallbackFiles={group.files.map((f) => ({
                            filename: f.filename,
                            size: f.size,
                            bitRate: f.bitRate,
                            length: f.length,
                          }))}
                          onDownload={async (files) => {
                            const validFiles = files.filter((f) => f.size > 0);
                            addDownloadedFolder(`${group.username}:${group.directory}`);
                            for (const f of validFiles) addDownloading(`${group.username}:${f.filename}`);
                            try {
                              await api.enqueueDownload(group.username, validFiles);
                              setDownloadError(null);
                            } catch (err) {
                              const removeDownloading = useSearchStore.getState().removeDownloading;
                              for (const f of validFiles) removeDownloading(`${group.username}:${f.filename}`);
                              setDownloadError(err instanceof Error ? err.message : 'Download failed');
                            }
                          }}
                          getStatus={getStatus}
                          isFolderQueued={downloadedFolders.has(`${group.username}:${group.directory}`)}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </section>
      )}

      {/* Empty state */}
      {networkState === 'idle' && !loading && (
        <div className="text-center py-20">
          <p className="text-zinc-600 text-lg">Search for music to get started</p>
          <p className="text-zinc-700 text-sm mt-1">
            Results from the Soulseek network will appear here
          </p>
        </div>
      )}
    </div>
  );
}
