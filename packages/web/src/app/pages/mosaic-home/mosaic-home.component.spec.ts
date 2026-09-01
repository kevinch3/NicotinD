import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { MosaicHomeComponent } from './mosaic-home.component';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { HistoryApiService } from '../../services/api/history-api.service';
import { PlaylistsApiService } from '../../services/api/playlists-api.service';
import { ToastService } from '../../services/toast.service';
import type {
  ListeningStats,
  PlaylistSummary,
  RecentPlay,
  Song,
} from '../../services/api/api-types';
import type { Track } from '../../services/player.service';

const song = (over: Partial<Song> = {}): Song => ({
  id: 's1',
  title: 'Track',
  artist: 'Artist',
  album: 'Album',
  albumId: 'al1',
  path: '/a.flac',
  bitRate: 320,
  size: 1,
  created: '2026-01-01',
  ...over,
});

const playlist = (over: Partial<PlaylistSummary> = {}): PlaylistSummary => ({
  id: 'p1',
  name: 'Curated Mix',
  description: null,
  songCount: 5,
  coverArt: null,
  kind: 'curated',
  createdAt: 0,
  modifiedAt: 0,
  ...over,
});

const recent = (over: Partial<RecentPlay> = {}): RecentPlay => ({
  songId: 'r1',
  title: 'Recent',
  artist: 'Artist',
  album: null,
  duration: null,
  coverArt: null,
  playedAt: 1,
  ...over,
});

const EMPTY_STATS: ListeningStats = {
  period: 'all',
  from: 0,
  to: 1,
  totals: { plays: 0, distinctSongs: 0, distinctArtists: 0, msPlayed: 0 },
  topSongs: [],
  topArtists: [],
  topAlbums: [],
  topGenres: [],
  clock: new Array(24).fill(0),
};

interface SetupOptions {
  recentPlays?: RecentPlay[];
  tasteBreakers?: Song[];
  keepVibe?: Song[];
  playlists?: PlaylistSummary[];
  genres?: Array<{ value: string; songCount: number; albumCount: number }>;
  filterRadio?: Song[];
  playlistSongs?: Song[];
  currentTrack?: Track | null;
  filterRadioFails?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const player = {
    currentTrack: signal<Track | null>(opts.currentTrack ?? null),
    nowPlayingOpen: signal(false),
    startRadio: vi.fn(),
    startRadioWithFilter: vi.fn(),
    startRadioWithTracks: vi.fn(),
  };
  const toast = { show: vi.fn() };
  const libraryApi = {
    getRandomSongs: vi.fn(() => of(opts.tasteBreakers ?? [])),
    getListRadio: vi.fn(() => of(opts.keepVibe ?? [])),
    getGenres: vi.fn(() => of(opts.genres ?? [])),
    getFilterRadio: vi.fn(() =>
      opts.filterRadioFails
        ? throwError(() => new Error('boom'))
        : of(opts.filterRadio ?? [song({ id: 'f1' })]),
    ),
  };
  const historyApi = {
    getRecentPlays: vi.fn(() => of(opts.recentPlays ?? [])),
    getStats: vi.fn(() => of(EMPTY_STATS)),
  };
  const playlistsApi = {
    getPlaylists: vi.fn(() => of({ playlists: opts.playlists ?? [] })),
    getPlaylist: vi.fn(() =>
      of({ ...playlist(), songs: opts.playlistSongs ?? [song({ id: 'ps1' })] }),
    ),
  };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [MosaicHomeComponent],
    providers: [
      { provide: PlayerService, useValue: player },
      { provide: ToastService, useValue: toast },
      { provide: LibraryApiService, useValue: libraryApi },
      { provide: HistoryApiService, useValue: historyApi },
      { provide: PlaylistsApiService, useValue: playlistsApi },
      { provide: AuthService, useValue: { token: () => 'tok' } },
    ],
  });
  const fixture = TestBed.createComponent(MosaicHomeComponent);
  fixture.detectChanges();
  return {
    fixture,
    component: fixture.componentInstance,
    player,
    toast,
    libraryApi,
    playlistsApi,
    historyApi,
  };
}

/** Let the parallel source loads and the dependent keep-the-vibe fetch settle. */
const settle = async (fixture: { detectChanges: () => void }): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  fixture.detectChanges();
};

describe('MosaicHomeComponent', () => {
  it('renders a tile per source, deduped', async () => {
    const { component, fixture } = setup({
      tasteBreakers: [song({ id: 'a' }), song({ id: 'b' })],
      genres: [{ value: 'rock', songCount: 10, albumCount: 2 }],
      playlists: [playlist()],
    });
    await settle(fixture);
    const kinds = component.tiles().map((t) => t.kind);
    expect(kinds.filter((k) => k === 'song')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'genre')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'playlist')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'vibe')).toHaveLength(8);
  });

  it('only shows curated playlists — a user playlist is not a tastemaker', async () => {
    const { component, fixture } = setup({
      playlists: [playlist({ id: 'c', kind: 'curated' }), playlist({ id: 'u', kind: 'user' })],
    });
    await settle(fixture);
    expect(
      component
        .tiles()
        .filter((t) => t.kind === 'playlist')
        .map((t) => t.key),
    ).toEqual(['playlist:c']);
  });

  // The whole point of the surface: one verb. Each branch of `start` must reach
  // a radio-start method, never plain playback.
  describe('every tile kind starts a radio', () => {
    it('song tiles use startRadio', async () => {
      const { component, player, fixture } = setup({ tasteBreakers: [song({ id: 'a' })] });
      await settle(fixture);
      const tile = component.tiles().find((t) => t.kind === 'song')!;
      await component.start(tile);
      expect(player.startRadio).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
      expect(player.nowPlayingOpen()).toBe(true);
    });

    it('a recently-played tile also starts a radio, not queued playback', async () => {
      // This is the one source that changed verb: the classic landing used
      // playWithContext, which kept the shelf as a queue.
      const { component, player, fixture } = setup({ recentPlays: [recent({ songId: 'r9' })] });
      await settle(fixture);
      const tile = component.tiles().find((t) => t.key === 'song:r9')!;
      await component.start(tile);
      expect(player.startRadio).toHaveBeenCalledWith(expect.objectContaining({ id: 'r9' }));
    });

    it('vibe tiles use startRadioWithFilter with the preset filter', async () => {
      const { component, player, fixture } = setup();
      await settle(fixture);
      const happy = component.tiles().find((t) => t.key === 'vibe:happy')!;
      await component.start(happy);
      expect(player.startRadioWithFilter).toHaveBeenCalledWith(expect.any(Array), {
        moods: ['happy'],
      });
    });

    it('genre tiles use startRadioWithFilter scoped to that genre', async () => {
      const { component, player, fixture } = setup({
        genres: [{ value: 'jazz', songCount: 4, albumCount: 1 }],
      });
      await settle(fixture);
      await component.start(component.tiles().find((t) => t.key === 'genre:jazz')!);
      expect(player.startRadioWithFilter).toHaveBeenCalledWith(expect.any(Array), {
        genres: ['jazz'],
      });
    });

    it('playlist tiles fetch the detail then use startRadioWithTracks', async () => {
      const { component, player, playlistsApi, fixture } = setup({
        playlists: [playlist({ id: 'p7' })],
      });
      await settle(fixture);
      await component.start(component.tiles().find((t) => t.kind === 'playlist')!);
      expect(playlistsApi.getPlaylist).toHaveBeenCalledWith('p7');
      expect(player.startRadioWithTracks).toHaveBeenCalled();
    });

    it('the resume tile starts a radio from the last-played track', async () => {
      const { component, player, fixture } = setup({
        currentTrack: { id: 'last', title: 'Last', artist: 'A' },
      });
      await settle(fixture);
      const tile = component.tiles().find((t) => t.kind === 'resume')!;
      await component.start(tile);
      expect(player.startRadio).toHaveBeenCalledWith(expect.objectContaining({ id: 'last' }));
    });
  });

  it('surfaces an empty vibe as a notice, not an error', async () => {
    const { component, toast, player, fixture } = setup({ filterRadio: [] });
    await settle(fixture);
    await component.start(component.tiles().find((t) => t.kind === 'vibe')!);
    expect(toast.show).toHaveBeenCalledWith({
      message: 'No tracks match that vibe yet',
      kind: 'info',
    });
    expect(player.startRadioWithFilter).not.toHaveBeenCalled();
  });

  it('reports a failed start instead of stranding the busy flag', async () => {
    const { component, toast, fixture } = setup({ filterRadioFails: true });
    await settle(fixture);
    await component.start(component.tiles().find((t) => t.kind === 'vibe')!);
    expect(toast.show).toHaveBeenCalledWith({
      message: "Couldn't start radio — try again",
      kind: 'error',
    });
    expect(component.starting()).toBeNull();
  });

  // One failing endpoint must cost its own tiles, not the whole mosaic.
  it('still renders when a source fails', async () => {
    const { component, fixture, libraryApi } = setup({ genres: [] });
    libraryApi.getRandomSongs.mockReturnValue(throwError(() => new Error('down')) as never);
    await settle(fixture);
    expect(component.tiles().filter((t) => t.kind === 'vibe')).toHaveLength(8);
  });

  it('seeds keep-the-vibe from the recent plays, and skips the call without them', async () => {
    const withHistory = setup({ recentPlays: [recent({ songId: 'r1' })] });
    await settle(withHistory.fixture);
    expect(withHistory.libraryApi.getListRadio).toHaveBeenCalledWith(['r1'], 10);

    const without = setup({ recentPlays: [] });
    await settle(without.fixture);
    expect(without.libraryApi.getListRadio).not.toHaveBeenCalled();
  });

  it('exposes every tile in a focusable list, since pooled tiles cannot hold focus order', async () => {
    const { fixture, component } = setup({
      tasteBreakers: [song({ id: 'a' })],
      genres: [{ value: 'rock', songCount: 3, albumCount: 1 }],
    });
    await settle(fixture);
    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '[data-testid="mosaic-tile-link"]',
    );
    expect(buttons).toHaveLength(component.tiles().length);
  });

  it('resolves vibe labels through i18n but leaves real titles alone', async () => {
    const { component, fixture } = setup({
      tasteBreakers: [song({ id: 'a', title: 'Real Title' })],
    });
    await settle(fixture);
    const vibe = component.tiles().find((t) => t.kind === 'vibe')!;
    const track = component.tiles().find((t) => t.kind === 'song')!;
    expect(component.label(vibe)).not.toBe('');
    expect(component.label(track)).toBe('Real Title');
  });
});
