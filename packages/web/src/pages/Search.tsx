import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore, type Track } from '@/stores/player';
import { useSearchStore } from '@/stores/search';
import { useTransferStore } from '@/stores/transfers';
import { getSingleDownloadLabel, getFolderDownloadLabel, BUTTON_CLASSES } from '@/lib/downloadStatus';
import { FolderBrowser } from '@/components/FolderBrowser';
import { groupByDirectory } from '@/lib/folderUtils';

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
  const local = useSearchStore((s) => s.local);
  const setLocal = useSearchStore((s) => s.setLocal);
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

  // Ephemeral state (resets on remount — that's fine)
  const [loading, setLoading] = useState(false);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [networkAvailable, setNetworkAvailable] = useState(true);
  const [networkConnected, setNetworkConnected] = useState<boolean | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'tracks' | 'folders'>('tracks');
  const [openBrowserKey, setOpenBrowserKey] = useState<string | null>(null);
  const token = useAuthStore((s) => s.token);
  const play = usePlayerStore((s) => s.play);

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

  const handleSearch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    // Cancel any running search before starting a new one
    const prevId = searchId;
    if (prevId) cleanupSearch(prevId);

    setLoading(true);
    useSearchStore.getState().reset();
    setErrors([]);
    setSearchError(null);
    setNetworkAvailable(true);

    try {
      const res = await api.search(query.trim());
      setLocal(res.local);
      setSearchId(res.searchId);
      setErrors(res.errors ?? []);
      setNetworkAvailable(res.networkAvailable ?? false);
      setNetworkState(res.networkAvailable ? 'searching' : 'complete');
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [query, searchId, cleanupSearch, setLocal, setNetworkState]);

  async function handleDownload(username: string, file: { filename: string; size: number }) {
    if (file.size === 0) return; // skip 0-byte directory stubs (Soulseek peer artifact)
    const key = `${username}:${file.filename}`;
    addDownloading(key);
    try {
      await api.enqueueDownload(username, [file]);
    } catch {
      // ignore
    }
  }

  function playSong(song: { id: string; title: string; artist: string; album: string; coverArt?: string; duration?: number }) {
    const track: Track = {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      coverArt: song.coverArt,
      duration: song.duration,
    };
    play(track);
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
  const hasLocal = local && (local.songs.length > 0 || local.albums.length > 0 || local.artists.length > 0);
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
        </div>
      </form>

      {/* Network status indicator */}
      {networkConnected !== null && (
        <div className="flex items-center gap-2 mb-6">
          <span className={`inline-block w-2 h-2 rounded-full ${networkConnected ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
          <span className="text-xs text-zinc-500">
            {networkConnected ? 'Soulseek network available' : 'Local library only'}
          </span>
        </div>
      )}

      {/* Errors / warnings */}
      {searchError && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-red-950/50 border border-red-900/50">
          <p className="text-sm text-red-400">{searchError}</p>
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
      {!loading && local && !hasLocal && !hasNetwork && networkState === 'complete' && (
        <div className="text-center py-12">
          <p className="text-zinc-500">No results found for "{query}"</p>
        </div>
      )}

      {/* Local results */}
      {hasLocal && (
        <section className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-4">
            Local Library
          </h2>

          {/* Songs */}
          {local.songs.length > 0 && (
            <div className="mb-4">
              {local.songs.map((song) => (
                <button
                  key={song.id}
                  onClick={() => playSong(song)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-800/50 transition text-left group"
                >
                  {song.coverArt ? (
                    <img
                      src={`/api/cover/${song.coverArt}?size=80&token=${token}`}
                      alt=""
                      className="w-10 h-10 rounded object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded bg-zinc-800 flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-100 truncate">{highlightText(song.title, highlightTerms)}</p>
                    <p className="text-xs text-zinc-500 truncate">
                      {highlightText(song.artist, highlightTerms)} &middot; {highlightText(song.album, highlightTerms)}
                    </p>
                  </div>
                  <span className="text-xs text-zinc-600">{formatDuration(song.duration)}</span>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="text-zinc-600 group-hover:text-zinc-300 transition flex-shrink-0"
                  >
                    <polygon points="5,3 19,12 5,21" />
                  </svg>
                </button>
              ))}
            </div>
          )}

          {/* Albums */}
          {local.albums.length > 0 && (
            <div className="mb-4">
              <h3 className="text-xs font-medium text-zinc-600 mb-2 px-3">Albums</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {local.albums.map((album) => (
                  <div
                    key={album.id}
                    className="p-3 rounded-lg bg-zinc-900/50 hover:bg-zinc-800/50 transition cursor-pointer"
                  >
                    {album.coverArt ? (
                      <img
                        src={`/api/cover/${album.coverArt}?size=200&token=${token}`}
                        alt=""
                        className="w-full aspect-square rounded object-cover mb-2"
                      />
                    ) : (
                      <div className="w-full aspect-square rounded bg-zinc-800 mb-2" />
                    )}
                    <p className="text-sm text-zinc-200 truncate">{highlightText(album.name, highlightTerms)}</p>
                    <p className="text-xs text-zinc-500 truncate">{highlightText(album.artist, highlightTerms)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Divider */}
      {(hasLocal || local) && (networkState === 'searching' || hasNetwork) && (
        <div className="flex items-center gap-3 my-6">
          <div className="flex-1 h-px bg-zinc-800" />
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-600 flex items-center gap-2">
            Soulseek Network
            {networkState === 'searching' && (
              <>
                <span className="inline-block w-3 h-3 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
                {flatNetwork.length > 0 && (
                  <span className="font-normal normal-case tracking-normal">{flatNetwork.length} tracks</span>
                )}
                <button
                  onClick={handleStopSearch}
                  className="font-normal normal-case tracking-normal text-zinc-500 hover:text-zinc-300 transition"
                >
                  Stop
                </button>
              </>
            )}
          </span>
          <div className="flex-1 h-px bg-zinc-800" />
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
                        <p className="text-sm text-zinc-300 truncate">{dirBasename}</p>
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
                          await api.enqueueDownload(
                            group.username,
                            validFiles.map((f) => ({ filename: f.filename, size: f.size })),
                          );
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
                            await api.enqueueDownload(group.username, validFiles);
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
      {!local && !loading && (
        <div className="text-center py-20">
          <p className="text-zinc-600 text-lg">Search for music to get started</p>
          <p className="text-zinc-700 text-sm mt-1">
            Results from your library appear first, followed by the Soulseek network
          </p>
        </div>
      )}
    </div>
  );
}
