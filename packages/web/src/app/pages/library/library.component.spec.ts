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

function setup() {
  // Minimal filteredItems signal returned by every connect() call — empty by
  // default so isEmpty computeds can be driven by setting the signal directly.
  const filteredItems = signal<unknown[]>([]);

  TestBed.configureTestingModule({
    imports: [LibraryComponent],
    providers: [
      {
        provide: LibraryApiService,
        useValue: {
          getAlbums: () => of([]),
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
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
      { provide: Router, useValue: { navigate: () => Promise.resolve() } },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(LibraryComponent);
  return { component: fixture.componentInstance, filteredItems };
}

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
