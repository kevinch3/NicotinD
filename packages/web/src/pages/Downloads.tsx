import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import { usePlayerStore, type Track } from '@/stores/player';
import { usePreserveStore } from '@/stores/preserve';
import { useTransferStore } from '@/stores/transfers';
import type { SlskdUserTransferGroup } from '@nicotind/core';
import { useNavigateAndSearch } from '@/hooks/useNavigateAndSearch';

interface AlbumGroup {
  key: string;
  name: string;
  username: string;
  fileIds: string[];
  totalFiles: number;
  completedFiles: number;
  overallPercent: number;
  state: 'downloading' | 'queued' | 'done' | 'error';
}

interface RecentSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  duration?: number;
  coverArt?: string;
  bitRate: number;
  size: number;
  created: string;
}

interface PlaylistOption {
  id: string;
  name: string;
  songCount: number;
}

// --- Helpers ---

function extractAlbumName(directory: string): string {
  const segments = directory.split('\\').filter(Boolean);
  return segments[segments.length - 1] ?? directory;
}

function groupByAlbum(downloads: SlskdUserTransferGroup[]): AlbumGroup[] {
  const groups: AlbumGroup[] = [];
  for (const transfer of downloads) {
    for (const dir of transfer.directories) {
      const name = extractAlbumName(dir.directory);
      const key = `${transfer.username}:${dir.directory}`;
      const files = dir.files;
      const completed = files.filter((f) => f.state.includes('Succeeded')).length;
      const active = files.filter((f) => f.state === 'InProgress').length;
      const errored = files.filter(
        (f) => f.state.includes('Errored') || f.state.includes('Cancelled'),
      ).length;
      const totalBytes = files.reduce((s, f) => s + f.size, 0);
      const transferredBytes = files.reduce((s, f) => s + f.bytesTransferred, 0);
      const overallPercent =
        totalBytes > 0 ? Math.round((transferredBytes / totalBytes) * 100) : 0;

      let state: AlbumGroup['state'] = 'queued';
      if (completed === files.length) state = 'done';
      else if (active > 0) state = 'downloading';
      else if (errored > 0 && completed + errored === files.length) state = 'error';

      groups.push({
        key,
        name,
        username: transfer.username,
        fileIds: files.map((f) => f.id),
        totalFiles: files.length,
        completedFiles: completed,
        overallPercent,
        state,
      });
    }
  }
  const order: Record<string, number> = { downloading: 0, queued: 1, error: 2, done: 3 };
  return groups.sort((a, b) => order[a.state] - order[b.state]);
}

function formatDuration(seconds?: number) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

// --- Component ---

export function DownloadsPage() {
  const downloads = useTransferStore((s) => s.downloads);
  const [recentSongs, setRecentSongs] = useState<RecentSong[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [showPlaylistPicker, setShowPlaylistPicker] = useState(false);
  const [playlists, setPlaylists] = useState<PlaylistOption[]>([]);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [addingToPlaylist, setAddingToPlaylist] = useState(false);
  type NormState = 'pending' | 'running' | 'fixed' | 'skipped' | 'failed';
  const [normStatus, setNormStatus] = useState<Map<string, NormState>>(new Map());
  const [normalizing, setNormalizing] = useState(false);
  const prevHadActiveRef = useRef(false);
  const play = usePlayerStore((s) => s.play);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const navigateAndSearch = useNavigateAndSearch();
  const preservedTracks = usePreserveStore((s) => s.preservedTracks);
  const totalUsage = usePreserveStore((s) => s.totalUsage);
  const budget = usePreserveStore((s) => s.budget);
  const removePreserved = usePreserveStore((s) => s.remove);
  const downloadToDevice = usePreserveStore((s) => s.downloadToDevice);

  const fetchRecentSongs = useCallback(async () => {
    try {
      const data = await api.getRecentSongs(50);
      setRecentSongs(data);
    } catch {
      /* ignore */
    }
  }, []);

  // Fetch recent songs on mount
  useEffect(() => {
    fetchRecentSongs();
  }, [fetchRecentSongs]);

  // Auto-refresh recently-added when active downloads complete
  const groups = groupByAlbum(downloads);
  const hasActive = groups.some((g) => g.state === 'downloading' || g.state === 'queued');

  useEffect(() => {
    if (prevHadActiveRef.current && !hasActive) {
      // Downloads just finished — wait for Navidrome scan, then refresh
      const timer = setTimeout(fetchRecentSongs, 5000);
      return () => clearTimeout(timer);
    }
    prevHadActiveRef.current = hasActive;
  }, [hasActive, fetchRecentSongs]);

  const inProgressGroups = groups.filter((g) => g.state === 'downloading' || g.state === 'queued');
  const errorGroups = groups.filter((g) => g.state === 'error');
  const doneGroups = groups.filter((g) => g.state === 'done');
  const clearableGroups = [...errorGroups, ...doneGroups];

  // --- Actions ---

  async function clearGroup(group: AlbumGroup) {
    for (const fileId of group.fileIds) {
      try {
        await api.cancelDownload(group.username, fileId);
      } catch { /* may already be gone */ }
    }
    useTransferStore.getState().poll();
  }

  async function clearAllFinished() {
    for (const group of clearableGroups) {
      for (const fileId of group.fileIds) {
        try {
          await api.cancelDownload(group.username, fileId);
        } catch { /* ignore */ }
      }
    }
    useTransferStore.getState().poll();
  }

  async function cancelAll() {
    try {
      await api.cancelAllDownloads();
    } catch { /* ignore */ }
    useTransferStore.getState().poll();
  }

  async function triggerScan() {
    if (scanning) return;

    setScanning(true);
    try {
      await api.triggerScan();
      window.setTimeout(fetchRecentSongs, 5000);
    } catch {
      /* ignore */
    } finally {
      setScanning(false);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    if (selected.size === recentSongs.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(recentSongs.map((s) => s.id)));
    }
  }

  async function handleDelete(songIds: string[]) {
    setDeleting((prev) => {
      const next = new Set(prev);
      songIds.forEach((id) => next.add(id));
      return next;
    });

    for (const id of songIds) {
      try {
        await api.deleteSong(id);
        setRecentSongs((prev) => prev.filter((s) => s.id !== id));
        setSelected((prev) => {
          const n = new Set(prev);
          n.delete(id);
          return n;
        });
      } catch {
        /* ignore */
      }
    }

    setDeleting((prev) => {
      const next = new Set(prev);
      songIds.forEach((id) => next.delete(id));
      return next;
    });
  }

  function handlePlay(song: RecentSong) {
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

  function handlePlayAll() {
    const songs = selected.size > 0
      ? recentSongs.filter((s) => selected.has(s.id))
      : recentSongs;
    if (!songs.length) return;
    const tracks = songs.map(
      (s): Track => ({
        id: s.id,
        title: s.title,
        artist: s.artist,
        album: s.album,
        coverArt: s.coverArt,
        duration: s.duration,
      }),
    );
    play(tracks[0]);
    tracks.slice(1).forEach((t) => addToQueue(t));
  }

  async function openPlaylistPicker() {
    setShowPlaylistPicker(true);
    try {
      const data = await api.getPlaylists();
      setPlaylists(data);
    } catch {
      /* ignore */
    }
  }

  async function addToPlaylist(playlistId: string) {
    const songIds = Array.from(selected);
    setAddingToPlaylist(true);
    try {
      await api.updatePlaylist(playlistId, { songIdsToAdd: songIds });
      setSelected(new Set());
      setShowPlaylistPicker(false);
    } catch {
      /* ignore */
    } finally {
      setAddingToPlaylist(false);
    }
  }

  async function createAndAdd() {
    if (!newPlaylistName.trim()) return;
    const songIds = Array.from(selected);
    setAddingToPlaylist(true);
    try {
      await api.createPlaylist(newPlaylistName.trim(), songIds);
      setSelected(new Set());
      setShowPlaylistPicker(false);
      setNewPlaylistName('');
    } catch {
      /* ignore */
    } finally {
      setAddingToPlaylist(false);
    }
  }

  async function normalizeSelected() {
    const ids = Array.from(selected);
    setNormalizing(true);
    setNormStatus(new Map(ids.map((id) => [id, 'pending'])));
    for (const id of ids) {
      setNormStatus((prev) => new Map(prev).set(id, 'running'));
      try {
        const result = await api.fixSongMetadata(id);
        setNormStatus((prev) => new Map(prev).set(id, result.fixed ? 'fixed' : 'skipped'));
      } catch {
        setNormStatus((prev) => new Map(prev).set(id, 'failed'));
      }
    }
    setNormalizing(false);
    fetchRecentSongs();
  }

  // --- Render ---

  return (
    <div className="max-w-5xl mx-auto px-3 py-4 md:px-6 md:py-8">
      <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <h1 className="text-lg font-semibold text-zinc-100">Downloads</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={triggerScan}
            disabled={scanning}
            className="inline-flex items-center gap-2 rounded-full border border-zinc-800/80 bg-zinc-950/40 px-3 py-1.5 text-xs font-medium text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-300 disabled:cursor-wait disabled:opacity-50"
            title="Trigger a library rescan"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={scanning ? 'animate-spin' : ''}
            >
              <path d="M21 12a9 9 0 1 1-3-6.7" />
              <polyline points="21 3 21 9 15 9" />
            </svg>
            <span>{scanning ? 'Scanning' : 'Scan library'}</span>
          </button>
          {recentSongs.length > 0 && (
            <button
              onClick={handlePlayAll}
              className="px-4 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-sm font-medium hover:bg-zinc-700 transition"
            >
              {selected.size > 0 ? `Play ${selected.size} selected` : 'Play all'}
            </button>
          )}
        </div>
      </div>

      {/* Active Downloads */}
      {(inProgressGroups.length > 0 || errorGroups.length > 0 || doneGroups.length > 0) && (
        <section className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Downloads
              {inProgressGroups.length > 0 && (
                <span className="ml-2 text-blue-400 normal-case font-normal">
                  {inProgressGroups.length} in progress
                </span>
              )}
            </h2>
            <div className="flex items-center gap-3">
              {inProgressGroups.length > 0 && (
                <button
                  onClick={cancelAll}
                  className="text-xs text-red-500/70 hover:text-red-400 transition"
                >
                  Cancel all
                </button>
              )}
              {clearableGroups.length > 0 && (
                <button
                  onClick={clearAllFinished}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition"
                >
                  Clear all finished
                </button>
              )}
            </div>
          </div>
          <div className="grid gap-2">
            {/* In progress */}
            {inProgressGroups.map((group) => (
              <div
                key={group.key}
                className="flex items-center gap-3 md:gap-4 px-3 md:px-4 py-3 rounded-lg bg-zinc-900/50 border border-zinc-800/50 min-w-0"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-200 truncate w-full">{group.name}</p>
                  <p className="text-xs text-zinc-600 mt-0.5 truncate w-full">
                    {group.completedFiles} of {group.totalFiles} tracks
                  </p>
                </div>
                <div className="w-20 md:w-32 flex-shrink-0">
                  {group.state === 'downloading' ? (
                    <div className="space-y-1">
                      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all duration-500"
                          style={{ width: `${group.overallPercent}%` }}
                        />
                      </div>
                      <p className="text-xs text-blue-400 text-right">{group.overallPercent}%</p>
                    </div>
                  ) : (
                    <p className="text-xs text-right font-medium text-zinc-500">Queued</p>
                  )}
                </div>
                <button
                  onClick={() => clearGroup(group)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition flex-shrink-0"
                  title="Cancel"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}

            {/* Errored */}
            {errorGroups.map((group) => (
              <div
                key={group.key}
                className="flex items-center gap-3 md:gap-4 px-3 md:px-4 py-3 rounded-lg bg-zinc-900/30 border border-red-900/20 min-w-0"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-400 truncate w-full">{group.name}</p>
                  <p className="text-xs text-zinc-600 mt-0.5 truncate w-full">
                    {group.completedFiles} of {group.totalFiles} tracks
                  </p>
                </div>
                <p className="text-xs text-red-400/70 font-medium flex-shrink-0">Error</p>
                <button
                  onClick={() => clearGroup(group)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition flex-shrink-0"
                  title="Dismiss"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}

            {/* Done */}
            {doneGroups.map((group) => (
              <div
                key={group.key}
                className="flex items-center gap-3 md:gap-4 px-3 md:px-4 py-3 rounded-lg bg-zinc-900/40 border border-zinc-800/40 opacity-80 min-w-0"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-400 truncate w-full">{group.name}</p>
                  <p className="text-xs text-zinc-600 mt-0.5 truncate w-full">{group.totalFiles} tracks</p>
                </div>
                <p className="text-xs text-emerald-400/70 font-medium flex-shrink-0">Done</p>
                <button
                  onClick={() => clearGroup(group)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition flex-shrink-0"
                  title="Dismiss"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Preserved */}
      {preservedTracks.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Preserved
              <span className="font-normal normal-case ml-1.5 text-zinc-600">
                ({preservedTracks.length})
              </span>
            </h2>
            <span className="text-xs text-zinc-600">
              {formatSize(totalUsage)} / {formatSize(budget)}
            </span>
          </div>

          {/* Storage bar */}
          <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden mb-3">
            <div
              className="h-full bg-emerald-500/70 rounded-full transition-all duration-500"
              style={{ width: `${Math.min(100, (totalUsage / budget) * 100)}%` }}
            />
          </div>

          <div className="space-y-0.5">
            {preservedTracks
              .sort((a, b) => b.preservedAt - a.preservedAt)
              .map((pt) => (
                <div
                  key={pt.id}
                  className="flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2.5 rounded-lg hover:bg-zinc-800/30 border border-transparent transition group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-200 truncate">{pt.title}</p>
                    <p className="text-xs text-zinc-500 truncate">
                      {pt.artist} &middot; {pt.album}
                    </p>
                  </div>

                  <span className="hidden md:inline text-xs text-zinc-600 flex-shrink-0 w-16 text-right">
                    {formatSize(pt.size)}
                  </span>
                  <span className="hidden sm:inline text-xs text-zinc-600 flex-shrink-0 w-12 text-right">
                    {formatDuration(pt.duration)}
                  </span>

                  {/* Play */}
                  <button
                    onClick={() =>
                      play({
                        id: pt.id,
                        title: pt.title,
                        artist: pt.artist,
                        album: pt.album,
                        coverArt: pt.coverArt,
                        duration: pt.duration,
                      })
                    }
                    className="p-1.5 text-zinc-500 md:text-zinc-700 hover:text-zinc-300 transition flex-shrink-0 md:opacity-0 md:group-hover:opacity-100"
                    title="Play"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5,3 19,12 5,21" />
                    </svg>
                  </button>

                  {/* Download to device */}
                  <button
                    onClick={() =>
                      downloadToDevice(
                        pt.id,
                        `${pt.artist} - ${pt.title}.${pt.format.split('/')[1] ?? 'mp3'}`,
                      )
                    }
                    className="p-1.5 text-zinc-500 md:text-zinc-700 hover:text-zinc-300 transition flex-shrink-0 md:opacity-0 md:group-hover:opacity-100"
                    title="Download to device"
                  >
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
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </button>

                  {/* Remove */}
                  <button
                    onClick={() => removePreserved(pt.id)}
                    className="p-1.5 text-zinc-500 md:text-zinc-700 hover:text-red-400 transition flex-shrink-0 md:opacity-0 md:group-hover:opacity-100"
                    title="Remove from preserved"
                  >
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
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    </svg>
                  </button>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Recently Added */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Recently Added
            {recentSongs.length > 0 && (
              <span className="font-normal normal-case ml-1.5 text-zinc-600">
                ({recentSongs.length})
              </span>
            )}
          </h2>
          {recentSongs.length > 0 && (
            <button
              onClick={selectAll}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition"
            >
              {selected.size === recentSongs.length ? 'Deselect all' : 'Select all'}
            </button>
          )}
        </div>

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 md:gap-3 px-3 md:px-4 py-2.5 mb-3 rounded-lg bg-zinc-800/60 border border-zinc-700/50">
            <span className="text-sm text-zinc-300 font-medium">{selected.size} selected</span>
            <div className="flex-1 min-w-0" />

            {showPlaylistPicker ? (
              <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
                <span className="text-xs text-zinc-400 flex-shrink-0">Add to:</span>
                <div className="flex gap-1.5 flex-wrap">
                  {playlists.map((pl) => (
                    <button
                      key={pl.id}
                      onClick={() => addToPlaylist(pl.id)}
                      disabled={addingToPlaylist}
                      className="px-2.5 py-1 rounded-md text-xs bg-zinc-700 text-zinc-300 hover:bg-zinc-600 transition disabled:opacity-50"
                    >
                      {pl.name}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1.5 w-full md:w-auto">
                  <input
                    type="text"
                    value={newPlaylistName}
                    onChange={(e) => setNewPlaylistName(e.target.value)}
                    placeholder="New playlist..."
                    className="flex-1 md:w-36 md:flex-none px-2.5 py-1 text-xs rounded-md bg-zinc-900 border border-zinc-700 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                    onKeyDown={(e) => e.key === 'Enter' && createAndAdd()}
                  />
                  <button
                    onClick={createAndAdd}
                    disabled={!newPlaylistName.trim() || addingToPlaylist}
                    className="px-2.5 py-1 rounded-md text-xs font-medium bg-zinc-100 text-zinc-900 hover:bg-zinc-200 transition disabled:opacity-40"
                  >
                    Create
                  </button>
                </div>
                <button
                  onClick={() => setShowPlaylistPicker(false)}
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={openPlaylistPicker}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-700 text-zinc-200 hover:bg-zinc-600 transition"
                >
                  Add to playlist
                </button>
                <button
                  onClick={normalizeSelected}
                  disabled={normalizing}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-700 text-zinc-200 hover:bg-zinc-600 transition disabled:opacity-50 disabled:cursor-wait"
                >
                  {normalizing ? 'Normalizing…' : 'Normalize metadata'}
                </button>
                <button
                  onClick={() => handleDelete(Array.from(selected))}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-700 text-red-400 hover:bg-red-500/20 transition"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        )}

        {/* Song list */}
        {recentSongs.length === 0 && groups.length === 0 && (
          <p className="text-center text-zinc-600 text-sm py-20">
            No recent downloads. Search for music and start downloading!
          </p>
        )}
        {recentSongs.length === 0 && groups.length > 0 && (
          <p className="text-center text-zinc-600 text-sm py-12">
            New songs will appear here after downloads complete and library rescans.
          </p>
        )}

        <div className="space-y-0.5">
          {recentSongs.map((song) => {
            const isSelected = selected.has(song.id);
            const isDeleting = deleting.has(song.id);
            return (
              <div
                key={song.id}
                className={`flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2.5 rounded-lg transition group ${
                  isSelected
                    ? 'bg-zinc-800/60 border border-zinc-700/50'
                    : 'hover:bg-zinc-800/30 border border-transparent'
                } ${isDeleting ? 'opacity-40 pointer-events-none' : ''}`}
              >
                {/* Checkbox */}
                <button
                  onClick={() => toggleSelect(song.id)}
                  className={`w-4.5 h-4.5 rounded border flex-shrink-0 flex items-center justify-center transition ${
                    isSelected
                      ? 'bg-blue-500 border-blue-500'
                      : 'border-zinc-700 hover:border-zinc-500'
                  }`}
                >
                  {isSelected && (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="white"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>

                {/* Song info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-200 truncate">{song.title}</p>
                  <p className="text-xs text-zinc-500 truncate">
                    <span
                      className="cursor-pointer hover:underline hover:text-zinc-300 transition"
                      onClick={() => navigateAndSearch(song.artist)}
                    >
                      {song.artist}
                    </span>
                    {' '}&middot;{' '}{song.album}
                  </p>
                </div>

                {/* Metadata - hidden on mobile */}
                <span className="hidden md:inline text-xs text-zinc-600 flex-shrink-0 w-14 text-right">
                  {song.bitRate ? `${song.bitRate}k` : ''}
                </span>
                <span className="hidden md:inline text-xs text-zinc-600 flex-shrink-0 w-16 text-right">
                  {formatSize(song.size)}
                </span>
                <span className="hidden sm:inline text-xs text-zinc-600 flex-shrink-0 w-12 text-right">
                  {formatDuration(song.duration)}
                </span>
                <span className="hidden lg:inline text-xs text-zinc-700 flex-shrink-0 w-20 text-right">
                  {timeAgo(song.created)}
                </span>

                {/* Normalization status indicator */}
                {normStatus.has(song.id) && (
                  <span className="flex-shrink-0 w-5 flex items-center justify-center">
                    {normStatus.get(song.id) === 'pending' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
                    )}
                    {normStatus.get(song.id) === 'running' && (
                      <svg className="animate-spin text-zinc-400" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 3 21 9 15 9" />
                      </svg>
                    )}
                    {normStatus.get(song.id) === 'fixed' && (
                      <svg className="text-emerald-400" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                    {normStatus.get(song.id) === 'skipped' && (
                      <span className="text-zinc-600 text-xs leading-none">—</span>
                    )}
                    {normStatus.get(song.id) === 'failed' && (
                      <svg className="text-red-400/70" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    )}
                  </span>
                )}

                {/* Play - always visible on mobile, hover on desktop */}
                <button
                  onClick={() => handlePlay(song)}
                  className="p-1.5 text-zinc-500 md:text-zinc-700 hover:text-zinc-300 transition flex-shrink-0 md:opacity-0 md:group-hover:opacity-100"
                  title="Play"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5,3 19,12 5,21" />
                  </svg>
                </button>

                {/* Delete - always visible on mobile, hover on desktop */}
                <button
                  onClick={() => handleDelete([song.id])}
                  className="p-1.5 text-zinc-500 md:text-zinc-700 hover:text-red-400 transition flex-shrink-0 md:opacity-0 md:group-hover:opacity-100"
                  title="Delete from library"
                >
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
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
