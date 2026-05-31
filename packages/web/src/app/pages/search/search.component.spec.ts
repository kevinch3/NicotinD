import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { SearchComponent } from './search.component';
import { ApiService, type CatalogAlbum } from '../../services/api.service';
import { SearchService } from '../../services/search.service';
import { TransferService } from '../../services/transfer.service';

const CATALOG_ALBUM: CatalogAlbum = {
  foreignAlbumId: 'dsotm-rg',
  title: 'The Dark Side of the Moon',
  artistName: 'Pink Floyd',
  artistMbid: 'pf-mbid',
  year: '1973',
  albumType: 'Album',
  secondaryTypes: [],
  coverUrl: 'http://x/c.jpg',
  trackCount: 10,
};

function setup(apiOverrides: Partial<Record<keyof ApiService, unknown>> = {}) {
  const api = {
    getSoulseekStatus: () => of({ connected: true }),
    catalogSearch: () => of({ artists: [{ mbid: 'pf-mbid', name: 'Pink Floyd' }], albums: [CATALOG_ALBUM] }),
    search: () => of({ searchId: '11111111-1111-1111-1111-111111111111', errors: [], networkAvailable: false }),
    catalogResolve: () =>
      of({ lidarrAlbumId: 55, totalTracks: 10, title: 'The Dark Side of the Moon', artistName: 'Pink Floyd' }),
    cancelSearch: () => of({ ok: true }),
    deleteSearch: () => of({ ok: true }),
    ...apiOverrides,
  };

  TestBed.configureTestingModule({
    imports: [SearchComponent],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: TransferService, useValue: { poll: () => {}, getStatus: () => undefined } },
      SearchService,
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(SearchComponent);
  return { component: fixture.componentInstance, search: TestBed.inject(SearchService) };
}

// of() resolves on the microtask queue; flush twice for the chained catalog promise.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('SearchComponent — metadata-driven search', () => {
  it('populates catalog results and collapses the direct-search fallback when there are hits', async () => {
    const { component, search } = setup();
    search.setQuery('pink floyd');

    component.handleSearch(new Event('submit'));
    await flush();

    expect(component.hasCatalog()).toBe(true);
    expect(component.catalog()?.albums[0]?.title).toBe('The Dark Side of the Moon');
    expect(component.directSearchOpen()).toBe(false);
  });

  it('opens the direct-search fallback when catalog has no hits', async () => {
    const { component, search } = setup({ catalogSearch: () => of({ artists: [], albums: [] }) });
    search.setQuery('zzz nothing');

    component.handleSearch(new Event('submit'));
    await flush();

    expect(component.hasCatalog()).toBe(false);
    expect(component.directSearchOpen()).toBe(true);
  });

  it('opens the direct-search fallback and flags unavailability when catalog lookup fails (no Lidarr)', async () => {
    const { component, search } = setup({ catalogSearch: () => throwError(() => new Error('404')) });
    search.setQuery('anything');

    component.handleSearch(new Event('submit'));
    await flush();

    expect(component.catalogUnavailable()).toBe(true);
    expect(component.directSearchOpen()).toBe(true);
  });

  it('resolves a searched album and opens the album-hunt modal with the real Lidarr id', async () => {
    const { component } = setup();

    await component.huntCatalogAlbum(CATALOG_ALBUM);

    const album = component.huntingAlbum();
    expect(album?.lidarrId).toBe(55);
    expect(album?.totalTracks).toBe(10);
    expect(component.huntingArtistName()).toBe('Pink Floyd');
    expect(component.resolvingAlbum()).toBeNull();
  });

  it('surfaces a resolve failure without opening the modal', async () => {
    const { component } = setup({ catalogResolve: () => throwError(() => new Error('not yet available')) });

    await component.huntCatalogAlbum(CATALOG_ALBUM);

    expect(component.huntingAlbum()).toBeNull();
    expect(component.resolveError()).toMatch(/not yet available/);
  });
});
