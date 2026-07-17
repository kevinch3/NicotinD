import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { GenreDetailComponent } from './genre-detail.component';
import { vi } from 'vitest';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { Song } from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';
import { asRole, canCurate as canCurateRole } from '../../../types/core';
import { PlayerService } from '../../services/player.service';
import { PreserveService } from '../../services/preserve.service';
import { PlaylistService } from '../../services/playlist.service';

const MOCK_SONGS: Song[] = [
  {
    id: 's1',
    title: 'Natiruts Reggae Power',
    artist: 'Natiruts',
    album: 'Natiruts',
    albumId: 'a1',
    path: '',
    bitRate: 320,
    size: 1000,
    created: '2024-01-01',
  },
  {
    id: 's2',
    title: 'Sorri, Sou Rei',
    artist: 'Natiruts',
    album: 'Natiruts',
    albumId: 'a1',
    path: '',
    bitRate: 320,
    size: 1000,
    created: '2024-01-01',
  },
  {
    id: 's3',
    title: 'Quatro Vezes Você',
    artist: 'Natiruts',
    album: 'Natiruts',
    albumId: 'a1',
    path: '',
    bitRate: 320,
    size: 1000,
    created: '2024-01-01',
  },
];

function setup(opts: { role?: 'admin' | 'user'; deleteSongs?: ReturnType<typeof vi.fn> } = {}) {
  const playWithContextCalls: unknown[][] = [];
  const playerStub = {
    play: () => {},
    playWithContext: (...args: unknown[]) => {
      playWithContextCalls.push(args);
    },
  };
  const openPicker = vi.fn();
  const deleteSongs = opts.deleteSongs ?? vi.fn(() => of({ ok: true, deletedCount: 0 }));

  TestBed.configureTestingModule({
    imports: [GenreDetailComponent],
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'Reggae' } } } },
      {
        provide: LibraryApiService,
        useValue: {
          getSongsByGenre: () => of(MOCK_SONGS),
          deleteSongs,
        },
      },
      { provide: AuthService, useValue: { token: signal('tok'), role: () => opts.role ?? 'user', canCurate: () => canCurateRole(asRole(opts.role ?? 'user')) } },
      { provide: PlayerService, useValue: playerStub },
      { provide: PlaylistService, useValue: { openPicker } },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(GenreDetailComponent);
  fixture.detectChanges();
  const preserve = TestBed.inject(PreserveService);
  return { component: fixture.componentInstance, playWithContextCalls, preserve, openPicker, deleteSongs };
}

describe('GenreDetailComponent — Play All', () => {
  it('calls playWithContext with all genre songs mapped to tracks', async () => {
    const { component, playWithContextCalls } = setup();

    component.genreSlug.set('Reggae');
    component.genreSongs.set(MOCK_SONGS);

    component.playGenre();

    expect(playWithContextCalls).toHaveLength(1);
    const [tracks, startIndex, context] = playWithContextCalls[0] as [
      unknown[],
      number,
      { type: string; name: string },
    ];
    expect(tracks).toHaveLength(3);
    expect((tracks[0] as { id: string }).id).toBe('s1');
    expect((tracks[2] as { id: string }).id).toBe('s3');
    expect(startIndex).toBe(0);
    expect(context.type).toBe('adhoc');
    expect(context.name).toBe('Reggae');
  });

  it('does nothing when no genre is selected', () => {
    const { component, playWithContextCalls } = setup();

    component.genreSlug.set(null);
    component.genreSongs.set(MOCK_SONGS);

    component.playGenre();

    expect(playWithContextCalls).toHaveLength(0);
  });

  it('does nothing when genre songs list is empty', () => {
    const { component, playWithContextCalls } = setup();

    component.genreSlug.set('Reggae');
    component.genreSongs.set([]);

    component.playGenre();

    expect(playWithContextCalls).toHaveLength(0);
  });

  it('preserves artist metadata in mapped tracks', () => {
    const { component, playWithContextCalls } = setup();

    component.genreSlug.set('Reggae');
    component.genreSongs.set(MOCK_SONGS);

    component.playGenre();

    const [tracks] = playWithContextCalls[0] as [
      Array<{ id: string; title: string; artist: string; album: string }>,
      ...unknown[],
    ];
    expect(tracks[0].title).toBe('Natiruts Reggae Power');
    expect(tracks[0].artist).toBe('Natiruts');
    expect(tracks[0].album).toBe('Natiruts');
  });
});

describe('GenreDetailComponent — Download', () => {
  it('preserves the whole genre as a collection', () => {
    const { component, preserve } = setup();
    const spy = vi.spyOn(preserve, 'preserveCollection').mockResolvedValue();

    component.genreSlug.set('Reggae');
    component.genreSongs.set(MOCK_SONGS);

    component.toggleDownloadGenre();

    expect(spy).toHaveBeenCalledTimes(1);
    // preserveCollection(key, name, tracks) — key === name === slug for a genre.
    const [key, name, tracks] = spy.mock.calls[0];
    expect(key).toBe('Reggae');
    expect(name).toBe('Reggae');
    expect(tracks).toHaveLength(3);
    expect(tracks[0].id).toBe('s1');
  });

  it('removes the collection when already downloaded', () => {
    const { component, preserve } = setup();
    vi.spyOn(preserve, 'isCollectionPreserved').mockReturnValue(true);
    const removeSpy = vi.spyOn(preserve, 'removeMany').mockResolvedValue();

    component.genreSlug.set('Reggae');
    component.genreSongs.set(MOCK_SONGS);

    component.toggleDownloadGenre();

    expect(removeSpy).toHaveBeenCalledWith(['s1', 's2', 's3']);
  });
});

describe('GenreDetailComponent — Add to playlist', () => {
  it('exposes an "Add to playlist" track action that opens the picker', () => {
    const { component, openPicker } = setup();
    const action = component.songMenu
      .build(MOCK_SONGS[0], { removable: true })
      .find((a) => a.label === 'Add to playlist');
    expect(action).toBeDefined();
    action!.action();
    expect(openPicker).toHaveBeenCalledWith(['s1']);
  });

  it('bulk-adds the ticked songs and exits select mode', () => {
    const { component, openPicker } = setup();
    component.genreSongs.set(MOCK_SONGS);

    component.selection.enter();
    component.selection.toggle('s1');
    component.selection.toggle('s3');
    component.addSelectedToPlaylist();

    expect(openPicker).toHaveBeenCalledTimes(1);
    expect(openPicker.mock.calls[0][0]).toEqual(['s1', 's3']);
    expect(component.selection.active()).toBe(false);
    expect(component.selection.count()).toBe(0);
  });

  it('selectAllSongs ticks every filtered song', () => {
    const { component } = setup();
    component.genreSongs.set(MOCK_SONGS);
    component.selection.enter();
    component.selectAllSongs();
    expect(component.selection.count()).toBe(3);
    expect(component.selection.isSelected('s2')).toBe(true);
  });
});

describe('GenreDetailComponent — Bulk delete', () => {
  it('deletes the selected songs, prunes them, and exits select mode', async () => {
    const deleteSongs = vi.fn(() => of({ ok: true, deletedCount: 2 }));
    const { component } = setup({ role: 'admin', deleteSongs });
    component.genreSongs.set(MOCK_SONGS);

    component.selection.enter();
    component.selection.toggle('s1');
    component.selection.toggle('s3');
    component.deleteSelectedSongs();

    // deleteSelectedSongs defers to the confirm dialog; run the queued callback.
    const cb = component.confirmCallback();
    expect(cb).toBeTruthy();
    await cb!();

    expect(deleteSongs).toHaveBeenCalledWith(['s1', 's3']);
    expect(component.genreSongs().map((s) => s.id)).toEqual(['s2']);
    expect(component.selection.active()).toBe(false);
    expect(component.selection.count()).toBe(0);
    expect(component.deleteError()).toBeNull();
  });

  it('surfaces a partial-failure message when not all songs were removed', async () => {
    const deleteSongs = vi.fn(() => of({ ok: true, deletedCount: 1 }));
    const { component } = setup({ role: 'admin', deleteSongs });
    component.genreSongs.set(MOCK_SONGS);

    component.selection.enter();
    component.selection.toggle('s1');
    component.selection.toggle('s2');
    component.deleteSelectedSongs();
    await component.confirmCallback()!();

    expect(component.deleteError()).toContain('1 of 2');
  });

  it('does nothing when no songs are selected', () => {
    const deleteSongs = vi.fn(() => of({ ok: true, deletedCount: 0 }));
    const { component } = setup({ role: 'admin', deleteSongs });
    component.selection.enter();
    component.deleteSelectedSongs();
    expect(component.confirmCallback()).toBeNull();
    expect(deleteSongs).not.toHaveBeenCalled();
  });
});
