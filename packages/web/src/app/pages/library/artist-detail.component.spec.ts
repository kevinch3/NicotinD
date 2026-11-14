import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter, Router, ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, BehaviorSubject, EMPTY, Subject, throwError, type Observable } from 'rxjs';
import { vi } from 'vitest';
import {
  ArtistDetailComponent,
  ARTIST_TAB_LABEL_KEYS,
  needsCompletion,
  sourceName,
} from './artist-detail.component';
import EN_CATALOG from '../../../../public/i18n/en.json';
import ES_CATALOG from '../../../../public/i18n/es.json';
import { LibraryApiService } from '../../services/api/library-api.service';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { AuthService } from '../../services/auth.service';
import { asRole, canCurate as canCurateRole } from '../../../types/core';
import { PlayerService } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { PullToRefreshService } from '../../services/pull-to-refresh.service';
import { LibraryEventsService } from '../../services/library-events.service';
import { PageBackService } from '../../services/page-back.service';
import { NavigationService } from '../../services/navigation.service';

const ARTIST = {
  id: 'ar1',
  name: 'Natiruts',
  albumCount: 2,
  coverArt: 'ar1',
  bio: null,
  urls: [],
};
const ALBUMS = [
  { id: 'a1', name: 'Natiruts', artist: 'Natiruts' },
  { id: 'a2', name: 'Acústico', artist: 'Natiruts' },
];
const ALBUM_DETAILS: Record<
  string,
  {
    id: string;
    name: string;
    artist: string;
    song: Array<{ id: string; title: string; artist: string }>;
  }
> = {
  a1: {
    id: 'a1',
    name: 'Natiruts',
    artist: 'Natiruts',
    song: [
      { id: 's1', title: 'Natiruts Reggae Power', artist: 'Natiruts' },
      { id: 's2', title: 'Sorri, Sou Rei', artist: 'Natiruts' },
    ],
  },
  a2: {
    id: 'a2',
    name: 'Acústico',
    artist: 'Natiruts',
    song: [{ id: 's3', title: 'Quatro Vezes Você', artist: 'Natiruts' }],
  },
};

/**
 * What the server's artist DTO carries beyond ARTIST — #1666's tests use it to
 * model "the portrait was replaced": whatever cover identity the API returns
 * moves with the bytes. Reset after every test.
 */
let serverArtistPatch: Record<string, unknown> = {};
/** The on-visit completion (#1855); answers nothing unless a test says otherwise. */
let completeArtistImpl: (id: string) => Observable<unknown> = () => EMPTY;
afterEach(() => {
  serverArtistPatch = {};
  completeArtistImpl = () => EMPTY;
});

interface GetSongsCall {
  id: string;
  size: number;
  offset: number;
  opts: { sort?: string; filter?: Record<string, unknown> };
}

function song(id: string) {
  return {
    id,
    title: id,
    artist: 'Natiruts',
    album: 'Album',
    albumId: 'a1',
    duration: 100,
    path: `p/${id}.mp3`,
    bitRate: 320,
    size: 1000,
    created: '2024-01-01',
  };
}

/** Per-artist answer of the top-songs stub; empty by default so no other case renders the block. */
let topSongsFor: Record<string, Array<{ id: string; title: string; artist: string }>> = {};

function setup(
  role = 'admin',
  deleteSongs = vi.fn(() => of({ ok: true, deletedCount: 0 })),
  canAcquire = true,
  downloadsApi: object = {
    getArtistDiscography: () => of({ artistId: 'ar1', lidarrId: 0, mbid: '', albums: [] }),
  },
  artistGenreDistribution?: (id: string) => unknown,
) {
  const playWithContextCalls: unknown[][] = [];
  const addToQueueCalls: unknown[] = [];
  const getAlbumCalls: string[] = [];
  const getArtistSongsCalls: GetSongsCall[] = [];
  const getArtistCalls: string[] = [];
  const imageCalls = {
    upload: [] as Array<{ id: string; file: File }>,
    fromAlbum: [] as Array<{ id: string; albumId: string }>,
    reset: [] as string[],
  };

  // Drives the :id param so tests can exercise the artist→artist reaction.
  const paramMap = new BehaviorSubject(convertToParamMap({ id: 'ar1' }));

  let registeredHandler: (() => Promise<void> | void) | null = null;
  const p2rStub = {
    register: (h: () => Promise<void> | void) => {
      registeredHandler = h;
    },
    refreshing: signal(false),
    hasHandler: signal(true),
    trigger: vi.fn(),
  };
  const invalidateLibraryReads = vi.fn();

  TestBed.configureTestingModule({
    imports: [ArtistDetailComponent],
    providers: [
      provideRouter([]),
      { provide: PullToRefreshService, useValue: p2rStub },
      {
        provide: ActivatedRoute,
        useValue: {
          paramMap,
          snapshot: {
            paramMap: { get: (k: string) => (k === 'id' ? paramMap.value.get('id') : null) },
            queryParamMap: { get: () => null, getAll: () => [], keys: [] as string[] },
          },
        },
      },
      {
        provide: DownloadsApiService,
        useValue: downloadsApi,
      },
      {
        provide: LibraryApiService,
        useValue: {
          // The curator image menu loads live source availability on construction (issue #422).
          artistImageSources: () => of({ sources: ['lidarr'] }),
          getArtist: (id: string) => {
            getArtistCalls.push(id);
            return of({
              artist: { ...ARTIST, ...serverArtistPatch, id },
              albums: ALBUMS,
              singlesAndEps: [],
            });
          },
          getAlbum: (id: string) => {
            getAlbumCalls.push(id);
            return of(ALBUM_DETAILS[id]);
          },
          // Each artist's row names its seed, so a test can tell whose row is showing.
          getRelatedArtists: (id: string) =>
            of({
              artists: [
                {
                  id: `rel-of-${id}`,
                  name: `Related to ${id}`,
                  coverArt: null,
                  albumCount: 1,
                  score: 0.9,
                  signals: {},
                },
              ],
            }),
          getArtistSongs: (
            id: string,
            size: number,
            offset: number,
            opts: { sort?: string; starred?: boolean } = {},
          ) => {
            getArtistSongsCalls.push({ id, size, offset, opts });
            // First page returns two songs; subsequent pages are empty (done).
            return of(offset === 0 ? [song('s1'), song('s2')] : []);
          },
          uploadArtistImage: (id: string, file: File) => {
            imageCalls.upload.push({ id, file });
            return of({ ok: true });
          },
          setArtistImageFromAlbum: (id: string, albumId: string) => {
            imageCalls.fromAlbum.push({ id, albumId });
            return of({ ok: true });
          },
          resetArtistImage: (id: string) => {
            imageCalls.reset.push(id);
            return of({ ok: true });
          },
          completeArtist: (id: string) => completeArtistImpl(id),
          getArtistTopSongs: (id: string) => of(topSongsFor[id] ?? []),
          deleteSongs,
          invalidateLibraryReads,
          ...(artistGenreDistribution ? { artistGenreDistribution } : {}),
        },
      },
      {
        provide: AuthService,
        useValue: {
          token: signal('tok'),
          mediaToken: signal('tok'),
          role: signal(role),
          canCurate: () => canCurateRole(asRole(role)),
          // The merged album grid gates its acquire buttons on this.
          canAcquire: () => canAcquire,
        },
      },
      {
        provide: PlayerService,
        useValue: {
          playWithContext: (...args: unknown[]) => {
            playWithContextCalls.push(args);
          },
          addToQueue: (t: unknown) => {
            addToQueueCalls.push(t);
          },
        },
      },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(ArtistDetailComponent);
  fixture.detectChanges();
  return {
    component: fixture.componentInstance,
    fixture,
    playWithContextCalls,
    addToQueueCalls,
    getAlbumCalls,
    getArtistSongsCalls,
    getArtistCalls,
    imageCalls,
    deleteSongs,
    paramMap,
    invalidateLibraryReads,
    getRegisteredHandler: () => registeredHandler,
  };
}

/** Settle the async song load (firstValueFrom over of()) without advancing
 *  macrotasks — a setTimeout flush lets the zoneless scheduler render the real
 *  <app-track-row> (a required-input child), which trips NG0950 under the JIT
 *  harness. Microtask flushing settles the load while leaving the list unrendered,
 *  so these tests assert on component state (the same approach as playlist-detail). */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ArtistDetailComponent — Play All', () => {
  it('fetches every album and calls playWithContext with all songs', async () => {
    const { component, playWithContextCalls, getAlbumCalls } = setup();
    await fixture_stable();

    await component.playAll();

    expect(getAlbumCalls).toContain('a1');
    expect(getAlbumCalls).toContain('a2');

    expect(playWithContextCalls).toHaveLength(1);
    const [tracks, startIndex, context] = playWithContextCalls[0] as [
      Array<{ id: string }>,
      number,
      { type: string; name: string },
    ];
    expect(tracks).toHaveLength(3); // s1+s2 from a1, s3 from a2
    expect(tracks.map((t) => t.id)).toEqual(['s1', 's2', 's3']);
    expect(startIndex).toBe(0);
    expect(context.type).toBe('adhoc');
    expect(context.name).toBe('Natiruts');
  });

  it('sets playingAll to false when done', async () => {
    const { component } = setup();
    await fixture_stable();

    await component.playAll();

    expect(component.playingAll()).toBe(false);
  });

  it('does not call playWithContext when albums list is empty', async () => {
    const { component, playWithContextCalls } = setup();
    await fixture_stable();

    component.albums.set([]);
    await component.playAll();

    expect(playWithContextCalls).toHaveLength(0);
  });

  it('assigns each song its album name as the album field', async () => {
    const { component, playWithContextCalls } = setup();
    await fixture_stable();

    await component.playAll();

    const [tracks] = playWithContextCalls[0] as [
      Array<{ id: string; album: string }>,
      ...unknown[],
    ];
    const s1 = tracks.find((t) => t.id === 's1');
    const s3 = tracks.find((t) => t.id === 's3');
    expect(s1?.album).toBe('Natiruts');
    expect(s3?.album).toBe('Acústico');
  });
});

describe('ArtistDetailComponent — Songs tab', () => {
  it('defaults to the Albums tab and does not load songs eagerly', async () => {
    const { component, getArtistSongsCalls } = setup();
    await fixture_stable();
    expect(component.activeTab()).toBe('albums');
    expect(getArtistSongsCalls).toHaveLength(0);
  });

  it('lazily loads songs only when the Songs tab is opened', async () => {
    const { component, getArtistSongsCalls } = setup();
    await fixture_stable();

    component.setTab('songs');
    await flush();

    expect(getArtistSongsCalls).toHaveLength(1);
    expect(getArtistSongsCalls[0].offset).toBe(0);
    expect(component.songs().map((s) => s.id)).toEqual(['s1', 's2']);
    expect(component.songsLoaded()).toBe(true);

    // Opening the tab again must NOT re-fetch (already loaded).
    component.setTab('albums');
    component.setTab('songs');
    await flush();
    expect(getArtistSongsCalls).toHaveLength(1);
  });

  it('refetches from the top when the sort changes', async () => {
    const { component, getArtistSongsCalls } = setup();
    await fixture_stable();
    component.setTab('songs');
    await flush();

    component.setSongSort('title');
    await flush();

    const last = getArtistSongsCalls[getArtistSongsCalls.length - 1];
    expect(last.offset).toBe(0);
    expect(last.opts.sort).toBe('title');
  });

  it('refetches from the top when the shared metadata filter changes', async () => {
    const { component, getArtistSongsCalls } = setup();
    await fixture_stable();
    component.setTab('songs');
    await flush();

    await component.onSongFilterChange({ starred: true, bpmMin: 120 });
    await flush();

    const last = getArtistSongsCalls[getArtistSongsCalls.length - 1];
    expect(last.offset).toBe(0);
    expect(last.opts.filter).toEqual({ starred: true, bpmMin: 120 });
    expect(component.songFilter()).toEqual({ starred: true, bpmMin: 120 });
  });

  it('plays the selected songs and exits select mode', async () => {
    const { component, playWithContextCalls } = setup();
    await fixture_stable();
    component.setTab('songs');
    await flush();

    component.selection.enter();
    component.selection.toggle('s2');
    component.playSelected();

    expect(playWithContextCalls).toHaveLength(1);
    const [tracks] = playWithContextCalls[0] as [Array<{ id: string }>, ...unknown[]];
    expect(tracks.map((t) => t.id)).toEqual(['s2']);
    expect(component.selection.active()).toBe(false);
  });

  it('enqueues each selected song for "add to queue"', async () => {
    const { component, addToQueueCalls } = setup();
    await fixture_stable();
    component.setTab('songs');
    await flush();

    component.selection.enter();
    component.selectAllSongs();
    component.queueSelected();

    expect(addToQueueCalls).toHaveLength(2);
    expect(component.selection.active()).toBe(false);
  });
});

describe('ArtistDetailComponent — image override', () => {
  // Upload / from-album / auto-fetch / reset moved to ArtistImageMenuComponent
  // (issue #250 gap 4) so the Artists grid can reuse them; see that component's
  // spec. What stays here is the page's own job: a portrait URL that carries the
  // artist's cover rev (#1666).
  it('exposes the artist albums + singles as pickable covers', async () => {
    const { component } = setup();
    await fixture_stable();
    component.singlesAndEps.set([{ id: 's-ep', name: 'EP', artist: 'Natiruts' } as never]);
    expect(component.pickableAlbums().map((a) => a.id)).toEqual(['a1', 'a2', 's-ep']);
  });

  it('a never-changed portrait keeps its unversioned URL; a rev adds v', async () => {
    const { component } = setup();
    await fixture_stable();
    expect(component.artistImageSrc()).toBe('/api/cover/ar1?size=200&token=tok');
    TestBed.inject(LibraryEventsService).apply(
      { type: 'artwork.changed', changes: [{ kind: 'artist', id: 'ar1', rev: 3 }] },
      1,
    );
    expect(component.artistImageSrc()).toBe('/api/cover/ar1?size=200&v=3&token=tok');
  });

  it('#1666 a portrait changed elsewhere re-keys the open page from artwork.changed', async () => {
    serverArtistPatch = { coverRev: 1 };
    const { component } = setup();
    await flush();
    const before = component.artistImageSrc();
    // Another tab, another device or the curator agent replaced it: only the
    // pushed event reaches this page. Before #1666 nothing on the page read it.
    TestBed.inject(LibraryEventsService).apply(
      { type: 'artwork.changed', changes: [{ kind: 'artist', id: 'ar1', rev: 2 }] },
      1,
    );
    expect(component.artistImageSrc()).not.toBe(before);
    // Another entity's change leaves this portrait alone.
    const after = component.artistImageSrc();
    TestBed.inject(LibraryEventsService).apply(
      { type: 'artwork.changed', changes: [{ kind: 'album', id: 'ar1', rev: 9 }] },
      2,
    );
    expect(component.artistImageSrc()).toBe(after);
  });

  it('#1666 a replay gap re-reads the artist, so a missed portrait change still lands', async () => {
    serverArtistPatch = { coverRev: 1 };
    const { component, getArtistCalls } = setup();
    await flush();
    const before = component.artistImageSrc();
    const reads = getArtistCalls.length;

    // The change happened while the stream could not replay it.
    serverArtistPatch = { coverRev: 2 };
    TestBed.inject(LibraryEventsService).resync.update((n) => n + 1);
    TestBed.tick();
    await flush();

    expect(getArtistCalls.length).toBe(reads + 1);
    expect(component.artistImageSrc()).not.toBe(before);
  });

  // #1666: `/api/cover/<id>` is cached for a day, so the portrait URL must move
  // with the image, not with a counter that lives as long as this page does.
  // Both scenarios model a replaced portrait the same way: the server's artist
  // DTO now carries the new `coverRev`, and (on navigation) artwork.changed
  // pushes it too.
  it('#1666 a replaced portrait still shows after navigating away and back', async () => {
    serverArtistPatch = { coverRev: 1 };
    const { component, paramMap } = setup();
    await flush();
    const stale = component.artistImageSrc();
    expect(stale).toBeDefined();

    // The menu's answer (or the pushed event) carries the new rev.
    serverArtistPatch = { coverRev: 2 };
    TestBed.inject(LibraryEventsService).apply(
      { type: 'artwork.changed', changes: [{ kind: 'artist', id: 'ar1', rev: 2 }] },
      1,
    );
    expect(component.artistImageSrc()).not.toBe(stale);

    paramMap.next(convertToParamMap({ id: 'ar2' }));
    await flush();
    paramMap.next(convertToParamMap({ id: 'ar1' }));
    await flush();

    expect(component.artist()?.id).toBe('ar1');
    // A page-local counter reset to 0 on the artist change, so the URL was
    // byte-identical to the one the browser cached before the replacement.
    expect(component.artistImageSrc()).not.toBe(stale);
  });

  it('#1666 a replaced portrait still shows when the page is mounted again', async () => {
    serverArtistPatch = { coverRev: 1 };
    const { component, fixture } = setup();
    await flush();
    const stale = component.artistImageSrc();

    serverArtistPatch = { coverRev: 2 };
    fixture.destroy();

    const again = TestBed.createComponent(ArtistDetailComponent);
    again.detectChanges();
    await flush();
    expect(again.componentInstance.artist()?.id).toBe('ar1');
    expect(again.componentInstance.artistImageSrc()).not.toBe(stale);
  });
});

// The genre editor is parked until it is redesigned (docs/library-scanner.md
// "Artist genre editor is hidden"). Its sibling identity fix must stay.
describe('ArtistDetailComponent — artist genre editor is hidden', () => {
  it('offers a curator the identity fix but not the genre fix', async () => {
    const { fixture } = setup('admin');
    await fixture_stable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="artist-identity-fix"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="artist-genre-fix"]')).toBeNull();
  });
});

// #1572: the header names the main genre(s); everything else sits in a
// collapsed About block that stays mounted so the bio auto-fetch still runs.
describe('ArtistDetailComponent — genre headline + About block', () => {
  const share = (slices: { genre: string; count: number; weight: number }[]) => (id: string) =>
    of({
      artist: id,
      trackCount: 10,
      genreCount: slices.length,
      slices: [],
      primary: { taggedCount: 10, slices },
    });

  function render(dist?: (id: string) => unknown, role = 'listener') {
    const ctx = setup(role, undefined, true, undefined, dist);
    return ctx;
  }

  async function settle(ctx: ReturnType<typeof setup>) {
    await flush();
    ctx.fixture.detectChanges();
    return ctx.fixture.nativeElement as HTMLElement;
  }

  const chips = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('[data-testid="artist-headline-genre"]')).map((c) =>
      c.textContent?.trim(),
    );

  it('names the two main genres from the primary share', async () => {
    const el = await settle(
      render(
        share([
          { genre: 'Pop', count: 5, weight: 0.5 },
          { genre: 'Salsa', count: 3, weight: 0.3 },
          { genre: 'Other', count: 2, weight: 0.2 },
        ]),
      ),
    );
    expect(chips(el)).toEqual(['Pop', 'Salsa']);
  });

  it('hands the API\'s folded "Other" to the bar as a bucket, not a genre', async () => {
    const ctx = render(
      share([
        { genre: 'Pop', count: 8, weight: 0.8 },
        { genre: 'Other', count: 2, weight: 0.2 },
      ]),
    );
    await settle(ctx);
    expect(ctx.component.genreShare()?.slices.map((s) => s.kind)).toEqual([undefined, 'other']);
  });

  it('names a single genre when one dominates', async () => {
    const el = await settle(
      render(
        share([
          { genre: 'Rock', count: 8, weight: 0.8 },
          { genre: 'Blues', count: 2, weight: 0.2 },
        ]),
      ),
    );
    expect(chips(el)).toEqual(['Rock']);
  });

  it('shows no chips and no About block when there is nothing to put in either', async () => {
    const el = await settle(render(share([])));
    expect(el.querySelector('[data-testid="artist-headline-genres"]')).toBeNull();
    expect(el.querySelector('[data-testid="artist-about"]')).toBeNull();
  });

  it('keeps the About body mounted but hidden until toggled', async () => {
    const ctx = render(share([{ genre: 'Pop', count: 10, weight: 1 }]));
    const el = await settle(ctx);
    const body = el.querySelector('#artist-about-body') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.hidden).toBe(true);
    expect(body.querySelector('app-artist-info')).not.toBeNull();

    (el.querySelector('[data-testid="artist-about-toggle"]') as HTMLButtonElement).click();
    ctx.fixture.detectChanges();
    expect(body.hidden).toBe(false);
    expect(
      el.querySelector('[data-testid="artist-about-toggle"]')?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('no longer renders the overlapping genre strip on the artist page', async () => {
    const el = await settle(render(share([{ genre: 'Pop', count: 10, weight: 1 }])));
    expect(el.querySelector('app-genre-distribution-strip')).toBeNull();
  });

  it('collapses About again on artist→artist navigation', async () => {
    const ctx = render(share([{ genre: 'Pop', count: 10, weight: 1 }]));
    await settle(ctx);
    ctx.component.aboutOpen.set(true);
    ctx.paramMap.next(convertToParamMap({ id: 'ar2' }));
    await flush();
    expect(ctx.component.aboutOpen()).toBe(false);
  });
});

describe('ArtistDetailComponent — delete (admin only)', () => {
  it('exposes a destructive "Remove from library" track action for admins', async () => {
    const { component } = setup('admin');
    await fixture_stable();
    component.setTab('songs');
    await flush();

    const action = component.songMenu
      .build(component.songs()[0], { hideGoToArtist: true, removable: true })
      .find((a) => a.label === 'Remove from library');
    expect(action).toBeDefined();
    expect(action!.destructive).toBe(true);
  });

  it('hides the "Remove from library" track action from non-admins', async () => {
    const { component } = setup('user');
    await fixture_stable();
    component.setTab('songs');
    await flush();

    const action = component.songMenu
      .build(component.songs()[0], { hideGoToArtist: true, removable: true })
      .find((a) => a.label === 'Remove from library');
    expect(action).toBeUndefined();
  });

  it('deletes the selected songs, prunes them, and exits select mode', async () => {
    const deleteSongs = vi.fn(() => of({ ok: true, deletedCount: 2 }));
    const { component } = setup('admin', deleteSongs);
    await fixture_stable();
    component.setTab('songs');
    await flush();

    component.selection.enter();
    component.selection.toggle('s1');
    component.selection.toggle('s2');
    component.deleteSelectedSongs();

    // deleteSelectedSongs defers to the confirm dialog; run the queued callback.
    const cb = component.confirmCallback();
    expect(cb).toBeTruthy();
    await cb!();

    expect(deleteSongs).toHaveBeenCalledWith(['s1', 's2']);
    expect(component.songs().map((s) => s.id)).toEqual([]);
    expect(component.selection.active()).toBe(false);
    expect(component.deleteError()).toBeNull();
  });

  it('surfaces a partial-failure message when not all songs were removed', async () => {
    const deleteSongs = vi.fn(() => of({ ok: true, deletedCount: 1 }));
    const { component } = setup('admin', deleteSongs);
    await fixture_stable();
    component.setTab('songs');
    await flush();

    component.selection.enter();
    component.selection.toggle('s1');
    component.selection.toggle('s2');
    component.deleteSelectedSongs();
    await component.confirmCallback()!();

    expect(component.deleteError()).toContain('1 of 2');
  });

  it('does nothing when no songs are selected', async () => {
    const deleteSongs = vi.fn(() => of({ ok: true, deletedCount: 0 }));
    const { component } = setup('admin', deleteSongs);
    await fixture_stable();
    component.setTab('songs');
    await flush();

    component.selection.enter();
    component.deleteSelectedSongs();

    expect(component.confirmCallback()).toBeNull();
    expect(deleteSongs).not.toHaveBeenCalled();
  });
});

describe('ArtistDetailComponent — reacts to :id changes', () => {
  it('reloads the artist when navigating artist→artist (same component instance)', async () => {
    const { component, getArtistCalls, paramMap } = setup();
    await fixture_stable();
    expect(getArtistCalls).toEqual(['ar1']);
    expect(component.artist()?.id).toBe('ar1');

    // Simulate router param change to a different artist without remounting.
    paramMap.next(convertToParamMap({ id: 'ar2' }));
    await flush();

    expect(getArtistCalls).toEqual(['ar1', 'ar2']);
    expect(component.artist()?.id).toBe('ar2');
    expect(component.loading()).toBe(false);
  });

  it('does not reload when the same id re-emits', async () => {
    const { getArtistCalls, paramMap } = setup();
    await fixture_stable();
    expect(getArtistCalls).toEqual(['ar1']);

    paramMap.next(convertToParamMap({ id: 'ar1' }));
    await flush();

    expect(getArtistCalls).toEqual(['ar1']);
  });

  it('resets per-artist Songs-tab state on navigation', async () => {
    const { component, paramMap } = setup();
    await fixture_stable();
    component.setTab('songs');
    await flush();
    expect(component.songs().length).toBe(2);
    expect(component.songsLoaded()).toBe(true);

    paramMap.next(convertToParamMap({ id: 'ar2' }));
    await flush();

    expect(component.songs()).toEqual([]);
    expect(component.songsLoaded()).toBe(false);
    expect(component.activeTab()).toBe('albums');
  });
});

describe('ArtistDetailComponent — related artists', () => {
  it("loads the artist's related row and swaps it on artist→artist navigation", async () => {
    const { component, paramMap } = setup();
    await fixture_stable();
    await flush();
    expect(component.relatedArtists().map((a) => a.id)).toEqual(['rel-of-ar1']);

    paramMap.next(convertToParamMap({ id: 'ar2' }));
    await flush();
    expect(component.relatedArtists().map((a) => a.id)).toEqual(['rel-of-ar2']);
  });
});

describe('ArtistDetailComponent — popular songs', () => {
  afterEach(() => {
    topSongsFor = {};
  });

  it('stays empty when nothing ranks, so the block is not rendered', async () => {
    const { component, fixture } = setup();
    await fixture_stable();
    await flush();
    expect(component.topSongs()).toEqual([]);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="artist-top-songs"]'),
    ).toBeNull();
  });

  it('loads the ranked songs in order and swaps them on artist→artist navigation', async () => {
    topSongsFor = {
      ar1: [
        { id: 'hit', title: 'Hit', artist: 'Natiruts' },
        { id: 'second', title: 'Second', artist: 'Natiruts' },
      ],
      ar2: [{ id: 'other', title: 'Other', artist: 'Someone' }],
    };
    const { component, paramMap } = setup();
    await flush();
    expect(component.topSongs().map((s) => s.id)).toEqual(['hit', 'second']);

    paramMap.next(convertToParamMap({ id: 'ar2' }));
    await flush();
    expect(component.topSongs().map((s) => s.id)).toEqual(['other']);
  });

  it('plays from the chosen row through the rest of the list', async () => {
    topSongsFor = {
      ar1: [
        { id: 'hit', title: 'Hit', artist: 'Natiruts' },
        { id: 'second', title: 'Second', artist: 'Natiruts' },
      ],
    };
    const { component, playWithContextCalls } = setup();
    await flush();
    component.playTopSong(1);
    expect(playWithContextCalls).toHaveLength(1);
    const [tracks, index] = playWithContextCalls[0] as [Array<{ id: string }>, number];
    expect(tracks.map((t) => t.id)).toEqual(['hit', 'second']);
    expect(index).toBe(1);

    component.playTopSong(7);
    expect(playWithContextCalls).toHaveLength(1);
  });
});

describe('ArtistDetailComponent — visibleSongs filters deletedSongIds', () => {
  it('excludes a song whose id was deleted elsewhere in the app', async () => {
    const { component } = setup();
    await fixture_stable();
    component.setTab('songs');
    await flush();

    expect(component.visibleSongs().map((s) => s.id)).toEqual(['s1', 's2']);

    TestBed.inject(TransferService).deletedSongIds.set(new Set(['s1']));

    expect(component.visibleSongs().map((s) => s.id)).toEqual(['s2']);
  });
});

describe('ArtistDetailComponent — Appears On tab never collapses the tab bar', () => {
  it('keeps appears-on navigable when the artist has no own albums or singles', async () => {
    const { component } = setup();
    await fixture_stable();

    // An artist who only appears on compilations: no own releases, non-empty appears-on.
    component.albums.set([]);
    component.singlesAndEps.set([]);
    component.appearsOn.set([{ id: 'c1', name: 'VA Comp', artist: 'Various Artists' } as never]);

    // The tab is listed (so the bar renders it) alongside the always-present Songs tab.
    expect(component.visibleTabs()).toContain('appears-on');
    expect(component.visibleTabs()).toContain('songs');

    // Switching to it keeps it listed — the old guard used to drop the whole bar here.
    component.setTab('appears-on');
    expect(component.activeTab()).toBe('appears-on');
    expect(component.visibleTabs()).toContain('appears-on');
  });
});

describe('ArtistDetailComponent — onIdentitySaved navigation', () => {
  it('navigates to a different resulting artist after a rename/merge', async () => {
    const { component } = setup();
    await fixture_stable();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    component.onIdentitySaved({ ok: true, resynced: true, kind: 'merged', artistId: 'ar2' });

    expect(nav).toHaveBeenCalledWith(['/library/artists', 'ar2']);
  });

  it('reloads in place when the rename keeps the same id (accent/case fix)', async () => {
    const { component, getArtistCalls } = setup();
    await fixture_stable();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    getArtistCalls.length = 0; // ignore the initial load

    component.onIdentitySaved({ ok: true, resynced: true, kind: 'renamed', artistId: 'ar1' });

    expect(nav).not.toHaveBeenCalled();
    expect(getArtistCalls).toEqual(['ar1']); // re-fetched in place
  });

  it('routes to the artists grid after a split (compound now hidden)', async () => {
    const { component } = setup();
    await fixture_stable();
    const nav = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    component.onIdentitySaved({ ok: true, resynced: true, kind: 'split', artistId: null });

    expect(nav).toHaveBeenCalledWith(['/library'], { queryParams: { type: 'artists' } });
  });
});

describe('ArtistDetailComponent — pull-to-refresh', () => {
  it('reloads the artist and invalidates library reads', async () => {
    const { getArtistCalls, invalidateLibraryReads, getRegisteredHandler } = setup();
    await fixture_stable();
    getArtistCalls.length = 0;

    const handler = getRegisteredHandler();
    expect(handler).toBeTruthy();
    await handler!();

    expect(invalidateLibraryReads).toHaveBeenCalled();
    expect(getArtistCalls).toEqual(['ar1']);
  });

  it('no-ops when artistId is empty', async () => {
    const { component, getArtistCalls, invalidateLibraryReads, getRegisteredHandler } = setup();
    await fixture_stable();
    component.artistId = '';
    getArtistCalls.length = 0;

    await getRegisteredHandler()!();

    expect(invalidateLibraryReads).not.toHaveBeenCalled();
    expect(getArtistCalls).toEqual([]);
  });
});

describe('ArtistDetailComponent — TV D-pad nav (issue android-tv phase3)', () => {
  it('renders the albums tab grid as one appTvNavGroup with grid axis', async () => {
    const { component, fixture } = setup();
    await fixture_stable();
    component.setTab('albums');
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const group = el.querySelector('[appTvNavGroup][axis="grid"]');
    expect(group).not.toBeNull();
  });

  // The assertion above only proves the ATTRIBUTE is in the DOM, which
  // NO_ERRORS_SCHEMA would let pass even with the directives unimported. This
  // one proves the group's item list is actually populated and navigable —
  // the exact thing an empty items() (cross-component boundary bug) breaks.
  it('ArrowRight moves focus across the albums grid (real D-pad behaviour)', async () => {
    const { component, fixture } = setup();
    await fixture_stable();
    component.setTab('albums');
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const group = el.querySelector('[appTvNavGroup][axis="grid"]')!;
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
});

// Helper: lets Angular settle the ngOnInit promise (of() resolves synchronously as a microtask)
async function fixture_stable() {
  await Promise.resolve();
}

// ─── Merged album grid (library + discography in one set of tiles) ───────────
// The page used to render the library's albums and then repeat the same records
// in a separate "Full Discography" section. These cover the join.

const release = (over: Record<string, unknown>) => ({
  foreignAlbumId: 'mb',
  albumType: 'Album',
  secondaryTypes: [] as string[],
  totalTracks: 10,
  localTrackCount: 0,
  status: 'missing' as const,
  tracks: [] as unknown[],
  ...over,
});

function setupMerged(
  albums: unknown[],
  discographyFails = false,
  opts: {
    jobs?: ReturnType<typeof signal<unknown[]>>;
    getArtistDiscography?: () => unknown;
    getArtist?: () => unknown;
  } = {},
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ArtistDetailComponent],
    providers: [
      provideRouter([]),
      {
        provide: PullToRefreshService,
        useValue: { register: () => {}, refreshing: signal(false), hasHandler: signal(true) },
      },
      {
        provide: ActivatedRoute,
        useValue: {
          paramMap: of(convertToParamMap({ id: 'ar1' })),
          snapshot: {
            paramMap: { get: () => 'ar1' },
            queryParamMap: { get: () => null, getAll: () => [], keys: [] as string[] },
          },
        },
      },
      {
        provide: DownloadsApiService,
        useValue: {
          getArtistDiscography:
            opts.getArtistDiscography ??
            (() =>
              discographyFails
                ? throwError(() => new Error('Lidarr not configured'))
                : of({ artistId: 'ar1', lidarrId: 1, mbid: 'm', albums })),
        },
      },
      {
        provide: LibraryApiService,
        useValue: {
          artistImageSources: () => of({ sources: [] }),
          getArtist:
            opts.getArtist ?? (() => of({ artist: ARTIST, albums: ALBUMS, singlesAndEps: [] })),
          getArtistAppearsOn: () => of([]),
          getArtistSongs: () => of({ songs: [], total: 0 }),
          artistGenreDistribution: () =>
            of({
              slices: [],
              trackCount: 0,
              genreCount: 0,
              primary: { taggedCount: 0, slices: [] },
            }),
          invalidateLibraryReads: () => {},
        },
      },
      {
        provide: AuthService,
        useValue: {
          token: signal('tok'),
          mediaToken: signal('tok'),
          role: signal('admin'),
          canCurate: () => true,
          canAcquire: () => true,
        },
      },
      { provide: PlayerService, useValue: { playWithContext: () => {}, addToQueue: () => {} } },
      {
        provide: TransferService,
        useValue: {
          deletedSongIds: signal(new Set<string>()),
          acquisitionJobs: opts.jobs ?? signal([]),
        },
      },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });
  const fixture = TestBed.createComponent(ArtistDetailComponent);
  fixture.detectChanges();
  return fixture;
}

const titles = (tiles: { title: string }[]) => tiles.map((t) => t.title);

describe('ArtistDetailComponent — merged album grid', () => {
  it('shows one tile per album, not one per source', async () => {
    // a1 matches a release; a2 does not. Three inputs, three tiles — the old page
    // would have drawn five (two library tiles + three discography tiles).
    const fixture = setupMerged([
      release({ lidarrId: 1, title: 'Natiruts', status: 'present', localAlbumId: 'a1' }),
      release({ lidarrId: 2, title: 'Raçá', releaseDate: '2010-01-01' }),
    ]);
    await fixture_stable();
    fixture.detectChanges();

    const tiles = fixture.componentInstance.albumTiles();
    expect(tiles).toHaveLength(3);
    expect(titles(tiles).sort()).toEqual(['Acústico', 'Natiruts', 'Raçá']);
    expect(tiles.find((t) => t.title === 'Natiruts')!.status).toBe('owned');
    expect(tiles.find((t) => t.title === 'Raçá')!.status).toBe('missing');
  });

  it('hands a missing album to the grid with the discography row its hunt needs', async () => {
    // The tile's own rendering is asserted in album-tile.component.spec.ts, where it
    // is the ROOT component. This harness does not register signal inputs on a nested
    // component (src/testing/signal-input.ts), so every <app-album-tile> here renders
    // its defaults — a DOM assertion through one would pass vacuously.
    const fixture = setupMerged([release({ lidarrId: 2, title: 'Raçá' })]);
    await fixture_stable();
    fixture.detectChanges();

    const missing = fixture.componentInstance.visibleAlbumTiles().find((t) => t.title === 'Raçá')!;

    expect(missing.status).toBe('missing');
    expect(missing.localAlbumId).toBeUndefined();
    // Without a source the tile's button would be inert.
    expect(missing.source?.lidarrId).toBe(2);
  });

  it('routes a tile press to the hunt for that release, and only for a release', async () => {
    const fixture = setupMerged([
      release({ lidarrId: 2, title: 'Raçá' }),
      release({ lidarrId: 1, title: 'Natiruts', status: 'present', localAlbumId: 'a1' }),
    ]);
    await fixture_stable();
    const c = fixture.componentInstance;
    const hunted: number[] = [];
    c.openHunt = ((album: { lidarrId: number }) => hunted.push(album.lidarrId)) as never;

    const tiles = c.albumTiles();
    c.huntTile(tiles.find((t) => t.title === 'Raçá')!);
    expect(hunted).toEqual([2]);

    // A complete album carries no source, so pressing it can never start a hunt.
    c.huntTile(tiles.find((t) => t.title === 'Natiruts')!);
    expect(hunted).toEqual([2]);
  });

  it('collapses unowned live albums until the toggle is pressed', async () => {
    const fixture = setupMerged([
      release({ lidarrId: 2, title: 'Raçá' }),
      release({ lidarrId: 3, title: 'Ao Vivo', secondaryTypes: ['Live'] }),
    ]);
    await fixture_stable();
    fixture.detectChanges();
    const c = fixture.componentInstance;

    expect(titles(c.visibleAlbumTiles())).not.toContain('Ao Vivo');
    expect(c.hiddenReleaseCount()).toBe(1);

    c.showAllReleases.set(true);
    expect(titles(c.visibleAlbumTiles())).toContain('Ao Vivo');
  });

  it('still renders every local album when the discography fails to load', async () => {
    // Lidarr unconfigured, artist unmatched, or the acquirer gate refused — the
    // grid must degrade to exactly what it showed before the merge, not to empty.
    const fixture = setupMerged([], true);
    await fixture_stable();
    fixture.detectChanges();

    expect(titles(fixture.componentInstance.albumTiles()).sort()).toEqual(['Acústico', 'Natiruts']);
    expect(fixture.componentInstance.visibleTabs()).toContain('albums');
    // Every tile is a plain owned album: nothing carries a hunt source, so the
    // grid offers no action even though the user could acquire.
    expect(fixture.componentInstance.albumTiles().every((t) => !t.source)).toBe(true);
  });

  it('keeps an Albums tab for an artist whose every album is missing', async () => {
    // visibleTabs used to count local rows only, which hid the tab holding the
    // acquire buttons in exactly the case they exist for.
    const fixture = setupMerged([release({ lidarrId: 9, title: 'Unowned' })]);
    await fixture_stable();
    fixture.componentInstance.albums.set([]);
    fixture.detectChanges();

    expect(fixture.componentInstance.visibleTabs()).toContain('albums');
  });

  it('no longer renders a separate Full Discography section', async () => {
    const fixture = setupMerged([release({ lidarrId: 1, title: 'Natiruts', localAlbumId: 'a1' })]);
    await fixture_stable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).not.toContain('Full Discography');
    expect(fixture.nativeElement.querySelector('[data-testid="discography-summary"]')).toBeTruthy();
  });
});

// #1636: the summary sat inside the tablist's flex row and squeezed the tabs on a
// phone, and the row's labels were English literals. The layout itself is
// measured at 390px in e2e (artist-tab-row.spec.ts); this pins the structure and
// that every label is a catalog key.
describe('ArtistDetailComponent — tab row (#1636)', () => {
  it('keeps the discography summary out of the tablist', async () => {
    const fixture = setupMerged([release({ lidarrId: 1, title: 'Natiruts', localAlbumId: 'a1' })]);
    await fixture_stable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;

    const tablist = el.querySelector('[role="tablist"]')!;
    expect(tablist.querySelector('[data-testid="discography-summary"]')).toBeNull();
    expect(Array.from(tablist.children).every((c) => c.getAttribute('role') === 'tab')).toBe(true);
    expect(
      el.querySelector('[data-testid="artist-tab-row"] [data-testid="discography-summary"]'),
    ).toBeTruthy();
  });

  it('renders every label in the row through the catalog', async () => {
    const fixture = setupMerged([
      release({ lidarrId: 1, title: 'Natiruts', localAlbumId: 'a1' }),
      release({ lidarrId: 2, title: 'Ao Vivo', secondaryTypes: ['Live'] }),
    ]);
    await fixture_stable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;

    // No catalog loads in a unit test, so a translated label renders as its key.
    expect(el.querySelector('[data-testid="artist-tab-albums"]')!.textContent!.trim()).toBe(
      'artist.tab.albums',
    );
    expect(el.querySelector('[data-testid="discography-summary"]')!.textContent!.trim()).toBe(
      'discography.summary',
    );
    expect(el.querySelector('[data-testid="toggle-all-releases"]')!.textContent!.trim()).toBe(
      'artist.showAllReleases',
    );
  });

  it('has every key it renders in both catalogs', () => {
    const keys = [
      ...Object.values(ARTIST_TAB_LABEL_KEYS),
      'artist.noReleases',
      'artist.tabEmpty',
      'artist.showAllReleases',
      'artist.showFewerReleases',
      'discography.summary',
      'discography.checking',
    ];
    for (const key of keys) {
      expect(EN_CATALOG, `missing en key: ${key}`).toHaveProperty([key]);
      expect(ES_CATALOG, `missing es key: ${key}`).toHaveProperty([key]);
    }
    expect((EN_CATALOG as Record<string, string>)['discography.summary']).toContain('{missing}');
    expect((ES_CATALOG as Record<string, string>)['discography.summary']).toContain('{missing}');
  });
});

// #1627, the prod shape: a local "A contraluz" holding only "El viejo" and a local
// "De bichos y flores" holding only "Zafar" — each song on the OTHER album's
// tracklist. The server grades both missing; the tiles used to say partial.
describe('ArtistDetailComponent — header and tiles read one completeness rule (#1627)', () => {
  const swappedAlbums = [
    { id: 'a1', name: 'A contraluz', artist: 'La Vela Puerca' },
    { id: 'a2', name: 'De bichos y flores', artist: 'La Vela Puerca' },
  ];
  const swapped = [
    release({ lidarrId: 1, title: 'A contraluz', localAlbumId: 'a1', totalTracks: 14 }),
    release({ lidarrId: 2, title: 'De bichos y flores', localAlbumId: 'a2', totalTracks: 14 }),
    release({ lidarrId: 3, title: 'Deskarado' }),
  ];
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const getArtist = () =>
    of({ artist: { ...ARTIST, name: 'La Vela Puerca' }, albums: swappedAlbums, singlesAndEps: [] });

  it('the header and the tiles agree: a folder holding none of its tracklist is missing', async () => {
    const fixture = setupMerged(swapped, false, { getArtist });
    await settle();
    fixture.detectChanges();
    const c = fixture.componentInstance;

    // The rendered line is a catalog string (#1636), a bare key in a unit test;
    // the counts it is fed are what the header shows.
    expect(fixture.nativeElement.querySelector('[data-testid="discography-summary"]')).toBeTruthy();
    expect(c.discographySummary()).toEqual({ releases: 3, complete: 0, partial: 0, missing: 3 });
    const tiles = c.albumTiles();
    expect(tiles.map((t) => t.status)).toEqual(['missing', 'missing', 'missing']);
    expect(
      tiles
        .filter((t) => t.localAlbumId)
        .map((t) => t.title)
        .sort(),
    ).toEqual(['A contraluz', 'De bichos y flores']);
  });

  it('re-reads the albums and their status when a job for one of them ends', async () => {
    const jobs = signal<unknown[]>([]);
    const discographyCalls = { n: 0 };
    const artistCalls = { n: 0 };
    const getArtistDiscography = () => {
      discographyCalls.n++;
      // After the job lands, the server's tracklist match finds every track.
      const albums =
        discographyCalls.n === 1
          ? swapped
          : [
              { ...swapped[0], status: 'present' as const, localTrackCount: 14 },
              ...swapped.slice(1),
            ];
      return of({ artistId: 'ar1', lidarrId: 1, mbid: 'm', albums });
    };
    const fixture = setupMerged([], false, {
      jobs,
      getArtistDiscography,
      getArtist: () => {
        artistCalls.n++;
        return getArtist();
      },
    });
    await settle();
    fixture.detectChanges();
    const c = fixture.componentInstance;
    const contraluz = () => c.albumTiles().find((t) => t.title === 'A contraluz')!;
    expect(contraluz().status).toBe('missing');

    const live = {
      id: 'j1',
      kind: 'album-hunt',
      state: 'active',
      stage: 'downloading',
      lidarrAlbumId: 1,
      artistName: null,
      albumTitle: null,
      createdAt: 1,
      progress: { expected: 14, delivered: 3, unavailable: 0, failed: 0, canonical: 14 },
    };
    jobs.set([live]);
    fixture.detectChanges();
    await settle();
    // A live job is not an ending: nothing re-reads while it runs.
    expect(discographyCalls.n).toBe(1);

    jobs.set([{ ...live, state: 'done' }]);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();

    expect(discographyCalls.n).toBe(2);
    expect(artistCalls.n).toBe(2);
    expect(contraluz().status).toBe('owned');
    expect(fixture.componentInstance.discographySummary().complete).toBe(1);
  });

  it('holds the landed tile busy until the discography re-read is in, reading both at once', async () => {
    const jobs = signal<unknown[]>([]);
    const reread = new Subject<unknown>();
    const calls: string[] = [];
    let discographyCalls = 0;
    const fixture = setupMerged([], false, {
      jobs,
      getArtist: () => {
        calls.push('artist');
        return getArtist();
      },
      getArtistDiscography: () => {
        discographyCalls++;
        calls.push('discography');
        return discographyCalls === 1
          ? of({ artistId: 'ar1', lidarrId: 1, mbid: 'm', albums: swapped })
          : reread;
      },
    });
    await settle();
    fixture.detectChanges();
    const c = fixture.componentInstance;
    // The status the grid hands each tile — its button is disabled on any phase but
    // `idle` (album-tile.component.spec.ts; a nested tile renders defaults here).
    const statusOf = (title: string) =>
      c.tileHuntStatus(c.albumTiles().find((t) => t.title === title)!);
    expect(statusOf('A contraluz').phase).toBe('idle');

    const live = {
      id: 'j1',
      state: 'active',
      stage: 'organizing',
      lidarrAlbumId: 1,
      artistName: null,
      albumTitle: null,
      createdAt: 1,
      progress: { expected: 14, delivered: 14, unavailable: 0, failed: 0, canonical: 14 },
    };
    jobs.set([live]);
    fixture.detectChanges();
    await settle();
    calls.length = 0;

    // The job leaves `active`; the discography read has not answered yet.
    jobs.set([{ ...live, state: 'done', stage: 'done' }]);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();

    expect(calls.sort()).toEqual(['artist', 'discography']);
    expect(statusOf('A contraluz')).toEqual({ phase: 'job', stage: 'scanning' });
    // Another release's tile is not held by this job's ending.
    expect(statusOf('Deskarado').phase).toBe('idle');

    reread.next({
      artistId: 'ar1',
      lidarrId: 1,
      mbid: 'm',
      albums: [{ ...swapped[0], status: 'partial', localTrackCount: 13 }, ...swapped.slice(1)],
    });
    reread.complete();
    await settle();
    fixture.detectChanges();

    const contraluz = c.albumTiles().find((t) => t.title === 'A contraluz')!;
    expect(contraluz.status).toBe('partial');
    expect(c.tileHuntStatus(contraluz).phase).toBe('idle');
  });

  it('ignores a job that ends for another artist’s album', async () => {
    const jobs = signal<unknown[]>([]);
    let discographyCalls = 0;
    const fixture = setupMerged([], false, {
      jobs,
      getArtist,
      getArtistDiscography: () => {
        discographyCalls++;
        return of({ artistId: 'ar1', lidarrId: 1, mbid: 'm', albums: swapped });
      },
    });
    await settle();
    const other = {
      id: 'j9',
      state: 'active',
      lidarrAlbumId: 99,
      artistName: 'X',
      albumTitle: 'Y',
    };
    jobs.set([other]);
    fixture.detectChanges();
    await settle();
    jobs.set([{ ...other, state: 'done' }]);
    fixture.detectChanges();
    await settle();

    expect(discographyCalls).toBe(1);
  });
});

describe('ArtistDetailComponent — add artist to Lidarr (#644)', () => {
  const notProvisioned = {
    notProvisioned: true,
    artistId: 'ar1',
    artistName: 'Natiruts',
    artistMbid: 'mb',
    candidateName: 'Natiruts',
    provisioning: false,
  };
  const running = {
    phase: 'running',
    target: { artistName: 'Natiruts', localArtistId: 'ar1' },
    lastOutcome: null,
    lastError: null,
  };

  afterEach(() => vi.useRealTimers());

  it('offers Add, runs the job, then loads the discography', async () => {
    vi.useFakeTimers();
    const getArtistDiscography = vi
      .fn()
      .mockReturnValueOnce(of(notProvisioned))
      .mockReturnValue(of({ artistId: 'ar1', lidarrId: 9, mbid: 'mb', albums: [] }));
    const provisionArtist = vi.fn(() => of({ provisioning: true, status: running }));
    const getArtistProvisioning = vi
      .fn()
      .mockReturnValueOnce(of(running))
      .mockReturnValue(of({ ...running, phase: 'idle', lastOutcome: 'completed' }));
    const { component } = setup('admin', undefined, true, {
      getArtistDiscography,
      provisionArtist,
      getArtistProvisioning,
    });
    await flush();
    expect(component.notProvisioned()?.artistName).toBe('Natiruts');
    expect(component.discography()).toBeNull();

    const adding = component.addArtistToLidarr();
    await flush();
    expect(provisionArtist).toHaveBeenCalledWith('ar1');
    expect(component.provisioning()).toBe(true);

    await vi.advanceTimersByTimeAsync(4_000);
    await adding;
    expect(getArtistProvisioning).toHaveBeenCalledTimes(2);
    expect(component.provisioning()).toBe(false);
    expect(component.notProvisioned()).toBeNull();
    expect(component.discography()?.lidarrId).toBe(9);
  });

  // #1854: Lidarr lists a just-added artist's albums before their images.
  it('keeps re-reading after the add until the album covers arrive', async () => {
    vi.useFakeTimers();
    const wanted = (coverArtUrl?: string) => ({
      lidarrId: 1,
      foreignAlbumId: 'f1',
      title: 'Soul Talk',
      albumType: 'Album',
      secondaryTypes: [],
      totalTracks: 1,
      localTrackCount: 0,
      status: 'missing',
      coverArtUrl,
      tracks: [],
    });
    const disco = (coverArtUrl?: string) =>
      of({ artistId: 'ar1', lidarrId: 9, mbid: 'mb', albums: [wanted(coverArtUrl)] });
    const getArtistDiscography = vi
      .fn()
      .mockReturnValueOnce(of(notProvisioned))
      .mockReturnValueOnce(disco())
      .mockReturnValue(disco('https://img/soul-talk.jpg'));
    const { component } = setup('admin', undefined, true, {
      getArtistDiscography,
      provisionArtist: () => of({ provisioning: true, status: running }),
      getArtistProvisioning: () => of({ ...running, phase: 'idle', lastOutcome: 'completed' }),
    });
    await flush();
    const adding = component.addArtistToLidarr();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(component.discography()?.albums[0].coverArtUrl).toBeUndefined();

    await vi.advanceTimersByTimeAsync(3_000);
    await adding;
    expect(component.discography()?.albums[0].coverArtUrl).toBe('https://img/soul-talk.jpg');
    expect(getArtistDiscography).toHaveBeenCalledTimes(3);
  });

  it('surfaces the job error instead of reloading when the add failed', async () => {
    vi.useFakeTimers();
    const getArtistDiscography = vi.fn(() => of(notProvisioned));
    const { component } = setup('admin', undefined, true, {
      getArtistDiscography,
      provisionArtist: () => of({ provisioning: true, status: running }),
      getArtistProvisioning: () =>
        of({ ...running, phase: 'idle', lastOutcome: 'failed', lastError: 'No confident match' }),
    });
    await flush();
    const adding = component.addArtistToLidarr();
    await vi.advanceTimersByTimeAsync(2_000);
    await adding;
    expect(component.provisionError()).toBe('No confident match');
    expect(getArtistDiscography).toHaveBeenCalledTimes(1);
  });

  it('resumes the pending state when the job was already running on load', async () => {
    vi.useFakeTimers();
    const getArtistProvisioning = vi.fn(() => of(running));
    const { component } = setup('admin', undefined, true, {
      getArtistDiscography: () => of({ ...notProvisioned, provisioning: true }),
      getArtistProvisioning,
    });
    await flush();
    expect(component.provisioning()).toBe(true);
  });
});

// #1544: the header read "2 albums" beside "8 releases · 2 complete" — two
// unlabelled counts of different things.
describe('ArtistDetailComponent — header count names what it counts', () => {
  it('says the albums are the ones in your library', async () => {
    const { fixture } = setup('admin');
    await fixture_stable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="artist-album-count"]')?.textContent).toMatch(
      /\d+ albums? in your library/,
    );
  });
});

// #1770: the arrow lives in the shell's top bar; the page declares the target.
describe('ArtistDetailComponent — top-bar back target', () => {
  it('registers a back target that returns via history, falling back to the library', () => {
    setup();
    const pageBack = TestBed.inject(PageBackService);
    const navBack = vi
      .spyOn(TestBed.inject(NavigationService), 'back')
      .mockImplementation(() => {});

    expect(pageBack.hasTarget()).toBe(true);
    pageBack.back();
    expect(navBack).toHaveBeenCalledWith(['/library']);
  });
});

// #1855: the page fills a header gap (no bio fetched, no origin row, no portrait)
// with one completion call, then patches the header in place.
describe('ArtistDetailComponent — on-visit completion', () => {
  const COMPLETE = { metaExists: true, origin: { country: 'BR', source: 'musicbrainz' } };

  it('asks once for a missing origin and patches the header', async () => {
    serverArtistPatch = { metaExists: true, origin: null };
    const calls: string[] = [];
    completeArtistImpl = (id) => {
      calls.push(id);
      return of({
        filled: ['origin'],
        bio: null,
        urls: [],
        metaExists: true,
        origin: { country: 'BR', source: 'musicbrainz' },
        coverArt: 'ar1',
        coverRev: 0,
      });
    };
    const { component } = setup('admin');
    await flush();
    expect(calls).toEqual(['ar1']);
    expect(component.artist()?.origin?.country).toBe('BR');
  });

  it('does not ask when the header has nothing missing', async () => {
    serverArtistPatch = COMPLETE;
    const complete = vi.fn(() => EMPTY);
    completeArtistImpl = complete;
    setup('admin');
    await flush();
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not ask for a listener who cannot curate', async () => {
    serverArtistPatch = { metaExists: false, origin: null };
    const complete = vi.fn(() => EMPTY);
    completeArtistImpl = complete;
    setup('user');
    await flush();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('needsCompletion', () => {
  it('names each gap the completion can fill', () => {
    const full = { metaExists: true, origin: { country: 'AR' }, coverArt: 'x' };
    expect(needsCompletion(full)).toBe(false);
    expect(needsCompletion({ ...full, metaExists: false })).toBe(true);
    expect(needsCompletion({ ...full, origin: null })).toBe(true);
    expect(needsCompletion({ ...full, coverArt: undefined })).toBe(true);
  });
});

// #1855: the About block names where each header value came from.
describe('ArtistDetailComponent — value sources', () => {
  const COMPLETE = { metaExists: true, origin: { country: 'BR', source: 'musicbrainz' } };

  it('lists the recorded sources, country first, and only those', async () => {
    serverArtistPatch = {
      ...COMPLETE,
      sources: { bio: 'discogs', origin: 'musicbrainz', portrait: null },
    };
    const { component, fixture } = setup('admin');
    await flush();
    expect(component.sourceEntries()).toEqual([
      { field: 'origin', source: 'musicbrainz' },
      { field: 'bio', source: 'discogs' },
    ]);
    fixture.detectChanges();
    const line = fixture.nativeElement.querySelector('[data-testid="artist-sources"]');
    expect(line?.textContent).toContain('MusicBrainz');
    expect(line?.textContent).toContain('Discogs');
    expect(
      fixture.nativeElement.querySelector('[data-testid="artist-source-portrait"]'),
    ).toBeNull();
  });

  it('names the provider an automatic portrait came from (#1860)', async () => {
    serverArtistPatch = { ...COMPLETE, sources: { bio: null, origin: null, portrait: 'spotify' } };
    const { fixture } = setup('admin');
    await flush();
    fixture.detectChanges();
    const portrait = fixture.nativeElement.querySelector('[data-testid="artist-source-portrait"]');
    expect(portrait?.textContent).toContain('Spotify');
  });

  it("a curator's own country edit becomes the country's source", async () => {
    serverArtistPatch = {
      ...COMPLETE,
      sources: { bio: null, origin: 'musicbrainz', portrait: null },
    };
    const { component } = setup('admin');
    await flush();
    component.onOriginChanged({ country: 'AR', source: 'user' });
    expect(component.artist()?.sources?.origin).toBe('user');
    component.onOriginChanged({ country: null, source: 'user' });
    expect(component.artist()?.sources?.origin).toBeNull();
  });

  it('a bio update names no bio source rather than a stale one', async () => {
    serverArtistPatch = { ...COMPLETE, sources: { bio: 'discogs', origin: null, portrait: null } };
    const { component } = setup('admin');
    await flush();
    component.onArtistInfoUpdated({ bio: 'Edited', urls: [] });
    expect(component.artist()?.sources?.bio).toBeNull();
  });

  it('names a provider by its display name, and an unknown one as recorded', () => {
    expect(sourceName('musicbrainz')).toBe('MusicBrainz');
    expect(sourceName('somewhere')).toBe('somewhere');
  });
});
