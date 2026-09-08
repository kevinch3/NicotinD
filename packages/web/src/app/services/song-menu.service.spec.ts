import { TestBed, getTestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { SongMenuService } from './song-menu.service';
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
import { asRole, canCurate as canCurateRole, type Role } from '../../types/core';
import type { BaseSong } from '../lib/track-utils';

const song = (over: Partial<BaseSong> = {}): BaseSong => ({
  id: 's1',
  title: 'Toxic',
  artist: 'Britney',
  ...over,
});

function setup(role: Role = 'user', excluded = false) {
  const router = { navigate: vi.fn() };
  const auth = { role: () => role, canCurate: () => canCurateRole(asRole(role)) };
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
        useValue: { deleteSongs: vi.fn(() => ({ subscribe: vi.fn() })) },
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
        { provide: AuthService, useValue: { role: () => 'user', canCurate: () => false } },
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

  it('adds Remove from library only for curators (refiner/admin) + removable', () => {
    expect(labels(song(), setup('listener').svc, { removable: true })).not.toContain(
      'Remove from library',
    );
    expect(labels(song(), setup('user').svc, { removable: true })).not.toContain(
      'Remove from library',
    );
    expect(labels(song(), setup('refiner').svc, { removable: true })).toContain(
      'Remove from library',
    );
    expect(labels(song(), setup('admin').svc, { removable: true })).toContain(
      'Remove from library',
    );
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
