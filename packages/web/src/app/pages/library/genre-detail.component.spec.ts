import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { GenreDetailComponent } from './genre-detail.component';
import { vi } from 'vitest';
import { ApiService, type Song } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { PreserveService } from '../../services/preserve.service';

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

function setup() {
  const playWithContextCalls: unknown[][] = [];
  const playerStub = {
    play: () => {},
    playWithContext: (...args: unknown[]) => {
      playWithContextCalls.push(args);
    },
  };

  TestBed.configureTestingModule({
    imports: [GenreDetailComponent],
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'Reggae' } } } },
      {
        provide: ApiService,
        useValue: {
          getSongsByGenre: () => of(MOCK_SONGS),
        },
      },
      { provide: AuthService, useValue: { token: signal('tok') } },
      { provide: PlayerService, useValue: playerStub },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(GenreDetailComponent);
  fixture.detectChanges();
  const preserve = TestBed.inject(PreserveService);
  return { component: fixture.componentInstance, playWithContextCalls, preserve };
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
    const [name, tracks] = spy.mock.calls[0];
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
