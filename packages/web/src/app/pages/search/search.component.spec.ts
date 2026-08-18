import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
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
import type { AcquireJob } from '../../services/acquire.service';
import { PluginService, type PluginInfo } from '../../services/plugin.service';
import { AutoHuntService } from '../../services/auto-hunt.service';
import { PullToRefreshService } from '../../services/pull-to-refresh.service';

let registeredHandler: (() => Promise<void> | void) | null = null;

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

function setup(
  apiOverrides: Partial<Record<keyof SearchApiService, unknown>> = {},
  acquireOverrides: { submit?: () => Promise<string> } = {},
  // PWA share-target query params (?url=/?text=/?title=), consumed by ngOnInit
  // via this.route.snapshot.queryParamMap. Empty by default (no share intent).
  shareParams: { url?: string; text?: string; title?: string } = {},
) {
  registeredHandler = null;
  const acquireSubmit = vi.fn(acquireOverrides.submit ?? (() => Promise.resolve('job1')));
  const acquireCancel = vi.fn(() => Promise.resolve());
  const acquireRefresh = vi.fn(() => Promise.resolve());
  const acquireJobs = signal<AcquireJob[]>([]);
  const retryAcquireJob = vi.fn(() => of({ jobId: 'job2' }));
  const autoHunt = { hunt: vi.fn() };
  const p2rStub = {
    register: (h: () => Promise<void> | void) => {
      registeredHandler = h;
    },
    refreshing: signal(false),
    hasHandler: signal(true),
    trigger: vi.fn(),
  };
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
      {
        provide: SystemApiService,
        useValue: {
          getSoulseekStatus: () => of({ connected: true }),
          getDownloadSettings: () =>
            of({
              transcodeLossless: { enabled: true, format: 'opus', bitRate: 192 },
              ffmpegAvailable: true,
            }),
        },
      },
      {
        provide: DownloadsApiService,
        useValue: { enqueueDownload: () => of({ ok: true }), retryAcquireJob },
      },
      { provide: LibraryApiService, useValue: { resolveArtistIdByName: () => of(null) } },
      { provide: TransferService, useValue: { poll: () => {}, getStatus: () => undefined } },
      {
        provide: AcquireService,
        useValue: {
          submit: acquireSubmit,
          cancel: acquireCancel,
          refresh: acquireRefresh,
          jobs: acquireJobs,
        },
      },
      { provide: AutoHuntService, useValue: autoHunt },
      { provide: PullToRefreshService, useValue: p2rStub },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(shareParams) } },
      },
      SearchService,
      PluginService,
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(SearchComponent);
  return {
    component: fixture.componentInstance,
    fixture,
    search: TestBed.inject(SearchService),
    plugins: TestBed.inject(PluginService),
    acquireSubmit,
    acquireCancel,
    acquireRefresh,
    acquireJobs,
    retryAcquireJob,
    autoHunt,
  };
}

/** Flip a resolve-capable plugin on so link-intent detection is active. */
function enableResolve(plugins: PluginService): void {
  plugins.plugins.set([
    { id: 'ytdlp', enabled: true, capabilities: ['resolve'] } as unknown as PluginInfo,
  ]);
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

  it('renders the catalog albums grid as an appTvNavGroup with grid axis', async () => {
    const { component, search, fixture } = setup();
    search.setQuery('pink floyd');

    component.handleSearch(new Event('submit'));
    await flush();
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const group = el
      .querySelector('[data-testid="catalog-album-cover"]')
      ?.closest('[appTvNavGroup]');
    expect(group?.getAttribute('axis')).toBe('grid');
  });

  // The assertion above only proves the ATTRIBUTE is in the DOM, which
  // NO_ERRORS_SCHEMA would let pass even with the directives unimported. This
  // one proves the group's item list is actually populated and navigable —
  // the exact thing an empty items() (cross-component boundary bug) breaks.
  it('ArrowRight moves focus across the catalog albums grid (real D-pad behaviour)', async () => {
    const second: CatalogAlbum = {
      ...CATALOG_ALBUM,
      foreignAlbumId: 'wywh-rg',
      title: 'Wish You Were Here',
    };
    const { component, search, fixture } = setup({
      catalogSearch: () =>
        of({ artists: [{ mbid: 'pf-mbid', name: 'Pink Floyd' }], albums: [CATALOG_ALBUM, second] }),
    });
    search.setQuery('pink floyd');

    component.handleSearch(new Event('submit'));
    await flush();
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const group = el
      .querySelector('[data-testid="catalog-album-cover"]')!
      .closest('[appTvNavGroup]')!;
    const cards: HTMLElement[] = Array.from(group.querySelectorAll('[appTvNavItem]'));
    expect(cards.length).toBe(2);
    expect(cards[0]!.getAttribute('tabindex')).toBe('0');
    expect(cards[1]!.getAttribute('tabindex')).toBe('-1');
    cards[0]!.focus();
    cards[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    expect(document.activeElement).toBe(cards[1]);
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

  it('resolves a searched album and calls autoHunt.hunt() with the real Lidarr id', async () => {
    const { component, autoHunt } = setup();

    await component.huntCatalogAlbum(CATALOG_ALBUM);

    expect(autoHunt.hunt).toHaveBeenCalledWith(
      expect.objectContaining({ lidarrId: 55, totalTracks: 10 }),
      'Pink Floyd',
      expect.any(Function),
    );
    expect(component.huntingArtistName()).toBe('Pink Floyd');
    expect(component.resolvingAlbum()).toBeNull();
  });

  it('surfaces a resolve failure without opening the modal', async () => {
    const { component, autoHunt } = setup({
      catalogResolve: () => throwError(() => new Error('not yet available')),
    });

    await component.huntCatalogAlbum(CATALOG_ALBUM);

    expect(autoHunt.hunt).not.toHaveBeenCalled();
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

  // Search is now acquisition-only (#227): local-library results were removed
  // from this page. The unified-search `res.local` payload still arrives but is
  // intentionally ignored — a search must not throw or surface owned-library rows
  // here anymore ("find what I own" lives in Library/Radio).
  it('ignores the unified-search local payload without error (acquisition-only Search)', async () => {
    const localAlbum = {
      id: 'loc-album-1',
      name: 'Ídolo',
      artist: 'C. Tangana',
      year: 2021,
      coverArt: 'loc-album-1',
      songCount: 11,
      classification: 'album',
    };
    const { component, search } = setup({
      search: () =>
        of({
          searchId: '11111111-1111-1111-1111-111111111111',
          errors: [],
          networkAvailable: false,
          local: { artists: [], albums: [localAlbum], songs: [] },
        }),
    });
    search.setQuery('C. Tangana Ídolo');

    component.handleSearch(new Event('submit'));
    await flush();

    // No local-results signal remains; the search settled cleanly.
    expect((component as unknown as { libraryAlbums?: unknown }).libraryAlbums).toBeUndefined();
    expect(component.searchError()).toBeNull();
  });

  it('getBlended submits a url candidate through the acquire pipeline and marks it added to library', async () => {
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

describe('SearchComponent — link-intent card (merged URL acquisition)', () => {
  it('does not treat a pasted URL as a link intent when no resolve plugin is enabled', async () => {
    const { component, search } = setup();
    search.setQuery('https://youtu.be/dQw4w9WgXcQ');

    component.handleSearch(new Event('submit'));
    await flush();

    expect(component.linkIntent()).toBeNull();
  });

  it('renders a link intent and fires no search when a resolve plugin is enabled', async () => {
    const searchSpy = vi.fn(() =>
      of({ searchId: '11111111-1111-1111-1111-111111111111', errors: [], networkAvailable: false }),
    );
    const { component, search, plugins } = setup({ search: searchSpy });
    enableResolve(plugins);
    search.setQuery('https://youtu.be/dQw4w9WgXcQ');

    component.handleSearch(new Event('submit'));
    await flush();

    expect(component.linkIntent()).toEqual(
      expect.objectContaining({ source: 'youtube', sourceLabel: 'YouTube' }),
    );
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('leaves normal text search unaffected when a resolve plugin is enabled', async () => {
    const { component, search, plugins } = setup();
    enableResolve(plugins);
    search.setQuery('pink floyd');

    component.handleSearch(new Event('submit'));
    await flush();

    expect(component.linkIntent()).toBeNull();
    expect(component.hasCatalog()).toBe(true);
  });

  it('clears stale search results when a link intent follows a prior search', async () => {
    const { component, search, plugins } = setup();
    enableResolve(plugins);
    search.setQuery('pink floyd');

    component.handleSearch(new Event('submit'));
    await flush();

    expect(component.hasCatalog()).toBe(true);

    search.setQuery('https://youtu.be/dQw4w9WgXcQ');
    component.handleSearch(new Event('submit'));
    await flush();

    expect(component.hasCatalog()).toBe(false);
    expect(component.linkIntent()).toEqual(
      expect.objectContaining({ source: 'youtube', sourceLabel: 'YouTube' }),
    );
  });

  it('submitLinkIntent submits the URL through the acquire pipeline', async () => {
    const { component, acquireSubmit } = setup();
    component.linkIntent.set({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      source: 'youtube',
      sourceLabel: 'YouTube',
      host: 'youtu.be',
    });

    await component.submitLinkIntent();

    // YouTube single-watch URLs (no `&list=`) don't carry a playlist signal
    // and aren't archive.org, so `as` is undefined here.
    expect(acquireSubmit).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ', undefined, {
      as: undefined,
    });
  });

  it('does not submit twice while the first submit is still in flight', async () => {
    // The regression this pins: the acquire job list only shows the new job on
    // the next poll, so between click and response there is nothing to hide the
    // Get button — a second click used to start a second download of the same link.
    let resolveSubmit!: (id: string) => void;
    const { component, acquireSubmit } = setup(
      {},
      { submit: () => new Promise<string>((res) => (resolveSubmit = res)) },
    );
    component.linkIntent.set({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      source: 'youtube',
      sourceLabel: 'YouTube',
      host: 'youtu.be',
    });

    const first = component.submitLinkIntent();
    expect(component.linkSubmitting()).toBe(true);
    await component.submitLinkIntent(); // second click, still in flight
    expect(acquireSubmit).toHaveBeenCalledTimes(1);

    resolveSubmit('job1');
    await first;
    expect(component.linkSubmitting()).toBe(false);
  });

  it('does not resubmit once a job for the link already exists', async () => {
    const { component, acquireSubmit, acquireJobs } = setup();
    component.linkIntent.set({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      source: 'youtube',
      sourceLabel: 'YouTube',
      host: 'youtu.be',
    });
    acquireJobs.set([
      {
        id: 'job1',
        backend: 'ytdlp',
        url: 'https://youtu.be/dQw4w9WgXcQ',
        label: null,
        state: 'running',
        progress: null,
        error: null,
        created_at: 0,
      },
    ]);

    await component.submitLinkIntent();

    expect(acquireSubmit).not.toHaveBeenCalled();
  });

  it('clears the in-flight guard after a failed submit so the user can retry', async () => {
    const { component } = setup({}, { submit: () => Promise.reject(new Error('boom')) });
    component.linkIntent.set({
      url: 'https://example.com/track.mp3',
      source: 'link',
      sourceLabel: 'Link',
      host: 'example.com',
    });

    await component.submitLinkIntent();

    expect(component.linkSubmitting()).toBe(false);
  });

  it('surfaces a submit failure on the card instead of throwing', async () => {
    const { component } = setup(
      {},
      { submit: () => Promise.reject(new Error('no plugin available')) },
    );
    component.linkIntent.set({
      url: 'https://example.com/track.mp3',
      source: 'link',
      sourceLabel: 'Link',
      host: 'example.com',
    });

    await component.submitLinkIntent();

    expect(component.linkSubmitError()).toBe('no plugin available');
  });

  it('opens Spotify instead of submitting when spotDL is unavailable', async () => {
    const { component, acquireSubmit } = setup();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    component.linkIntent.set({
      url: 'https://open.spotify.com/album/abc',
      source: 'spotify',
      sourceLabel: 'Spotify',
      host: 'open.spotify.com',
    });

    await component.submitLinkIntent();

    expect(openSpy).toHaveBeenCalledWith(
      'https://open.spotify.com/album/abc',
      '_blank',
      'noopener',
    );
    expect(acquireSubmit).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('derives linkJob from the shared acquire job list by URL', () => {
    const { component, acquireJobs } = setup();
    component.linkIntent.set({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      source: 'youtube',
      sourceLabel: 'YouTube',
      host: 'youtu.be',
    });
    acquireJobs.set([
      {
        id: 'job1',
        backend: 'ytdlp',
        url: 'https://youtu.be/dQw4w9WgXcQ',
        label: null,
        state: 'running',
        progress: { done: 1, total: 3 },
        error: null,
        created_at: Date.now(),
      },
    ]);

    expect(component.linkJob()?.id).toBe('job1');
  });

  it('cancelLinkJob cancels the tracked job', async () => {
    const { component, acquireJobs, acquireCancel } = setup();
    component.linkIntent.set({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      source: 'youtube',
      sourceLabel: 'YouTube',
      host: 'youtu.be',
    });
    acquireJobs.set([
      {
        id: 'job1',
        backend: 'ytdlp',
        url: 'https://youtu.be/dQw4w9WgXcQ',
        label: null,
        state: 'running',
        progress: null,
        error: null,
        created_at: Date.now(),
      },
    ]);

    await component.cancelLinkJob();

    expect(acquireCancel).toHaveBeenCalledWith('job1');
  });

  it('retryLinkJob calls the retry endpoint and refreshes the job list', async () => {
    const { component, acquireJobs, retryAcquireJob, acquireRefresh } = setup();
    component.linkIntent.set({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      source: 'youtube',
      sourceLabel: 'YouTube',
      host: 'youtu.be',
    });
    acquireJobs.set([
      {
        id: 'job1',
        backend: 'ytdlp',
        url: 'https://youtu.be/dQw4w9WgXcQ',
        label: null,
        state: 'failed',
        progress: null,
        error: 'boom',
        created_at: Date.now(),
      },
    ]);

    await component.retryLinkJob();

    expect(retryAcquireJob).toHaveBeenCalledWith('job1');
    expect(acquireRefresh).toHaveBeenCalled();
  });

  it('ngOnInit submits a share-target URL even when no resolve plugin is enabled', async () => {
    const { component, plugins, acquireSubmit } = setup(
      {},
      {},
      { url: 'https://youtu.be/dQw4w9WgXcQ' },
    );

    expect(plugins.hasResolve()).toBe(false);

    component.ngOnInit();
    await flush();

    expect(component.linkIntent()).toEqual(
      expect.objectContaining({ url: 'https://youtu.be/dQw4w9WgXcQ', source: 'youtube' }),
    );
    expect(acquireSubmit).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ', undefined, {
      as: undefined,
    });
  });

  it('dismissLinkIntent clears the card and any error', () => {
    const { component } = setup();
    component.linkIntent.set({
      url: 'https://example.com',
      source: 'link',
      sourceLabel: 'Link',
      host: 'example.com',
    });
    component.linkSubmitError.set('boom');

    component.dismissLinkIntent();

    expect(component.linkIntent()).toBeNull();
    expect(component.linkSubmitError()).toBeNull();
  });
});

describe('SearchComponent — transcode reminder', () => {
  it('transcodeActive only when the setting is enabled AND ffmpeg is present', () => {
    const { component } = setup();

    component.downloadSettings.set({
      transcodeLossless: { enabled: true, format: 'opus', bitRate: 192 },
      ffmpegAvailable: true,
    });
    expect(component.transcodeActive()).toBe(true);
    expect(component.transcodeBitRate()).toBe(192);

    component.downloadSettings.set({
      transcodeLossless: { enabled: false, format: 'opus', bitRate: 192 },
      ffmpegAvailable: true,
    });
    expect(component.transcodeActive()).toBe(false);

    component.downloadSettings.set({
      transcodeLossless: { enabled: true, format: 'opus', bitRate: 192 },
      ffmpegAvailable: false,
    });
    expect(component.transcodeActive()).toBe(false);
  });

  it('isLosslessCandidate is true only for a lossless enqueue pick', () => {
    const { component } = setup();
    const base = {
      id: 'x',
      source: 'soulseek' as const,
      sourceLabel: 'Soulseek',
      title: 't',
      subtitle: '',
      score: 1,
    };
    const flac = {
      ...base,
      acquire: { via: 'enqueue' as const, username: 'u', file: { filename: 'song.flac', size: 1 } },
    };
    const mp3 = {
      ...base,
      acquire: { via: 'enqueue' as const, username: 'u', file: { filename: 'song.mp3', size: 1 } },
    };
    const url = { ...base, acquire: { via: 'url' as const, url: 'http://x' } };

    expect(component.isLosslessCandidate(flac)).toBe(true);
    expect(component.isLosslessCandidate(mp3)).toBe(false);
    expect(component.isLosslessCandidate(url)).toBe(false);
  });
});

describe('SearchComponent — catalog-miss fallback', () => {
  // httpErrorCode reads err.error.code; this shape triggers the raw fallback.
  const notInLidarr = () => throwError(() => ({ error: { code: 'ALBUM_NOT_IN_LIDARR' } }));

  it('opens the network lane for the clicked album without auto-loading the discography', async () => {
    const catalogDiscography = vi.fn(() => of({ artists: [], albums: [] }));
    const { component } = setup({ catalogResolve: notInLidarr, catalogDiscography });

    await component.huntCatalogAlbum(CATALOG_ALBUM);
    await flush();

    expect(component.rawFallbackAlbum()?.title).toBe(CATALOG_ALBUM.title);
    expect(component.rawFallbackNote()).toMatch(/isn't in/);
    expect(component.directSearchOpen()).toBe(true);
    // Discography load auto-adds the artist to Lidarr — must be opt-in now.
    expect(catalogDiscography).not.toHaveBeenCalled();
  });

  it('browseFallbackDiscography loads the discography only on demand', async () => {
    const catalogDiscography = vi.fn(() =>
      of({ artists: [], albums: [CATALOG_ALBUM], scopedArtist: 'Pink Floyd' }),
    );
    const { component } = setup({ catalogResolve: notInLidarr, catalogDiscography });

    await component.huntCatalogAlbum(CATALOG_ALBUM);
    await flush();
    await component.browseFallbackDiscography();

    expect(catalogDiscography).toHaveBeenCalled();
  });
});

describe('SearchComponent — results cap', () => {
  it('caps the long blended Results list and expands on demand', () => {
    const { component, search } = setup();
    const files = Array.from({ length: 12 }, (_, i) => ({
      filename: `Artist/${i}-Title${i}.flac`,
      size: 1000,
      artist: 'Artist',
      title: `Title ${i}`,
    }));
    search.setNetwork([{ username: 'peer', freeUploadSlots: 1, uploadSpeed: 100, files }]);

    expect(component.blendedResults().length).toBe(12);
    expect(component.visibleBlendedResults().length).toBe(8); // RESULTS_CAP
    expect(component.hiddenResultCount()).toBe(4);

    component.resultsExpanded.set(true);
    expect(component.visibleBlendedResults().length).toBe(12);
  });
});

describe('SearchComponent — pull-to-refresh', () => {
  it('pull-to-refresh re-runs the current query', async () => {
    const { component, search } = setup();
    search.setQuery('pink floyd');
    const spy = vi.spyOn(component as never, 'executeSearch' as never);
    (spy as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(undefined);

    await registeredHandler!();

    expect(spy).toHaveBeenCalled();
  });

  it('pull-to-refresh is a no-op when the query is empty or a link-intent card is showing', async () => {
    const { component, search } = setup();
    const spy = vi.spyOn(component as never, 'executeSearch' as never);

    await registeredHandler!(); // empty query
    expect(spy).not.toHaveBeenCalled();

    search.setQuery('pink floyd');
    component.linkIntent.set({} as never); // link-intent card showing
    await registeredHandler!();
    expect(spy).not.toHaveBeenCalled();
  });

  it('pull-to-refresh is a no-op while a search is already in flight', async () => {
    const { component, search } = setup();
    search.setQuery('pink floyd');
    const spy = vi.spyOn(component as never, 'executeSearch' as never);
    component.loading.set(true);

    await registeredHandler!();

    expect(spy).not.toHaveBeenCalled();
  });
});
