import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { Router } from '@angular/router';
import { ApiService, type Playlist, type PlaylistDetail } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService, type Track } from '../../services/player.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { PreserveService } from '../../services/preserve.service';
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { TrackRowComponent, type TrackAction } from '../../components/track-row/track-row.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { toTrack } from '../../lib/track-utils';

// Deterministic gradient from playlist name
const GRADIENTS = [
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
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length];
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

interface DetailItem {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album: string;
  albumId?: string;
  duration?: number;
  track?: number;
  coverArt?: string;
  _originalIndex: number;
}

@Component({
  selector: 'app-playlists',
  imports: [FormsModule, ListToolbarComponent, TrackRowComponent, ConfirmDialogComponent],
  templateUrl: './playlists.component.html',
  })
export class PlaylistsComponent implements OnInit {
  private api = inject(ApiService);
  readonly auth = inject(AuthService);
  private player = inject(PlayerService);
  private listControls = inject(ListControlsService);
  private router = inject(Router);

  readonly gradientFor = gradientFor;
  readonly formatTotalDuration = formatTotalDuration;
  readonly timeAgo = timeAgo;

  readonly playlists = signal<Playlist[]>([]);
  readonly loading = signal(true);
  readonly selected = signal<PlaylistDetail | null>(null);
  readonly loadingDetail = signal(false);
  readonly deleting = signal(false);
  readonly nameDraft = signal('');
  readonly removing = signal(new Set<number>());
  readonly showRenameModal = signal(false);

  readonly preserve = inject(PreserveService);

  readonly playlistPreserveProgress = computed(() => {
    const pl = this.selected();
    if (!pl?.entry?.length) return { done: 0, total: 0 };
    const total = pl.entry.length;
    const done = pl.entry.filter(s => this.preserve.isPreserved(s.id)).length;
    return { done, total };
  });

  readonly playlistOfflineState = computed<'idle' | 'downloading' | 'done'>(() => {
    const pl = this.selected();
    if (!pl?.entry?.length) return 'idle';
    const preserving = this.preserve.preserving();
    const isDownloading = pl.entry.some(s => preserving.has(s.id));
    if (isDownloading) return 'downloading';
    const { done, total } = this.playlistPreserveProgress();
    if (done === total) return 'done';
    return 'idle';
  });

  readonly confirmMessage = signal('');
  readonly confirmLabel = signal('Delete');
  readonly confirmCallback = signal<(() => void | Promise<void>) | null>(null);
  readonly showConfirm = computed(() => this.confirmCallback() !== null);

  readonly detailItems = computed<DetailItem[]>(() => {
    const sel = this.selected();
    return (sel?.entry ?? []).map((song, idx) => ({ ...song, _originalIndex: idx }));
  });

  readonly gridSortOptions: SortOption[] = [
    { field: 'name', label: 'Name' },
    { field: 'created', label: 'Date created' },
    { field: 'songCount', label: 'Track count' },
  ];

  readonly detailSortOptions: SortOption[] = [
    { field: 'title', label: 'Title' },
    { field: 'artist', label: 'Artist' },
    { field: 'duration', label: 'Duration' },
  ];

  readonly gridControls = this.listControls.connect({
    pageKey: 'playlists',
    items: this.playlists,
    searchFields: ['name'] as const,
    sortOptions: this.gridSortOptions,
    defaultSort: 'created',
    defaultDirection: 'desc',
  });

  readonly detailControls = this.listControls.connect({
    pageKey: 'playlist-detail',
    items: this.detailItems,
    searchFields: ['title', 'artist', 'album'] as const,
    sortOptions: this.detailSortOptions,
  });

  ngOnInit(): void {
    this.fetchPlaylists();
  }

  async openPlaylist(pl: Playlist): Promise<void> {
    this.loadingDetail.set(true);
    try {
      const detail = await firstValueFrom(this.api.getPlaylist(pl.id));
      this.selected.set(detail);
    } catch { /* ignore */ }
    finally { this.loadingDetail.set(false); }
  }

  playSong(song: DetailItem): void {
    this.player.play(toTrack(song));
  }

  playAll(): void {
    const pl = this.selected();
    if (!pl?.entry?.length) return;
    const tracks = pl.entry.map((s): Track => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: s.album,
      coverArt: s.coverArt,
      duration: s.duration,
    }));
    this.player.playWithContext(tracks, 0, { type: 'playlist', id: pl.id, name: pl.name });
  }

  async togglePlaylistOffline(): Promise<void> {
    const pl = this.selected();
    if (!pl?.entry?.length) return;

    if (this.playlistOfflineState() === 'done') {
      for (const song of pl.entry) {
        if (this.preserve.isPreserved(song.id)) {
          await this.preserve.remove(song.id);
        }
      }
    } else {
      for (const song of pl.entry) {
        if (!this.preserve.isPreserved(song.id)) {
          await this.preserve.preserve({
            id: song.id,
            title: song.title,
            artist: song.artist,
            album: song.album ?? '',
            coverArt: song.coverArt,
            duration: song.duration,
          });
        }
      }
    }
  }

  async handleDelete(): Promise<void> {
    const pl = this.selected();
    if (!pl) return;
    this.deleting.set(true);
    try {
      await firstValueFrom(this.api.deletePlaylist(pl.id));
      this.playlists.update(prev => prev.filter(p => p.id !== pl.id));
      this.selected.set(null);
    } catch { /* ignore */ }
    finally { this.deleting.set(false); }
  }

  confirmDelete(): void {
    const pl = this.selected();
    if (!pl) return;
    this.askConfirm(`Delete playlist "${pl.name}"?`, () => this.handleDelete());
  }

  openRenameModal(): void {
    const pl = this.selected();
    if (!pl) return;
    this.nameDraft.set(pl.name);
    this.showRenameModal.set(true);
  }

  async saveRename(): Promise<void> {
    const pl = this.selected();
    if (!pl) return;
    const trimmed = this.nameDraft().trim();
    this.showRenameModal.set(false);
    if (!trimmed || trimmed === pl.name) return;
    try {
      await firstValueFrom(this.api.updatePlaylist(pl.id, { name: trimmed }));
      this.selected.set({ ...pl, name: trimmed });
      this.playlists.update(prev => prev.map(p => p.id === pl.id ? { ...p, name: trimmed } : p));
    } catch { /* ignore */ }
  }

  async removeSong(songIndex: number): Promise<void> {
    const pl = this.selected();
    if (!pl) return;
    this.removing.update(prev => new Set(prev).add(songIndex));
    try {
      await firstValueFrom(this.api.updatePlaylist(pl.id, { songIndexesToRemove: [songIndex] }));
      const updatedEntry = pl.entry?.filter((_, i) => i !== songIndex) ?? [];
      this.selected.set({ ...pl, entry: updatedEntry, songCount: updatedEntry.length });
      this.playlists.update(prev => prev.map(p => p.id === pl.id ? { ...p, songCount: updatedEntry.length } : p));
    } catch { /* ignore */ }
    this.removing.update(prev => { const n = new Set(prev); n.delete(songIndex); return n; });
  }

  confirmRemoveSong(index: number, title: string): void {
    this.askConfirm(`Remove "${title}" from playlist?`, () => this.removeSong(index), 'Remove');
  }

  playlistTrackActions(song: DetailItem): TrackAction[] {
    const actions: TrackAction[] = [];
    if (song.artistId) {
      actions.push({
        label: 'Go to artist',
        action: () => this.router.navigate(['/library', 'artists', song.artistId]),
      });
    }
    if (song.albumId) {
      actions.push({
        label: 'Go to album',
        action: () => this.router.navigate(['/library'], { queryParams: { album: song.albumId } }),
      });
    }
    actions.push({
      label: 'Remove from playlist',
      destructive: true,
      action: () => this.confirmRemoveSong(song._originalIndex, song.title),
    });
    return actions;
  }

  private askConfirm(message: string, cb: () => void | Promise<void>, label = 'Delete'): void {
    this.confirmMessage.set(message);
    this.confirmLabel.set(label);
    this.confirmCallback.set(cb);
  }

  onConfirm(): void {
    const cb = this.confirmCallback();
    this.confirmCallback.set(null);
    Promise.resolve(cb?.()).catch(() => { /* ignore */ });
  }

  onCancelConfirm(): void {
    this.confirmCallback.set(null);
  }

  toTrackFromSong(song: DetailItem): Track {
    return toTrack(song);
  }

  private async fetchPlaylists(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.getPlaylists());
      this.playlists.set(data);
    } catch { /* ignore */ }
    finally { this.loading.set(false); }
  }
}
