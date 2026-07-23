import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { vi } from 'vitest';
import { PlaylistDetailComponent } from './playlist-detail.component';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { PlaylistService } from '../../services/playlist.service';
import { TransferService } from '../../services/transfer.service';
import type { PlaylistDetail, Song } from '../../services/api/api-types';

const SONG = (id: string): Song => ({
  id,
  title: id,
  artist: 'A',
  album: 'Album',
  albumId: 'al1',
  path: '',
  bitRate: 320,
  size: 1000,
  created: '2024-01-01',
});

const PLAYLIST: PlaylistDetail = {
  id: 'pl1',
  name: 'My mix',
  description: null,
  songCount: 4,
  coverArt: null,
  kind: 'user',
  createdAt: 0,
  modifiedAt: 0,
  songs: [SONG('s1'), SONG('s2'), SONG('s3'), SONG('s4')],
};

function setup(playlist: PlaylistDetail = PLAYLIST) {
  const removeSong = vi.fn(() => Promise.resolve());
  const addSongs = vi.fn(() => Promise.resolve());
  const getProposals = vi.fn(() => Promise.resolve<Song[]>([]));
  const get = vi.fn(() => Promise.resolve({ ...playlist, songs: [...playlist.songs] }));

  TestBed.configureTestingModule({
    imports: [PlaylistDetailComponent],
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'pl1' } } } },
      { provide: AuthService, useValue: { token: signal('tok'), role: () => 'user' } },
      { provide: PlayerService, useValue: { play: () => {}, playWithContext: () => {} } },
      {
        provide: PlaylistService,
        useValue: {
          get,
          removeSong,
          addSongs,
          getProposals,
          openPicker: vi.fn(),
        },
      },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(PlaylistDetailComponent);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  return { component: fixture.componentInstance, removeSong, addSongs, getProposals, get, httpMock };
}

describe('PlaylistDetailComponent — bulk remove from playlist', () => {
  it('removes each selected song from the playlist and exits select mode', async () => {
    const { component, removeSong } = setup();
    await Promise.resolve(); // let ngOnInit settle the get() promise

    component.selection.enter();
    component.selection.toggle('s2');
    component.selection.toggle('s4');
    await component.removeSelectedFromPlaylist();

    expect(removeSong).toHaveBeenCalledWith('pl1', 's2');
    expect(removeSong).toHaveBeenCalledWith('pl1', 's4');
    expect(component.playlist()?.songs.map((s) => s.id)).toEqual(['s1', 's3']);
    expect(component.playlist()?.songCount).toBe(2);
    expect(component.selection.active()).toBe(false);
    expect(component.selection.count()).toBe(0);
  });

  it('does nothing when nothing is selected', async () => {
    const { component, removeSong } = setup();
    await Promise.resolve();

    component.selection.enter();
    await component.removeSelectedFromPlaylist();

    expect(removeSong).not.toHaveBeenCalled();
  });
});

describe('PlaylistDetailComponent — song picker / proposals', () => {
  it('addSong adds the picked song via the bulk-add method, then reloads', async () => {
    const { component, addSongs, get } = setup();
    await Promise.resolve(); // ngOnInit get()
    get.mockClear();

    await component.addSong(SONG('s5'));

    expect(addSongs).toHaveBeenCalledWith('pl1', ['s5']);
    expect(get).toHaveBeenCalledTimes(1); // reload() re-fetched the playlist
  });

  it('refreshes proposals (getProposals called again) after addSong', async () => {
    const { component, getProposals } = setup();
    await Promise.resolve();
    getProposals.mockClear();

    await component.addSong(SONG('s5'));

    expect(getProposals).toHaveBeenCalledTimes(1);
  });

  it('refreshes proposals after removeSong', async () => {
    const { component, getProposals } = setup();
    await Promise.resolve();
    getProposals.mockClear();

    await component.removeSong('s2');

    expect(getProposals).toHaveBeenCalledTimes(1);
  });

  it('refreshes proposals after removeSelectedFromPlaylist', async () => {
    const { component, getProposals } = setup();
    await Promise.resolve();
    getProposals.mockClear();

    component.selection.enter();
    component.selection.toggle('s2');
    await component.removeSelectedFromPlaylist();

    expect(getProposals).toHaveBeenCalledTimes(1);
  });

  it('does not refresh proposals merely from sharing (not a mutation)', async () => {
    Object.assign(navigator, { clipboard: { writeText: () => Promise.resolve() } });
    const { component, getProposals, httpMock } = setup();
    await Promise.resolve();
    getProposals.mockClear();

    component.sharePlaylist();
    const req = httpMock.expectOne('/api/share');
    req.flush({ url: 'http://x/share/tok' });
    await Promise.resolve();

    expect(getProposals).not.toHaveBeenCalled();
    httpMock.verify();
  });
});

describe('PlaylistDetailComponent — visibleSongs filters deletedSongIds', () => {
  it('excludes a song whose id was deleted elsewhere in the app', async () => {
    const { component } = setup();
    await Promise.resolve(); // ngOnInit get()

    expect(component.visibleSongs().map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4']);

    TestBed.inject(TransferService).deletedSongIds.set(new Set(['s3']));

    expect(component.visibleSongs().map((s) => s.id)).toEqual(['s1', 's2', 's4']);
  });
});

describe('PlaylistDetailComponent — sharing', () => {
  beforeEach(() => {
    // jsdom has no clipboard; stub it so sharePlaylist()'s copy doesn't throw.
    Object.assign(navigator, { clipboard: { writeText: () => Promise.resolve() } });
  });

  it('POSTs a playlist share request and flashes the copied state', async () => {
    const { component, httpMock } = setup();
    await Promise.resolve(); // ngOnInit get()

    expect(component.shareCopied()).toBe(false);
    component.sharePlaylist();

    const req = httpMock.expectOne('/api/share');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ resourceType: 'playlist', resourceId: 'pl1' });
    req.flush({ url: 'http://x/share/tok' });
    await Promise.resolve();

    expect(component.shareCopied()).toBe(true);
    httpMock.verify();
  });

  it('is a no-op for curated playlists (read-only, nothing to share)', async () => {
    const { component, httpMock } = setup({ ...PLAYLIST, kind: 'curated' });
    await Promise.resolve();

    component.sharePlaylist();

    httpMock.expectNone('/api/share');
    httpMock.verify();
  });
});
