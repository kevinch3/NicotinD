import { useState, useEffect, useMemo } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore, type Track } from '@/stores/player';
import { usePreserveStore } from '@/stores/preserve';
import { toTrack } from '@/lib/trackUtils';
import { TrackRow } from '@/components/TrackRow';
import { useListControls } from '@/hooks/useListControls';
import { ListToolbar } from '@/components/ListToolbar';

interface Playlist {
  id: string;
  name: string;
  songCount: number;
  duration: number;
  owner: string;
  created: string;
  changed: string;
  coverArt?: string;
}

interface PlaylistSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration?: number;
  track?: number;
  coverArt?: string;
}

interface PlaylistDetail extends Playlist {
  entry?: PlaylistSong[];
}

// Deterministic gradient from playlist name
const gradients = [
  'from-indigo-500 to-purple-600',
  'from-pink-500 to-rose-600',
  'from-teal-500 to-cyan-600',
  'from-amber-500 to-red-600',
  'from-emerald-500 to-teal-600',
  'from-blue-500 to-indigo-600',
  'from-violet-500 to-fuchsia-600',
  'from-orange-500 to-amber-600',
];

function gradientFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return gradients[Math.abs(hash) % gradients.length];
}

function formatTotalDuration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return 'Added today';
  if (days === 1) return 'Added yesterday';
  if (days < 30) return `Added ${days} days ago`;
  return `Added ${new Date(dateStr).toLocaleDateString()}`;
}

export function PlaylistsPage() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PlaylistDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [removing, setRemoving] = useState<Set<number>>(new Set());
  const token = useAuthStore((s) => s.token);
  const play = usePlayerStore((s) => s.play);
  const playWithContext = usePlayerStore((s) => s.playWithContext);
  const preserve = usePreserveStore((s) => s.preserve);

  // Detail items with original index preserved for removeSong
  const detailItems = useMemo(() =>
    (selected?.entry ?? []).map((song, idx) => ({ ...song, _originalIndex: idx })),
    [selected?.entry]
  );

  // Grid list controls
  const gridControls = useListControls({
    pageKey: 'playlists',
    items: playlists,
    searchFields: ['name'] as const,
    sortOptions: [
      { field: 'name', label: 'Name' },
      { field: 'created', label: 'Date created' },
      { field: 'songCount', label: 'Track count' },
    ],
  });

  // Detail list controls
  const detailControls = useListControls({
    pageKey: 'playlist-detail',
    items: detailItems,
    searchFields: ['title', 'artist', 'album'] as const,
    sortOptions: [
      { field: 'title', label: 'Title' },
      { field: 'artist', label: 'Artist' },
      { field: 'duration', label: 'Duration' },
    ],
  });

  useEffect(() => {
    api.getPlaylists()
      .then(setPlaylists)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function openPlaylist(pl: Playlist) {
    setLoadingDetail(true);
    try {
      const detail = await api.getPlaylist(pl.id);
      setSelected(detail);
    } catch {
      // ignore
    } finally {
      setLoadingDetail(false);
    }
  }

  function playSong(song: PlaylistSong) {
    play(toTrack(song));
  }

  function playAll(pl: PlaylistDetail) {
    if (!pl.entry?.length) return;
    const tracks = pl.entry.map((s): Track => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: s.album,
      coverArt: s.coverArt,
      duration: s.duration,
    }));
    playWithContext(tracks, 0, { type: 'playlist', id: pl.id, name: pl.name });
  }

  function preserveAll(pl: PlaylistDetail) {
    if (!pl.entry?.length) return;
    pl.entry.forEach((s) => preserve(toTrack(s), token));
  }

  async function handleDelete(pl: PlaylistDetail) {
    setDeleting(true);
    try {
      await api.deletePlaylist(pl.id);
      setPlaylists(prev => prev.filter(p => p.id !== pl.id));
      setSelected(null);
    } catch {
      // ignore
    } finally {
      setDeleting(false);
    }
  }

  function startRename(pl: PlaylistDetail) {
    setNameDraft(pl.name);
    setEditingName(true);
  }

  async function saveRename(pl: PlaylistDetail) {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === pl.name) {
      setEditingName(false);
      return;
    }
    try {
      await api.updatePlaylist(pl.id, { name: trimmed });
      setSelected({ ...pl, name: trimmed });
      setPlaylists(prev => prev.map(p => p.id === pl.id ? { ...p, name: trimmed } : p));
    } catch {
      // ignore
    }
    setEditingName(false);
  }

  async function removeSong(pl: PlaylistDetail, songIndex: number) {
    setRemoving(prev => new Set(prev).add(songIndex));
    try {
      await api.updatePlaylist(pl.id, { songIndexesToRemove: [songIndex] });
      const updatedEntry = pl.entry?.filter((_, i) => i !== songIndex) ?? [];
      const updated = { ...pl, entry: updatedEntry, songCount: updatedEntry.length };
      setSelected(updated);
      setPlaylists(prev => prev.map(p => p.id === pl.id ? { ...p, songCount: updatedEntry.length } : p));
    } catch {
      // ignore
    }
    setRemoving(prev => { const n = new Set(prev); n.delete(songIndex); return n; });
  }

  // Detail view
  if (selected) {
    return (
      <div className="max-w-6xl mx-auto px-3 py-4 md:px-6 md:py-8">
        <button
          onClick={() => setSelected(null)}
          className="text-sm text-zinc-500 hover:text-zinc-300 transition mb-6"
        >
          &larr; Back to playlists
        </button>

        <div className="flex flex-col sm:flex-row items-center sm:items-end gap-6 mb-8 text-center sm:text-left">
          {selected.coverArt ? (
            <img
              src={`/api/cover/${selected.coverArt}?size=300&token=${token}`}
              alt=""
              className="w-48 h-48 rounded-lg object-cover flex-shrink-0"
            />
          ) : (
            <div className={`w-48 h-48 rounded-lg bg-gradient-to-br ${gradientFor(selected.name)} flex items-center justify-center flex-shrink-0`}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
                <path d="M9 18V5l12-2v13" />
                <circle cx="6" cy="18" r="3" />
                <circle cx="18" cy="16" r="3" />
              </svg>
            </div>
          )}
          <div className="flex flex-col justify-end">
            {editingName ? (
              <input
                autoFocus
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                onBlur={() => saveRename(selected)}
                onKeyDown={e => { if (e.key === 'Enter') saveRename(selected); if (e.key === 'Escape') setEditingName(false); }}
                className="text-2xl font-bold text-zinc-100 bg-transparent border-b border-zinc-600 focus:border-zinc-400 outline-none pb-0.5"
              />
            ) : (
              <h1
                className="text-2xl font-bold text-zinc-100 cursor-pointer hover:text-zinc-300 transition"
                onClick={() => startRename(selected)}
                title="Click to rename"
              >
                {selected.name}
              </h1>
            )}
            <p className="text-zinc-400 mt-1">
              {selected.entry?.length ?? selected.songCount} tracks · {formatTotalDuration(selected.duration)}
            </p>
            <div className="flex justify-center sm:justify-start gap-3 mt-4">
              <button
                onClick={() => playAll(selected)}
                className="px-5 py-2 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition"
              >
                Play All
              </button>
              <button
                onClick={() => preserveAll(selected)}
                className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-300 text-sm font-medium hover:bg-zinc-700 transition"
                title="Save all tracks for offline"
              >
                Preserve All
              </button>
              <button
                onClick={() => handleDelete(selected)}
                disabled={deleting}
                className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-400 text-sm font-medium hover:bg-zinc-700 hover:text-red-400 transition disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>

        {detailControls.isToolbarVisible && (
          <ListToolbar
            searchText={detailControls.searchText}
            onSearchChange={detailControls.setSearchText}
            sortField={detailControls.sortField}
            onSortFieldChange={detailControls.setSortField}
            sortDirection={detailControls.sortDirection}
            onToggleSortDirection={detailControls.toggleSortDirection}
            sortOptions={detailControls.sortOptions}
            onDismiss={detailControls.hideToolbar}
            inputRef={detailControls.inputRef}
            resultCount={detailControls.filtered.length}
          />
        )}

        <div>
          {detailControls.filtered.map((song) => (
            <TrackRow
              key={`${song.id}-${song._originalIndex}`}
              track={toTrack(song)}
              indexLabel={song.track ?? song._originalIndex + 1}
              subtitle={song.artist}
              duration={song.duration}
              onPlay={() => playSong(song)}
              disabled={removing.has(song._originalIndex)}
              trailingAction={{
                title: 'Remove from playlist',
                onClick: () => removeSong(selected, song._originalIndex),
                icon: (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                ),
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  // Grid view
  return (
    <div className="max-w-6xl mx-auto px-3 py-4 md:px-6 md:py-8">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Playlists</h1>
        <button onClick={gridControls.showToolbar} className="p-1 text-zinc-600 hover:text-zinc-300 transition" title="Search (Ctrl+F)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
        </button>
      </div>

      {gridControls.isToolbarVisible && (
        <ListToolbar
          searchText={gridControls.searchText}
          onSearchChange={gridControls.setSearchText}
          sortField={gridControls.sortField}
          onSortFieldChange={gridControls.setSortField}
          sortDirection={gridControls.sortDirection}
          onToggleSortDirection={gridControls.toggleSortDirection}
          sortOptions={gridControls.sortOptions}
          onDismiss={gridControls.hideToolbar}
          inputRef={gridControls.inputRef}
          resultCount={gridControls.filtered.length}
        />
      )}

      {loading && (
        <div className="text-center py-20">
          <span className="inline-block w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
        </div>
      )}

      {!loading && playlists.length === 0 && (
        <p className="text-center text-zinc-600 py-20">
          No playlists yet. Download an album and one will be created automatically!
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {gridControls.filtered.map((pl) => (
          <button
            key={pl.id}
            onClick={() => openPlaylist(pl)}
            disabled={loadingDetail}
            className="p-3 rounded-lg bg-zinc-900/30 hover:bg-zinc-800/50 transition text-left"
          >
            {pl.coverArt ? (
              <img
                src={`/api/cover/${pl.coverArt}?size=300&token=${token}`}
                alt=""
                className="w-full aspect-square rounded object-cover mb-2"
              />
            ) : (
              <div className={`w-full aspect-square rounded bg-gradient-to-br ${gradientFor(pl.name)} flex items-center justify-center mb-2`}>
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              </div>
            )}
            <p className="text-sm text-zinc-200 truncate">{pl.name}</p>
            <p className="text-xs text-zinc-500 truncate">
              {pl.songCount} tracks · {timeAgo(pl.created)}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
