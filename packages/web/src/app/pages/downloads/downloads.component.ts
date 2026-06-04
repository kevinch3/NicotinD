import { Component, inject, signal, computed, effect, OnInit, OnDestroy, HostListener } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, type Song } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService, type Track, shuffleArray } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { TrackAction } from '../../components/track-row/track-row.component';
import { resolveArtistRoute } from '../../lib/route-utils';
import { PreserveService } from '../../services/preserve.service';
import type { AcquireJob } from '@nicotind/core';
import {
  type AlbumGroup,
  groupByAlbum,
  albumGroupTitle,
  albumGroupTotal,
} from '../../lib/download-groups';

// ─── Types ──────────────────────────────────────────────────────────

type DateGroup = 'Today' | 'Yesterday' | 'This week' | 'Older';

interface SongDateGroup {
  label: DateGroup;
  songs: Song[];
}

// ─── Helpers ────────────────────────────────────────────────────────

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

/** Shorten a raw URL into a human-readable label (used when job.label is absent). */
function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1
      ? u.pathname.substring(0, 40) + (u.pathname.length > 40 ? '…' : '')
      : '';
    return u.hostname + path;
  } catch {
    return url.substring(0, 50);
  }
}

/** Display label for an acquire job. */
function acquireLabel(job: AcquireJob): string {
  return job.label ?? shortenUrl(job.url);
}

const ACQUIRE_STATE_ORDER: Record<AcquireJob['state'], number> = {
  running: 0,
  queued: 1,
  failed: 2,
  done: 3,
};

function sortAcquireJobs(jobs: AcquireJob[]): AcquireJob[] {
  return [...jobs].sort((a, b) => ACQUIRE_STATE_ORDER[a.state] - ACQUIRE_STATE_ORDER[b.state]);
}

// ─── Component ──────────────────────────────────────────────────────

@Component({
  selector: 'app-downloads',
  imports: [NgTemplateOutlet, FormsModule, ListToolbarComponent, ConfirmDialogComponent],
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

  readonly Math = Math;
  readonly formatDuration = formatDuration;
  readonly formatSize = formatSize;
  readonly timeAgo = timeAgo;
  readonly albumGroupTitle = albumGroupTitle;
  readonly albumGroupTotal = albumGroupTotal;
  readonly acquireLabel = acquireLabel;

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
  readonly retrying = signal(new Set<string>());
  readonly deleteError = signal<string | null>(null);
  readonly scanning = signal(false);

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

  // Computed — slskd transfers
  readonly groups = computed(() => groupByAlbum(this.transferService.downloads()));
  readonly inProgressGroups = computed(() => this.groups().filter(g => g.state === 'downloading' || g.state === 'queued'));
  readonly errorGroups = computed(() => this.groups().filter(g => g.state === 'error'));
  readonly doneGroups = computed(() => this.groups().filter(g => g.state === 'done'));
  readonly clearableGroups = computed(() => [...this.errorGroups(), ...this.doneGroups()]);

  // Computed — acquire jobs
  readonly sortedAcquireJobs = computed(() => sortAcquireJobs(this.transferService.acquireJobs()));
  readonly activeAcquireJobs = computed(() => this.sortedAcquireJobs().filter(j => j.state === 'running' || j.state === 'queued'));
  readonly failedAcquireJobs = computed(() => this.sortedAcquireJobs().filter(j => j.state === 'failed'));
  readonly doneAcquireJobs = computed(() => this.sortedAcquireJobs().filter(j => j.state === 'done'));

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
    const tracks = shuffleArray(songs.map((s): Track => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: s.album,
      coverArt: s.coverArt,
      duration: s.duration,
    })));
    this.player.playWithContext(tracks, 0, { type: 'adhoc' });
  }

  handleOfflinePlay(index: number): void {
    const tracks = this.offlineControls.filtered().map((t): Track => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      album: t.album,
      coverArt: t.coverArt,
      duration: t.duration,
    }));
    this.player.playWithContext(tracks, index, { type: 'saved-offline', name: 'Saved Offline' });
  }

  handleOfflinePlayAll(): void {
    const tracks = shuffleArray(
      this.offlineControls.filtered().map((t): Track => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        coverArt: t.coverArt,
        duration: t.duration,
      }))
    );
    if (!tracks.length) return;
    this.player.playWithContext(tracks, 0, { type: 'saved-offline', name: 'Saved Offline' });
  }

  async handleDelete(songIds: string[]): Promise<void> {
    this.deleteError.set(null);
    this.deleting.update(prev => {
      const next = new Set(prev);
      songIds.forEach(id => next.add(id));
      return next;
    });

    try {
      const result = await firstValueFrom(this.api.deleteSongs(songIds));
      this.recentSongs.update(prev => prev.filter(s => !songIds.includes(s.id)));
      this.selected.update(prev => {
        const next = new Set(prev);
        songIds.forEach(id => next.delete(id));
        return next;
      });
      if (result.deletedCount < songIds.length) {
        const failedCount = songIds.length - result.deletedCount;
        this.deleteError.set(`Deleted ${result.deletedCount} of ${songIds.length} songs. ${failedCount} could not be removed.`);
      }
    } catch {
      this.deleteError.set('Failed to delete songs. Please try again.');
    }

    this.deleting.update(prev => {
      const next = new Set(prev);
      songIds.forEach(id => next.delete(id));
      return next;
    });
  }

  // Re-enqueue the failed tracks of a group. slskd resumes the partial files,
  // and the retried transfers get a fresh auto-retry budget on the server.
  async retryGroup(group: AlbumGroup): Promise<void> {
    const ids = group.erroredFileIds;
    if (!ids.length) return;
    this.retrying.update(prev => new Set(prev).add(group.key));
    try {
      await firstValueFrom(
        this.api.retryDownloads(ids.map(id => ({ username: group.username, id }))),
      );
    } catch { /* ignore */ }
    finally {
      this.retrying.update(prev => {
        const next = new Set(prev);
        next.delete(group.key);
        return next;
      });
      this.transferService.poll();
    }
  }

  async clearGroup(group: AlbumGroup): Promise<void> {
    await Promise.all(
      group.fileIds.map(id =>
        firstValueFrom(this.api.cancelDownload(group.username, id)).catch(() => {}),
      ),
    );
    this.transferService.poll();
  }

  async clearAllFinished(): Promise<void> {
    try { await firstValueFrom(this.api.cancelAllFinished()); } catch { /* ignore */ }
    // Also clear all done/failed acquire jobs
    const toClear = [...this.failedAcquireJobs(), ...this.doneAcquireJobs()];
    await Promise.all(
      toClear.map(j => firstValueFrom(this.api.deleteAcquireJob(j.id)).catch(() => {})),
    );
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
        await Promise.all(
          group.fileIds.map((id) =>
            firstValueFrom(this.api.cancelDownload(group.username, id)).catch(() => {}),
          ),
        );
        this.transferService.poll();
      },
    );
  }

  // ─── Acquire job actions ─────────────────────────────────────────

  async dismissAcquireJob(job: AcquireJob): Promise<void> {
    try {
      await firstValueFrom(this.api.deleteAcquireJob(job.id));
    } catch { /* ignore */ }
    this.transferService.poll();
  }

  async retryAcquireJob(job: AcquireJob): Promise<void> {
    this.retrying.update(prev => new Set(prev).add(job.id));
    try {
      await firstValueFrom(this.api.retryAcquireJob(job.id));
    } catch { /* ignore */ }
    finally {
      this.retrying.update(prev => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
      this.transferService.poll();
    }
  }

  songActions(song: Song): TrackAction[] {
    return [
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
    const selected = this.offlineSelected();
    if (all.every(id => selected.has(id))) {
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

  navigateAndSearch(query: string): void {
    this.router.navigate(['/'], { queryParams: { q: query } });
  }

  navigateToArtist(song: Song): void {
    if (song.artistId) {
      this.router.navigate(resolveArtistRoute(song.artistId));
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
