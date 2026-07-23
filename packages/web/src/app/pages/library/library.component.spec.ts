import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { LibraryComponent } from './library.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { AuthService } from '../../services/auth.service';
import { PlaylistService } from '../../services/playlist.service';
import { ConfirmService } from '../../services/confirm.service';
import { TransferService } from '../../services/transfer.service';
import { ListControlsService } from '../../services/list-controls.service';
import type { PlaylistSummary } from '../../services/api/api-types';

function setup(
  queryParams: Record<string, string | string[]> = {},
  opts: { playlists?: PlaylistSummary[]; confirmResult?: boolean } = {},
) {
  // Minimal filteredItems signal returned by every connect() call — empty by
  // default so isEmpty computeds can be driven by setting the signal directly.
  const filteredItems = signal<unknown[]>([]);
  // Recorded getAlbums calls so filter plumbing is assertable.
  const albumCalls: Array<{ type: string; opts: Record<string, unknown> }> = [];
  // Recorded router.navigate queryParams merges (URL filter sync).
  const navigations: Array<Record<string, unknown>> = [];
  // Recorded router.navigate route commands (e.g. ['/library/playlists', id]).
  const navigateCommands: unknown[][] = [];

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

  const playlistsSignal = signal<PlaylistSummary[]>(opts.playlists ?? []);
  const playlistRename = vi.fn().mockResolvedValue(undefined);
  const playlistDelete = vi.fn().mockResolvedValue(undefined);
  const playlistCreate = vi.fn().mockResolvedValue({ id: 'new-pl' } as PlaylistSummary);
  const confirmAsk = vi.fn().mockResolvedValue(opts.confirmResult ?? true);

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
        useValue: {
          refresh: () => Promise.resolve(),
          playlists: playlistsSignal,
          loaded: signal(true),
          create: playlistCreate,
          rename: playlistRename,
          delete: playlistDelete,
        },
      },
      { provide: ConfirmService, useValue: { ask: confirmAsk } },
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
          navigate: (cmds: unknown[], extras?: { queryParams?: Record<string, unknown> }) => {
            navigateCommands.push(cmds);
            if (extras?.queryParams) navigations.push(extras.queryParams);
            return Promise.resolve(true);
          },
        },
      },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(LibraryComponent);
  return {
    component: fixture.componentInstance,
    fixture,
    filteredItems,
    albumCalls,
    navigations,
    navigateCommands,
    playlistsSignal,
    playlistRename,
    playlistDelete,
    playlistCreate,
    confirmAsk,
  };
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

describe('LibraryComponent — merged playlists list', () => {
  const CURATED: PlaylistSummary = {
    id: 'c1',
    name: 'Made for you',
    description: null,
    songCount: 10,
    coverArt: null,
    kind: 'curated',
    createdAt: 0,
    modifiedAt: 0,
  };
  const USER: PlaylistSummary = {
    id: 'u1',
    name: 'My mix',
    description: null,
    songCount: 3,
    coverArt: null,
    kind: 'user',
    createdAt: 0,
    modifiedAt: 0,
  };

  it('renders one merged list with every playlist as a row', () => {
    const { component, fixture } = setup({}, { playlists: [CURATED, USER] });
    component.libraryMode.set('playlists');
    fixture.detectChanges();

    const list = fixture.nativeElement.querySelector('[data-testid="playlists-list"]');
    expect(list).not.toBeNull();
    // No separate curated shelf / user-playlists sections — one list only.
    expect(fixture.nativeElement.querySelector('[data-testid="curated-playlists"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="user-playlists"]')).toBeNull();

    const rows = fixture.nativeElement.querySelectorAll('[data-testid="playlist-row"]');
    expect(rows.length).toBe(2);
  });

  it('shows the curated badge on a curated row and hides its edit/delete icons', () => {
    const { component, fixture } = setup({}, { playlists: [CURATED, USER] });
    component.libraryMode.set('playlists');
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('[data-testid="playlist-row"]');
    const curatedRow = rows[0] as HTMLElement;
    const userRow = rows[1] as HTMLElement;

    expect(curatedRow.querySelector('[data-testid="curated-badge-inline"]')).not.toBeNull();
    expect(curatedRow.querySelector('[data-testid="rename-playlist"]')).toBeNull();
    expect(curatedRow.querySelector('[data-testid="delete-playlist"]')).toBeNull();

    expect(userRow.querySelector('[data-testid="curated-badge-inline"]')).toBeNull();
    expect(userRow.querySelector('[data-testid="rename-playlist"]')).not.toBeNull();
    expect(userRow.querySelector('[data-testid="delete-playlist"]')).not.toBeNull();
  });

  it('createPlaylist navigates to the new playlist on success', async () => {
    const { component, navigateCommands, playlistCreate } = setup();
    component.newPlaylistName.set('Road trip');

    await component.createPlaylist();

    expect(playlistCreate).toHaveBeenCalledWith('Road trip');
    expect(navigateCommands.at(-1)).toEqual(['/library/playlists', 'new-pl']);
    expect(component.newPlaylistName()).toBe('');
  });

  it('does nothing when the new-playlist name is blank', async () => {
    const { component, playlistCreate, navigateCommands } = setup();
    component.newPlaylistName.set('   ');

    await component.createPlaylist();

    expect(playlistCreate).not.toHaveBeenCalled();
    expect(navigateCommands).toHaveLength(0);
  });

  it('commitRename calls playlistService.rename with the trimmed draft and exits edit mode', async () => {
    const { component, playlistRename } = setup({}, { playlists: [USER] });
    component.startRename(USER);
    expect(component.editingPlaylistId()).toBe('u1');
    component.renameDraft.set('  New name  ');

    await component.commitRename('u1');

    expect(playlistRename).toHaveBeenCalledWith('u1', 'New name');
    expect(component.editingPlaylistId()).toBeNull();
  });

  it('commitRename is a no-op for a blank draft', async () => {
    const { component, playlistRename } = setup({}, { playlists: [USER] });
    component.startRename(USER);
    component.renameDraft.set('   ');

    await component.commitRename('u1');

    expect(playlistRename).not.toHaveBeenCalled();
    expect(component.editingPlaylistId()).toBe('u1'); // stays in edit mode
  });

  it('cancelRename exits edit mode without renaming', () => {
    const { component, playlistRename } = setup({}, { playlists: [USER] });
    component.startRename(USER);

    component.cancelRename();

    expect(component.editingPlaylistId()).toBeNull();
    expect(playlistRename).not.toHaveBeenCalled();
  });

  it('deletePlaylistRow asks for confirmation, then deletes only when confirmed', async () => {
    const { component, confirmAsk, playlistDelete } = setup(
      {},
      { playlists: [USER], confirmResult: true },
    );

    await component.deletePlaylistRow(USER);

    expect(confirmAsk).toHaveBeenCalledWith('Delete "My mix"? This cannot be undone.');
    expect(playlistDelete).toHaveBeenCalledWith('u1');
  });

  it('deletePlaylistRow does not delete when the confirmation is declined', async () => {
    const { component, confirmAsk, playlistDelete } = setup(
      {},
      { playlists: [USER], confirmResult: false },
    );

    await component.deletePlaylistRow(USER);

    expect(confirmAsk).toHaveBeenCalled();
    expect(playlistDelete).not.toHaveBeenCalled();
  });

  it('deletePlaylistRow is a no-op for a curated playlist (no confirm, no delete)', async () => {
    const { component, confirmAsk, playlistDelete } = setup({}, { playlists: [CURATED] });

    await component.deletePlaylistRow(CURATED);

    expect(confirmAsk).not.toHaveBeenCalled();
    expect(playlistDelete).not.toHaveBeenCalled();
  });
});
