import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore, type Track } from '@/stores/player';

interface Album {
  id: string;
  name: string;
  artist: string;
  coverArt?: string;
  songCount?: number;
  year?: number;
}

interface Song {
  id: string;
  title: string;
  artist: string;
  duration?: number;
  track?: number;
  coverArt?: string;
}

interface AlbumDetail extends Album {
  song: Song[];
}

export function LibraryPage() {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAlbum, setSelectedAlbum] = useState<AlbumDetail | null>(null);
  const [loadingAlbum, setLoadingAlbum] = useState(false);
  const token = useAuthStore((s) => s.token);
  const play = usePlayerStore((s) => s.play);
  const addToQueue = usePlayerStore((s) => s.addToQueue);

  useEffect(() => {
    api
      .getAlbums('newest', 80)
      .then(setAlbums)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function openAlbum(album: Album) {
    setLoadingAlbum(true);
    try {
      const detail = await api.getAlbum(album.id);
      setSelectedAlbum(detail);
    } catch {
      // ignore
    } finally {
      setLoadingAlbum(false);
    }
  }

  function playSong(song: Song, albumName: string) {
    const track: Track = {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: albumName,
      coverArt: song.coverArt,
      duration: song.duration,
    };
    play(track);
  }

  function playAlbum(album: AlbumDetail) {
    if (!album.song?.length) return;
    const tracks = album.song.map((s): Track => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: album.name,
      coverArt: s.coverArt,
      duration: s.duration,
    }));
    play(tracks[0]);
    tracks.slice(1).forEach((t) => addToQueue(t));
  }

  function formatDuration(seconds?: number) {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // Album detail view
  if (selectedAlbum) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <button
          onClick={() => setSelectedAlbum(null)}
          className="text-sm text-zinc-500 hover:text-zinc-300 transition mb-6"
        >
          &larr; Back to library
        </button>

        <div className="flex gap-6 mb-8">
          {selectedAlbum.coverArt ? (
            <img
              src={`/api/cover/${selectedAlbum.coverArt}?size=300&token=${token}`}
              alt=""
              className="w-48 h-48 rounded-lg object-cover flex-shrink-0"
            />
          ) : (
            <div className="w-48 h-48 rounded-lg bg-zinc-800 flex-shrink-0" />
          )}
          <div className="flex flex-col justify-end">
            <h1 className="text-2xl font-bold text-zinc-100">{selectedAlbum.name}</h1>
            <p className="text-zinc-400 mt-1">{selectedAlbum.artist}</p>
            {selectedAlbum.year && (
              <p className="text-zinc-600 text-sm mt-1">{selectedAlbum.year}</p>
            )}
            <button
              onClick={() => playAlbum(selectedAlbum)}
              className="mt-4 px-5 py-2 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition w-fit"
            >
              Play Album
            </button>
          </div>
        </div>

        <div>
          {selectedAlbum.song?.map((song) => (
            <button
              key={song.id}
              onClick={() => playSong(song, selectedAlbum.name)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-800/50 transition text-left group"
            >
              <span className="text-xs text-zinc-600 w-6 text-right">
                {song.track ?? ''}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-zinc-200 truncate">{song.title}</p>
              </div>
              <span className="text-xs text-zinc-600">{formatDuration(song.duration)}</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="text-zinc-700 group-hover:text-zinc-300 transition flex-shrink-0"
              >
                <polygon points="5,3 19,12 5,21" />
              </svg>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Album grid
  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <h1 className="text-lg font-semibold text-zinc-100 mb-6">Library</h1>

      {loading && (
        <div className="text-center py-20">
          <span className="inline-block w-5 h-5 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
        </div>
      )}

      {!loading && albums.length === 0 && (
        <p className="text-center text-zinc-600 py-20">
          No albums yet. Download some music to get started!
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {albums.map((album) => (
          <button
            key={album.id}
            onClick={() => openAlbum(album)}
            disabled={loadingAlbum}
            className="p-3 rounded-lg bg-zinc-900/30 hover:bg-zinc-800/50 transition text-left"
          >
            {album.coverArt ? (
              <img
                src={`/api/cover/${album.coverArt}?size=300&token=${token}`}
                alt=""
                className="w-full aspect-square rounded object-cover mb-2"
              />
            ) : (
              <div className="w-full aspect-square rounded bg-zinc-800 mb-2" />
            )}
            <p className="text-sm text-zinc-200 truncate">{album.name}</p>
            <p className="text-xs text-zinc-500 truncate">
              {album.artist} {album.year ? `\u00B7 ${album.year}` : ''}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
