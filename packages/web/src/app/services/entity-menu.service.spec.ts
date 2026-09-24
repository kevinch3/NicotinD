import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { EntityMenuService, type EntityRef } from './entity-menu.service';
import { PlayerService } from './player.service';
import { PreserveService } from './preserve.service';
import { LibraryApiService } from './api/library-api.service';
import { PlaylistsApiService } from './api/playlists-api.service';
import { ToastService } from './toast.service';
import { resolveAlbumRoute, resolveGenreRoute } from '../lib/route-utils';

const SONGS = [
  { id: 's1', title: 'One', artist: 'A', album: 'Al', albumId: 'al1' },
  { id: 's2', title: 'Two', artist: 'A', album: 'Al', albumId: 'al1' },
];

function setup() {
  const player = {
    startRadioWithTracks: vi.fn(),
    startRadioWithFilter: vi.fn(),
    playWithContext: vi.fn(),
    queueNext: vi.fn(),
    addToQueue: vi.fn(),
  };
  const api = {
    getAlbum: vi.fn(() => of({ id: 'al1', name: 'Al', artist: 'A', song: SONGS })),
    getArtistSongs: vi.fn(() => of(SONGS)),
    getSongsByGenre: vi.fn(() => of(SONGS)),
    getFilterRadio: vi.fn(() => of(SONGS)),
  };
  const playlists = { getPlaylist: vi.fn(() => of({ id: 'p1', name: 'P', songs: SONGS })) };
  const preserve = { preserveCollection: vi.fn(async () => {}) };
  const toasts = { show: vi.fn() };
  const router = { navigate: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      EntityMenuService,
      { provide: PlayerService, useValue: player },
      { provide: LibraryApiService, useValue: api },
      { provide: PlaylistsApiService, useValue: playlists },
      { provide: PreserveService, useValue: preserve },
      { provide: ToastService, useValue: toasts },
      { provide: Router, useValue: router },
    ],
  });
  return {
    svc: TestBed.inject(EntityMenuService),
    player,
    api,
    playlists,
    preserve,
    toasts,
    router,
  };
}

const ALBUM: EntityRef = { kind: 'album', id: 'al1', name: 'Al' };
const ARTIST: EntityRef = { kind: 'artist', id: 'ar1', name: 'A' };
const GENRE: EntityRef = { kind: 'genre', value: 'jazz' };
const PLAYLIST: EntityRef = { kind: 'playlist', id: 'p1', name: 'P' };

const labels = (svc: EntityMenuService, ref: EntityRef) => svc.build(ref).map((a) => a.label);
const run = async (svc: EntityMenuService, ref: EntityRef, label: string) => {
  const action = svc.build(ref).find((a) => a.label === label)!;
  await action.action();
  await Promise.resolve();
};

describe('EntityMenuService.build — one order for every kind', () => {
  it('starts with Start radio (the app verb), then the playback verbs, then Open', () => {
    const { svc } = setup();
    for (const ref of [ALBUM, ARTIST, GENRE, PLAYLIST]) {
      expect(labels(svc, ref), ref.kind).toEqual([
        'Start radio',
        'Play',
        'Play next',
        'Add to queue',
        'Save offline',
        'Open',
      ]);
    }
  });

  it('appends page-specific extra actions last, like the song menu', () => {
    const { svc } = setup();
    const extra = { label: 'Hide album', action: () => {} };
    expect(labels(svc, ALBUM)).not.toContain('Hide album');
    expect(svc.build(ALBUM, { extraActions: [extra] }).at(-1)?.label).toBe('Hide album');
  });

  it('every action carries an i18n key', () => {
    const { svc } = setup();
    for (const a of svc.build(ALBUM)) expect(a.labelKey, a.label).toMatch(/^entityMenu\./);
  });
});

describe("EntityMenuService — the verbs reach the player with the entity's tracks", () => {
  it('album: radio is list-anchored on the album songs, play keeps the album context', async () => {
    const { svc, player, api } = setup();
    await run(svc, ALBUM, 'Start radio');
    expect(api.getAlbum).toHaveBeenCalledWith('al1');
    expect(player.startRadioWithTracks).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 's1' })]),
      { seedIds: ['s1', 's2'], name: 'Al' },
    );
    await run(svc, ALBUM, 'Play');
    expect(player.playWithContext).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 's2' })]),
      0,
      { type: 'album', id: 'al1', name: 'Al' },
    );
  });

  it('artist: songs come from getArtistSongs and play is an adhoc context named after the artist', async () => {
    const { svc, player, api } = setup();
    await run(svc, ARTIST, 'Play');
    expect(api.getArtistSongs).toHaveBeenCalledWith('ar1', expect.any(Number));
    expect(player.playWithContext).toHaveBeenCalledWith(expect.any(Array), 0, {
      type: 'adhoc',
      name: 'A',
    });
  });

  it('genre: radio is a filter radio on the genre, play uses the genre songs', async () => {
    const { svc, player, api } = setup();
    await run(svc, GENRE, 'Start radio');
    expect(api.getFilterRadio).toHaveBeenCalledWith({ genres: ['jazz'] }, [], expect.any(Number));
    expect(player.startRadioWithFilter).toHaveBeenCalledWith(expect.any(Array), {
      genres: ['jazz'],
    });
    await run(svc, GENRE, 'Play');
    expect(api.getSongsByGenre).toHaveBeenCalledWith('jazz', expect.any(Number));
  });

  it('playlist: radio is anchored on the playlist songs, play keeps the playlist context', async () => {
    const { svc, player, playlists } = setup();
    await run(svc, PLAYLIST, 'Start radio');
    expect(playlists.getPlaylist).toHaveBeenCalledWith('p1');
    expect(player.startRadioWithTracks).toHaveBeenCalledWith(expect.any(Array), {
      seedIds: ['s1', 's2'],
      name: 'P',
    });
    await run(svc, PLAYLIST, 'Play');
    expect(player.playWithContext).toHaveBeenCalledWith(expect.any(Array), 0, {
      type: 'playlist',
      id: 'p1',
      name: 'P',
    });
  });

  it('Play next keeps the album order (queueNext prepends, so it is called in reverse)', async () => {
    const { svc, player } = setup();
    await run(svc, ALBUM, 'Play next');
    expect(player.queueNext.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual([
      's2',
      's1',
    ]);
  });

  it('Add to queue appends in order', async () => {
    const { svc, player } = setup();
    await run(svc, ALBUM, 'Add to queue');
    expect(player.addToQueue.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual([
      's1',
      's2',
    ]);
  });

  it('Save offline uses the same collection key the detail pages use', async () => {
    const { svc, preserve } = setup();
    await run(svc, ALBUM, 'Save offline');
    expect(preserve.preserveCollection).toHaveBeenCalledWith('al1', 'Al', expect.any(Array));
    await run(svc, ARTIST, 'Save offline');
    expect(preserve.preserveCollection).toHaveBeenCalledWith('artist-ar1', 'A', expect.any(Array));
    await run(svc, GENRE, 'Save offline');
    expect(preserve.preserveCollection).toHaveBeenCalledWith('jazz', 'jazz', expect.any(Array));
  });

  it('Open navigates to the entity route', async () => {
    const { svc, router } = setup();
    await run(svc, ALBUM, 'Open');
    expect(router.navigate).toHaveBeenCalledWith(resolveAlbumRoute('al1'));
    await run(svc, GENRE, 'Open');
    expect(router.navigate).toHaveBeenCalledWith(resolveGenreRoute('jazz'));
  });

  it('a failed fetch is one error toast, never an unhandled rejection', async () => {
    const { svc, api, toasts, player } = setup();
    api.getAlbum.mockReturnValueOnce(throwError(() => new Error('down')));
    await run(svc, ALBUM, 'Play');
    expect(player.playWithContext).not.toHaveBeenCalled();
    expect(toasts.show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });

  it('an entity with no tracks says so instead of starting an empty radio', async () => {
    const { svc, api, toasts, player } = setup();
    api.getAlbum.mockReturnValueOnce(of({ id: 'al1', name: 'Al', artist: 'A', song: [] }));
    await run(svc, ALBUM, 'Start radio');
    expect(player.startRadioWithTracks).not.toHaveBeenCalled();
    expect(toasts.show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'info' }));
  });
});

describe('EntityMenuService — the open menu (one host, one state)', () => {
  it('opens at a point or anchored to an element, and closes', () => {
    const { svc } = setup();
    const actions = [{ label: 'Play', action: () => {} }];
    expect(svc.state()).toBeNull();
    svc.open({ actions, at: { x: 10, y: 20 } });
    expect(svc.state()).toEqual({ actions, at: { x: 10, y: 20 }, anchor: undefined });
    const el = document.createElement('button');
    svc.open({ actions, anchor: el });
    expect(svc.state()?.anchor).toBe(el);
    svc.close();
    expect(svc.state()).toBeNull();
  });
});
