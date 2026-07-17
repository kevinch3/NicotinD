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
import { asRole, canCurate as canCurateRole, type Role } from '../../types/core';
import type { BaseSong } from '../lib/track-utils';

const song = (over: Partial<BaseSong> = {}): BaseSong => ({
  id: 's1', title: 'Toxic', artist: 'Britney', ...over,
});

function setup(role: Role = 'user') {
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
      { provide: PreserveService, useValue: { isPreserved: () => false, isPreserving: () => false } },
      { provide: LibraryApiService, useValue: { deleteSongs: vi.fn(() => ({ subscribe: vi.fn() })) } },
      { provide: TransferService, useValue: { addDeletedIds: vi.fn() } },
      { provide: TrackInfoService, useValue: { open: vi.fn() } },
      { provide: ConfirmService, useValue: { ask: vi.fn(async () => true) } },
    ],
  });
  return { svc: TestBed.inject(SongMenuService), router, auth };
}

const labels = (song: BaseSong, svc: SongMenuService, ctx = {}) =>
  svc.build(song, ctx).map((a) => a.label);

describe('SongMenuService.build', () => {
  it('emits the 8 common actions in order when data allows', () => {
    const { svc } = setup();
    expect(labels(song({ artistId: 'ar1', albumId: 'al1' }), svc)).toEqual([
      'Add to queue', 'Play next', 'Start radio', 'Go to artist',
      'Go to album', 'Add to playlist', 'Save offline', 'Song info',
    ]);
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
      hideGoToArtist: true, hideGoToAlbum: true,
    });
    expect(out).not.toContain('Go to artist');
    expect(out).not.toContain('Go to album');
  });

  it('adds Remove from library only for curators (refiner/admin) + removable', () => {
    expect(labels(song(), setup('listener').svc, { removable: true })).not.toContain('Remove from library');
    expect(labels(song(), setup('user').svc, { removable: true })).not.toContain('Remove from library');
    expect(labels(song(), setup('refiner').svc, { removable: true })).toContain('Remove from library');
    expect(labels(song(), setup('admin').svc, { removable: true })).toContain('Remove from library');
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
