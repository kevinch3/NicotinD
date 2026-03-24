import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore, type Track } from '@/stores/player';
import { TrackRow } from '@/components/TrackRow';

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
  const playWithContext = usePlayerStore((s) => s.playWithContext);

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
    play(toTrack(song, albumName));
  }

  function toTrack(song: Song, albumName: string): Track {
    return {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: albumName,
      coverArt: song.coverArt,
      duration: song.duration,
    };
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
    playWithContext(tracks, 0, { type: 'album', id: album.id, name: album.name });
  }

  // Album detail view
  if (selectedAlbum) {
    return (
      <div className="max-w-4xl mx-auto px-3 py-4 md:px-6 md:py-8">
        <button
          onClick={() => setSelectedAlbum(null)}
          className="text-sm text-zinc-500 hover:text-zinc-300 transition mb-6"
        >
          &larr; Back to library
        </button>

        <div className="flex flex-col sm:flex-row items-center sm:items-end gap-6 mb-8 text-center sm:text-left">
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
          {selectedAlbum.song?.map((song) => {
            const track = toTrack(song, selectedAlbum.name);

            return (
              <TrackRow
                key={song.id}
                track={track}
                indexLabel={song.track ?? ''}
                duration={song.duration}
                onPlay={() => playSong(song, selectedAlbum.name)}
              />
            );
          })}
        </div>
      </div>
    );
  }

  // Album grid
  return (
    <div className="max-w-6xl mx-auto px-3 py-4 md:px-6 md:py-8">
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
