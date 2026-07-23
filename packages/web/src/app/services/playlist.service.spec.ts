import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { PlaylistService } from './playlist.service';
import { PlaylistsApiService } from './api/playlists-api.service';
import type { PlaylistSummary, Song } from './api/api-types';

function summary(over: Partial<PlaylistSummary> = {}): PlaylistSummary {
  return {
    id: 'p1',
    name: 'Mine',
    description: null,
    songCount: 0,
    coverArt: null,
    kind: 'user',
    createdAt: 0,
    modifiedAt: 0,
    ...over,
  };
}

describe('PlaylistService (web)', () => {
  const getPlaylists = vi.fn();
  const createPlaylist = vi.fn();
  const updatePlaylist = vi.fn();
  const deletePlaylist = vi.fn();
  const getProposals = vi.fn();
  let svc: PlaylistService;

  beforeEach(() => {
    getPlaylists.mockReset().mockReturnValue(of({ playlists: [] }));
    createPlaylist.mockReset().mockReturnValue(of({ playlist: summary({ id: 'new' }) }));
    updatePlaylist.mockReset().mockReturnValue(of({ ok: true }));
    deletePlaylist.mockReset().mockReturnValue(of({ ok: true }));
    getProposals.mockReset().mockReturnValue(of([]));

    TestBed.configureTestingModule({
      providers: [
        PlaylistService,
        {
          provide: PlaylistsApiService,
          useValue: { getPlaylists, createPlaylist, updatePlaylist, deletePlaylist, getProposals },
        },
      ],
    });
    svc = TestBed.inject(PlaylistService);
  });

  it('refresh populates the list and marks loaded', async () => {
    getPlaylists.mockReturnValue(of({ playlists: [summary({ id: 'a' })] }));
    await svc.refresh();
    expect(svc.playlists()).toHaveLength(1);
    expect(svc.loaded()).toBe(true);
  });

  it('create prepends the new playlist', async () => {
    await svc.create('Fresh', ['s1']);
    expect(createPlaylist).toHaveBeenCalledWith('Fresh', ['s1']);
    expect(svc.playlists()[0]?.id).toBe('new');
  });

  it('delete removes the playlist locally', async () => {
    getPlaylists.mockReturnValue(of({ playlists: [summary({ id: 'a' })] }));
    await svc.refresh();
    await svc.delete('a');
    expect(deletePlaylist).toHaveBeenCalledWith('a');
    expect(svc.playlists()).toHaveLength(0);
  });

  it('getProposals passes through the id and limit and returns the songs', async () => {
    const song: Song = {
      id: 's1',
      title: 'T',
      artist: 'A',
      album: 'Al',
      albumId: 'al1',
      path: '',
      bitRate: 320,
      size: 1000,
      created: '2024-01-01',
    };
    getProposals.mockReturnValue(of([song]));
    const result = await svc.getProposals('pl1', 5);
    expect(getProposals).toHaveBeenCalledWith('pl1', 5);
    expect(result).toEqual([song]);
  });

  it('openPicker sets pending song ids and refreshes when unloaded', () => {
    svc.openPicker(['s1', 's2']);
    expect(svc.pendingSongIds()).toEqual(['s1', 's2']);
    expect(getPlaylists).toHaveBeenCalled(); // refreshed because not yet loaded
    svc.closePicker();
    expect(svc.pendingSongIds()).toBeNull();
  });
});
