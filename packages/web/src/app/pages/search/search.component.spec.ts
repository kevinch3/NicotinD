import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { SearchComponent } from './search.component';
import { SearchApiService } from '../../services/api/search-api.service';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { SystemApiService } from '../../services/api/system-api.service';
import type { CatalogAlbum } from '../../services/api/api-types';
import { SearchService } from '../../services/search.service';
import { TransferService } from '../../services/transfer.service';
import { AcquireService } from '../../services/acquire.service';
import { PluginService, type PluginInfo } from '../../services/plugin.service';

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

function setup(apiOverrides: Partial<Record<keyof SearchApiService, unknown>> = {}) {
  const acquireSubmit = vi.fn(() => Promise.resolve('job1'));
  const searchApi = {
    catalogSearch: () =>
      of({ artists: [{ mbid: 'pf-mbid', name: 'Pink Floyd' }], albums: [CATALOG_ALBUM] }),
    search: () =>
      of({ searchId: '11111111-1111-1111-1111-111111111111', errors: [], networkAvailable: false }),
    catalogResolve: () =>
      of({
        lidarrAlbumId: 55,
        totalTracks: 10,
        title: 'The Dark Side of the Moon',
        artistName: 'Pink Floyd',
      }),
    archiveSearch: () => of({ candidates: [] }),
    cancelSearch: () => of({ ok: true }),
    deleteSearch: () => of({ ok: true }),
    ...apiOverrides,
  };

  TestBed.configureTestingModule({
    imports: [SearchComponent],
    providers: [
      provideRouter([]),
      { provide: SearchApiService, useValue: searchApi },
      { provide: SystemApiService, useValue: { getSoulseekStatus: () => of({ connected: true }) } },
      { provide: DownloadsApiService, useValue: { enqueueDownload: () => of({ ok: true }) } },
      { provide: LibraryApiService, useValue: { resolveArtistIdByName: () => of(null) } },
      { provide: TransferService, useValue: { poll: () => {}, getStatus: () => undefined } },
      { provide: AcquireService, useValue: { submit: acquireSubmit } },
      SearchService,
      PluginService,
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(SearchComponent);
  return {
    component: fixture.componentInstance,
    search: TestBed.inject(SearchService),
    plugins: TestBed.inject(PluginService),
    acquireSubmit,
  };
}

/** Flip the archive plugin on in the (real) PluginService so hasArchive() is true. */
function enableArchive(plugins: PluginService): void {
  plugins.plugins.set([
    { id: 'archive', enabled: true, capabilities: ['resolve'] } as unknown as PluginInfo,
  ]);
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
    const { component, search } = setup({
      catalogSearch: () => throwError(() => new Error('404')),
    });
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
    const { component } = setup({
      catalogResolve: () => throwError(() => new Error('not yet available')),
    });

    await component.huntCatalogAlbum(CATALOG_ALBUM);

    expect(component.huntingAlbum()).toBeNull();
    expect(component.resolveError()).toMatch(/not yet available/);
  });

  it('populates the archive.org lane in parallel when the plugin is enabled', async () => {
    const { component, search, plugins } = setup({
      archiveSearch: () =>
        of({
          candidates: [
            { identifier: 'a1', title: 'Album', creator: 'Artist', year: '2016', detailsUrl: 'u1' },
          ],
        }),
    });
    enableArchive(plugins);
    search.setQuery('pink floyd');

    component.handleSearch(new Event('submit'));
    await flush();

    expect(search.archiveState()).toBe('complete');
    expect(search.archive().map((x) => x.identifier)).toEqual(['a1']);
  });

  it('skips the archive.org lane when the plugin is disabled', async () => {
    const archiveSearch = vi.fn(() => of({ candidates: [] }));
    const { component, search } = setup({ archiveSearch });
    search.setQuery('pink floyd');

    component.handleSearch(new Event('submit'));
    await flush();

    expect(archiveSearch).not.toHaveBeenCalled();
    expect(search.archiveState()).toBe('idle');
  });

  it('blends archive + Spotify candidates into one ranked Results list', async () => {
    const { component, search, plugins } = setup({
      archiveSearch: () =>
        of({
          candidates: [
            { identifier: 'a1', title: 'Album', creator: 'Artist', year: '2016', detailsUrl: 'u1' },
          ],
        }),
    });
    enableArchive(plugins);
    search.setQuery('pink floyd');
    component.handleSearch(new Event('submit'));
    await flush();

    const blended = component.blendedResults();
    expect(blended.some((c) => c.source === 'archive' && c.id === 'archive:a1')).toBe(true);
    expect(component.hasBlendedResults()).toBe(true);
  });

  it('getBlended submits a url candidate through the acquire pipeline and marks it started', async () => {
    const { component, acquireSubmit } = setup();
    const candidate = {
      id: 'archive:a1',
      source: 'archive' as const,
      sourceLabel: 'Internet Archive',
      title: 'Album',
      subtitle: 'Artist',
      score: 62,
      acquire: { via: 'url' as const, url: 'https://archive.org/details/a1' },
    };

    await component.getBlended(candidate);

    expect(acquireSubmit).toHaveBeenCalledWith('https://archive.org/details/a1');
    expect(component.blendedState(candidate)).toBe('done');
  });
});
