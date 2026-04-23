import { Component, inject, signal, computed, effect, OnInit, OnDestroy, HostListener } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, type Song, type Playlist } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService, type Track } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { PlaylistAutocompleteComponent } from '../../components/playlist-autocomplete/playlist-autocomplete.component';
import { TrackAction } from '../../components/track-row/track-row.component';
import { PreserveService } from '../../services/preserve.service';
import type { SlskdUserTransferGroup } from '@nicotind/core';

// ─── Types ──────────────────────────────────────────────────────────

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

type NormState = 'pending' | 'running' | 'fixed' | 'skipped' | 'failed';

type DateGroup = 'Today' | 'Yesterday' | 'This week' | 'Older';

interface SongDateGroup {
  label: DateGroup;
  songs: Song[];
}

// ─── Helpers ────────────────────────────────────────────────────────

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
      const completed = files.filter(f => f.state.includes('Succeeded')).length;
      const active = files.filter(f => f.state === 'InProgress').length;
      const errored = files.filter(f => f.state.includes('Errored') || f.state.includes('Cancelled')).length;
      const totalBytes = files.reduce((s, f) => s + f.size, 0);
      const transferredBytes = files.reduce((s, f) => s + f.bytesTransferred, 0);
      const overallPercent = totalBytes > 0 ? Math.round((transferredBytes / totalBytes) * 100) : 0;

      let state: AlbumGroup['state'] = 'queued';
      if (completed === files.length) state = 'done';
      else if (active > 0) state = 'downloading';
      else if (errored > 0 && completed + errored === files.length) state = 'error';

      groups.push({ key, name, username: transfer.username, fileIds: files.map(f => f.id), totalFiles: files.length, completedFiles: completed, overallPercent, state });
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

function timeAgo(date: string | number): string {
  const diff = Date.now() - (typeof date === 'number' ? date : new Date(date).getTime());
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

function groupRecentSongsByDate(songs: Song[]): SongDateGroup[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
  const weekStart = new Date(todayStart.getTime() - 6 * 86_400_000);

  const buckets: Record<DateGroup, Song[]> = { 'Today': [], 'Yesterday': [], 'This week': [], 'Older': [] };
  for (const song of songs) {
    const d = new Date(song.created).getTime();
    if (d >= todayStart.getTime()) buckets['Today'].push(song);
    else if (d >= yesterdayStart.getTime()) buckets['Yesterday'].push(song);
    else if (d >= weekStart.getTime()) buckets['This week'].push(song);
    else buckets['Older'].push(song);
  }

  const order: DateGroup[] = ['Today', 'Yesterday', 'This week', 'Older'];
  return order.filter(label => buckets[label].length > 0).map(label => ({ label, songs: buckets[label] }));
}

// ─── Component ──────────────────────────────────────────────────────

@Component({
  selector: 'app-downloads',
  imports: [NgTemplateOutlet, FormsModule, ListToolbarComponent, ConfirmDialogComponent, PlaylistAutocompleteComponent],
  templateUrl: './downloads.component.html',
  })
export class DownloadsComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private player = inject(PlayerService);
  private transferService = inject(TransferService);
  private listControls = inject(ListControlsService);
  private router = inject(Router);
  readonly preserve = inject(PreserveService);
  readonly auth = inject(AuthService);

  readonly formatDuration = formatDuration;
  readonly formatSize = formatSize;
  readonly timeAgo = timeAgo;

  readonly storagePercent = computed(() => {
    const used = this.preserve.totalUsage();
    const budget = this.preserve.budget();
    return budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  });

  // State
  readonly activeTab = signal<'active' | 'offline' | 'recent'>('active');
  readonly recentSongs = signal<Song[]>([]);
  readonly selected = signal(new Set<string>());
  readonly lastSelectedId = signal<string | null>(null);
  readonly deleting = signal(new Set<string>());
  readonly scanning = signal(false);
  readonly showPlaylistPicker = signal(false);
  readonly addingToPlaylist = signal(false);
  readonly normStatus = signal(new Map<string, NormState>());
  readonly normalizing = signal(false);

  // Confirm dialog
  readonly confirmMessage = signal('');
  readonly confirmCallback = signal<(() => void | Promise<void>) | null>(null);
  readonly showConfirm = computed(() => this.confirmCallback() !== null);

  // Song context menu
  readonly songMenuId = signal<string | null>(null);

  private askConfirm(message: string, cb: () => void): void {
    this.confirmMessage.set(message);
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

  @HostListener('document:click')
  closeSongMenu(): void {
    this.songMenuId.set(null);
    this.offlineMenuId.set(null);
  }

  private prevHadActive = false;

  // List controls for Recently Added
  readonly recentSortOptions: SortOption[] = [
    { field: 'created', label: 'Date added' },
    { field: 'title', label: 'Title' },
    { field: 'artist', label: 'Artist' },
  ];

  readonly recentControls = this.listControls.connect({
    pageKey: 'downloads-recent',
    items: this.recentSongs,
    searchFields: ['title', 'artist', 'album'] as const,
    sortOptions: this.recentSortOptions,
    defaultSort: 'created',
    defaultDirection: 'desc',
  });

  // ─── Offline tab state ────────────────────────────────────────────
  readonly offlineSelected = signal(new Set<string>());
  readonly offlineSelectedArray = computed(() => Array.from(this.offlineSelected()));
  readonly offlineShowPlaylistPicker = signal(false);
  readonly addingOfflineToPlaylist = signal(false);
  readonly offlineMenuId = signal<string | null>(null);

  readonly offlineSortOptions: SortOption[] = [
    { field: 'preservedAt', label: 'Saved date' },
    { field: 'title', label: 'Title' },
    { field: 'artist', label: 'Artist' },
  ];

  readonly offlineControls = this.listControls.connect({
    pageKey: 'downloads-offline',
    items: this.preserve.preservedTracks,
    searchFields: ['title', 'artist', 'album'] as const,
    sortOptions: this.offlineSortOptions,
    defaultSort: 'preservedAt',
    defaultDirection: 'desc',
  });

  // Computed
  readonly groups = computed(() => groupByAlbum(this.transferService.downloads()));
  readonly inProgressGroups = computed(() => this.groups().filter(g => g.state === 'downloading' || g.state === 'queued'));
  readonly errorGroups = computed(() => this.groups().filter(g => g.state === 'error'));
  readonly doneGroups = computed(() => this.groups().filter(g => g.state === 'done'));
  readonly clearableGroups = computed(() => [...this.errorGroups(), ...this.doneGroups()]);

  readonly showDateGroups = computed(() =>
    this.recentControls.sortField() === 'created' &&
    this.recentControls.sortDirection() === 'desc' &&
    !this.recentControls.searchText(),
  );

  readonly dateGroups = computed(() => groupRecentSongsByDate(this.recentControls.filtered()));

  readonly selectedArray = computed(() => Array.from(this.selected()));

  // Auto-refresh when active downloads complete; auto-switch to active tab when downloads start
  private completionEffect = effect(() => {
    const hasActive = this.inProgressGroups().length > 0;
    if (hasActive && !this.prevHadActive) {
      this.activeTab.set('active');
    }
    if (this.prevHadActive && !hasActive) {
      this.pollRecentSongs();
    }
    this.prevHadActive = hasActive;
  });

  ngOnInit(): void {
    this.fetchRecentSongs();
  }

  ngOnDestroy(): void {}

  isSelected(id: string): boolean {
    return this.selected().has(id);
  }

  toggleSelect(id: string, event: MouseEvent): void {
    const isShift = event.shiftKey;
    const lastId = this.lastSelectedId();

    if (isShift && lastId && lastId !== id) {
      const visible = this.recentControls.filtered();
      const lastIndex = visible.findIndex(s => s.id === lastId);
      const currIndex = visible.findIndex(s => s.id === id);

      if (lastIndex !== -1 && currIndex !== -1) {
        const [start, end] = [Math.min(lastIndex, currIndex), Math.max(lastIndex, currIndex)];
        const rangeIds = visible.slice(start, end + 1).map(s => s.id);

        this.selected.update(prev => {
          const next = new Set(prev);
          const shouldSelect = !prev.has(id);
          for (const rid of rangeIds) {
            if (shouldSelect) next.add(rid);
            else next.delete(rid);
          }
          return next;
        });
        this.lastSelectedId.set(id);
        return;
      }
    }

    this.selected.update(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    this.lastSelectedId.set(id);
  }

  selectAll(): void {
    const visible = this.recentControls.filtered();
    if (this.selected().size === visible.length) {
      this.selected.set(new Set());
    } else {
      this.selected.set(new Set(visible.map(s => s.id)));
    }
  }

  handlePlay(song: Song): void {
    const track: Track = {
      id: song.id,
      title: song.title,
      artist: song.artist,
      album: song.album,
      coverArt: song.coverArt,
      duration: song.duration,
    };
    this.player.play(track);
  }

  handlePlayAll(): void {
    const songs = this.selected().size > 0
      ? this.recentSongs().filter(s => this.selected().has(s.id))
      : this.recentSongs();
    if (!songs.length) return;
    const tracks = songs.map((s): Track => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: s.album,
      coverArt: s.coverArt,
      duration: s.duration,
    }));
    this.player.play(tracks[0]);
    tracks.slice(1).forEach(t => this.player.addToQueue(t));
  }

  async handleDelete(songIds: string[]): Promise<void> {
    this.deleting.update(prev => {
      const next = new Set(prev);
      songIds.forEach(id => next.add(id));
      return next;
    });

    try {
      await firstValueFrom(this.api.deleteSongs(songIds));
      this.recentSongs.update(prev => prev.filter(s => !songIds.includes(s.id)));
      this.selected.update(prev => {
        const next = new Set(prev);
        songIds.forEach(id => next.delete(id));
        return next;
      });
    } catch { /* ignore */ }

    this.deleting.update(prev => {
      const next = new Set(prev);
      songIds.forEach(id => next.delete(id));
      return next;
    });
  }

  async clearGroup(group: AlbumGroup): Promise<void> {
    for (const fileId of group.fileIds) {
      try { await firstValueFrom(this.api.cancelDownload(group.username, fileId)); } catch { /* may already be gone */ }
    }
    this.transferService.poll();
  }

  async clearAllFinished(): Promise<void> {
    for (const group of this.clearableGroups()) {
      for (const fileId of group.fileIds) {
        try { await firstValueFrom(this.api.cancelDownload(group.username, fileId)); } catch { /* ignore */ }
      }
    }
    this.transferService.poll();
  }

  async cancelAll(): Promise<void> {
    try { await firstValueFrom(this.api.cancelAllDownloads()); } catch { /* ignore */ }
    this.transferService.poll();
  }

  async triggerScan(): Promise<void> {
    if (this.scanning()) return;
    this.scanning.set(true);
    try {
      await firstValueFrom(this.api.triggerScan());
      this.pollRecentSongs();
    } catch { /* ignore */ }
    finally { this.scanning.set(false); }
  }

  private pollRecentSongs(delays = [5000, 10000, 20000]): void {
    let totalDelay = 0;
    for (const delay of delays) {
      totalDelay += delay;
      setTimeout(() => this.fetchRecentSongs(), totalDelay);
    }
  }

  removeGroup(group: AlbumGroup): void {
    this.askConfirm(
      `Remove "${group.name}" and all its ${group.totalFiles} file(s)?`,
      async () => {
        for (const fileId of group.fileIds) {
          try { await firstValueFrom(this.api.cancelDownload(group.username, fileId)); } catch { /* ignore */ }
        }
        this.transferService.poll();
      },
    );
  }

  songActions(song: Song): TrackAction[] {
    return [
      {
        label: 'Add to playlist',
        action: () => {
          this.selected.update(prev => new Set([...prev, song.id]));
          this.showPlaylistPicker.set(true);
        },
      },
      {
        label: 'Remove',
        destructive: true,
        action: () => this.askConfirm(`Remove "${song.title}" from library?`, () => this.handleDelete([song.id])),
      },
    ];
  }

  confirmDeleteSelected(): void {
    const count = this.selected().size;
    this.askConfirm(
      `Delete ${count} song${count !== 1 ? 's' : ''} from library?`,
      () => this.handleDelete(this.selectedArray()),
    );
  }

  openPlaylistPicker(): void {
    this.showPlaylistPicker.set(true);
  }

  async addToPlaylist(playlistId: string): Promise<void> {
    const songIds = Array.from(this.selected());
    this.addingToPlaylist.set(true);
    try {
      await firstValueFrom(this.api.updatePlaylist(playlistId, { songIdsToAdd: songIds }));
      this.selected.set(new Set());
      this.showPlaylistPicker.set(false);
    } catch { /* ignore */ }
    finally { this.addingToPlaylist.set(false); }
  }

  async createAndAdd(name: string): Promise<void> {
    if (!name.trim()) return;
    const songIds = Array.from(this.selected());
    this.addingToPlaylist.set(true);
    try {
      await firstValueFrom(this.api.createPlaylist(name.trim(), songIds));
      this.selected.set(new Set());
      this.showPlaylistPicker.set(false);
    } catch { /* ignore */ }
    finally { this.addingToPlaylist.set(false); }
  }

  async normalizeSelected(): Promise<void> {
    const ids = Array.from(this.selected());
    this.normalizing.set(true);
    this.normStatus.set(new Map(ids.map(id => [id, 'pending' as NormState])));
    for (const id of ids) {
      this.normStatus.update(prev => new Map(prev).set(id, 'running'));
      try {
        const result = await firstValueFrom(this.api.fixSongMetadata(id));
        this.normStatus.update(prev => new Map(prev).set(id, result.fixed ? 'fixed' : 'skipped'));
      } catch {
        this.normStatus.update(prev => new Map(prev).set(id, 'failed'));
      }
    }
    this.normalizing.set(false);
    this.fetchRecentSongs();
  }

  async removePreserved(id: string): Promise<void> {
    await this.preserve.remove(id);
  }

  async clearAllPreserved(): Promise<void> {
    const tracks = this.preserve.preservedTracks();
    for (const t of tracks) {
      await this.preserve.remove(t.id);
    }
  }

  selectAllOffline(): void {
    const all = this.offlineControls.filtered().map(t => t.id);
    if (this.offlineSelected().size === all.length) {
      this.offlineSelected.set(new Set());
    } else {
      this.offlineSelected.set(new Set(all));
    }
  }

  toggleOfflineSelect(id: string): void {
    this.offlineSelected.update(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  addOfflineToPlaylistPicker(id: string): void {
    this.offlineSelected.update(s => new Set([...s, id]));
    this.offlineShowPlaylistPicker.set(true);
    this.offlineMenuId.set(null);
  }

  async removeOfflineTracks(ids: string[]): Promise<void> {
    const removed: string[] = [];
    try {
      for (const id of ids) {
        await this.preserve.remove(id);
        removed.push(id);
      }
    } catch { /* ignore individual failure */ }
    finally {
      this.offlineSelected.update(s => {
        const n = new Set(s);
        removed.forEach(id => n.delete(id));
        return n;
      });
    }
  }

  async addOfflineToPlaylist(playlistId: string): Promise<void> {
    const songIds = Array.from(this.offlineSelected());
    this.addingOfflineToPlaylist.set(true);
    try {
      await firstValueFrom(this.api.updatePlaylist(playlistId, { songIdsToAdd: songIds }));
      this.offlineSelected.set(new Set());
      this.offlineShowPlaylistPicker.set(false);
    } catch { /* ignore */ }
    finally { this.addingOfflineToPlaylist.set(false); }
  }

  async createOfflinePlaylistAndAdd(name: string): Promise<void> {
    if (!name.trim()) return;
    const songIds = Array.from(this.offlineSelected());
    this.addingOfflineToPlaylist.set(true);
    try {
      await firstValueFrom(this.api.createPlaylist(name.trim(), songIds));
      this.offlineSelected.set(new Set());
      this.offlineShowPlaylistPicker.set(false);
    } catch { /* ignore */ }
    finally { this.addingOfflineToPlaylist.set(false); }
  }

  navigateAndSearch(query: string): void {
    this.router.navigate(['/'], { queryParams: { q: query } });
  }

  navigateToArtist(song: Song): void {
    if (song.artistId) {
      this.router.navigate(['/library/artists', song.artistId]);
    } else {
      this.navigateAndSearch(song.artist);
    }
  }

  private async fetchRecentSongs(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.getRecentSongs(50));
      this.recentSongs.set(data);
    } catch { /* ignore */ }
  }
}
