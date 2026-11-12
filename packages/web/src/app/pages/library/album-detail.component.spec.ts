import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { AlbumDetailComponent } from './album-detail.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { AlbumDetail } from '../../services/api/api-types';
import type { Track } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { PlaylistService } from '../../services/playlist.service';
import { ListControlsService } from '../../services/list-controls.service';
import { TransferService } from '../../services/transfer.service';
import { PullToRefreshService } from '../../services/pull-to-refresh.service';
import { LibraryEventsService } from '../../services/library-events.service';
import { PageBackService } from '../../services/page-back.service';
import { NavigationService } from '../../services/navigation.service';
import { resolveArtistRoute } from '../../lib/route-utils';

const ALBUM: AlbumDetail = {
  id: 'a1',
  name: 'Natiruts',
  artist: 'Natiruts',
  artistId: 'ar1',
  song: [
    { id: 's1', title: 'One', artist: 'Natiruts' },
    { id: 's2', title: 'Two', artist: 'Natiruts' },
    { id: 's3', title: 'Three', artist: 'Natiruts' },
  ],
} as unknown as AlbumDetail;

function setup(
  opts: {
    deleteSongs?: ReturnType<typeof vi.fn>;
    optimizeAlbumMetadata?: ReturnType<typeof vi.fn>;
    albumGenreDistribution?: ReturnType<typeof vi.fn>;
    role?: string;
  } = {},
) {
  const searchText = signal('');
  const sortField = signal('track');
  const sortDirection = signal<'asc' | 'desc'>('asc');
  const deleteSongs = opts.deleteSongs ?? vi.fn(() => of({ ok: true, deletedCount: 0 }));
  const playWithContext = vi.fn();
  const playSingle = vi.fn();
  const optimizeAlbumMetadata =
    opts.optimizeAlbumMetadata ??
    vi.fn(() =>
      of({ matched: true, coverUpdated: true, yearUpdated: true, releaseTypeUpdated: false }),
    );
  const getAlbumCalls: string[] = [];
  const getAlbum = vi.fn((id: string) => {
    getAlbumCalls.push(id);
    return of(ALBUM);
  });

  let registeredHandler: (() => Promise<void> | void) | null = null;
  const p2rStub = {
    register: (h: () => Promise<void> | void) => {
      registeredHandler = h;
    },
    refreshing: signal(false),
    hasHandler: signal(true),
    trigger: vi.fn(),
  };

  TestBed.configureTestingModule({
    imports: [AlbumDetailComponent],
    providers: [
      provideRouter([]),
      { provide: PullToRefreshService, useValue: p2rStub },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'a1' } } } },
      {
        provide: LibraryApiService,
        useValue: {
          getAlbum,
          deleteSongs,
          optimizeAlbumMetadata,
          albumGenreDistribution: opts.albumGenreDistribution,
        },
      },
      {
        provide: AuthService,
        useValue: { token: signal('tok'), mediaToken: signal('tok'), role: () => 'admin' },
      },
      { provide: PlayerService, useValue: { play: () => {}, playWithContext, playSingle } },
      { provide: PlaylistService, useValue: { openPicker: vi.fn() } },
      // The list-controls connect() result is only read through the (unrendered)
      // template here; a minimal stub keeps construction cheap.
      {
        provide: ListControlsService,
        useValue: {
          connect: () => ({ filtered: () => ALBUM.song, searchText, sortField, sortDirection }),
        },
      },
      { provide: HttpClient, useValue: {} },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  // No detectChanges(): we drive the delete handler directly rather than render
  // the toolbar-heavy template.
  const fixture = TestBed.createComponent(AlbumDetailComponent);
  return {
    component: fixture.componentInstance,
    deleteSongs,
    optimizeAlbumMetadata,
    playWithContext,
    playSingle,
    getAlbum,
    getAlbumCalls,
    getRegisteredHandler: () => registeredHandler,
    searchText,
    sortField,
    sortDirection,
  };
}

describe('AlbumDetailComponent — bulk delete', () => {
  it('deletes the selected songs, prunes the album, and exits select mode', async () => {
    const deleteSongs = vi.fn(() => of({ ok: true, deletedCount: 2 }));
    const { component } = setup({ deleteSongs });
    component.selectedAlbum.set(ALBUM);

    component.selection.enter();
    component.selection.toggle('s1');
    component.selection.toggle('s3');
    component.deleteSelectedSongs();
    await component.confirmCallback()!();

    expect(deleteSongs).toHaveBeenCalledWith(['s1', 's3']);
    expect(component.selectedAlbum()?.song.map((s) => s.id)).toEqual(['s2']);
    expect(component.selection.active()).toBe(false);
    expect(component.deleteError()).toBeNull();
  });

  it('reports a partial failure when not all songs were removed', async () => {
    const deleteSongs = vi.fn(() => of({ ok: true, deletedCount: 1 }));
    const { component } = setup({ deleteSongs });
    component.selectedAlbum.set(ALBUM);

    component.selection.enter();
    component.selection.toggle('s1');
    component.selection.toggle('s2');
    component.deleteSelectedSongs();
    await component.confirmCallback()!();

    expect(component.deleteError()).toContain('1 of 2');
  });
});

describe('AlbumDetailComponent — toTrackFromSong stamps the page album onto the queue track', () => {
  it('carries the album id and artist id so the queue and Now Playing can link them', () => {
    const { component } = setup();
    component.selectedAlbum.set(ALBUM);
    const track = component.toTrackFromSong({ id: 's1', title: 'One', artist: 'Natiruts' });
    expect(track.album).toBe('Natiruts');
    expect(track.albumId).toBe('a1');
    expect(track.artistId).toBe('ar1');
  });

  it('prefers the song’s own ids when it has them', () => {
    const { component } = setup();
    component.selectedAlbum.set(ALBUM);
    const track = component.toTrackFromSong({
      id: 's1',
      title: 'One',
      artist: 'Guest',
      artistId: 'ar-guest',
      albumId: 'a-other',
    });
    expect(track.albumId).toBe('a-other');
    expect(track.artistId).toBe('ar-guest');
  });

  it('the album Play button queues tracks that carry the album id (the e2e queue-link contract)', () => {
    const { component, playWithContext } = setup();
    component.selectedAlbum.set(ALBUM);
    component.playAlbum();
    const [tracks] = playWithContext.mock.calls[0] as [Track[]];
    expect(tracks.map((t) => t.albumId)).toEqual(['a1', 'a1', 'a1']);
    expect(tracks[0]!.album).toBe('Natiruts');
  });
});

describe('AlbumDetailComponent — playSong queue semantics (issue #233)', () => {
  it('plays a clicked track through playWithContext so the album replaces the stale queue', () => {
    const { component, playWithContext, playSingle } = setup();
    component.selectedAlbum.set(ALBUM);

    component.playSong({ id: 's2', title: 'Two', artist: 'Natiruts' });

    expect(playSingle).not.toHaveBeenCalled();
    const [tracks, index, context] = playWithContext.mock.calls[0];
    expect(tracks.map((t: { id: string }) => t.id)).toEqual(['s1', 's2', 's3']);
    expect(index).toBe(1);
    expect(context).toEqual({ type: 'album', id: 'a1', name: 'Natiruts' });
  });

  it('falls back to playSingle when the clicked track is not in the album', () => {
    const { component, playWithContext, playSingle } = setup();
    component.selectedAlbum.set(ALBUM);

    component.playSong({ id: 'orphan', title: 'Orphan', artist: 'Natiruts' });

    expect(playWithContext).not.toHaveBeenCalled();
    expect(playSingle).toHaveBeenCalledWith(expect.objectContaining({ id: 'orphan' }));
  });

  it('falls back to playSingle when no album is loaded', () => {
    const { component, playWithContext, playSingle } = setup();

    component.playSong({ id: 's1', title: 'One', artist: 'Natiruts' });

    expect(playWithContext).not.toHaveBeenCalled();
    expect(playSingle).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
  });
});

describe('AlbumDetailComponent — deletedSongIds filter', () => {
  it('drops a row whose id is marked deleted elsewhere in the app', () => {
    const { component } = setup();
    component.selectedAlbum.set(ALBUM);
    expect(component.detailSongs().map((s) => s.id)).toEqual(['s1', 's2', 's3']);

    TestBed.inject(TransferService).deletedSongIds.set(new Set(['s2']));

    expect(component.detailSongs().map((s) => s.id)).toEqual(['s1', 's3']);
  });
});

describe('AlbumDetailComponent — fix metadata', () => {
  it('opens the fix modal only when an album is loaded', () => {
    const { component } = setup();
    component.openMetadataFix();
    expect(component.showMetadataFix()).toBe(false);

    component.selectedAlbum.set(ALBUM);
    component.openMetadataFix();
    expect(component.showMetadataFix()).toBe(true);
  });

  it('re-fetches in place, and the cover follows the refetched rev', async () => {
    const { component, getAlbum } = setup();
    component.selectedAlbum.set({ ...ALBUM, coverArt: 'a1' });
    component.showMetadataFix.set(true);
    getAlbum.mockReturnValueOnce(of({ ...ALBUM, coverArt: 'a1', coverRev: 2 }));

    await component.onMetadataApplied({ albumId: 'a1' });

    expect(component.showMetadataFix()).toBe(false);
    expect(component.coverSrc()).toContain('&v=2&');
    expect(component.selectedAlbum()?.id).toBe('a1');
  });

  it("the cover URL follows the album's cover rev: DTO, then a pushed change (#1666)", () => {
    const { component } = setup();
    const events = TestBed.inject(LibraryEventsService);
    component.selectedAlbum.set({ ...ALBUM, coverArt: 'a1', coverRev: 0 });
    expect(component.coverSrc()).toBe('/api/cover/a1?size=300&token=tok');
    component.selectedAlbum.set({ ...ALBUM, coverArt: 'a1', coverRev: 3 });
    expect(component.coverSrc()).toBe('/api/cover/a1?size=300&v=3&token=tok');
    events.apply({ type: 'artwork.changed', changes: [{ kind: 'album', id: 'a1', rev: 4 }] }, 1);
    expect(component.coverSrc()).toBe('/api/cover/a1?size=300&v=4&token=tok');
  });

  it('a cover-only change re-keys the hero from the refetched DTO (#1666)', async () => {
    const { component, getAlbum } = setup();
    component.selectedAlbum.set({ ...ALBUM, coverArt: 'a1', coverRev: 1 });
    const before = component.coverSrc();
    getAlbum.mockReturnValueOnce(of({ ...ALBUM, coverArt: 'a1', coverRev: 2 }));
    await component.onCoverChanged();
    expect(component.coverSrc()).not.toBe(before);
    expect(component.coverSrc()).toContain('&v=2&');
  });

  it('navigates to the new album when a correction changes its id', async () => {
    const { component } = setup();
    const navigate = vi
      .spyOn(
        (component as unknown as { router: { navigate: (c: unknown[]) => Promise<boolean> } })
          .router,
        'navigate',
      )
      .mockResolvedValue(true);
    component.selectedAlbum.set(ALBUM);

    await component.onMetadataApplied({ albumId: 'a2-new' });

    expect(navigate).toHaveBeenCalledWith(['/library', 'albums', 'a2-new']);
    expect(component.showMetadataFix()).toBe(false);
  });
});

describe('AlbumDetailComponent — pull-to-refresh', () => {
  it('re-fetches the album from the route id', async () => {
    const { getAlbumCalls, getRegisteredHandler } = setup();
    getAlbumCalls.length = 0;

    const handler = getRegisteredHandler();
    expect(handler).toBeTruthy();
    await handler!();

    expect(getAlbumCalls).toEqual(['a1']);
  });
});

/**
 * Issue #747. A two-disc album is ONE album row whose songs carry `disc`, so
 * without a header the page shows two rows both labelled "1" with nothing to
 * separate them.
 */
describe('AlbumDetailComponent — disc headers', () => {
  const SONGS = [
    { id: 'd1t1', title: 'Intro', artist: 'A', disc: 1, track: 1 },
    { id: 'd1t2', title: 'Output', artist: 'A', disc: 1, track: 2 },
    { id: 'd2t1', title: 'Intro', artist: 'A', disc: 2, track: 1 },
  ];

  function make(songs: unknown[], sortField = 'track') {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AlbumDetailComponent],
      providers: [
        provideRouter([]),
        {
          provide: PullToRefreshService,
          useValue: { register: () => {}, refreshing: signal(false), hasHandler: signal(true) },
        },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'a1' } } } },
        { provide: LibraryApiService, useValue: { getAlbum: () => of({ song: songs }) } },
        {
          provide: AuthService,
          useValue: { token: signal('tok'), mediaToken: signal('tok'), role: () => 'admin' },
        },
        { provide: PlayerService, useValue: { play: () => {} } },
        { provide: PlaylistService, useValue: { openPicker: vi.fn() } },
        {
          provide: ListControlsService,
          useValue: { connect: () => ({ filtered: () => songs, sortField: () => sortField }) },
        },
        { provide: HttpClient, useValue: {} },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });
    return TestBed.createComponent(AlbumDetailComponent).componentInstance;
  }

  it('marks the first row of each disc', () => {
    const headers = make(SONGS).discHeaders();
    expect([...headers.entries()]).toEqual([
      ['d1t1', 1],
      ['d2t1', 2],
    ]);
  });

  it('renders no header on a single-disc album', () => {
    // Every existing album is single-disc; a "Disc 1" label on all of them
    // would be pure noise.
    expect(make([SONGS[0], SONGS[1]]).discHeaders().size).toBe(0);
  });

  it('renders no header under a sort that interleaves the discs', () => {
    // Headers mark disc BOUNDARIES. Sorted by title there are none to mark.
    expect(make(SONGS, 'title').discHeaders().size).toBe(0);
  });
});

// #1770: the arrow lives in the shell's top bar; the page only declares where
// "back" goes, keeping its history-then-artist behaviour.
describe('AlbumDetailComponent — top-bar back target', () => {
  it('registers a back target that returns via history, falling back to the artist', () => {
    const { component } = setup();
    component.selectedAlbum.set(ALBUM);
    const pageBack = TestBed.inject(PageBackService);
    const navBack = vi
      .spyOn(TestBed.inject(NavigationService), 'back')
      .mockImplementation(() => {});

    expect(pageBack.hasTarget()).toBe(true);
    pageBack.back();
    expect(navBack).toHaveBeenCalledWith(resolveArtistRoute('ar1'));
  });
});

describe('AlbumDetailComponent — header menu', () => {
  it('offers the queue verbs then Select, and nothing destructive', () => {
    const { component } = setup();
    component.selectedAlbum.set(ALBUM);
    expect(component.albumMenu().map((a) => a.label)).toEqual([
      'Start radio',
      'Play next',
      'Add to queue',
      'Select',
    ]);
    expect(component.albumMenu().some((a) => a.destructive)).toBe(false);
  });

  it('Select enters selection mode and then leaves the menu', () => {
    const { component } = setup();
    component.selectedAlbum.set(ALBUM);
    component
      .albumMenu()
      .find((a) => a.label === 'Select')!
      .action();
    expect(component.selection.active()).toBe(true);
    expect(component.albumMenu().map((a) => a.label)).not.toContain('Select');
  });

  it('is empty until an album is loaded', () => {
    const { component } = setup();
    expect(component.albumMenu()).toEqual([]);
  });

  it('puts the destructive curator action last', () => {
    const { component } = setup();
    component.selectedAlbum.set(ALBUM);
    const curator = component.curatorMenu();
    expect(curator.map((a) => a.label)).toEqual(['Fix metadata', 'Remove album']);
    expect(curator.map((a) => !!a.destructive)).toEqual([false, true]);
    curator[0].action();
    expect(component.showMetadataFix()).toBe(true);
    curator[1].action();
    expect(component.showConfirm()).toBe(true);
  });
});

describe('AlbumDetailComponent — filter row toggle', () => {
  it('is closed by default and follows the toggle', () => {
    const { component } = setup();
    expect(component.controlsOpen()).toBe(false);
    component.toggleControls();
    expect(component.controlsOpen()).toBe(true);
    component.toggleControls();
    expect(component.controlsOpen()).toBe(false);
  });

  it('opens itself for a persisted search or order, until the user closes it', () => {
    const { component, searchText, sortField, sortDirection } = setup();
    sortField.set('title');
    expect(component.filterActive()).toBe(true);
    expect(component.controlsOpen()).toBe(true);

    sortField.set('track');
    sortDirection.set('desc');
    expect(component.controlsOpen()).toBe(true);

    sortDirection.set('asc');
    searchText.set('one');
    expect(component.controlsOpen()).toBe(true);

    // Closed by hand: the filter stays active (the toggle shows its dot), the row stays shut.
    component.toggleControls();
    expect(component.controlsOpen()).toBe(false);
    expect(component.filterActive()).toBe(true);
  });
});

describe('AlbumDetailComponent — genre chip', () => {
  const distribution = (slices: Array<{ genre: string; count: number; weight: number }>) =>
    vi.fn(() =>
      of({
        album: 'Natiruts',
        trackCount: 3,
        genreCount: slices.length,
        // The overlapping weights the page must not read.
        slices: [{ genre: 'Pop', count: 3, weight: 1 }],
        primary: { taggedCount: 3, slices },
      }),
    );

  it('headlines the primary share, collapsed, and marks the folded tail as a bucket', async () => {
    const { component } = setup({
      albumGenreDistribution: distribution([
        { genre: 'Reggae', count: 2, weight: 0.67 },
        { genre: 'Other', count: 1, weight: 0.33 },
      ]),
    });
    await component.ngOnInit();
    await Promise.resolve();
    expect(component.headline()).toEqual({ kind: 'single', genres: ['Reggae'] });
    expect(component.genresOpen()).toBe(false);
    expect(component.genreShare()).toEqual({
      taggedCount: 3,
      slices: [
        { genre: 'Reggae', count: 2, weight: 0.67 },
        { genre: 'Other', count: 1, weight: 0.33, kind: 'other' },
      ],
    });
  });

  it('shows no chip for an untagged album or a failed read', async () => {
    const empty = setup({ albumGenreDistribution: distribution([]) });
    await empty.component.ngOnInit();
    await Promise.resolve();
    expect(empty.component.headline()).toBeNull();

    TestBed.resetTestingModule();
    const failed = setup({
      albumGenreDistribution: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    await failed.component.ngOnInit();
    await Promise.resolve();
    expect(failed.component.headline()).toBeNull();
  });
});
