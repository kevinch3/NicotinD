import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { ArtistDetailComponent } from './artist-detail.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';

const ARTIST = { id: 'ar1', name: 'Natiruts', albumCount: 2 };
const ALBUMS = [
  { id: 'a1', name: 'Natiruts', artist: 'Natiruts' },
  { id: 'a2', name: 'Acústico',  artist: 'Natiruts' },
];
const ALBUM_DETAILS: Record<string, { id: string; name: string; artist: string; song: Array<{ id: string; title: string; artist: string }> }> = {
  a1: { id: 'a1', name: 'Natiruts', artist: 'Natiruts', song: [
    { id: 's1', title: 'Natiruts Reggae Power', artist: 'Natiruts' },
    { id: 's2', title: 'Sorri, Sou Rei',        artist: 'Natiruts' },
  ]},
  a2: { id: 'a2', name: 'Acústico', artist: 'Natiruts', song: [
    { id: 's3', title: 'Quatro Vezes Você', artist: 'Natiruts' },
  ]},
};

function setup() {
  const playWithContextCalls: unknown[][] = [];
  const getAlbumCalls: string[] = [];

  TestBed.configureTestingModule({
    imports: [ArtistDetailComponent],
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'ar1' } } } },
      {
        provide: ApiService,
        useValue: {
          getArtist: () => of({ artist: ARTIST, albums: ALBUMS }),
          getAlbum: (id: string) => { getAlbumCalls.push(id); return of(ALBUM_DETAILS[id]); },
        },
      },
      { provide: AuthService, useValue: { token: signal('tok') } },
      { provide: PlayerService, useValue: { playWithContext: (...args: unknown[]) => { playWithContextCalls.push(args); } } },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(ArtistDetailComponent);
  fixture.detectChanges();
  return { component: fixture.componentInstance, playWithContextCalls, getAlbumCalls };
}

describe('ArtistDetailComponent — Play All', () => {
  it('fetches every album and calls playWithContext with all songs', async () => {
    const { component, playWithContextCalls, getAlbumCalls } = setup();
    await fixture_stable();

    await component.playAll();

    expect(getAlbumCalls).toContain('a1');
    expect(getAlbumCalls).toContain('a2');

    expect(playWithContextCalls).toHaveLength(1);
    const [tracks, startIndex, context] = playWithContextCalls[0] as [Array<{ id: string }>, number, { type: string; name: string }];
    expect(tracks).toHaveLength(3); // s1+s2 from a1, s3 from a2
    expect(tracks.map(t => t.id)).toEqual(['s1', 's2', 's3']);
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

    const [tracks] = playWithContextCalls[0] as [Array<{ id: string; album: string }>, ...unknown[]];
    const s1 = tracks.find(t => t.id === 's1');
    const s3 = tracks.find(t => t.id === 's3');
    expect(s1?.album).toBe('Natiruts');
    expect(s3?.album).toBe('Acústico');
  });
});

// Helper: lets Angular settle the ngOnInit promise (of() resolves synchronously as a microtask)
async function fixture_stable() {
  await Promise.resolve();
}
