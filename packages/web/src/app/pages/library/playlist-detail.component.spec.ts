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
          get: () => Promise.resolve({ ...playlist, songs: [...playlist.songs] }),
          removeSong,
          openPicker: vi.fn(),
        },
      },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(PlaylistDetailComponent);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  return { component: fixture.componentInstance, removeSong, httpMock };
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
