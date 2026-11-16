import { of } from 'rxjs';
import { TestBed, getTestBed } from '@angular/core/testing';
import { startsGroup } from '../lib/menu-groups';
import { Router } from '@angular/router';
import { SongMenuService, type SongContext } from './song-menu.service';
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
      { provide: PlaylistService, useValue: { openPicker: vi.fn() } },
      {
        provide: PreserveService,
        useValue: { isPreserved: () => false, isPreserving: () => false },
      },
      {
        provide: LibraryApiService,
        useValue: {
          deleteSongs: vi.fn(() => of({})),
          getIdentifyAvailable: vi.fn(() => of({ available: identify })),
        },
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
