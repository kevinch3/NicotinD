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
import { ApiService, type Album } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlaylistService } from '../../services/playlist.service';
import { TransferService } from '../../services/transfer.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { resolveAlbumRoute, resolveGenreRoute, resolveArtistRoute } from '../../lib/route-utils';
import { appendUnique } from '../../lib/append-unique';
import {
  type AlbumListType,
  ALBUM_LIST_TYPES,
  effectiveAlbumListType,
  splitAlbumListType,
  parseMinTracks,
  activeFilterCount,
} from '../../lib/library-filters';

export type { AlbumListType };

type LibraryMode = 'albums' | 'singles' | 'artists' | 'genre' | 'playlists';

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
  imports: [ListToolbarComponent, RouterLink, CoverArtComponent, FormsModule],
  templateUrl: './library.component.html',
})
export class LibraryComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  readonly auth = inject(AuthService);
  readonly playlistService = inject(PlaylistService);
  private transferService = inject(TransferService);
  private listControls = inject(ListControlsService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  // ─── Mode ─────────────────────────────────────────────────────────
  readonly modes = [
    { value: 'albums' as LibraryMode, label: 'Albums' },
    { value: 'singles' as LibraryMode, label: 'Singles' },
    { value: 'artists' as LibraryMode, label: 'Artists' },
    { value: 'genre' as LibraryMode, label: 'Genre' },
    { value: 'playlists' as LibraryMode, label: 'Playlists' },
  ];

  readonly libraryMode = signal<LibraryMode>(
    (localStorage.getItem('nicotind-library-mode') as LibraryMode) ?? 'albums',
  );

  setMode(mode: LibraryMode): void {
    this.libraryMode.set(mode);
    localStorage.setItem('nicotind-library-mode', mode);
    if (mode === 'singles' && !this.singles().length) this.fetchSingles();
    if (mode === 'artists' && !this.artists().length) this.fetchArtists();
    if (mode === 'genre' && !this.genres().length) this.fetchGenres();
    if (mode === 'playlists') void this.playlistService.refresh();
  }

  // ─── Albums (lazy-loaded) ─────────────────────────────────────────
  // Sort options exclude 'starred' — starred is a *filter* (a checkbox in the
  // Filters disclosure), not an ordering, even though the server models both as
  // one `type` enum. `albumListType` is the effective value sent to the API.
  readonly albumSortOptions = ALBUM_TYPE_OPTIONS.filter((o) => o.value !== 'starred');

  readonly albumSort = signal<AlbumListType>('newest');
  readonly starredOnly = signal(false);
  readonly albumListType = signal<AlbumListType>('newest');
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

  // Number of active filters shown as a badge on the Filters disclosure.
  readonly activeFilterCount = computed(() =>
    activeFilterCount({
      starredOnly: this.starredOnly(),
      minTracks: this.minSongCount(),
      showHidden: this.showHidden(),
    }),
  );

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

  readonly singlesControls = this.listControls.connect({
    pageKey: 'library-singles',
    items: this.singles,
    searchFields: ['name', 'artist'] as const,
    sortOptions: this.gridSortOptions,
  });

  // ─── Artists ──────────────────────────────────────────────────────
  readonly artists = signal<
    Array<{ id: string; name: string; albumCount: number; coverArt?: string }>
  >([]);
  readonly loadingArtists = signal(false);

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

  // ─── Genre ────────────────────────────────────────────────────────
  readonly genres = signal<Array<{ value: string; songCount: number; albumCount: number }>>([]);
  readonly loadingGenres = signal(false);

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
    const initialType = this.resolveInitialType();
    this.albumListType.set(initialType);
    // Map the effective server type back onto the split sort/starred controls.
    const split = splitAlbumListType(initialType);
    this.albumSort.set(split.sort);
    this.starredOnly.set(split.starredOnly);

    // Clear any pending dirty state on load to avoid unnecessary fetches
    this.transferService.clearLibraryDirty();

    const persisted = readPersistedState();
    if (persisted && persisted.type === initialType && persisted.loaded > PAGE_SIZE) {
      await this.restoreAndLoad(persisted);
    } else {
      await this.resetAndLoad();
    }

    const mode = this.libraryMode();
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

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.persistState();
  }

  // ─── Albums fetcher ──────────────────────────────────────────────
  // The effective server `type` = the Starred filter (if on) else the chosen
  // ordering. Both refetch from page 0 since ordering/filtering is server-side.
  private async applyAlbumOrdering(): Promise<void> {
    const type = effectiveAlbumListType(this.albumSort(), this.starredOnly());
    this.albumListType.set(type);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { type },
      queryParamsHandling: 'merge',
    });
    await this.resetAndLoad();
  }

  async setAlbumSort(value: AlbumListType): Promise<void> {
    if (this.albumSort() === value) return;
    this.albumSort.set(value);
    if (!this.starredOnly()) await this.applyAlbumOrdering();
  }

  async toggleStarredOnly(): Promise<void> {
    this.starredOnly.update((v) => !v);
    await this.applyAlbumOrdering();
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
        this.api.getAlbums(this.albumListType(), PAGE_SIZE, this.offset, {
          includeHidden: this.showHidden(),
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
          this.api.getAlbums(this.albumListType(), fetchSize, this.offset, {
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
      type: this.albumListType(),
      loaded: this.albums().length,
      scrollY: typeof window !== 'undefined' ? window.scrollY : 0,
    });
  }

  // ─── Artists / Genre fetchers ────────────────────────────────────
  async fetchArtists(): Promise<void> {
    if (this.loadingArtists()) return;
    this.loadingArtists.set(true);
    try {
      const data = await firstValueFrom(this.api.getArtists());
      this.artists.set(data.map((a) => ({ ...a, albumCount: a.albumCount ?? 0 })));
    } catch {
      /* ignore */
    } finally {
      this.loadingArtists.set(false);
    }
  }

  async fetchSingles(): Promise<void> {
    if (this.loadingSingles()) return;
    this.loadingSingles.set(true);
    try {
      const data = await firstValueFrom(this.api.getSingles('newest', 500));
      this.singles.set(data);
    } catch {
      /* ignore */
    } finally {
      this.loadingSingles.set(false);
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
