import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore, type Track } from '@/stores/player';

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

function formatDuration(seconds?: number) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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
  const addToQueue = usePlayerStore((s) => s.addToQueue);

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
    play(tracks[0]);
    tracks.slice(1).forEach(t => addToQueue(t));
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
      <div className="max-w-4xl mx-auto px-6 py-8">
        <button
          onClick={() => setSelected(null)}
          className="text-sm text-zinc-500 hover:text-zinc-300 transition mb-6"
        >
          &larr; Back to playlists
        </button>

        <div className="flex gap-6 mb-8">
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
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => playAll(selected)}
                className="px-5 py-2 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition"
              >
                Play All
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

        <div>
          {selected.entry?.map((song, idx) => (
            <div
              key={`${song.id}-${idx}`}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-800/50 transition group ${removing.has(idx) ? 'opacity-40 pointer-events-none' : ''}`}
            >
              <span className="text-xs text-zinc-600 w-6 text-right">
                {song.track ?? idx + 1}
              </span>
              <button
                onClick={() => playSong(song)}
                className="flex-1 min-w-0 text-left"
              >
                <p className="text-sm text-zinc-200 truncate">{song.title}</p>
                <p className="text-xs text-zinc-500 truncate">{song.artist}</p>
              </button>
              <span className="text-xs text-zinc-600">{formatDuration(song.duration)}</span>
              <button
                onClick={() => playSong(song)}
                className="p-1 text-zinc-700 group-hover:text-zinc-300 transition flex-shrink-0"
                title="Play"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5,3 19,12 5,21" />
                </svg>
              </button>
              <button
                onClick={() => removeSong(selected, idx)}
                className="p-1 text-zinc-700 hover:text-red-400 transition flex-shrink-0 opacity-0 group-hover:opacity-100"
                title="Remove from playlist"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Grid view
  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <h1 className="text-lg font-semibold text-zinc-100 mb-6">Playlists</h1>

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
        {playlists.map((pl) => (
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
