import {
  Component,
  inject,
  signal,
  computed,
  effect,
  viewChild,
  ElementRef,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { Album } from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';
import { PlaylistService } from '../../services/playlist.service';
import { TransferService } from '../../services/transfer.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { LibraryFilterPanelComponent } from '../../components/library-filter-panel/library-filter-panel.component';
import { LibrarySongsComponent } from './library-songs.component';
import { SetupService } from '../../services/setup.service';
import { resolveAlbumRoute, resolveGenreRoute, resolveArtistRoute } from '../../lib/route-utils';
import { appendUnique } from '../../lib/append-unique';
import { createRenderWindow } from '../../lib/render-window';
import {
  type AlbumListType,
  ALBUM_LIST_TYPES,
  splitAlbumListType,
  parseMinTracks,
  activeExtraFilterCount,
} from '../../lib/library-filters';
import {
  LIBRARY_FILTER_PARAM_KEYS,
  isEmptyLibraryFilter,
  parseLibraryFilter,
  serializeLibraryFilter,
  type LibraryFilter,
} from '@nicotind/core';

export type { AlbumListType };

type LibraryMode =
  | 'albums'
  | 'compilations'
  | 'singles'
  | 'artists'
  | 'genre'
  | 'songs'
  | 'playlists';

interface AlbumTypeOption {
  value: AlbumListType;
  label: string;
}

const ALBUM_TYPE_OPTIONS: AlbumTypeOption[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'frequent', label: 'Most Played' },
  { value: 'recent', label: 'Recently Played' },
  { value: 'alphabeticalByName', label: 'A–Z' },
  { value: 'starred', label: 'Starred' },
  { value: 'random', label: 'Random' },
];

const PAGE_SIZE = 40;
const RESTORE_CAP = 200;
const STATE_KEY = 'nicotind-library-state';

interface PersistedLibraryState {
  type: AlbumListType;
  loaded: number;
  scrollY: number;
}

function readPersistedState(): PersistedLibraryState | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedLibraryState>;
    if (
      typeof parsed.type !== 'string' ||
      !ALBUM_LIST_TYPES.includes(parsed.type as AlbumListType) ||
      typeof parsed.loaded !== 'number' ||
      typeof parsed.scrollY !== 'number'
    ) {
      return null;
    }
    return parsed as PersistedLibraryState;
  } catch {
    return null;
  }
}

function writePersistedState(state: PersistedLibraryState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

@Component({
  selector: 'app-library',
  imports: [
    RouterLink,
    CoverArtComponent,
    FormsModule,
    LibraryFilterPanelComponent,
    LibrarySongsComponent,
  ],
  templateUrl: './library.component.html',
})
export class LibraryComponent implements OnInit, OnDestroy {
  private api = inject(LibraryApiService);
  readonly auth = inject(AuthService);
  readonly playlistService = inject(PlaylistService);
  private transferService = inject(TransferService);
  private listControls = inject(ListControlsService);
  readonly setup = inject(SetupService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  // ─── Mode ─────────────────────────────────────────────────────────
  readonly modes = [
    { value: 'albums' as LibraryMode, label: 'Albums' },
    { value: 'compilations' as LibraryMode, label: 'Compilations' },
    { value: 'singles' as LibraryMode, label: 'Singles' },
    { value: 'artists' as LibraryMode, label: 'Artists' },
    { value: 'genre' as LibraryMode, label: 'Genre' },
    { value: 'songs' as LibraryMode, label: 'Songs' },
    { value: 'playlists' as LibraryMode, label: 'Playlists' },
  ];

  readonly libraryMode = signal<LibraryMode>(
    (localStorage.getItem('nicotind-library-mode') as LibraryMode) ?? 'albums',
  );

  // Offline (backend unreachable): only the Songs tab works — it reads the
  // on-device preserved tracks. Hide the server-backed tabs so the library page
  // stays usable as the offline browse surface.
  readonly visibleModes = computed(() =>
    this.setup.isOffline() ? this.modes.filter((m) => m.value === 'songs') : this.modes,
  );

  setMode(mode: LibraryMode): void {
    this.libraryMode.set(mode);
    localStorage.setItem('nicotind-library-mode', mode);
    // Fetched flags (not list lengths) gate the lazy fetches so a filter change
    // can invalidate a tab and have it refetch on the next switch.
    if (mode === 'albums' && this.albumsStale) {
      this.albumsStale = false;
      void this.resetAndLoad();
    }
    if (mode === 'compilations' && !this.compilationsFetched()) this.fetchCompilations();
    if (mode === 'singles' && !this.singlesFetched()) this.fetchSingles();
    if (mode === 'artists' && !this.artistsFetched()) this.fetchArtists();
    if (mode === 'genre' && !this.genresFetched()) this.fetchGenres();
    if (mode === 'playlists') void this.playlistService.refresh();
  }

  // ─── Shared metadata filter (all four tabs) ───────────────────────
  // One LibraryFilter drives Albums/Compilations/Singles/Artists ("filter my
  // library, then look at it as albums or artists"), mirrored into URL query
  // params so filtered views are shareable and survive refresh.
  readonly libFilter = signal<LibraryFilter>({});
  /** Albums refetch lazily when the filter changed while another tab was active. */
  private albumsStale = false;

  // ─── Albums (lazy-loaded) ─────────────────────────────────────────
  // Sort options exclude 'starred' — starred is a real WHERE filter in
  // `libFilter` now, not an ordering; `type` is ordering-only. Legacy
  // `type=starred` URLs/persisted state map onto the filter in ngOnInit.
  readonly albumSortOptions = ALBUM_TYPE_OPTIONS.filter((o) => o.value !== 'starred');

  readonly albumSort = signal<AlbumListType>('newest');
  readonly albums = signal<Album[]>([]);
  readonly loading = signal(true);
  readonly loadingMore = signal(false);
  readonly done = signal(false);
  readonly showHidden = signal<boolean>(
    localStorage.getItem('nicotind-library-show-hidden') === '1',
  );

  private offset = 0;
  private observer: IntersectionObserver | null = null;
  private restoring = false;
  private scrollSentinel = viewChild<ElementRef<HTMLElement>>('scrollSentinel');

  readonly gridSortOptions: SortOption[] = [
    { field: 'name', label: 'Name' },
    { field: 'artist', label: 'Artist' },
    { field: 'year', label: 'Year' },
  ];

  // Search-only (empty sortOptions): the grid must preserve the *server* order
  // from `albumListType`; a client sort would override Most Played / Newest /…
  readonly gridControls = this.listControls.connect({
    pageKey: 'library',
    items: this.albums,
    searchFields: ['name', 'artist'] as const,
    sortOptions: [],
  });

  readonly trackCountOptions: Array<{ label: string; value: number | null }> = [
    { label: 'All', value: null },
    { label: '1', value: 1 },
    { label: '2', value: 2 },
    { label: '3', value: 3 },
    { label: '4', value: 4 },
    { label: '5', value: 5 },
    { label: '6', value: 6 },
    { label: '7', value: 7 },
    { label: '8', value: 8 },
    { label: '9', value: 9 },
    { label: '10+', value: 10 },
  ];

  readonly minSongCount = signal<number | null>(null);

  readonly filteredAlbums = computed(() => {
    const min = this.minSongCount();
    if (min === null) return this.gridControls.filtered();
    return this.gridControls.filtered().filter((a) => (a.songCount ?? 0) >= min);
  });

  // Albums-tab-specific filters (projected into the shared panel's content
  // slot); counted separately so the panel badge includes them.
  readonly albumExtraFilterCount = computed(() =>
    activeExtraFilterCount({
      minTracks: this.minSongCount(),
      showHidden: this.showHidden(),
    }),
  );

  // Genre options for the shared panel, lazy-loaded on first open.
  readonly genreOptions = computed(() => this.genres().map((g) => g.value));

  ensureGenresLoaded(): void {
    if (!this.genresFetched() && !this.loadingGenres()) void this.fetchGenres();
  }

  setMinSongCount(n: number | null): void {
    this.minSongCount.set(n);
  }

  /** `<select>` emits strings; '' is the "All" (no-minimum) option. */
  setMinTracksFromSelect(value: string): void {
    this.minSongCount.set(parseMinTracks(value));
  }

  // ─── Singles & EPs ────────────────────────────────────────────────
  // Dedicated view for the release types kept out of the Albums grid.
  readonly singles = signal<Album[]>([]);
  readonly loadingSingles = signal(false);
  readonly singlesFetched = signal(false);

  readonly singlesControls = this.listControls.connect({
    pageKey: 'library-singles',
    items: this.singles,
    searchFields: ['name', 'artist'] as const,
    sortOptions: this.gridSortOptions,
  });

  readonly isSinglesEmpty = computed(
    () =>
      this.singlesFetched() &&
      !this.loadingSingles() &&
      this.singlesControls.filtered().length === 0,
  );

  // ─── Compilations ─────────────────────────────────────────────────
  readonly compilations = signal<Album[]>([]);
  readonly loadingCompilations = signal(false);
  readonly compilationsFetched = signal(false);

  readonly compilationsControls = this.listControls.connect({
    pageKey: 'library-compilations',
    items: this.compilations,
    searchFields: ['name', 'artist'] as const,
    sortOptions: this.gridSortOptions,
  });

  readonly isCompilationsEmpty = computed(
    () =>
      this.compilationsFetched() &&
      !this.loadingCompilations() &&
      this.compilationsControls.filtered().length === 0,
  );

  // ─── Artists ──────────────────────────────────────────────────────
  readonly artists = signal<
    Array<{ id: string; name: string; albumCount: number; coverArt?: string }>
  >([]);
  readonly loadingArtists = signal(false);
  readonly artistsFetched = signal(false);
  readonly isArtistsEmpty = computed(
    () =>
      this.artistsFetched() &&
      !this.loadingArtists() &&
      this.artistControls.filtered().length === 0,
  );

  readonly artistSortOptions: SortOption[] = [
    { field: 'name', label: 'Name' },
    { field: 'albumCount', label: 'Albums' },
  ];

  readonly artistControls = this.listControls.connect({
    pageKey: 'library-artists',
    items: this.artists,
    searchFields: ['name'] as const,
    sortOptions: this.artistSortOptions,
    defaultSort: 'name',
  });

  // Render-windows over the (filtered) tab lists. These tabs used to fetch and
  // render everything at once (artists is unbounded; singles/compilations up to
  // 500), mounting thousands of tiles. Windowing keeps the full filtered list
  // for search/sort but only mounts a growing slice, grown by the shared
  // `#tabSentinel` observer below (tabs are mutually exclusive, so one sentinel).
  readonly singlesWindow = createRenderWindow(this.singlesControls.filtered, 60);
  readonly compilationsWindow = createRenderWindow(this.compilationsControls.filtered, 60);
  readonly artistsWindow = createRenderWindow(this.artistControls.filtered, 80);

  private tabSentinel = viewChild<ElementRef<HTMLElement>>('tabSentinel');
  private tabObserver: IntersectionObserver | null = null;
  private tabObserverEffect = effect(() => {
    const sentinel = this.tabSentinel();
    this.tabObserver?.disconnect();
    this.tabObserver = null;
    if (!sentinel) return;
    this.tabObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) this.growActiveTab();
      },
      { rootMargin: '400px 0px' },
    );
    this.tabObserver.observe(sentinel.nativeElement);
  });

  private growActiveTab(): void {
    switch (this.libraryMode()) {
      case 'singles':
        this.singlesWindow.showMore();
        break;
      case 'compilations':
        this.compilationsWindow.showMore();
        break;
      case 'artists':
        this.artistsWindow.showMore();
        break;
    }
  }

  // ─── Genre ────────────────────────────────────────────────────────
  readonly genres = signal<Array<{ value: string; songCount: number; albumCount: number }>>([]);
  readonly loadingGenres = signal(false);
  readonly genresFetched = signal(false);
  readonly isGenresEmpty = computed(
    () => this.genresFetched() && !this.loadingGenres() && this.genres().length === 0,
  );

  // ─── Lifecycle ────────────────────────────────────────────────────
  private observerEffect = effect(() => {
    const sentinel = this.scrollSentinel();
    this.observer?.disconnect();
    this.observer = null;
    if (!sentinel) return;

    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void this.loadMore();
        }
      },
      { rootMargin: '400px 0px' },
    );
    this.observer.observe(sentinel.nativeElement);
  });

  async ngOnInit(): Promise<void> {
    // Offline: the only usable tab is Songs (on-device preserved tracks).
    if (this.setup.isOffline()) this.libraryMode.set('songs');

    // Shared filter from the URL; a legacy `type=starred` (URL or persisted
    // state) folds into it as the starred filter with a `newest` ordering.
    const qp = this.route.snapshot.queryParamMap;
    const urlFilter = parseLibraryFilter(
      Object.fromEntries(qp.keys.map((k) => [k, qp.getAll(k)])),
    );
    const initialType = this.resolveInitialType();
    const split = splitAlbumListType(initialType);
    this.albumSort.set(split.sort);
    if (split.starredOnly) urlFilter.starred = true;
    this.libFilter.set(urlFilter);

    // Clear any pending dirty state on load to avoid unnecessary fetches
    this.transferService.clearLibraryDirty();

    const persisted = readPersistedState();
    if (
      persisted &&
      persisted.type === initialType &&
      persisted.loaded > PAGE_SIZE &&
      isEmptyLibraryFilter(urlFilter)
    ) {
      await this.restoreAndLoad(persisted);
    } else {
      await this.resetAndLoad();
    }

    const mode = this.libraryMode();
    if (mode === 'compilations') this.fetchCompilations();
    if (mode === 'singles') this.fetchSingles();
    if (mode === 'artists') this.fetchArtists();
    if (mode === 'genre') this.fetchGenres();
    if (mode === 'playlists') void this.playlistService.refresh();
  }

  // ─── Playlists ────────────────────────────────────────────────────
  readonly newPlaylistName = signal('');
  readonly creatingPlaylist = signal(false);

  // Curated (system, global) playlists lead as a "Made for you" shelf; the
  // user's own playlists follow. Split client-side off the one list call.
  readonly curatedPlaylists = computed(() =>
    this.playlistService.playlists().filter((p) => p.kind === 'curated'),
  );
  readonly userPlaylists = computed(() =>
    this.playlistService.playlists().filter((p) => p.kind !== 'curated'),
  );

  async createPlaylist(): Promise<void> {
    const name = this.newPlaylistName().trim();
    if (!name || this.creatingPlaylist()) return;
    this.creatingPlaylist.set(true);
    try {
      await this.playlistService.create(name);
      this.newPlaylistName.set('');
    } finally {
      this.creatingPlaylist.set(false);
    }
  }

  readonly generating = signal(false);

  /** Build a playlist from the starred set via the Radio scorer, then open it. */
  async generateFromFavorites(): Promise<void> {
    if (this.generating()) return;
    this.generating.set(true);
    try {
      const playlist = await this.playlistService.generate({ starred: true });
      await this.router.navigate(['/library/playlists', playlist.id]);
    } catch {
      // Non-fatal (e.g. nothing starred yet) — stay on the list.
    } finally {
      this.generating.set(false);
    }
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.tabObserver?.disconnect();
    this.persistState();
  }

  // ─── Albums fetcher ──────────────────────────────────────────────
  async setAlbumSort(value: AlbumListType): Promise<void> {
    if (this.albumSort() === value) return;
    this.albumSort.set(value);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { type: value },
      queryParamsHandling: 'merge',
    });
    await this.resetAndLoad();
  }

  /**
   * Shared-panel change: mirror the filter into the URL (nulling cleared
   * params), refetch the active tab now, and invalidate the rest so they
   * lazily refetch on their next switch.
   */
  async onFilterChange(filter: LibraryFilter): Promise<void> {
    this.libFilter.set(filter);
    const cleared: Record<string, string | string[] | null> = {};
    for (const key of LIBRARY_FILTER_PARAM_KEYS) cleared[key] = null;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { ...cleared, ...serializeLibraryFilter(filter) },
      queryParamsHandling: 'merge',
    });
    this.singlesFetched.set(false);
    this.compilationsFetched.set(false);
    this.artistsFetched.set(false);
    this.albumsStale = true;
    const mode = this.libraryMode();
    if (mode === 'albums') {
      this.albumsStale = false;
      await this.resetAndLoad();
    } else if (mode === 'singles') {
      await this.fetchSingles();
    } else if (mode === 'compilations') {
      await this.fetchCompilations();
    } else if (mode === 'artists') {
      await this.fetchArtists();
    }
  }

  toggleShowHidden(): void {
    const next = !this.showHidden();
    this.showHidden.set(next);
    localStorage.setItem('nicotind-library-show-hidden', next ? '1' : '0');
    void this.resetAndLoad();
  }

  async hideAlbum(album: Album, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    try {
      await firstValueFrom(this.api.hideAlbum(album.id));
      this.albums.update((existing) => existing.filter((a) => a.id !== album.id));
    } catch {
      /* ignore */
    }
  }

  async unhideAlbum(album: Album, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    try {
      await firstValueFrom(this.api.unhideAlbum(album.id));
      void this.resetAndLoad();
    } catch {
      /* ignore */
    }
  }

  async loadMore(): Promise<void> {
    if (this.loadingMore() || this.done() || this.restoring) return;
    this.loadingMore.set(true);
    try {
      const page = await firstValueFrom(
        this.api.getAlbums(this.albumSort(), PAGE_SIZE, this.offset, {
          includeHidden: this.showHidden(),
          filter: this.libFilter(),
        }),
      );
      if (page.length === 0) {
        this.done.set(true);
      } else {
        this.albums.update((existing) => appendUnique(existing, page));
        this.offset += page.length;
        if (page.length < PAGE_SIZE) this.done.set(true);
      }
      this.persistState();
    } catch {
      /* ignore */
    } finally {
      this.loadingMore.set(false);
    }
  }

  private async resetAndLoad(): Promise<void> {
    this.albums.set([]);
    this.offset = 0;
    this.done.set(false);
    this.loading.set(true);
    try {
      await this.loadMore();
    } finally {
      this.loading.set(false);
    }
  }

  private async restoreAndLoad(persisted: PersistedLibraryState): Promise<void> {
    this.restoring = true;
    this.albums.set([]);
    this.offset = 0;
    this.done.set(false);
    this.loading.set(true);
    const target = Math.min(persisted.loaded, RESTORE_CAP);
    try {
      while (this.offset < target && !this.done()) {
        const remaining = target - this.offset;
        const fetchSize = Math.min(PAGE_SIZE, remaining);
        const page = await firstValueFrom(
          this.api.getAlbums(this.albumSort(), fetchSize, this.offset, {
            includeHidden: this.showHidden(),
          }),
        );
        if (page.length === 0) {
          this.done.set(true);
          break;
        }
        this.albums.update((existing) => appendUnique(existing, page));
        this.offset += page.length;
        if (page.length < fetchSize) this.done.set(true);
      }
      if (persisted.scrollY > 0) {
        requestAnimationFrame(() => window.scrollTo({ top: persisted.scrollY }));
      }
    } catch {
      /* ignore */
    } finally {
      this.restoring = false;
      this.loading.set(false);
    }
  }

  private resolveInitialType(): AlbumListType {
    const urlType = this.route.snapshot.queryParamMap.get('type');
    if (urlType && ALBUM_LIST_TYPES.includes(urlType as AlbumListType)) {
      return urlType as AlbumListType;
    }
    const persisted = readPersistedState();
    return persisted?.type ?? 'newest';
  }

  private persistState(): void {
    writePersistedState({
      type: this.albumSort(),
      loaded: this.albums().length,
      scrollY: typeof window !== 'undefined' ? window.scrollY : 0,
    });
  }

  // ─── Artists / Genre fetchers ────────────────────────────────────
  async fetchArtists(): Promise<void> {
    if (this.loadingArtists()) return;
    this.loadingArtists.set(true);
    try {
      const data = await firstValueFrom(this.api.getArtists(this.libFilter()));
      this.artists.set(data.map((a) => ({ ...a, albumCount: a.albumCount ?? 0 })));
    } catch {
      /* ignore */
    } finally {
      this.loadingArtists.set(false);
      this.artistsFetched.set(true);
    }
  }

  async fetchSingles(): Promise<void> {
    if (this.loadingSingles()) return;
    this.loadingSingles.set(true);
    try {
      const data = await firstValueFrom(this.api.getSingles('newest', 500, 0, this.libFilter()));
      this.singles.set(data);
    } catch {
      /* ignore */
    } finally {
      this.loadingSingles.set(false);
      this.singlesFetched.set(true);
    }
  }

  async fetchCompilations(): Promise<void> {
    if (this.loadingCompilations()) return;
    this.loadingCompilations.set(true);
    try {
      const data = await firstValueFrom(
        this.api.getCompilations('newest', 500, 0, this.libFilter()),
      );
      this.compilations.set(data);
    } catch {
      /* ignore */
    } finally {
      this.loadingCompilations.set(false);
      this.compilationsFetched.set(true);
    }
  }

  async fetchGenres(): Promise<void> {
    if (this.loadingGenres()) return;
    this.loadingGenres.set(true);
    try {
      const data = await firstValueFrom(this.api.getGenres());
      this.genres.set(data.sort((a, b) => b.songCount - a.songCount));
    } catch {
      /* ignore */
    } finally {
      this.loadingGenres.set(false);
      this.genresFetched.set(true);
    }
  }

  getAlbumLink(id: string) {
    return resolveAlbumRoute(id);
  }

  getGenreLink(slug: string) {
    return resolveGenreRoute(slug);
  }

  getArtistLink(id: string) {
    return resolveArtistRoute(id);
  }
}
