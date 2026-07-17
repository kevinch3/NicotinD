import {
  Component,
  inject,
  input,
  output,
  signal,
  computed,
  effect,
  ElementRef,
  viewChild,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { Song } from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';
import { PlayerService, type Track } from '../../services/player.service';
import { PlaylistService } from '../../services/playlist.service';
import { PreserveService } from '../../services/preserve.service';
import { TransferService } from '../../services/transfer.service';
import { SongMenuService } from '../../services/song-menu.service';
import {
  TrackRowComponent,
  type TrackAction,
} from '../../components/track-row/track-row.component';
import { SelectionBarComponent } from '../../components/selection-bar/selection-bar.component';
import { LibraryFilterPanelComponent } from '../../components/library-filter-panel/library-filter-panel.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { isEmptyLibraryFilter, type LibraryFilter } from '@nicotind/core';
import { createSelection } from '../../lib/selection';
import { toTrack, offlineTrackAction } from '../../lib/track-utils';
import { appendUnique } from '../../lib/append-unique';
import type { PreservedTrackMeta } from '../../lib/preserve-store';

export type SongSort = 'newest' | 'title' | 'album';
const SONGS_PAGE_SIZE = 60;

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function metaToTrack(t: PreservedTrackMeta): Track {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    coverArt: t.coverArt,
    duration: t.duration,
    bitRate: t.bitRate,
  };
}

/**
 * The Library "Songs" tab: a flat, filterable, newest-first listing of the whole
 * library. When `offline` is true (backend unreachable) it swaps its source to
 * the on-device preserved tracks — a client-side search/sort list with no server
 * filters — and surfaces the offline-storage controls (usage bar + Clear all).
 */
@Component({
  selector: 'app-library-songs',
  standalone: true,
  imports: [
    TrackRowComponent,
    SelectionBarComponent,
    LibraryFilterPanelComponent,
    ConfirmDialogComponent,
    ListToolbarComponent,
  ],
  templateUrl: './library-songs.component.html',
})
export class LibrarySongsComponent implements OnInit, OnDestroy {
  private api = inject(LibraryApiService);
  readonly auth = inject(AuthService);
  private player = inject(PlayerService);
  private playlists = inject(PlaylistService);
  readonly preserve = inject(PreserveService);
  private transferService = inject(TransferService);
  readonly songMenu = inject(SongMenuService);
  private listControls = inject(ListControlsService);

  // ─── Inputs / outputs ─────────────────────────────────────────────
  /** Shared library filter (owned by the parent, mirrored into the URL). */
  readonly filter = input<LibraryFilter>({});
  /** When true, render the offline (on-device) variant. */
  readonly offline = input(false);
  /** Genre vocabulary for the filter panel (lazy-loaded by the parent). */
  readonly genres = input<string[]>([]);
  readonly filterChange = output<LibraryFilter>();
  readonly ensureGenres = output<void>();

  readonly toTrack = toTrack;
  readonly formatSize = formatSize;
  readonly metaToTrack = metaToTrack;

  // ─── Online listing state ─────────────────────────────────────────
  readonly songs = signal<Song[]>([]);
  readonly visibleSongs = computed(() => {
    const deleted = this.transferService.deletedSongIds();
    return this.songs().filter((s) => !deleted.has(s.id));
  });
  readonly songsLoaded = signal(false);
  readonly songsLoadingMore = signal(false);
  readonly songsDone = signal(false);
  readonly songSort = signal<SongSort>('newest');
  private songsOffset = 0;
  // Local mirror of the filter used for fetches: on a panel change the parent's
  // `filter` input updates asynchronously (after the emit round-trip), so we
  // fetch against this signal to avoid a one-change-stale query.
  private readonly activeFilter = signal<LibraryFilter>({});
  readonly hasActiveFilter = computed(() => !isEmptyLibraryFilter(this.activeFilter()));

  // Free-text search input. Updates `searchText` immediately on every keystroke
  // for the input binding, but the actual fetch is debounced (250 ms) so a
  // typing burst collapses into a single refetch + pagination reset. `q` is
  // transient — not URL-mirrored through `LibraryFilter` — so it intentionally
  // lives only in this component.
  readonly searchText = signal('');
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  readonly sortOptions: { value: SongSort; label: string }[] = [
    { value: 'newest', label: 'Recently added' },
    { value: 'title', label: 'Title' },
    { value: 'album', label: 'Album' },
  ];

  readonly songsSentinel = viewChild<ElementRef<HTMLElement>>('songsSentinel');
  private songsObserver?: IntersectionObserver;

  readonly selection = createSelection();
  readonly songOrderedIds = computed(() => this.visibleSongs().map((s) => s.id));
  private selectedSongs(): Song[] {
    return this.visibleSongs().filter((s) => this.selection.isSelected(s.id));
  }

  // ─── Offline listing state ────────────────────────────────────────
  readonly offlineSortOptions: SortOption[] = [
    { field: 'preservedAt', label: 'Saved date' },
    { field: 'title', label: 'Title' },
    { field: 'artist', label: 'Artist' },
  ];
  readonly offlineControls = this.listControls.connect({
    pageKey: 'library-songs-offline',
    items: this.preserve.preservedTracks,
    searchFields: ['title', 'artist', 'album'] as const,
    sortOptions: this.offlineSortOptions,
    defaultSort: 'preservedAt',
    defaultDirection: 'desc',
  });
  readonly storagePercent = computed(() => {
    const used = this.preserve.totalUsage();
    const budget = this.preserve.budget();
    return budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  });

  // ─── Confirm dialog (bulk delete / clear all) ─────────────────────
  readonly deleteError = signal<string | null>(null);
  readonly confirmMessage = signal('');
  readonly confirmCallback = signal<(() => void | Promise<void>) | null>(null);
  readonly showConfirm = computed(() => this.confirmCallback() !== null);

  private askConfirm(message: string, cb: () => void | Promise<void>): void {
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

  // ─── Lifecycle ────────────────────────────────────────────────────
  private songsObserverEffect = effect(() => {
    const sentinel = this.songsSentinel();
    this.songsObserver?.disconnect();
    if (!sentinel || this.offline()) return;
    this.songsObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void this.loadSongs();
      },
      { rootMargin: '400px 0px' },
    );
    this.songsObserver.observe(sentinel.nativeElement);
  });

  // Source selection reacts to the live `offline` input flipping mid-session:
  // losing/regaining connectivity swaps between the server listing and the
  // on-device preserved tracks without a reload. The initial load is done in
  // ngOnInit (with the filter applied), so this only handles genuine changes.
  private lastOffline: boolean | null = null;
  private offlineSourceEffect = effect(() => {
    const offline = this.offline();
    if (this.lastOffline === null) {
      this.lastOffline = offline;
      return;
    }
    if (offline === this.lastOffline) return;
    this.lastOffline = offline;
    if (offline) void this.preserve.refreshList();
    else void this.loadSongs(true);
  });

  ngOnInit(): void {
    this.activeFilter.set(this.filter());
    if (this.offline()) void this.preserve.refreshList();
    else void this.loadSongs(true);
  }

  ngOnDestroy(): void {
    this.songsObserver?.disconnect();
    if (this.searchDebounceTimer !== null) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
  }

  // ─── Online fetching ──────────────────────────────────────────────
  setSongSort(sort: SongSort): void {
    if (sort === this.songSort()) return;
    this.songSort.set(sort);
    void this.loadSongs(true);
  }

  /** Search input: bind immediately, refetch after 250 ms idle (debounced). */
  setSearchText(text: string): void {
    this.searchText.set(text);
    if (this.searchDebounceTimer !== null) clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = setTimeout(() => {
      this.searchDebounceTimer = null;
      void this.loadSongs(true);
    }, 250);
  }

  /** Filter panel change: bubble up (parent mirrors to URL) and refetch. */
  onFilterChange(filter: LibraryFilter): void {
    this.activeFilter.set(filter);
    this.filterChange.emit(filter);
    void this.loadSongs(true);
  }

  async loadSongs(reset = false): Promise<void> {
    if (reset) {
      this.songsOffset = 0;
      this.songs.set([]);
      this.songsDone.set(false);
      this.selection.exit();
    }
    if (this.songsLoadingMore() || (this.songsDone() && !reset)) return;
    this.songsLoadingMore.set(true);
    try {
      const q = this.searchText().trim();
      const page = await firstValueFrom(
        this.api.getAllSongs(SONGS_PAGE_SIZE, this.songsOffset, {
          sort: this.songSort(),
          filter: this.activeFilter(),
          q: q || undefined,
        }),
      );
      this.songs.update((existing) => appendUnique(existing, page));
      this.songsOffset += page.length;
      if (page.length < SONGS_PAGE_SIZE) this.songsDone.set(true);
    } catch {
      this.songsDone.set(true);
    } finally {
      this.songsLoaded.set(true);
      this.songsLoadingMore.set(false);
    }
  }

  playSong(index: number): void {
    const tracks = this.visibleSongs().map((s) => toTrack(s));
    if (!tracks.length) return;
    this.player.playWithContext(tracks, index, { type: 'adhoc', name: 'Songs' });
  }

  songSubtitle(song: Song): string {
    return song.album || song.artist;
  }

  // ─── Bulk actions (online) ────────────────────────────────────────
  playSelected(): void {
    const tracks = this.selectedSongs().map((s) => toTrack(s));
    if (!tracks.length) return;
    this.player.playWithContext(tracks, 0, { type: 'adhoc', name: 'Songs' });
    this.selection.exit();
  }

  queueSelected(): void {
    for (const s of this.selectedSongs()) this.player.addToQueue(toTrack(s));
    this.selection.exit();
  }

  addSelectedToPlaylist(): void {
    const ids = [...this.selection.ids()];
    if (!ids.length) return;
    this.playlists.openPicker(ids);
    this.selection.exit();
  }

  downloadSelected(): void {
    const tracks = this.selectedSongs().map((s) => toTrack(s));
    if (!tracks.length) return;
    void this.preserve.preserveCollection('library-songs-selection', 'Selected songs', tracks);
    this.selection.exit();
  }

  selectAllSongs(): void {
    this.selection.selectAll(this.visibleSongs().map((s) => s.id));
  }

  private pruneSongs(ids: string[]): void {
    const gone = new Set(ids);
    this.songs.update((s) => s.filter((x) => !gone.has(x.id)));
  }

  deleteSelectedSongs(): void {
    const ids = [...this.selection.ids()];
    if (ids.length === 0) return;
    this.askConfirm(
      `Remove ${ids.length} song${ids.length !== 1 ? 's' : ''} from library?`,
      async () => {
        this.deleteError.set(null);
        try {
          const result = await firstValueFrom(this.api.deleteSongs(ids));
          this.transferService.addDeletedIds(ids);
          this.pruneSongs(ids);
          this.selection.exit();
          if (result.deletedCount < ids.length) {
            this.deleteError.set(
              `Removed ${result.deletedCount} of ${ids.length} songs. ${ids.length - result.deletedCount} could not be removed.`,
            );
          }
        } catch {
          this.deleteError.set('Failed to remove the selected songs.');
        }
      },
    );
  }

  // ─── Offline variant ──────────────────────────────────────────────
  /** Minimal, backend-free menu for a downloaded track. */
  offlineActions(t: PreservedTrackMeta): TrackAction[] {
    const track = metaToTrack(t);
    return [
      { label: 'Add to queue', action: () => this.player.addToQueue(track) },
      { label: 'Play next', action: () => this.player.queueNext(track) },
      offlineTrackAction(this.preserve, track),
    ];
  }

  playOffline(index: number): void {
    const tracks = this.offlineControls.filtered().map((t) => metaToTrack(t));
    if (!tracks.length) return;
    this.player.playWithContext(tracks, index, { type: 'saved-offline', name: 'Downloaded' });
  }

  clearAllOffline(): void {
    this.askConfirm('Remove all downloaded songs from this device?', async () => {
      await this.preserve.clearAll();
    });
  }
}
