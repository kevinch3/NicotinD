import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter, ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, BehaviorSubject } from 'rxjs';
import { vi } from 'vitest';
import { ArtistDetailComponent } from './artist-detail.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { AuthService } from '../../services/auth.service';
import { asRole, canCurate as canCurateRole } from '../../../types/core';
import { PlayerService } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';

const ARTIST = { id: 'ar1', name: 'Natiruts', albumCount: 2, coverArt: 'ar1' };
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

function setup(role = 'admin', deleteSongs = vi.fn(() => of({ ok: true, deletedCount: 0 }))) {
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

  TestBed.configureTestingModule({
    imports: [ArtistDetailComponent],
    providers: [
      provideRouter([]),
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
        useValue: {
          getArtistDiscography: () => of({ artistId: 'ar1', lidarrId: 0, mbid: '', albums: [] }),
        },
      },
      {
        provide: LibraryApiService,
        useValue: {
          getArtist: (id: string) => {
            getArtistCalls.push(id);
            return of({ artist: { ...ARTIST, id }, albums: ALBUMS, singlesAndEps: [] });
          },
          getAlbum: (id: string) => {
            getAlbumCalls.push(id);
            return of(ALBUM_DETAILS[id]);
          },
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
          deleteSongs,
        },
      },
      { provide: AuthService, useValue: { token: signal('tok'), role: signal(role), canCurate: () => canCurateRole(asRole(role)) } },
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
    playWithContextCalls,
    addToQueueCalls,
    getAlbumCalls,
    getArtistSongsCalls,
    getArtistCalls,
    imageCalls,
    deleteSongs,
    paramMap,
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
  it('uploads a selected file and bumps the cache-bust version', async () => {
    const { component, imageCalls } = setup();
    await fixture_stable();
    expect(component.imageVersion()).toBe(0);

    const file = new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' });
    const event = { target: { files: [file], value: 'x' } } as unknown as Event;
    await component.onImageFileSelected(event);

    expect(imageCalls.upload).toHaveLength(1);
    expect(imageCalls.upload[0].id).toBe('ar1');
    expect(component.imageVersion()).toBe(1);
    expect(component.imageBusy()).toBe(false);
  });

  it('does nothing when no file is selected', async () => {
    const { component, imageCalls } = setup();
    await fixture_stable();
    const event = { target: { files: [], value: '' } } as unknown as Event;
    await component.onImageFileSelected(event);
    expect(imageCalls.upload).toHaveLength(0);
    expect(component.imageVersion()).toBe(0);
  });

  it('copies a chosen album cover and closes the picker', async () => {
    const { component, imageCalls } = setup();
    await fixture_stable();
    component.openAlbumPicker();
    expect(component.albumPickerOpen()).toBe(true);

    await component.pickAlbumCover('a2');

    expect(imageCalls.fromAlbum).toEqual([{ id: 'ar1', albumId: 'a2' }]);
    expect(component.albumPickerOpen()).toBe(false);
    expect(component.imageVersion()).toBe(1);
  });

  it('resets the image override', async () => {
    const { component, imageCalls } = setup();
    await fixture_stable();
    await component.resetImage();
    expect(imageCalls.reset).toEqual(['ar1']);
    expect(component.imageVersion()).toBe(1);
  });

  it('exposes the artist albums + singles as pickable covers', async () => {
    const { component } = setup();
    await fixture_stable();
    component.singlesAndEps.set([{ id: 's-ep', name: 'EP', artist: 'Natiruts' } as never]);
    expect(component.pickableAlbums().map((a) => a.id)).toEqual(['a1', 'a2', 's-ep']);
  });

  it('cache-busts the portrait src only after a change', async () => {
    const { component } = setup();
    await fixture_stable();
    expect(component.artistImageSrc()).toBe('/api/cover/ar1?size=200&token=tok');
    await component.resetImage();
    expect(component.artistImageSrc()).toBe('/api/cover/ar1?size=200&token=tok&v=1');
  });
});

describe('ArtistDetailComponent — delete (admin only)', () => {
  it('exposes a destructive "Remove from library" track action for admins', async () => {
    const { component } = setup('admin');
    await fixture_stable();
    component.setTab('songs');
    await flush();

    const action = component
      .songMenu.build(component.songs()[0], { hideGoToArtist: true, removable: true })
      .find((a) => a.label === 'Remove from library');
    expect(action).toBeDefined();
    expect(action!.destructive).toBe(true);
  });

  it('hides the "Remove from library" track action from non-admins', async () => {
    const { component } = setup('user');
    await fixture_stable();
    component.setTab('songs');
    await flush();

    const action = component
      .songMenu.build(component.songs()[0], { hideGoToArtist: true, removable: true })
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

// Helper: lets Angular settle the ngOnInit promise (of() resolves synchronously as a microtask)
async function fixture_stable() {
  await Promise.resolve();
}
