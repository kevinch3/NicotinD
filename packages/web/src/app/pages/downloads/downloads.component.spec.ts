import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { DownloadsComponent } from './downloads.component';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { SystemApiService } from '../../services/api/system-api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { PreserveService } from '../../services/preserve.service';
import { PlaylistService } from '../../services/playlist.service';
import type { Song } from '../../services/api/api-types';

const MOCK_SONGS: Song[] = [
  {
    id: 's1',
    title: 'Track One',
    artist: 'Artist',
    album: 'Album',
    path: '',
    bitRate: 320,
    size: 1000,
    created: '2024-01-03',
  },
  {
    id: 's2',
    title: 'Track Two',
    artist: 'Artist',
    album: 'Album',
    path: '',
    bitRate: 320,
    size: 1000,
    created: '2024-01-02',
  },
  {
    id: 's3',
    title: 'Track Three',
    artist: 'Artist',
    album: 'Album',
    path: '',
    bitRate: 320,
    size: 1000,
    created: '2024-01-01',
  },
];

function setup(opts: { songs?: Song[]; deletedIds?: Set<string> } = {}) {
  const songs = opts.songs ?? MOCK_SONGS;
  const deletedSongIds = signal<ReadonlySet<string>>(opts.deletedIds ?? new Set());
  const transferStub = {
    downloads: signal([]),
    uploads: signal([]),
    acquireJobs: signal([]),
    acquisitionJobs: signal([]),
    libraryDirty: signal(false),
    deletedSongIds,
    addDeletedIds: (ids: string[]) => {
      deletedSongIds.update((s) => new Set([...s, ...ids]));
    },
    kickPoll: () => {},
  };

  TestBed.configureTestingModule({
    imports: [DownloadsComponent],
    providers: [
      provideRouter([]),
      {
        provide: LibraryApiService,
        useValue: {
          getRecentSongs: () => of(songs),
          deleteSongs: () => of({ ok: true, deletedCount: 0 }),
        },
      },
      { provide: DownloadsApiService, useValue: {} },
      { provide: SystemApiService, useValue: { triggerScan: () => of({}) } },
      { provide: AuthService, useValue: { token: signal('tok'), role: () => 'user' } },
      { provide: PlayerService, useValue: { play: () => {}, playWithContext: () => {}, addToQueue: () => {} } },
      { provide: TransferService, useValue: transferStub },
      { provide: PreserveService, useValue: { preservedTracks: signal([]), totalUsage: signal(0), budget: signal(0), isPreserved: () => false } },
      { provide: PlaylistService, useValue: { openPicker: () => {} } },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(DownloadsComponent);
  fixture.detectChanges();
  return { component: fixture.componentInstance, transferService: transferStub };
}

describe('DownloadsComponent — recent-songs selection', () => {
  it('selects two ids via createSelection()', () => {
    const { component } = setup();
    component.recentSongs.set(MOCK_SONGS);

    component.selection.toggle('s1');
    component.selection.toggle('s2');

    expect(component.selection.ids().size).toBe(2);
    expect(component.selection.isSelected('s1')).toBe(true);
    expect(component.selection.isSelected('s2')).toBe(true);
  });

  it('visibleRecent excludes a song deleted this session', () => {
    const { component, transferService } = setup();
    component.recentSongs.set(MOCK_SONGS);

    expect(component.visibleRecent().map((s) => s.id)).toEqual(['s1', 's2', 's3']);

    transferService.addDeletedIds(['s2']);

    expect(component.visibleRecent().map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('offline selection is independent of the recent-songs selection', () => {
    const { component } = setup();
    component.recentSongs.set(MOCK_SONGS);

    component.selection.toggle('s1');
    component.offlineSelection.toggle('s1');

    expect(component.selection.ids().size).toBe(1);
    expect(component.offlineSelection.ids().size).toBe(1);

    component.selection.exit();

    expect(component.selection.ids().size).toBe(0);
    expect(component.offlineSelection.ids().size).toBe(1);
  });
});
