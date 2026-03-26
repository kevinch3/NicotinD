import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { usePlayerStore, type Track } from '@/stores/player';
import { usePreserveStore } from '@/stores/preserve';
import { toTrack } from '@/lib/trackUtils';
import { TrackRow } from '@/components/TrackRow';
import { useListControls } from '@/hooks/useListControls';
import { ListToolbar } from '@/components/ListToolbar';

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
  const preserve = usePreserveStore((s) => s.preserve);

  // List controls for album grid
  const gridControls = useListControls<Album>({
    pageKey: 'library',
    items: albums,
    searchFields: ['name', 'artist'],
    sortOptions: [
      { field: 'name', label: 'Name' },
      { field: 'artist', label: 'Artist' },
      { field: 'year', label: 'Year' },
    ],
  });

  // List controls for album detail track list
  const detailControls = useListControls<Song>({
    pageKey: 'library-album',
    items: selectedAlbum?.song ?? [],
    searchFields: ['title', 'artist'] as const,
    sortOptions: [
      { field: 'track', label: 'Track #' },
      { field: 'title', label: 'Title' },
      { field: 'artist', label: 'Artist' },
    ],
    defaultSort: 'track',
  });

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

  function preserveAlbum(album: AlbumDetail) {
    if (!album.song?.length) return;
    album.song.forEach((s) => preserve(toTrack(s, album.name), token));
  }

  // Album detail view
  if (selectedAlbum) {
    return (
      <div className="max-w-6xl mx-auto px-3 py-4 md:px-6 md:py-8">
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
            <div className="flex justify-center sm:justify-start gap-3 mt-4">
              <button
                onClick={() => playAlbum(selectedAlbum)}
                className="px-5 py-2 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition"
              >
                Play Album
              </button>
              <button
                onClick={() => preserveAlbum(selectedAlbum)}
                className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-300 text-sm font-medium hover:bg-zinc-700 transition"
                title="Save all tracks for offline"
              >
                Preserve All
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
          {detailControls.filtered.map((song) => {
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
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Library</h1>
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

      {!loading && albums.length === 0 && (
        <p className="text-center text-zinc-600 py-20">
          No albums yet. Download some music to get started!
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {gridControls.filtered.map((album) => (
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
