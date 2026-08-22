import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { Subject, of, throwError } from 'rxjs';
import { TastemakersComponent } from './tastemakers.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { PlaylistsApiService } from '../../services/api/playlists-api.service';
import { PlayerService } from '../../services/player.service';
import { ToastService } from '../../services/toast.service';
import type { PlaylistDetail, PlaylistSummary, Song } from '../../services/api/api-types';

function playlist(over: Partial<PlaylistSummary> = {}): PlaylistSummary {
  return {
    id: 'pl1',
    name: 'Fresh This Week',
    description: null,
    songCount: 12,
    coverArt: '/playlist-covers/fresh-this-week.svg',
    kind: 'curated',
    createdAt: 1_700_000_000_000,
    modifiedAt: 1_700_000_000_000,
    ...over,
  };
}

function song(over: Partial<Song> = {}): Song {
  return {
    id: 's1',
    title: 'Track',
    album: 'Album',
    albumId: 'a1',
    artist: 'Artist',
    artistId: 'ar1',
    coverArt: 'cov1',
    size: 0,
    contentType: 'audio/mpeg',
    suffix: 'mp3',
    duration: 200,
    bitRate: 320,
    path: '/m/s1.mp3',
    created: '2024-01-01',
    ...over,
  } as Song;
}

function detail(songs: Song[], over: Partial<PlaylistSummary> = {}): PlaylistDetail {
  return { ...playlist(over), songs };
}

function setup(opts: {
  playlists?: PlaylistSummary[] | 'error';
  detail?: PlaylistDetail | 'error' | 'pending';
  variations?: Song[] | 'error';
}) {
  const playlists = opts.playlists ?? [playlist()];
  const getPlaylists = vi.fn(() =>
    playlists === 'error' ? throwError(() => new Error('down')) : of({ playlists }),
  );
  const pendingDetail = new Subject<PlaylistDetail>();
  const getPlaylist = vi.fn(() => {
    if (opts.detail === 'error') return throwError(() => new Error('down'));
    if (opts.detail === 'pending') return pendingDetail.asObservable();
    return of(opts.detail ?? detail([song()]));
  });
  const variations = opts.variations ?? [];
  const getListRadio = vi.fn(() =>
    variations === 'error' ? throwError(() => new Error('down')) : of(variations),
  );
  const startRadioWithTracks = vi.fn();
  const nowPlayingOpen = signal(false);
  const toastShow = vi.fn();

  TestBed.configureTestingModule({
    imports: [TastemakersComponent],
    providers: [
      { provide: PlaylistsApiService, useValue: { getPlaylists, getPlaylist } },
      { provide: LibraryApiService, useValue: { getListRadio } },
      { provide: PlayerService, useValue: { startRadioWithTracks, nowPlayingOpen } },
      { provide: ToastService, useValue: { show: toastShow } },
    ],
  });
  const fixture = TestBed.createComponent(TastemakersComponent);
  fixture.detectChanges();
  return {
    fixture,
    getPlaylists,
    getPlaylist,
    getListRadio,
    startRadioWithTracks,
    nowPlayingOpen,
    toastShow,
  };
}

async function settle(fixture: { whenStable: () => Promise<unknown>; detectChanges: () => void }) {
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('TastemakersComponent', () => {
  it('renders one tile per curated playlist, filtering out user/liked rows', async () => {
    const { fixture } = setup({
      playlists: [
        playlist({ id: 'c1' }),
        playlist({ id: 'u1', kind: 'user', name: 'Mine' }),
        playlist({ id: 'l1', kind: 'liked', name: 'Liked Songs' }),
        playlist({ id: 'c2', name: 'Deep Focus' }),
      ],
    });
    await settle(fixture);

    const tiles = fixture.nativeElement.querySelectorAll('[data-testid="tastemaker-item"]');
    expect(tiles).toHaveLength(2);
    const ids = [...tiles].map((t: Element) => t.getAttribute('data-playlist-id'));
    expect(ids).toEqual(['c1', 'c2']);
  });

  it('caps the shelf at 10 tiles', async () => {
    const { fixture } = setup({
      playlists: Array.from({ length: 12 }, (_, i) => playlist({ id: `c${i}` })),
    });
    await settle(fixture);

    expect(fixture.nativeElement.querySelectorAll('[data-testid="tastemaker-item"]')).toHaveLength(
      10,
    );
  });

  it('hides itself when there are no curated playlists', async () => {
    const { fixture } = setup({ playlists: [playlist({ id: 'u1', kind: 'user' })] });
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="tastemakers"]')).toBeNull();
  });

  it('stays hidden when the playlists endpoint fails, rather than erroring the page', async () => {
    const { fixture } = setup({ playlists: 'error' });
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-testid="tastemakers"]')).toBeNull();
  });

  // The curated cover is a bundled SPA asset — the raw root-relative path must
  // reach the <img> src un-rewritten (docs/curated-playlists.md "Covers").
  it('renders the gradient cover via a plain <img> with the raw path, and an initial fallback without one', async () => {
    const { fixture } = setup({
      playlists: [
        playlist({ id: 'c1' }),
        playlist({ id: 'c2', name: 'Deep Focus', coverArt: null }),
      ],
    });
    await settle(fixture);

    const img = fixture.nativeElement.querySelector('[data-playlist-id="c1"] img');
    expect(img.getAttribute('src')).toBe('/playlist-covers/fresh-this-week.svg');
    expect(fixture.nativeElement.querySelector('[data-playlist-id="c2"] img')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-playlist-id="c2"]').textContent).toContain(
      'D',
    );
  });

  it('tap starts a blend: picks from the playlist first, variations after', async () => {
    const members = [
      song({ id: 'm1' }),
      song({ id: 'm2' }),
      song({ id: 'm3' }),
      song({ id: 'm4' }),
    ];
    const { fixture, getPlaylist, getListRadio, startRadioWithTracks, nowPlayingOpen } = setup({
      detail: detail(members),
      variations: [song({ id: 'v1' }), song({ id: 'v2' })],
    });
    await settle(fixture);

    fixture.nativeElement.querySelector('[data-testid="tastemaker-item"]').click();
    await settle(fixture);

    expect(getPlaylist).toHaveBeenCalledWith('pl1');
    expect(getListRadio).toHaveBeenCalledWith(['m1', 'm2', 'm3', 'm4'], 10);
    expect(startRadioWithTracks).toHaveBeenCalledTimes(1);
    const tracks = startRadioWithTracks.mock.calls[0]![0] as Array<{ id: string }>;
    const memberIds = new Set(members.map((m) => m.id));
    // First 3 are shuffled playlist members; the variations follow in order.
    expect(tracks.slice(0, 3).every((t) => memberIds.has(t.id))).toBe(true);
    expect(tracks.slice(3).map((t) => t.id)).toEqual(['v1', 'v2']);
    expect(nowPlayingOpen()).toBe(true);
  });

  // The server caps seedIds at 20, so for a longer playlist the engine can't
  // exclude the tail members itself — the component must.
  it('filters a variation that is itself a playlist member', async () => {
    const members = [song({ id: 'm1' }), song({ id: 'm2' })];
    const { fixture, startRadioWithTracks } = setup({
      detail: detail(members),
      variations: [song({ id: 'm2' }), song({ id: 'v1' })],
    });
    await settle(fixture);

    fixture.nativeElement.querySelector('[data-testid="tastemaker-item"]').click();
    await settle(fixture);

    const tracks = startRadioWithTracks.mock.calls[0]![0] as Array<{ id: string }>;
    expect(tracks.slice(2).map((t) => t.id)).toEqual(['v1']);
  });

  it('an empty playlist toasts and never starts playback', async () => {
    const { fixture, startRadioWithTracks, toastShow } = setup({ detail: detail([]) });
    await settle(fixture);

    fixture.nativeElement.querySelector('[data-testid="tastemaker-item"]').click();
    await settle(fixture);

    expect(startRadioWithTracks).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(expect.objectContaining({ kind: 'info' }));
  });

  it('a radio-engine failure degrades to playing the picks alone', async () => {
    const { fixture, startRadioWithTracks, toastShow } = setup({
      detail: detail([song({ id: 'm1' }), song({ id: 'm2' })]),
      variations: 'error',
    });
    await settle(fixture);

    fixture.nativeElement.querySelector('[data-testid="tastemaker-item"]').click();
    await settle(fixture);

    const tracks = startRadioWithTracks.mock.calls[0]![0] as Array<{ id: string }>;
    expect(tracks.map((t) => t.id).sort()).toEqual(['m1', 'm2']);
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('a playlist-fetch failure toasts an error instead of dying silently', async () => {
    const { fixture, startRadioWithTracks, toastShow } = setup({ detail: 'error' });
    await settle(fixture);

    fixture.nativeElement.querySelector('[data-testid="tastemaker-item"]').click();
    await settle(fixture);

    expect(startRadioWithTracks).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });

  it('disables every tile while a blend is loading', async () => {
    const { fixture } = setup({
      playlists: [playlist({ id: 'c1' }), playlist({ id: 'c2', name: 'Deep Focus' })],
      detail: 'pending',
    });
    await settle(fixture);

    fixture.nativeElement.querySelector('[data-testid="tastemaker-item"]').click();
    fixture.detectChanges();

    const tiles = fixture.nativeElement.querySelectorAll('[data-testid="tastemaker-item"]');
    expect([...tiles].every((t: HTMLButtonElement) => t.disabled)).toBe(true);
  });
});
