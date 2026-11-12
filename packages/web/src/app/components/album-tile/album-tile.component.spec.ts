import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { AlbumTileComponent } from './album-tile.component';
import { ServerConfigService } from '../../services/server-config.service';
import { CoverRevisionsService } from '../../services/cover-revisions.service';
import { setInputValue } from '../../../testing/signal-input';
import type { AlbumTile } from '../../lib/artist-album-tiles';
import type { AlbumHuntStatus } from '../../lib/album-hunt-status';
import { TranslateService, interpolate } from '../../services/translate.service';
import EN from '../../../../public/i18n/en.json';
import ES from '../../../../public/i18n/es.json';

type Catalog = Record<string, string>;

/**
 * The real catalogs behind a stub service — `init()` never runs in a unit test, so
 * the live service would render raw keys. Spanish falls through to English the way
 * the service does (#1636: the tile rendered English in a Spanish UI).
 */
function translateWith(active: Catalog) {
  return {
    lang: signal(active === ES ? 'es' : 'en'),
    revision: signal(0),
    t: (key: string, params?: Record<string, string | number>) =>
      interpolate(active[key] ?? (EN as Catalog)[key] ?? key, params),
  };
}

const tile = (over: Partial<AlbumTile> & Pick<AlbumTile, 'status'>): AlbumTile => ({
  key: 'k',
  title: 'Meddle',
  year: 1971,
  secondary: false,
  ...over,
});

function render(
  t: AlbumTile,
  inputs: Partial<{ canAcquire: boolean; status: AlbumHuntStatus }> = {},
  catalog: Catalog = EN,
) {
  // One fresh component per scenario (signal-input.ts landmine 2), which means a
  // reset — TestBed refuses to be reconfigured once it has been instantiated.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AlbumTileComponent],
    providers: [
      provideRouter([]),
      { provide: ServerConfigService, useValue: { apiUrl: (u: string) => u } },
      { provide: TranslateService, useValue: translateWith(catalog) },
    ],
  });
  const fixture = TestBed.createComponent(AlbumTileComponent);
  const c = fixture.componentInstance;
  // Every write lands BEFORE the first detectChanges: the raw signal write
  // bypasses signalSetFn, so a consumer that already read keeps the stale value.
  setInputValue(c.tile, t);
  setInputValue(c.artistName, 'Pink Floyd');
  setInputValue(c.token, 'tok');
  setInputValue(c.canAcquire, inputs.canAcquire ?? true);
  setInputValue(c.status, inputs.status ?? { phase: 'idle' });
  fixture.detectChanges();
  return fixture;
}

const el = (fixture: ReturnType<typeof render>, sel: string): HTMLElement | null =>
  fixture.nativeElement.querySelector(sel);

describe('AlbumTileComponent', () => {
  it('an owned album navigates to its album page and offers no action', () => {
    const fixture = render(tile({ status: 'owned', localAlbumId: 'a1', coverArt: 'hash' }));
    const root = el(fixture, '[data-testid="album-tile"]')!;

    expect(root.tagName).toBe('A');
    expect(root.getAttribute('href')).toBe('/library/albums/a1');
    // The whole point of the merge: a complete album is quiet.
    expect(el(fixture, '[data-testid="album-tile-action"]')).toBeNull();
  });

  it('a partial album still navigates, and shows its gap plus Complete album', () => {
    const fixture = render(
      tile({ status: 'partial', localAlbumId: 'a2', localTrackCount: 4, totalTracks: 7 }),
    );
    const root = el(fixture, '[data-testid="album-tile"]')!;

    // Owned means playable — a partial tile is a link, not a dead cell.
    expect(root.tagName).toBe('A');
    expect(root.textContent).toContain('4/7 tracks');
    expect(el(fixture, '[data-testid="album-tile-action"]')!.textContent!.trim()).toBe(
      'Complete album',
    );
  });

  it('an owned album whose tracklist matched nothing claims no "0/N" (#1565)', () => {
    const fixture = render(
      tile({ status: 'partial', localAlbumId: 'a2', localTrackCount: 0, totalTracks: 11 }),
    );
    expect(el(fixture, '[data-testid="album-tile"]')!.textContent).not.toContain('0/11');
  });

  it('a missing album does not navigate and offers Get album', () => {
    const fixture = render(
      tile({ status: 'missing', title: 'Atom Heart Mother', year: 1970, totalTracks: 5 }),
    );
    const root = el(fixture, '[data-testid="album-tile"]')!;

    expect(root.tagName).not.toBe('A');
    expect(root.getAttribute('href')).toBeNull();
    expect(el(fixture, '[data-testid="album-tile-action"]')!.textContent!.trim()).toBe('Get album');
    // No track count on something we do not have — "0/5" would read as a real album.
    expect(root.textContent).not.toContain('tracks');
  });

  it('speaks the active language: action and track count come from the catalog (#1636)', () => {
    const missing = render(tile({ status: 'missing', totalTracks: 5 }), {}, ES);
    expect(el(missing, '[data-testid="album-tile-action"]')!.textContent!.trim()).toBe(
      'Obtener álbum',
    );

    const partial = render(
      tile({ status: 'partial', localAlbumId: 'a2', localTrackCount: 4, totalTracks: 7 }),
      {},
      ES,
    );
    expect(el(partial, '[data-testid="album-tile"]')!.textContent).toContain('4/7 pistas');
    expect(el(partial, '[data-testid="album-tile-action"]')!.textContent!.trim()).toBe(
      'Completar álbum',
    );
  });

  // #1627: the header counts a local folder holding none of the tracklist missing;
  // the tile says so too, but the folder's songs are still the user's to open.
  it('a missing album the library holds a folder for navigates and offers Get album', () => {
    const fixture = render(
      tile({ status: 'missing', localAlbumId: 'a4', localTrackCount: 0, totalTracks: 14 }),
    );
    const root = el(fixture, '[data-testid="album-tile"]')!;

    expect(root.tagName).toBe('A');
    expect(root.getAttribute('href')).toBe('/library/albums/a4');
    expect(root.getAttribute('data-status')).toBe('missing');
    expect(el(fixture, '[data-testid="album-tile-action"]')!.textContent!.trim()).toBe('Get album');
    expect(root.textContent).not.toContain('0/14');
  });

  it('hides both actions from a listener who cannot acquire', () => {
    for (const status of ['partial', 'missing'] as const) {
      const fixture = render(tile({ status, localAlbumId: 'a3', totalTracks: 7 }), {
        canAcquire: false,
      });
      // Today a listener sees a button that 403s on click.
      expect(el(fixture, '[data-testid="album-tile-action"]')).toBeNull();
    }
  });

  it('disables the action and says Finding… while its own hunt searches', () => {
    const fixture = render(tile({ status: 'missing' }), { status: { phase: 'searching' } });
    const button = el(fixture, '[data-testid="album-tile-action"]') as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    expect(el(fixture, '[data-testid="album-tile-hunt-status"]')!.textContent).toBe('Finding…');
  });

  it('offers a cancel carrying the job once the server has one, and none before', () => {
    const before = render(tile({ status: 'missing' }), { status: { phase: 'searching' } });
    expect(el(before, '[data-testid="album-tile-cancel"]')).toBeNull();

    for (const status of [
      { phase: 'searching', jobId: 'j9' },
      { phase: 'job', stage: 'downloading', jobId: 'j9' },
    ] as const) {
      const fixture = render(tile({ status: 'partial', localAlbumId: 'a' }), { status });
      const cancelled: string[] = [];
      fixture.componentInstance.cancel.subscribe((id) => cancelled.push(id));
      el(fixture, '[data-testid="album-tile-cancel"]')!.click();
      expect(cancelled).toEqual(['j9']);
    }
  });

  it('carries its live job stage, worded as on the Downloads page', () => {
    for (const [status, stage, label] of [
      ['missing', 'queued', 'Queued'],
      ['partial', 'downloading', 'Downloading'],
      ['missing', 'organizing', 'Organizing'],
    ] as const) {
      const fixture = render(tile({ status, localAlbumId: 'a', totalTracks: 7 }), {
        status: { phase: 'job', stage },
      });
      const button = el(fixture, '[data-testid="album-tile-action"]') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.dataset['huntPhase']).toBe('job');
      expect(el(fixture, '[data-testid="album-tile-hunt-status"]')!.textContent).toBe(label);
    }
  });

  // The site-wide lock is gone: an idle album is clickable whatever else is hunting.
  it('an idle album stays clickable, with no busy text', () => {
    const fixture = render(tile({ status: 'missing' }));
    const button = el(fixture, '[data-testid="album-tile-action"]') as HTMLButtonElement;

    expect(button.disabled).toBe(false);
    expect(el(fixture, '[data-testid="album-tile-hunt-status"]')).toBeNull();
  });

  it('prefers the local cover over the remote one, and falls back to remote when unowned', () => {
    const owned = render(
      tile({
        status: 'owned',
        localAlbumId: 'a',
        coverArt: 'hash',
        coverArtUrl: 'https://mb/x.jpg',
      }),
    );
    expect(owned.componentInstance.coverSrc()).toBe('/api/cover/hash?size=300&token=tok');

    const missing = render(tile({ status: 'missing', coverArtUrl: 'https://mb/x.jpg' }));
    expect(missing.componentInstance.coverSrc()).toBe('https://mb/x.jpg');
  });

  // #1666: an owned tile's cover follows its album's rev, from the DTO or pushed.
  it("carries the local album's cover rev, and a newer pushed one", () => {
    const owned = render(
      tile({ status: 'owned', localAlbumId: 'a', coverArt: 'hash', coverRev: 2 }),
    );
    expect(owned.componentInstance.coverSrc()).toBe('/api/cover/hash?size=300&v=2&token=tok');
    TestBed.inject(CoverRevisionsService).raise([{ kind: 'album', id: 'a', rev: 3 }]);
    expect(owned.componentInstance.coverSrc()).toBe('/api/cover/hash?size=300&v=3&token=tok');
  });

  it('builds a subtitle from only the parts a tile actually has', () => {
    const bare = render(tile({ status: 'owned', localAlbumId: 'a', year: null }));
    expect(bare.componentInstance.subtitle()).toBe('');

    const ep = render(tile({ status: 'owned', localAlbumId: 'a', year: 1969, kind: 'EP' }));
    expect(ep.componentInstance.subtitle()).toBe('1969 · EP');
  });
});

// One tile interaction standard (#1298).
describe('AlbumTileComponent — entity menu doors', () => {
  it('an owned tile carries the ⋯; a missing tile carries none', () => {
    const owned = render(tile({ status: 'owned', title: 'Meddle', localAlbumId: 'al1' }));
    expect(el(owned, '[data-testid="entity-menu-button"]')).not.toBeNull();
    const missing = render(tile({ status: 'missing', title: 'Atom Heart Mother' }));
    expect(el(missing, '[data-testid="entity-menu-button"]')).toBeNull();
  });
});
