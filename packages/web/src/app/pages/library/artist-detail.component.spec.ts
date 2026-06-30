import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { ArtistDetailComponent } from './artist-detail.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';

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
  opts: { sort?: string; starred?: boolean };
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

function setup(role = 'admin') {
  const playWithContextCalls: unknown[][] = [];
  const addToQueueCalls: unknown[] = [];
  const getAlbumCalls: string[] = [];
  const getArtistSongsCalls: GetSongsCall[] = [];
  const imageCalls = {
    upload: [] as Array<{ id: string; file: File }>,
    fromAlbum: [] as Array<{ id: string; albumId: string }>,
    reset: [] as string[],
  };

  TestBed.configureTestingModule({
    imports: [ArtistDetailComponent],
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'ar1' } } } },
      {
        provide: DownloadsApiService,
        useValue: {
          getArtistDiscography: () => of({ artistId: 'ar1', lidarrId: 0, mbid: '', albums: [] }),
        },
      },
      {
        provide: LibraryApiService,
        useValue: {
          getArtist: () => of({ artist: ARTIST, albums: ALBUMS, singlesAndEps: [] }),
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
        },
      },
      { provide: AuthService, useValue: { token: signal('tok'), role: signal(role) } },
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
    imageCalls,
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

  it('refetches with starred=true when the starred filter is toggled', async () => {
    const { component, getArtistSongsCalls } = setup();
    await fixture_stable();
    component.setTab('songs');
    await flush();

    component.toggleStarredOnly();
    await flush();

    const last = getArtistSongsCalls[getArtistSongsCalls.length - 1];
    expect(last.opts.starred).toBe(true);
    expect(component.activeSongFilterCount()).toBe(1);
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

// Helper: lets Angular settle the ngOnInit promise (of() resolves synchronously as a microtask)
async function fixture_stable() {
  await Promise.resolve();
}
