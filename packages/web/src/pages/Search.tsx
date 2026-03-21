import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore, type Track } from '@/stores/player';
import { useSearchStore } from '@/stores/search';

interface NetworkResult {
  username: string;
  freeUploadSlots: boolean;
  uploadSpeed: number;
  files: Array<{ filename: string; size: number; bitRate?: number; length?: number }>;
}

interface FlatFile {
  username: string;
  uploadSpeed: number;
  filename: string;
  size: number;
  bitRate?: number;
  length?: number;
}

const ALLOWED_EXTENSIONS = ['.mp3', '.ogg'];

function flattenAndFilter(results: NetworkResult[]): FlatFile[] {
  const flat: FlatFile[] = [];
  for (const result of results) {
    if (result.uploadSpeed === 0) continue;
    for (const file of result.files) {
      const ext = file.filename.slice(file.filename.lastIndexOf('.')).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext)) continue;
      flat.push({
        username: result.username,
        uploadSpeed: result.uploadSpeed,
        filename: file.filename,
        size: file.size,
        bitRate: file.bitRate,
        length: file.length,
      });
    }
  }
  // Sort by speed descending, then alphabetically by filename as tiebreaker
  flat.sort((a, b) => b.uploadSpeed - a.uploadSpeed || a.filename.localeCompare(b.filename));
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

  // Ephemeral state (resets on remount — that's fine)
  const [loading, setLoading] = useState(false);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [networkAvailable, setNetworkAvailable] = useState(true);
  const [networkConnected, setNetworkConnected] = useState<boolean | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const token = useAuthStore((s) => s.token);
  const play = usePlayerStore((s) => s.play);

  // Check Soulseek network status on mount
  useEffect(() => {
    api.getSoulseekStatus()
      .then((s) => setNetworkConnected(s.connected))
      .catch(() => setNetworkConnected(false));
  }, []);

  // Poll network results (only if slskd was reachable)
  useEffect(() => {
    if (!searchId || networkState === 'complete' || !networkAvailable) return;

    const interval = setInterval(async () => {
      try {
        const res = await api.pollNetwork(searchId);
        setNetwork(res.results);
        if (res.state === 'complete') {
          setNetworkState('complete');
        }
      } catch {
        setNetworkState('complete');
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [searchId, networkState, networkAvailable]);

  const handleSearch = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

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
  }, [query, setLocal, setNetworkState]);

  async function handleDownload(username: string, file: { filename: string; size: number }) {
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

  function extractName(filepath: string) {
    const parts = filepath.split('\\');
    return parts[parts.length - 1];
  }

  const hasLocal = local && (local.songs.length > 0 || local.albums.length > 0 || local.artists.length > 0);
  const flatNetwork = flattenAndFilter(network);
  const hasNetwork = flatNetwork.length > 0;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
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
                    <p className="text-sm text-zinc-100 truncate">{song.title}</p>
                    <p className="text-xs text-zinc-500 truncate">
                      {song.artist} &middot; {song.album}
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
                    <p className="text-sm text-zinc-200 truncate">{album.name}</p>
                    <p className="text-xs text-zinc-500 truncate">{album.artist}</p>
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
              </>
            )}
          </span>
          <div className="flex-1 h-px bg-zinc-800" />
        </div>
      )}

      {/* Network results — flat track list, sorted by speed */}
      {hasNetwork && (
        <section>
          {flatNetwork.map((file) => {
            const key = `${file.username}:${file.filename}`;
            const queued = downloading.has(key);
            return (
              <div
                key={key}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-zinc-800/50 transition"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-300 truncate">{extractName(file.filename)}</p>
                  <p className="text-xs text-zinc-600 truncate">
                    {file.bitRate ? `${file.bitRate} kbps` : ''}
                    {file.length ? ` · ${formatDuration(file.length)}` : ''}
                    {' · '}
                    {formatSize(file.size)}
                    {' · '}
                    <span className="text-emerald-600">{formatSpeed(file.uploadSpeed)}</span>
                  </p>
                </div>
                <button
                  onClick={() => handleDownload(file.username, { filename: file.filename, size: file.size })}
                  disabled={queued}
                  className="px-3 py-1 rounded-md text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition disabled:opacity-50"
                >
                  {queued ? 'Queued' : 'Download'}
                </button>
              </div>
            );
          })}
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
