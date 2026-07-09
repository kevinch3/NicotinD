import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { of } from 'rxjs';
import { LibraryComponent } from './library.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { PlaylistService } from '../../services/playlist.service';
import { TransferService } from '../../services/transfer.service';
import { ListControlsService } from '../../services/list-controls.service';

function setup(queryParams: Record<string, string | string[]> = {}) {
  // Minimal filteredItems signal returned by every connect() call — empty by
  // default so isEmpty computeds can be driven by setting the signal directly.
  const filteredItems = signal<unknown[]>([]);
  // Recorded getAlbums calls so filter plumbing is assertable.
  const albumCalls: Array<{ type: string; opts: Record<string, unknown> }> = [];
  // Recorded router.navigate queryParams merges (URL filter sync).
  const navigations: Array<Record<string, unknown>> = [];

  // ParamMap-shaped mock over plain records (get/getAll/keys are what we use).
  const queryParamMap = {
    get: (k: string) => {
      const v = queryParams[k];
      return v === undefined ? null : Array.isArray(v) ? (v[0] ?? null) : v;
    },
    getAll: (k: string) => {
      const v = queryParams[k];
      return v === undefined ? [] : Array.isArray(v) ? v : [v];
    },
    keys: Object.keys(queryParams),
  };

  TestBed.configureTestingModule({
    imports: [LibraryComponent],
    providers: [
      {
        provide: LibraryApiService,
        useValue: {
          getAlbums: (type: string, _size: number, _offset: number, opts: Record<string, unknown>) => {
            albumCalls.push({ type, opts });
            return of([]);
          },
          getArtists: () => of([]),
          getSingles: () => of([]),
          getCompilations: () => of([]),
          getGenres: () => of([]),
        },
      },
      { provide: AuthService, useValue: { token: signal('tok'), role: () => 'user' } },
      {
        provide: PlaylistService,
        useValue: { refresh: () => Promise.resolve(), playlists: signal([]) },
      },
      { provide: TransferService, useValue: { clearLibraryDirty: () => {} } },
      {
        provide: ListControlsService,
        useValue: {
          connect: () => ({
            filtered: filteredItems,
            searchText: signal(''),
            sortField: signal(''),
            sortDirection: signal('asc'),
            setSearchText: () => {},
            setSortField: () => {},
            toggleSortDirection: () => {},
          }),
        },
      },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap } } },
      {
        provide: Router,
        useValue: {
          navigate: (_cmds: unknown[], extras?: { queryParams?: Record<string, unknown> }) => {
            if (extras?.queryParams) navigations.push(extras.queryParams);
            return Promise.resolve(true);
          },
        },
      },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(LibraryComponent);
  return { component: fixture.componentInstance, filteredItems, albumCalls, navigations };
}

describe('LibraryComponent — standardized metadata filters', () => {
  it('initializes the shared filter from URL query params', async () => {
    const { component } = setup({ bpmMin: '120', mood: 'happy,party', genre: ['Rock'] });
    await component.ngOnInit();
    expect(component.libFilter()).toEqual({
      bpmMin: 120,
      moods: ['happy', 'party'],
      genres: ['Rock'],
    });
  });

  it('maps a legacy type=starred URL onto the starred filter + newest sort', async () => {
    const { component, albumCalls } = setup({ type: 'starred' });
    await component.ngOnInit();
    expect(component.libFilter().starred).toBe(true);
    expect(component.albumSort()).toBe('newest');
    expect(albumCalls[0]?.type).toBe('newest');
    expect((albumCalls[0]?.opts['filter'] as { starred?: boolean }).starred).toBe(true);
  });

  it('passes the active filter to getAlbums on load', async () => {
    const { component, albumCalls } = setup({ energy: 'high' });
    await component.ngOnInit();
    expect(albumCalls[0]?.opts['filter']).toEqual({ buckets: { energy: ['high'] } });
  });

  it('onFilterChange syncs the URL, nulling out cleared filter params', async () => {
    const { component, navigations } = setup();
    await component.ngOnInit();
    await component.onFilterChange({ bpmMin: 120 });
    const nav = navigations.at(-1)!;
    expect(nav['bpmMin']).toBe('120');
    expect(nav['mood']).toBeNull(); // cleared keys removed from the URL
    expect(nav['genre']).toBeNull();
  });

  it('onFilterChange refetches the active tab and invalidates the others', async () => {
    const { component, albumCalls } = setup();
    await component.ngOnInit();
    component.singlesFetched.set(true);
    const before = albumCalls.length;
    await component.onFilterChange({ starred: true });
    expect(albumCalls.length).toBeGreaterThan(before); // albums (active) refetched
    expect(component.singlesFetched()).toBe(false); // others lazily refetch on switch
  });
});

describe('LibraryComponent — isXxxEmpty flash-prevention computeds', () => {
  it('isGenresEmpty is false before the first fetch (prevents empty-state flash)', () => {
    const { component } = setup();
    // genresFetched starts false — empty state must NOT show before fetch
    expect(component.isGenresEmpty()).toBe(false);
  });

  it('isGenresEmpty is false while the fetch is in progress', () => {
    const { component } = setup();
    component.genresFetched.set(true);
    component.loadingGenres.set(true);
    component.genres.set([]);
    expect(component.isGenresEmpty()).toBe(false);
  });

  it('isGenresEmpty is true only after fetch completed with empty results', () => {
    const { component } = setup();
    component.genresFetched.set(true);
    component.loadingGenres.set(false);
    component.genres.set([]);
    expect(component.isGenresEmpty()).toBe(true);
  });

  it('isGenresEmpty is false when genres are present', () => {
    const { component } = setup();
    component.genresFetched.set(true);
    component.loadingGenres.set(false);
    component.genres.set([{ value: 'Rock', songCount: 10, albumCount: 2 }]);
    expect(component.isGenresEmpty()).toBe(false);
  });

  it('isArtistsEmpty is false before the first fetch', () => {
    const { component } = setup();
    expect(component.isArtistsEmpty()).toBe(false);
  });

  it('isArtistsEmpty is true only after fetch with no results', () => {
    const { component, filteredItems } = setup();
    component.artistsFetched.set(true);
    component.loadingArtists.set(false);
    filteredItems.set([]);
    expect(component.isArtistsEmpty()).toBe(true);
  });

  it('isCompilationsEmpty is false before the first fetch', () => {
    const { component } = setup();
    expect(component.isCompilationsEmpty()).toBe(false);
  });

  it('isCompilationsEmpty is true only after fetch with no results', () => {
    const { component, filteredItems } = setup();
    component.compilationsFetched.set(true);
    component.loadingCompilations.set(false);
    filteredItems.set([]);
    expect(component.isCompilationsEmpty()).toBe(true);
  });

  it('isSinglesEmpty is false before the first fetch', () => {
    const { component } = setup();
    expect(component.isSinglesEmpty()).toBe(false);
  });

  it('isSinglesEmpty is true only after fetch with no results', () => {
    const { component, filteredItems } = setup();
    component.singlesFetched.set(true);
    component.loadingSingles.set(false);
    filteredItems.set([]);
    expect(component.isSinglesEmpty()).toBe(true);
  });
});
