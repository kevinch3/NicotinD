import {
  Component,
  inject,
  signal,
  computed,
  effect,
  OnInit,
  OnDestroy,
  HostListener,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { SystemApiService } from '../../services/api/system-api.service';
import type { Song } from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';
import { PlayerService, type Track, shuffleArray } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { resolveArtistRoute } from '../../lib/route-utils';
import { PreserveService } from '../../services/preserve.service';
import { PlaylistService } from '../../services/playlist.service';
import { SongMenuService } from '../../services/song-menu.service';
import { createSelection } from '../../lib/selection';
import { SelectionBarComponent } from '../../components/selection-bar/selection-bar.component';
import { toTrack } from '../../lib/track-utils';
import type { AcquireJob } from '@nicotind/core';
import {
  type AlbumGroup,
  type DownloadItem,
  groupByAlbum,
  buildDownloadFeed,
  mergeAcquisitionJobs,
} from '../../lib/download-groups';
import { DownloadItemComponent } from '../../components/download-item/download-item.component';

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

  const buckets: Record<DateGroup, Song[]> = {
    Today: [],
    Yesterday: [],
    'This week': [],
    Older: [],
  };
  for (const song of songs) {
    const d = new Date(song.created).getTime();
    if (d >= todayStart.getTime()) buckets['Today'].push(song);
    else if (d >= yesterdayStart.getTime()) buckets['Yesterday'].push(song);
    else if (d >= weekStart.getTime()) buckets['This week'].push(song);
    else buckets['Older'].push(song);
  }

  const order: DateGroup[] = ['Today', 'Yesterday', 'This week', 'Older'];
  return order
    .filter((label) => buckets[label].length > 0)
    .map((label) => ({ label, songs: buckets[label] }));
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
  imports: [
    NgTemplateOutlet,
    FormsModule,
    ListToolbarComponent,
    ConfirmDialogComponent,
    DownloadItemComponent,
    SelectionBarComponent,
  ],
  templateUrl: './downloads.component.html',
})
export class DownloadsComponent implements OnInit, OnDestroy {
  private api = inject(DownloadsApiService);
  private libraryApi = inject(LibraryApiService);
  private systemApi = inject(SystemApiService);
  private player = inject(PlayerService);
  private transferService = inject(TransferService);
  private listControls = inject(ListControlsService);
  private router = inject(Router);
  readonly preserve = inject(PreserveService);
  readonly auth = inject(AuthService);
  private playlists = inject(PlaylistService);
  readonly songMenu = inject(SongMenuService);

  readonly Math = Math;
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
  /** Recent-songs multi-select, shared with SelectionBarComponent. */
  readonly selection = createSelection();
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
    Promise.resolve(cb?.()).catch(() => {
      /* ignore */
    });
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

  /**
   * Excludes songs deleted (this session) elsewhere in the app — mirrors the
   * pattern in genre-detail/artist-detail. Feeds `recentControls` so search,
   * sort, and date-grouping all agree with the deleted-id filter (rather than
   * filtering downstream of it, which would let the rendered list and the
   * selection/order helpers disagree).
   */
  readonly visibleRecent = computed(() => {
    const deleted = this.transferService.deletedSongIds();
    return this.recentSongs().filter((s) => !deleted.has(s.id));
  });

  readonly recentControls = this.listControls.connect({
    pageKey: 'downloads-recent',
    items: this.visibleRecent,
    searchFields: ['title', 'artist', 'album'] as const,
    sortOptions: this.recentSortOptions,
    defaultSort: 'created',
    defaultDirection: 'desc',
  });

  /** The ids as currently displayed (post search/sort/date-filter) — the single
   * source shift-click range-select, selectAll, and bulk actions all read from. */
  readonly recentOrderedIds = computed(() => this.recentControls.filtered().map((s) => s.id));

  // ─── Offline tab state ────────────────────────────────────────────
  readonly offlineSelection = createSelection();
  readonly offlineSelectedArray = computed(() => [...this.offlineSelection.ids()]);
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
  // Used by the completion effect to auto-switch tabs / refresh on completion.
  readonly inProgressGroups = computed(() =>
    this.groups().filter((g) => g.state === 'downloading' || g.state === 'queued'),
  );

  // Computed — acquire jobs (the finished buckets drive "Clear finished").
  readonly sortedAcquireJobs = computed(() => sortAcquireJobs(this.transferService.acquireJobs()));
  readonly failedAcquireJobs = computed(() =>
    this.sortedAcquireJobs().filter((j) => j.state === 'failed'),
  );
  readonly doneAcquireJobs = computed(() =>
    this.sortedAcquireJobs().filter((j) => j.state === 'done'),
  );

  // Unified Active-tab feed: slskd groups + acquire jobs as one sorted list,
  // then the unified acquisition jobs folded in (post-download stages:
  // organizing → scanning → processing → done, honest-partial unavailable
  // counts, and job rows whose transfers vanished from slskd).
  readonly downloadFeed = computed(() =>
    mergeAcquisitionJobs(
      buildDownloadFeed(this.groups(), this.transferService.acquireJobs()),
      this.transferService.acquisitionJobs(),
    ),
  );
  readonly activeFeedCount = computed(
    () => this.downloadFeed().filter((i) => i.stage !== 'done' && i.stage !== 'error').length,
  );
  readonly clearableFeedCount = computed(
    () => this.downloadFeed().filter((i) => i.stage === 'done' || i.stage === 'error').length,
  );

  readonly showDateGroups = computed(
    () =>
      this.recentControls.sortField() === 'created' &&
      this.recentControls.sortDirection() === 'desc' &&
      !this.recentControls.searchText(),
  );

  readonly dateGroups = computed(() => groupRecentSongsByDate(this.recentControls.filtered()));

  readonly selectedArray = computed(() => [...this.selection.ids()]);

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

  selectAll(): void {
    const visible = this.recentOrderedIds();
    if (this.selection.count() === visible.length) {
      this.selection.ids.set(new Set());
    } else {
      this.selection.selectAll(visible);
    }
  }

  playSelectedRecent(): void {
    const songs = this.recentControls.filtered().filter((s) => this.selection.isSelected(s.id));
    if (!songs.length) return;
    this.player.playWithContext(
      songs.map((s) => toTrack(s)),
      0,
      { type: 'adhoc' },
    );
    this.selection.exit();
  }

  queueSelectedRecent(): void {
    for (const s of this.recentControls.filtered().filter((s) => this.selection.isSelected(s.id))) {
      this.player.addToQueue(toTrack(s));
    }
    this.selection.exit();
  }

  addSelectedRecentToPlaylist(): void {
    const ids = this.selectedArray();
    if (!ids.length) return;
    this.playlists.openPicker(ids);
    this.selection.exit();
  }

  preserveSelectedRecent(): void {
    const songs = this.recentControls.filtered().filter((s) => this.selection.isSelected(s.id));
    if (!songs.length) return;
    void this.preserve.preserveCollection(
      'downloads-recent-selection',
      'Selected tracks',
      songs.map((s) => toTrack(s)),
    );
    this.selection.exit();
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
    const visible = this.recentControls.filtered();
    const songs =
      this.selection.count() > 0 ? visible.filter((s) => this.selection.isSelected(s.id)) : visible;
    if (!songs.length) return;
    const tracks = shuffleArray(songs.map((s) => toTrack(s)));
    this.player.playWithContext(tracks, 0, { type: 'adhoc' });
  }

  handleOfflinePlay(index: number): void {
    const tracks = this.offlineControls.filtered().map(
      (t): Track => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        coverArt: t.coverArt,
        duration: t.duration,
      }),
    );
    this.player.playWithContext(tracks, index, { type: 'saved-offline', name: 'Saved Offline' });
  }

  handleOfflinePlayAll(): void {
    const tracks = shuffleArray(
      this.offlineControls.filtered().map(
        (t): Track => ({
          id: t.id,
          title: t.title,
          artist: t.artist,
          album: t.album,
          coverArt: t.coverArt,
          duration: t.duration,
        }),
      ),
    );
    if (!tracks.length) return;
    this.player.playWithContext(tracks, 0, { type: 'saved-offline', name: 'Saved Offline' });
  }

  async handleDelete(songIds: string[]): Promise<void> {
    this.deleteError.set(null);
    this.deleting.update((prev) => {
      const next = new Set(prev);
      songIds.forEach((id) => next.add(id));
      return next;
    });

    try {
      const result = await firstValueFrom(this.libraryApi.deleteSongs(songIds));
      this.recentSongs.update((prev) => prev.filter((s) => !songIds.includes(s.id)));
      this.selection.ids.update((prev) => {
        const next = new Set(prev);
        songIds.forEach((id) => next.delete(id));
        return next;
      });
      if (result.deletedCount < songIds.length) {
        const failedCount = songIds.length - result.deletedCount;
        this.deleteError.set(
          `Deleted ${result.deletedCount} of ${songIds.length} songs. ${failedCount} could not be removed.`,
        );
      }
    } catch {
      this.deleteError.set('Failed to delete songs. Please try again.');
    }

    this.deleting.update((prev) => {
      const next = new Set(prev);
      songIds.forEach((id) => next.delete(id));
      return next;
    });
  }

  // Re-enqueue the failed tracks of a group. slskd resumes the partial files,
  // and the retried transfers get a fresh auto-retry budget on the server.
  async retryGroup(group: AlbumGroup): Promise<void> {
    const ids = group.erroredFileIds;
    if (!ids.length) return;
    this.retrying.update((prev) => new Set(prev).add(group.key));
    try {
      await firstValueFrom(
        this.api.retryDownloads(ids.map((id) => ({ username: group.username, id }))),
      );
    } catch {
      /* ignore */
    } finally {
      this.retrying.update((prev) => {
        const next = new Set(prev);
        next.delete(group.key);
        return next;
      });
      this.transferService.kickPoll();
    }
  }

  async clearGroup(group: AlbumGroup): Promise<void> {
    await Promise.all(
      group.fileIds.map((id) =>
        firstValueFrom(this.api.cancelDownload(group.username, id)).catch(() => {}),
      ),
    );
    this.transferService.kickPoll();
  }

  async clearAllFinished(): Promise<void> {
    try {
      await firstValueFrom(this.api.cancelAllFinished());
    } catch {
      /* ignore */
    }
    // Also clear all done/failed acquire jobs
    const toClear = [...this.failedAcquireJobs(), ...this.doneAcquireJobs()];
    await Promise.all(
      toClear.map((j) => firstValueFrom(this.api.deleteAcquireJob(j.id)).catch(() => {})),
    );
    this.transferService.kickPoll();
  }

  async cancelAll(): Promise<void> {
    try {
      await firstValueFrom(this.api.cancelAllDownloads());
    } catch {
      /* ignore */
    }
    this.transferService.kickPoll();
  }

  async triggerScan(): Promise<void> {
    if (this.scanning()) return;
    this.scanning.set(true);
    try {
      await firstValueFrom(this.systemApi.triggerScan());
      this.pollRecentSongs();
    } catch {
      /* ignore */
    } finally {
      this.scanning.set(false);
    }
  }

  private pollRecentSongs(delays = [5000, 10000, 20000]): void {
    let totalDelay = 0;
    for (const delay of delays) {
      totalDelay += delay;
      setTimeout(() => this.fetchRecentSongs(), totalDelay);
    }
  }

  removeGroup(group: AlbumGroup): void {
    this.askConfirm(`Remove "${group.name}" and all its ${group.totalFiles} file(s)?`, async () => {
      await Promise.all(
        group.fileIds.map((id) =>
          firstValueFrom(this.api.cancelDownload(group.username, id)).catch(() => {}),
        ),
      );
      this.transferService.kickPoll();
    });
  }

  // ─── Unified feed dispatch (routes a DownloadItem action to its source) ───

  onItemRetry(item: DownloadItem): void {
    if (item.kind === 'slskd') {
      const g = this.groups().find((x) => x.key === item.key);
      if (g) void this.retryGroup(g);
    } else {
      const j = this.transferService.acquireJobs().find((x) => x.id === item.key);
      if (j) void this.retryAcquireJob(j);
    }
  }

  onItemCancel(item: DownloadItem): void {
    if (item.kind === 'slskd') {
      const g = this.groups().find((x) => x.key === item.key);
      if (g) void this.clearGroup(g);
    } else {
      const j = this.transferService.acquireJobs().find((x) => x.id === item.key);
      if (j) void this.dismissAcquireJob(j);
    }
  }

  onItemRemove(item: DownloadItem): void {
    if (item.kind === 'slskd') {
      const g = this.groups().find((x) => x.key === item.key);
      if (g) this.removeGroup(g);
    } else {
      const j = this.transferService.acquireJobs().find((x) => x.id === item.key);
      if (j) void this.dismissAcquireJob(j);
    }
  }

  // ─── Acquire job actions ─────────────────────────────────────────

  async dismissAcquireJob(job: AcquireJob): Promise<void> {
    try {
      await firstValueFrom(this.api.deleteAcquireJob(job.id));
    } catch {
      /* ignore */
    }
    this.transferService.kickPoll();
  }

  async retryAcquireJob(job: AcquireJob): Promise<void> {
    this.retrying.update((prev) => new Set(prev).add(job.id));
    try {
      await firstValueFrom(this.api.retryAcquireJob(job.id));
    } catch {
      /* ignore */
    } finally {
      this.retrying.update((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
      this.transferService.kickPoll();
    }
  }

  confirmDeleteSelected(): void {
    const count = this.selection.count();
    this.askConfirm(`Delete ${count} song${count !== 1 ? 's' : ''} from library?`, () =>
      this.handleDelete(this.selectedArray()),
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
    const all = this.offlineControls.filtered().map((t) => t.id);
    if (all.every((id) => this.offlineSelection.isSelected(id))) {
      this.offlineSelection.ids.set(new Set());
    } else {
      this.offlineSelection.selectAll(all);
    }
  }

  toggleOfflineSelect(id: string): void {
    this.offlineSelection.toggle(id);
  }

  async removeOfflineTracks(ids: string[]): Promise<void> {
    const removed: string[] = [];
    try {
      for (const id of ids) {
        await this.preserve.remove(id);
        removed.push(id);
      }
    } catch {
      /* ignore individual failure */
    } finally {
      this.offlineSelection.ids.update((s) => {
        const n = new Set(s);
        removed.forEach((id) => n.delete(id));
        return n;
      });
    }
  }

  navigateAndSearch(query: string): void {
    this.router.navigate(['/'], { queryParams: { q: query } });
  }

  async navigateToArtist(song: Song): Promise<void> {
    if (song.artistId) {
      void this.router.navigate(resolveArtistRoute(song.artistId));
      return;
    }
    // No id (network-origin row): resolve the name to a local artist page when
    // possible, else fall back to searching for the artist.
    const id = await firstValueFrom(this.libraryApi.resolveArtistIdByName(song.artist));
    if (id) void this.router.navigate(resolveArtistRoute(id));
    else this.navigateAndSearch(song.artist);
  }

  private async fetchRecentSongs(): Promise<void> {
    try {
      const data = await firstValueFrom(this.libraryApi.getRecentSongs(50));
      this.recentSongs.set(data);
    } catch {
      /* ignore */
    }
  }
}
