import { of, throwError, type Observable } from 'rxjs';
import { TestBed, getTestBed } from '@angular/core/testing';
import { startsGroup } from '../lib/menu-groups';
import { Router } from '@angular/router';
import { SearchService } from './search.service';
import type {
  AlbumCompleteness,
  CompleteAlbumResponse,
  RelatedArtistsResponse,
} from './api/api-types';
import { ToastService } from './toast.service';
import { TranslateService } from './translate.service';
import {
  SongMenuService,
  songSelection,
  type SongContext,
  type SongSelection,
} from './song-menu.service';
import { PlayerService } from './player.service';
import { PlaylistService } from './playlist.service';
import { PreserveService } from './preserve.service';
import { AuthService } from './auth.service';
import { LibraryApiService } from './api/library-api.service';
import { TransferService } from './transfer.service';
import { TrackInfoService } from './track-info.service';
import { ConfirmService } from './confirm.service';
import { LikeService } from './like.service';
import { RecommendationExclusionsService } from './recommendation-exclusions.service';
import { ReportTrackService } from './report-track.service';
import { OfflineModeService } from './offline-mode.service';
import {
  asRole,
  canCurate as canCurateRole,
  canAcquire as canAcquireRole,
  type Role,
} from '../../types/core';
import type { BaseSong } from '../lib/track-utils';
import EN from '../../../public/i18n/en.json';
import ES from '../../../public/i18n/es.json';

const song = (over: Partial<BaseSong> = {}): BaseSong => ({
  id: 's1',
  title: 'Toxic',
  artist: 'Britney',
  ...over,
});

/** What the related-artists endpoint answers; a test swaps it before building a menu. */
let related: () => Observable<RelatedArtistsResponse> = () => of({ artists: [] });
/** What the completeness and complete-album endpoints answer. */
let completeness: () => Observable<AlbumCompleteness> = () =>
  of({ albumId: 'al1', confirmed: null });
let completed: () => Observable<CompleteAlbumResponse> = () =>
  of({ ok: true, outcome: 'enqueued', lidarrAlbumId: 1 } as CompleteAlbumResponse);

function setup(role: Role = 'user', excluded = false, acquisitionOn = true, identify = true) {
  const router = { navigate: vi.fn() };
  const auth = {
    role: () => role,
    canCurate: () => canCurateRole(asRole(role)),
    canAcquire: () => acquisitionOn && canAcquireRole(asRole(role)),
  };
  // Some tests call setup() twice within one `it` (comparing user vs admin) —
  // reset so the second TestBed.configureTestingModule doesn't error on an
  // already-instantiated module.
  getTestBed().resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      SongMenuService,
      PlayerService,
      { provide: Router, useValue: router },
      { provide: AuthService, useValue: auth },
      {
        provide: PlaylistService,
        useValue: {
          openPicker: vi.fn(),
          loaded: () => true,
          playlists: () => [{ id: 'p1', name: 'Road Trip', kind: 'user', modifiedAt: 1 }],
          addSongs: vi.fn(async () => {}),
          create: vi.fn(async () => {}),
        },
      },
      {
        provide: PreserveService,
        useValue: {
          isPreserved: () => false,
          isPreserving: () => false,
          preserveCollection: vi.fn(async () => {}),
        },
      },
      {
        provide: LibraryApiService,
        useValue: {
          deleteSongs: vi.fn(() => of({})),
          getIdentifyAvailable: vi.fn(() => of({ available: identify })),
          getRelatedArtists: vi.fn(() => related()),
          getAlbumCompleteness: vi.fn(() => completeness()),
          completeAlbum: vi.fn(() => completed()),
        },
      },
      { provide: ToastService, useValue: { show: vi.fn() } },
      {
        provide: TranslateService,
        useValue: {
          t: (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k),
        },
      },
      {
        provide: SearchService,
        useValue: { query: () => 'old', resetResults: vi.fn(), setQuery: vi.fn() },
      },
      { provide: TransferService, useValue: { addDeletedIds: vi.fn() } },
      { provide: TrackInfoService, useValue: { open: vi.fn() } },
      { provide: ConfirmService, useValue: { ask: vi.fn(async () => true) } },
      { provide: LikeService, useValue: { isLiked: () => false, toggle: vi.fn() } },
      {
        provide: RecommendationExclusionsService,
        useValue: { isExcluded: () => excluded, exclude: vi.fn(), restore: vi.fn() },
      },
      {
        provide: ReportTrackService,
        useValue: { open: vi.fn(), close: vi.fn() },
      },
    ],
  });
  return { svc: TestBed.inject(SongMenuService), router, auth };
}

const labels = (song: BaseSong, svc: SongMenuService, ctx = {}) =>
  svc.build(song, ctx).map((a) => a.label);

describe('SongMenuService.build', () => {
  it('emits the common actions in order when data allows (Like leads)', () => {
    const { svc } = setup();
    expect(labels(song({ artistId: 'ar1', albumId: 'al1' }), svc)).toEqual([
      'Like',
      'Add to queue',
      'Play next',
      'Start radio',
      'Go to artist',
      'Go to album',
      'Add to playlist',
      'Save offline',
      'Song info',
      "Don't recommend this",
      'Report this track',
      'Get more',
    ]);
  });

  // #2013: acquirers get a path from a song to more by its artist.
  describe('Get more', () => {
    const s = () =>
      song({ artistId: 'compound', artists: [{ id: 'one', name: 'One', role: 'primary' }] });
    const getMore = (svc: SongMenuService) =>
      svc.build(s(), {}).find((a) => a.label === 'Get more');

    it('is offered to a user and to a refiner, not to a listener', () => {
      expect(getMore(setup('user').svc)).toBeDefined();
      expect(getMore(setup('refiner').svc)).toBeDefined();
      expect(getMore(setup('listener').svc)).toBeUndefined();
    });

    it('is hidden when the server has acquisition switched off, whatever the role', () => {
      expect(getMore(setup('admin', false, false).svc)).toBeUndefined();
    });

    it('is hidden offline and for a song with no artist to go to', () => {
      const { svc } = setup('user');
      expect(svc.build(song({ albumId: 'al1' }), {}).some((a) => a.label === 'Get more')).toBe(
        false,
      );
      TestBed.inject(OfflineModeService).serverUnreachable.set(true);
      expect(getMore(svc)).toBeUndefined();
    });

    it("is hidden on the artist's own page, where it would lead nowhere new", () => {
      const { svc } = setup('user');
      expect(svc.build(s(), { hideGoToArtist: true }).some((a) => a.label === 'Get more')).toBe(
        false,
      );
    });

    // #2014: the album is confirmed incomplete, and this person may complete it.
    describe('Get the full album', () => {
      const partial = () =>
        song({
          artistId: 'ar1',
          albumId: 'al1',
          album: 'Circus',
          artists: [{ id: 'one', name: 'One', role: 'primary' }],
        });
      const entry = async (svc: SongMenuService, s = partial()) =>
        (await svc.build(s, {}).find((a) => a.label === 'Get more')!.children!()).find(
          (e) => e.label === 'Get the full album',
        );
      const incomplete = (missing: number) => () =>
        of({ albumId: 'al1', confirmed: { expected: 10, owned: 10 - missing, missing } });
      afterEach(() => {
        completeness = () => of({ albumId: 'al1', confirmed: null });
        completed = () =>
          of({ ok: true, outcome: 'enqueued', lidarrAlbumId: 1 } as CompleteAlbumResponse);
      });

      it('is offered to a curator when the album is confirmed incomplete, saying how many', async () => {
        completeness = incomplete(3);
        const found = await entry(setup('refiner').svc);
        expect(found).toMatchObject({ labelKey: 'song.getFullAlbum', labelParams: { missing: 3 } });
      });

      it('is left out when the album is complete', async () => {
        completeness = incomplete(0);
        expect(await entry(setup('refiner').svc)).toBeUndefined();
      });

      it('is left out when completeness is unknown', async () => {
        expect(await entry(setup('refiner').svc)).toBeUndefined();
      });

      it('is left out when the read fails, and the rest of the menu still opens', async () => {
        completeness = () => throwError(() => new Error('500'));
        const { svc } = setup('refiner');
        expect(await entry(svc)).toBeUndefined();
        const rows = await svc.build(partial(), {}).find((a) => a.label === 'Get more')!
          .children!();
        expect(rows.map((r) => r.label)).toContain('More by this artist');
      });

      it('is not asked for, nor shown to, a plain user: the server would refuse them', async () => {
        completeness = incomplete(3);
        const { svc } = setup('user');
        expect(await entry(svc)).toBeUndefined();
        const api = TestBed.inject(LibraryApiService) as unknown as {
          getAlbumCompleteness: ReturnType<typeof vi.fn>;
        };
        expect(api.getAlbumCompleteness).not.toHaveBeenCalled();
      });

      it('is left out for a song with no album', async () => {
        completeness = incomplete(3);
        const loose = song({
          artistId: 'ar1',
          artists: [{ id: 'one', name: 'One', role: 'primary' }],
        });
        expect(await entry(setup('refiner').svc, loose)).toBeUndefined();
      });

      it('confirms, starts the hunt, and toasts the outcome', async () => {
        completeness = incomplete(3);
        const { svc } = setup('refiner');
        (await entry(svc))!.action();
        const toast = TestBed.inject(ToastService).show as ReturnType<typeof vi.fn>;
        await vi.waitFor(() => expect(toast).toHaveBeenCalled());
        const ask = TestBed.inject(ConfirmService).ask as ReturnType<typeof vi.fn>;
        expect(ask.mock.calls[0]![0]).toContain('"album":"Circus"');
        expect(ask.mock.calls[0]![1]).toMatchObject({ destructive: false });
        const api = TestBed.inject(LibraryApiService) as unknown as {
          completeAlbum: ReturnType<typeof vi.fn>;
        };
        expect(api.completeAlbum).toHaveBeenCalledWith('al1');
        expect(toast).toHaveBeenCalledWith({
          kind: 'success',
          message: 'album.completeOutcome.enqueued',
        });
      });

      it('does nothing when the confirm is declined', async () => {
        completeness = incomplete(3);
        const { svc } = setup('refiner');
        (TestBed.inject(ConfirmService).ask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
          false,
        );
        (await entry(svc))!.action();
        await Promise.resolve();
        await Promise.resolve();
        const api = TestBed.inject(LibraryApiService) as unknown as {
          completeAlbum: ReturnType<typeof vi.fn>;
        };
        expect(api.completeAlbum).not.toHaveBeenCalled();
      });

      it("a source outage is an error toast carrying the addon's own detail", async () => {
        completeness = incomplete(3);
        completed = () =>
          of({
            ok: true,
            outcome: 'slskd-unavailable',
            detail: 'connection refused',
            lidarrAlbumId: 1,
          } as CompleteAlbumResponse);
        const { svc } = setup('refiner');
        (await entry(svc))!.action();
        const toast = TestBed.inject(ToastService).show as ReturnType<typeof vi.fn>;
        await vi.waitFor(() => expect(toast).toHaveBeenCalled());
        expect(toast.mock.calls[0]![0]).toEqual({
          kind: 'error',
          message: 'album.completeOutcome.slskd-unavailable — connection refused',
        });
      });

      it('a refused or failed request is one plain error toast', async () => {
        completeness = incomplete(3);
        completed = () => throwError(() => new Error('403'));
        const { svc } = setup('refiner');
        (await entry(svc))!.action();
        const toast = TestBed.inject(ToastService).show as ReturnType<typeof vi.fn>;
        await vi.waitFor(() => expect(toast).toHaveBeenCalled());
        expect(toast.mock.calls[0]![0]).toEqual({ kind: 'error', message: 'album.completeFailed' });
      });
    });

    // #2015: artists close to this one that the library does not have.
    describe('Similar artists', () => {
      const notOwned = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          mbid: `m${i}`,
          name: `Artist ${i}`,
          score: 1 - i / 10,
        }));
      const entries = async (svc: SongMenuService) =>
        (await getMore(svc)!.children!()).map((e) => e.label);
      afterEach(() => (related = () => of({ artists: [] })));

      it('is left out when the library has every related artist', async () => {
        expect(await entries(setup('user').svc)).toEqual(['More by this artist']);
      });

      it('is left out when no source knows the artist', async () => {
        related = () => of({ artists: [], notOwned: notOwned(2), reason: 'no-signal' as const });
        expect(await entries(setup('user').svc)).toEqual(['More by this artist']);
      });

      it('is left out when the lookup fails, and the rest of the menu still opens', async () => {
        related = () => throwError(() => new Error('502'));
        expect(await entries(setup('user').svc)).toEqual(['More by this artist']);
      });

      it('lists at most five, and picking one opens Get with the name prefilled', async () => {
        related = () => of({ artists: [], notOwned: notOwned(8) });
        const { svc, router } = setup('user');
        const similar = (await getMore(svc)!.children!()).find(
          (e) => e.label === 'Similar artists',
        )!;
        const names = await similar.children!();
        expect(names.map((n) => n.label)).toEqual([
          'Artist 0',
          'Artist 1',
          'Artist 2',
          'Artist 3',
          'Artist 4',
        ]);
        names[1]!.action();
        const search = TestBed.inject(SearchService);
        expect(search.resetResults).toHaveBeenCalled();
        expect(search.setQuery).toHaveBeenCalledWith('Artist 1');
        expect(router.navigate).toHaveBeenLastCalledWith(['/get'], { queryParams: { tab: 'add' } });
      });

      it('asks once per artist, for the primary credited one', async () => {
        related = () => of({ artists: [], notOwned: notOwned(1) });
        const { svc } = setup('user');
        await getMore(svc)!.children!();
        await getMore(svc)!.children!();
        const api = TestBed.inject(LibraryApiService) as unknown as {
          getRelatedArtists: ReturnType<typeof vi.fn>;
        };
        expect(api.getRelatedArtists).toHaveBeenCalledTimes(1);
        expect(api.getRelatedArtists).toHaveBeenCalledWith('one');
      });
    });

    it('opens a submenu whose first entry goes to the artist, named in its label', async () => {
      const { svc, router } = setup('user');
      const parent = getMore(svc)!;
      expect(parent.group).toBe('role');
      const [more] = await parent.children!();
      expect(more).toMatchObject({
        label: 'More by this artist',
        labelKey: 'song.moreByArtist',
        labelParams: { artist: 'One' },
      });
      more!.action();
      expect(router.navigate).toHaveBeenLastCalledWith(['/library', 'artists', 'one']);
    });
  });

  // #2006: a separator is drawn wherever the group changes.
  it('groups the menu Play, Go to, Keep, Info, Feedback, Role, Remove, with a page extra last', () => {
    const { svc } = setup('admin');
    const actions = svc.build(song({ artistId: 'ar1', albumId: 'al1' }), {
      onRemoveFromPlaylist: () => {},
      extraActions: [{ label: 'Page extra', action: () => {} }],
    });
    expect(actions.map((a) => a.group ?? null)).toEqual([
      'play',
      'play',
      'play',
      'play',
      'goto',
      'goto',
      'keep',
      'keep',
      'info',
      'feedback',
      'feedback',
      'role',
      'role',
      'remove',
      null,
    ]);
    const above = actions.filter((_, i) => startsGroup(actions, i)).map((a) => a.label);
    expect(above).toEqual([
      'Go to artist',
      'Add to playlist',
      'Song info',
      "Don't recommend this",
      'Get more',
      'Remove from playlist',
      'Page extra',
    ]);
  });

  it('labels the like action Unlike when already liked', () => {
    const router = { navigate: vi.fn() };
    getTestBed().resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        SongMenuService,
        PlayerService,
        { provide: Router, useValue: router },
        {
          provide: AuthService,
          useValue: { role: () => 'user', canCurate: () => false, canAcquire: () => false },
        },
        { provide: PlaylistService, useValue: { openPicker: vi.fn() } },
        {
          provide: PreserveService,
          useValue: { isPreserved: () => false, isPreserving: () => false },
        },
        {
          provide: LibraryApiService,
          useValue: { deleteSongs: vi.fn(() => ({ subscribe: vi.fn() })) },
        },
        { provide: TransferService, useValue: { addDeletedIds: vi.fn() } },
        { provide: TrackInfoService, useValue: { open: vi.fn() } },
        { provide: ConfirmService, useValue: { ask: vi.fn(async () => true) } },
        { provide: LikeService, useValue: { isLiked: () => true, toggle: vi.fn() } },
        {
          provide: ReportTrackService,
          useValue: { open: vi.fn(), close: vi.fn() },
        },
      ],
    });
    const svc = TestBed.inject(SongMenuService);
    expect(labels(song(), svc)).toContain('Unlike');
    expect(labels(song(), svc)).not.toContain('Like');
  });

  it('hides Go to album without albumId', () => {
    const { svc } = setup();
    expect(labels(song({ artistId: 'ar1' }), svc)).not.toContain('Go to album');
  });

  // #1751: offline the artist and album pages need the server; the menu opens
  // the saved songs filtered to the name instead of a dead page.
  it('offline, Go to artist / Go to album open the saved songs filtered by name', () => {
    const { svc, router } = setup();
    TestBed.inject(OfflineModeService).serverUnreachable.set(true);
    const actions = svc.build(
      song({
        artistId: 'compound',
        artists: [{ id: 'one', name: 'One', role: 'primary' }],
        albumId: 'al1',
        album: 'Circus',
      }),
      {},
    );
    actions.find((a) => a.label === 'Go to artist')!.action();
    expect(router.navigate).toHaveBeenLastCalledWith(['/library'], {
      queryParams: { find: 'One' },
    });
    actions.find((a) => a.label === 'Go to album')!.action();
    expect(router.navigate).toHaveBeenLastCalledWith(['/library'], {
      queryParams: { find: 'Circus' },
    });
  });

  it('sends Go to artist to the first credited artist, not a split compound', () => {
    const { svc, router } = setup();
    const actions = svc.build(
      song({
        artistId: 'compound',
        artists: [
          { id: 'one', name: 'One', role: 'primary' },
          { id: 'two', name: 'Two', role: 'primary' },
        ],
      }),
      {},
    );
    actions.find((a) => a.label === 'Go to artist')!.action();
    expect(router.navigate).toHaveBeenCalledWith(['/library', 'artists', 'one']);
  });

  // #2010: a joint or featured credit lists every artist.
  describe('Go to artist with several credits', () => {
    const joint = () =>
      song({
        artistId: 'compound',
        artists: [
          { id: 'feat', name: 'Guest', role: 'featuring' },
          { id: 'one', name: 'One', role: 'primary' },
          { id: 'two', name: 'Two', role: 'primary' },
        ],
      });
    const goTo = (svc: SongMenuService, s: BaseSong) =>
      svc.build(s, {}).find((a) => a.label === 'Go to artist')!;

    it('stays a plain item for one credit', () => {
      const { svc } = setup();
      const one = song({ artistId: 'a', artists: [{ id: 'a', name: 'Solo', role: 'primary' }] });
      expect(goTo(svc, one).children).toBeUndefined();
      expect(goTo(svc, song({ artistId: 'a' })).children).toBeUndefined();
    });

    it('opens a submenu with one entry per credit, primary artists first', async () => {
      const { svc, router } = setup();
      const entries = await goTo(svc, joint()).children!();
      expect(entries.map((e) => e.label)).toEqual(['One', 'Two', 'Guest']);
      entries[2]!.action();
      expect(router.navigate).toHaveBeenLastCalledWith(['/library', 'artists', 'feat']);
      entries[1]!.action();
      expect(router.navigate).toHaveBeenLastCalledWith(['/library', 'artists', 'two']);
    });

    it("offline, each entry opens the saved songs filtered by that artist's name", async () => {
      const { svc, router } = setup();
      TestBed.inject(OfflineModeService).serverUnreachable.set(true);
      const entries = await goTo(svc, joint()).children!();
      entries[2]!.action();
      expect(router.navigate).toHaveBeenLastCalledWith(['/library'], {
        queryParams: { find: 'Guest' },
      });
    });

    it('keeps two credits with one name apart', async () => {
      const { svc } = setup();
      const twins = song({
        artistId: 'c',
        artists: [
          { id: 'n1', name: 'Nirvana', role: 'primary' },
          { id: 'n2', name: 'Nirvana', role: 'primary' },
        ],
      });
      const entries = await goTo(svc, twins).children!();
      expect(entries.map((e) => e.label)).toEqual(['Nirvana', 'Nirvana (2)']);
    });
  });

  it('hides Go to artist without artistId', () => {
    const { svc } = setup();
    expect(labels(song({ albumId: 'al1' }), svc)).not.toContain('Go to artist');
  });

  it('respects hideGoToArtist / hideGoToAlbum', () => {
    const { svc } = setup();
    const out = labels(song({ artistId: 'ar1', albumId: 'al1' }), svc, {
      hideGoToArtist: true,
      hideGoToAlbum: true,
    });
    expect(out).not.toContain('Go to artist');
    expect(out).not.toContain('Go to album');
  });

  // #2017: a curator's song actions, one tap in, on every page.
  describe('Curate', () => {
    const curate = (svc: SongMenuService, ctx: SongContext = {}) =>
      svc.build(song({ id: 's9', title: 'Nine' }), ctx).find((a) => a.label === 'Curate');

    it('is offered to a refiner and an admin, not to a listener or a user', () => {
      expect(curate(setup('listener').svc)).toBeUndefined();
      expect(curate(setup('user').svc)).toBeUndefined();
      expect(curate(setup('refiner').svc)).toBeDefined();
      expect(curate(setup('admin').svc)!.group).toBe('role');
    });

    it('is hidden offline: every entry writes to the server', () => {
      const { svc } = setup('admin');
      TestBed.inject(OfflineModeService).serverUnreachable.set(true);
      expect(curate(svc)).toBeUndefined();
    });

    it('lists the four editors and Remove, on a page that passes no options', async () => {
      const entries = await curate(setup('refiner').svc)!.children!();
      expect(entries.map((e) => e.label)).toEqual([
        'Edit tags',
        'Fix artist credit',
        'Identify',
        'Set genre',
        'Remove from library',
      ]);
      expect(entries[4]).toMatchObject({ destructive: true, group: 'remove' });
    });

    it('leaves Identify out when the server cannot fingerprint', async () => {
      const entries = await curate(setup('refiner', false, true, false).svc)!.children!();
      expect(entries.map((e) => e.label)).not.toContain('Identify');
    });

    it('asks the server about Identify once, not per menu', async () => {
      const { svc } = setup('refiner');
      await curate(svc)!.children!();
      await curate(svc)!.children!();
      const api = TestBed.inject(LibraryApiService) as unknown as {
        getIdentifyAvailable: ReturnType<typeof vi.fn>;
      };
      expect(api.getIdentifyAvailable).toHaveBeenCalledTimes(1);
    });

    for (const [label, focus] of [
      ['Edit tags', 'tags'],
      ['Fix artist credit', 'artist'],
      ['Identify', 'identify'],
      ['Set genre', 'genre'],
    ] as const) {
      it(`${label} opens Song info at ${focus}`, async () => {
        const { svc } = setup('refiner');
        const entries = await curate(svc)!.children!();
        entries.find((e) => e.label === label)!.action();
        expect(TestBed.inject(TrackInfoService).open).toHaveBeenCalledWith(
          expect.objectContaining({ songId: 's9' }),
          { focus },
        );
      });
    }

    it('Remove from library confirms, deletes and marks the song deleted', async () => {
      const { svc } = setup('admin');
      const entries = await curate(svc)!.children!();
      entries.find((e) => e.label === 'Remove from library')!.action();
      await vi.waitFor(() =>
        expect(TestBed.inject(TransferService).addDeletedIds).toHaveBeenCalledWith(['s9']),
      );
      expect(TestBed.inject(ConfirmService).ask).toHaveBeenCalled();
    });
  });

  it('appends onRemoveFromPlaylist and extraActions last', () => {
    const { svc } = setup();
    const out = labels(song(), svc, {
      onRemoveFromPlaylist: () => {},
      extraActions: [{ label: 'X', action: () => {} }],
    });
    expect(out.slice(-2)).toEqual(['Remove from playlist', 'X']);
  });
});

describe("SongMenuService.build — Don't recommend this", () => {
  it('offers the veto after Song info and flips to Recommend again once excluded', () => {
    expect(labels(song(), setup().svc)).toContain("Don't recommend this");
    const out = labels(song(), setup('user', true).svc);
    expect(out).toContain('Recommend again');
    expect(out).not.toContain("Don't recommend this");
  });

  it('wires the two actions to the exclusions service', () => {
    const { svc } = setup();
    const svcMock = TestBed.inject(RecommendationExclusionsService) as unknown as {
      exclude: ReturnType<typeof vi.fn>;
    };
    svc
      .build(song())
      .find((a) => a.label === "Don't recommend this")!
      .action();
    expect(svcMock.exclude).toHaveBeenCalledWith('s1');
  });
});

describe('SongMenuService.build — Report this track', () => {
  it('offers the report beside the veto, translated through report.menuItem', () => {
    const { svc } = setup();
    const action = svc.build(song()).find((a) => a.label === 'Report this track')!;
    // The testid the e2e suite selects on is built from `label`, so it must
    // stay untranslated even though the item renders through `labelKey`.
    expect(action.labelKey).toBe('report.menuItem');
    expect(action.destructive).toBeUndefined();
  });

  it('opens the shared report dialog for this song', () => {
    const { svc } = setup();
    const report = TestBed.inject(ReportTrackService) as unknown as {
      open: ReturnType<typeof vi.fn>;
    };
    svc
      .build(song())
      .find((a) => a.label === 'Report this track')!
      .action();
    expect(report.open).toHaveBeenCalledWith('s1');
  });

  it('stays ahead of the contextual actions appended last', () => {
    const { svc } = setup();
    const out = labels(song(), svc, {
      onRemoveFromPlaylist: () => {},
      extraActions: [{ label: 'X', action: () => {} }],
    });
    expect(out.slice(-2)).toEqual(['Remove from playlist', 'X']);
    expect(out).toContain('Report this track');
  });
});

// #1714: the owner's Spanish UI showed eight of the ten items in English — only
// the two that already carried a key were translated. Every item must render
// through a key both catalogs carry; `label` stays English for the testid.
describe('SongMenuService.build — every item is translated', () => {
  const en = EN as Record<string, string>;
  const es = ES as Record<string, string>;

  async function everyAction(liked: boolean, excluded: boolean) {
    const { svc } = setup('admin', excluded);
    const likes = TestBed.inject(LikeService) as unknown as { isLiked: () => boolean };
    likes.isLiked = () => liked;
    const top = svc.build(song({ artistId: 'ar1', albumId: 'al1' }), {
      onRemoveFromPlaylist: () => {},
    });
    // Curate and Get more carry their own items; playlists and artists are names.
    const nested = await Promise.all(
      top.filter((a) => a.label === 'Curate' || a.label === 'Get more').map((a) => a.children!()),
    );
    return [...top, ...nested.flat()];
  }

  for (const [liked, excluded] of [
    [false, false],
    [true, true],
  ] as const) {
    it(`carries a key in en and es for every item (liked=${liked}, excluded=${excluded})`, async () => {
      for (const action of await everyAction(liked, excluded)) {
        expect(action.labelKey, `${action.label} has no labelKey`).toBeTruthy();
        expect(en[action.labelKey!], `${action.labelKey} missing from en.json`).toBeTruthy();
        expect(es[action.labelKey!], `${action.labelKey} missing from es.json`).toBeTruthy();
      }
    });
  }

  it('keeps the English label as the stable identity (the e2e testid suffix)', async () => {
    const labelsByKey = Object.fromEntries(
      (await everyAction(false, false)).map((a) => [a.labelKey, a.label]),
    );
    expect(labelsByKey['song.addToQueue']).toBe('Add to queue');
    expect(en['song.addToQueue']).toBe('Add to queue');
    expect(es['song.addToQueue']).toBe('Añadir a la cola');
  });
});

// #2012: with several songs selected, the menu acts on all of them.
describe('SongMenuService.buildMany', () => {
  const songs = [
    song({ id: 'a', title: 'A' }),
    song({ id: 'b', title: 'B' }),
    song({ id: 'c', title: 'C' }),
  ];
  function selection(picked = ['a', 'c']) {
    const exit = vi.fn();
    const state = {
      count: () => picked.length,
      isSelected: (id: string) => picked.includes(id),
      exit,
    };
    return {
      sel: songSelection(
        state,
        () => songs,
        (s) => s,
      ),
      exit,
    };
  }
  const run = (svc: SongMenuService, sel: SongSelection, label: string) =>
    svc.buildMany(sel).find((a) => a.label === label)!;

  it('offers only what makes sense in bulk', () => {
    const { sel } = selection();
    expect(
      setup('user')
        .svc.buildMany(sel)
        .map((a) => a.label),
    ).toEqual([
      'Play next',
      'Add to queue',
      'Like all',
      'Add to playlist',
      'Save offline',
      "Don't recommend these",
    ]);
    expect(setup('refiner').svc.buildMany(sel).at(-1)).toMatchObject({
      label: 'Remove from library',
      destructive: true,
    });
  });

  it('offline, keeps only what the player can do alone', () => {
    const { svc } = setup('admin');
    TestBed.inject(OfflineModeService).serverUnreachable.set(true);
    expect(svc.buildMany(selection().sel).map((a) => a.label)).toEqual([
      'Play next',
      'Add to queue',
    ]);
  });

  it('reads the selection when an action runs, not when the menu is built', () => {
    const picked = ['a'];
    const state = {
      count: () => picked.length,
      isSelected: (id: string) => picked.includes(id),
      exit: vi.fn(),
    };
    const { svc } = setup('user');
    const player = TestBed.inject(PlayerService);
    const add = vi.spyOn(player, 'addToQueue').mockImplementation(() => {});
    const action = run(
      svc,
      songSelection(
        state,
        () => songs,
        (s) => s,
      ),
      'Add to queue',
    );
    picked.push('b');
    action.action();
    expect(add.mock.calls.map(([t]) => t.id)).toEqual(['a', 'b']);
  });

  it('Play next queues the selection so it plays in its own order', () => {
    const { sel, exit } = selection(['a', 'b', 'c']);
    const { svc } = setup('user');
    const next = vi.spyOn(TestBed.inject(PlayerService), 'queueNext').mockImplementation(() => {});
    run(svc, sel, 'Play next').action();
    // Each lands right after the current track, so the last goes in first.
    expect(next.mock.calls.map(([t]) => t.id)).toEqual(['c', 'b', 'a']);
    expect(exit).toHaveBeenCalled();
  });

  it('Like all likes the ones not liked yet, and unlikes nothing', () => {
    const { sel, exit } = selection();
    const { svc } = setup('user');
    const likes = TestBed.inject(LikeService) as unknown as {
      isLiked: (id: string) => boolean;
      toggle: ReturnType<typeof vi.fn>;
    };
    likes.isLiked = (id) => id === 'a';
    run(svc, sel, 'Like all').action();
    expect(likes.toggle.mock.calls).toEqual([['c']]);
    expect(exit).toHaveBeenCalled();
  });

  it('Add to playlist adds every selected song to the picked playlist', async () => {
    const { sel, exit } = selection();
    const { svc } = setup('user');
    const rows = await run(svc, sel, 'Add to playlist').children!();
    rows.find((r) => r.label === 'Road Trip')!.action();
    expect(TestBed.inject(PlaylistService).addSongs).toHaveBeenCalledWith('p1', ['a', 'c']);
    expect(exit).toHaveBeenCalled();
  });

  it('Add to playlist creates a playlist holding the whole selection', async () => {
    const { sel } = selection();
    const { svc } = setup('user');
    const rows = await run(svc, sel, 'Add to playlist').children!();
    rows.find((r) => r.label === 'New playlist')!.field!.submit!('Sunday');
    expect(TestBed.inject(PlaylistService).create).toHaveBeenCalledWith('Sunday', ['a', 'c']);
  });

  it('Save offline saves the selection as one collection', () => {
    const { sel } = selection();
    const { svc } = setup('user');
    run(svc, sel, 'Save offline').action();
    const [, , tracks] = (
      TestBed.inject(PreserveService).preserveCollection as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    expect((tracks as { id: string }[]).map((t) => t.id)).toEqual(['a', 'c']);
  });

  it("Don't recommend these vetoes each song once", () => {
    const { sel } = selection();
    const { svc } = setup('user');
    run(svc, sel, "Don't recommend these").action();
    expect(
      (TestBed.inject(RecommendationExclusionsService).exclude as ReturnType<typeof vi.fn>).mock
        .calls,
    ).toEqual([['a'], ['c']]);
  });

  it('Remove from library asks once for the whole selection, then deletes it', async () => {
    const { sel, exit } = selection();
    const { svc } = setup('admin');
    run(svc, sel, 'Remove from library').action();
    await vi.waitFor(() =>
      expect(TestBed.inject(TransferService).addDeletedIds).toHaveBeenCalledWith(['a', 'c']),
    );
    const ask = TestBed.inject(ConfirmService).ask as ReturnType<typeof vi.fn>;
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toContain('2 songs');
    expect(exit).toHaveBeenCalled();
  });

  it('Remove from library keeps the selection when the confirm is declined', async () => {
    const { sel, exit } = selection();
    const { svc } = setup('admin');
    (TestBed.inject(ConfirmService).ask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    run(svc, sel, 'Remove from library').action();
    await Promise.resolve();
    await Promise.resolve();
    expect(TestBed.inject(TransferService).addDeletedIds).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('carries a key in en and es for every bulk item', async () => {
    const en = (await import('../../../public/i18n/en.json')).default as Record<string, string>;
    const es = (await import('../../../public/i18n/es.json')).default as Record<string, string>;
    for (const action of setup('admin').svc.buildMany(selection().sel)) {
      expect(en[action.labelKey!], `${action.label} missing from en.json`).toBeTruthy();
      expect(es[action.labelKey!], `${action.label} missing from es.json`).toBeTruthy();
    }
    expect(en['song.selectionCount']).toContain('{count}');
    expect(es['song.selectionCount']).toContain('{count}');
  });

  describe('forRow', () => {
    it('gives a selected row the bulk menu once more than one song is selected', () => {
      const { svc } = setup('user');
      const labels = (id: string, picked: string[]) =>
        svc.forRow(song({ id }), {}, selection(picked).sel).map((a) => a.label);
      expect(labels('a', ['a', 'c'])).toContain('Like all');
      // An unselected row keeps its own menu, and so does a lone selected one.
      expect(labels('b', ['a', 'c'])).toContain('Song info');
      expect(labels('a', ['a'])).toContain('Song info');
      expect(svc.forRow(song({ id: 'a' }), {}).map((a) => a.label)).toContain('Song info');
    });
  });
});
