import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { MosaicHomeComponent, TILE_INSET } from './mosaic-home.component';
import { PlayerService } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { HistoryApiService } from '../../services/api/history-api.service';
import { Router } from '@angular/router';
import { PlaylistsApiService } from '../../services/api/playlists-api.service';
import { ToastService } from '../../services/toast.service';
import { TrackInfoService } from '../../services/track-info.service';
import { EntityMenuService } from '../../services/entity-menu.service';
import { SongMenuService } from '../../services/song-menu.service';
import { SetupService } from '../../services/setup.service';
import { NetworkStatusService } from '../../services/network-status.service';
import { PreserveService } from '../../services/preserve.service';
import type { PreservedTrackMeta } from '../../lib/preserve-store';
import type {
  ListeningStats,
  PlaylistSummary,
  RecentPlay,
  Song,
} from '../../services/api/api-types';
import type { Track } from '../../services/player.service';
import { LANE_MIX, type MosaicTile } from '../../lib/mosaic-tiles';
import type { PackedTile, Packing } from '../../lib/mosaic-packing';

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
  artistId: null,
  album: null,
  albumId: null,
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
  offline?: boolean;
  preserved?: PreservedTrackMeta[];
  recentPlays?: RecentPlay[];
  tasteBreakers?: Song[];
  keepVibe?: Song[];
  playlists?: PlaylistSummary[];
  genres?: Array<{ value: string; songCount: number; albumCount: number }>;
  filterRadio?: Song[];
  playlistSongs?: Song[];
  filterRadioFails?: boolean;
}

function setup(opts: SetupOptions = {}) {
  const player = {
    currentTrack: signal<Track | null>(null),
    nowPlayingOpen: signal(false),
    startRadio: vi.fn(),
    startRadioWithFilter: vi.fn(),
    startRadioWithTracks: vi.fn(),
    playWithContext: vi.fn(),
    playSingle: vi.fn(),
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
  const trackInfo = { open: vi.fn(), close: vi.fn() };
  const menuState = signal<unknown>(null);
  const entityMenu = {
    state: menuState.asReadonly(),
    open: vi.fn((s: unknown) => menuState.set(s)),
    close: vi.fn(() => menuState.set(null)),
    build: vi.fn((ref: { kind: string }) => [
      { label: `Start radio ${ref.kind}`, action: () => {} },
    ]),
  };
  const songMenu = {
    build: vi.fn(() => [
      { label: 'Start radio', action: () => {} },
      { label: 'Song info', action: () => {} },
    ]),
  };
  const isOffline = signal(opts.offline ?? false);
  const reconnects = signal(0);
  const preserve = {
    preservedTracks: signal(opts.preserved ?? []),
    refreshList: vi.fn(() => Promise.resolve()),
  };
  const router = { navigateByUrl: vi.fn() };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [MosaicHomeComponent],
    providers: [
      { provide: PlayerService, useValue: player },
      { provide: ToastService, useValue: toast },
      { provide: LibraryApiService, useValue: libraryApi },
      { provide: HistoryApiService, useValue: historyApi },
      { provide: PlaylistsApiService, useValue: playlistsApi },
      { provide: AuthService, useValue: { token: () => 'tok', mediaToken: () => 'tok' } },
      { provide: TrackInfoService, useValue: trackInfo },
      { provide: EntityMenuService, useValue: entityMenu },
      { provide: SongMenuService, useValue: songMenu },
      { provide: SetupService, useValue: { isOffline } },
      { provide: NetworkStatusService, useValue: { reconnects } },
      { provide: PreserveService, useValue: preserve },
      { provide: Router, useValue: router },
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
    trackInfo,
    entityMenu,
    songMenu,
    preserve,
    router,
    isOffline,
    reconnects,
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
      // Anchored on the playlist (#1277), so the top-up and heading stay on it.
      expect(player.startRadioWithTracks).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ seedIds: ['ps1'] }),
      );
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
    expect(withHistory.libraryApi.getListRadio).toHaveBeenCalledWith(
      ['r1'],
      LANE_MIX.keepVibe.pool,
    );

    const without = setup({ recentPlays: [] });
    await settle(without.fixture);
    expect(without.libraryApi.getListRadio).not.toHaveBeenCalled();
  });

  it('fetches each lane at its LANE_MIX pool size, and a whole budget of breakers', async () => {
    const { fixture, libraryApi, historyApi } = setup({ recentPlays: [recent({ songId: 'r1' })] });
    await settle(fixture);
    expect(historyApi.getRecentPlays).toHaveBeenCalledWith(LANE_MIX.recent.pool);
    // The breakers fetch the whole song budget, not their usual share: with no
    // history the other two lanes are empty and this one has to fill the field.
    expect(libraryApi.getRandomSongs).toHaveBeenCalledWith(LANE_MIX.songSlots);
  });

  it('has no tile for the current track — the mini-player is the one-tap continue', async () => {
    const { component, fixture, player } = setup({ tasteBreakers: [song({ id: 'b1' })] });
    player.currentTrack.set({ id: 'now', title: 'Now', artist: 'A' });
    await settle(fixture);
    expect(component.tiles().find((t) => t.key === 'song:now')).toBeUndefined();
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

/**
 * The private surface the next suites drive directly. jsdom gives the stage no
 * size, so the packing — and everything pointer- or frame-driven — never runs
 * through the DOM here; these tests exercise the glue behind it instead.
 */
interface MosaicInternals {
  schedulePress(t: MosaicTile, at: { x: number; y: number }, el?: HTMLElement | null): void;
  markHeld(el: HTMLElement | null): void;
  cancelPress(): void;
  onStageClick(e: MouseEvent): void;
  onStageContextMenu(e: MouseEvent): void;
  tileFromEvent(e: Event): MosaicTile | null;
  suppressTap: boolean;
  packing: Packing | null;
  cells: Map<string, unknown>;
  loadCell(cell: string): Promise<void>;
  enterCell(cell: string): unknown;
  frame(): void;
  wake(): void;
  running: boolean;
  raf: number;
  dragging: boolean;
  vx: number;
  vy: number;
}

const preservedMeta = (over: Partial<PreservedTrackMeta> = {}): PreservedTrackMeta => ({
  id: 'p1',
  title: 'Downloaded',
  artist: 'Artist',
  album: 'Album',
  size: 1000,
  format: 'flac',
  preservedAt: 1,
  lastAccessedAt: 1,
  source: 'user',
  ...over,
});
const internals = (c: unknown): MosaicInternals => c as MosaicInternals;

const packedStub = (id: number, size: number): PackedTile => ({
  tile: {
    key: `slot:${id}`,
    kind: 'song',
    title: '',
    subtitle: '',
    score: 0.5,
    action: { type: 'song', track: { id: `slot${id}`, title: '', artist: '' } },
  },
  id,
  x: 0,
  y: 0,
  size,
  half: size / 2,
});

describe('hold-for-menu (#1298)', () => {
  it('a held press on a song tile opens the song menu at the finger and swallows the tap', async () => {
    vi.useFakeTimers();
    try {
      const { component, entityMenu, songMenu, player, fixture } = setup({
        tasteBreakers: [song({ id: 'a', title: 'T', artist: 'A' })],
      });
      await settle(fixture);
      const c = internals(component);
      c.schedulePress(
        component.tiles().find((t) => t.kind === 'song')!,
        { x: 12, y: 34 },
      );
      vi.advanceTimersByTime(450);
      expect(songMenu.build).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
      expect(entityMenu.open).toHaveBeenCalledWith({
        actions: expect.arrayContaining([expect.objectContaining({ label: 'Song info' })]),
        at: { x: 12, y: 34 },
      });
      // The release that follows the hold must not start a radio under the
      // menu it just opened — the suppress flag eats exactly one click — and
      // must not bubble to the document, where the host would close the menu.
      expect(c.suppressTap).toBe(true);
      const release = new MouseEvent('click', { bubbles: true });
      const stop = vi.spyOn(release, 'stopPropagation');
      c.onStageClick(release);
      expect(c.suppressTap).toBe(false);
      expect(stop).toHaveBeenCalled();
      expect(player.startRadio).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a press released before the hold threshold opens nothing', async () => {
    vi.useFakeTimers();
    try {
      const { component, entityMenu, fixture } = setup({ tasteBreakers: [song({ id: 'a' })] });
      await settle(fixture);
      const c = internals(component);
      c.schedulePress(
        component.tiles().find((t) => t.kind === 'song')!,
        { x: 0, y: 0 },
      );
      vi.advanceTimersByTime(200);
      c.cancelPress();
      vi.advanceTimersByTime(1000);
      expect(entityMenu.open).not.toHaveBeenCalled();
      expect(c.suppressTap).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('every tile kind draws its menu from one source: song → song menu, playlist/genre → entity menu, vibe → its one verb', async () => {
    const { component, entityMenu, fixture } = setup({
      tasteBreakers: [song({ id: 'a' })],
      playlists: [playlist({ id: 'p1', name: 'P', kind: 'curated' })],
      genres: [{ value: 'jazz', songCount: 3, albumCount: 1 }],
    });
    await settle(fixture);
    const byKind = (kind: string) => component.tiles().find((t) => t.kind === kind)!;
    expect(component.tileActions(byKind('song')).map((a) => a.label)).toContain('Song info');
    component.tileActions(byKind('playlist'));
    expect(entityMenu.build).toHaveBeenCalledWith({ kind: 'playlist', id: 'p1', name: 'P' });
    component.tileActions(byKind('genre'));
    expect(entityMenu.build).toHaveBeenCalledWith({ kind: 'genre', value: 'jazz' });
    expect(component.tileActions(byKind('vibe')).map((a) => a.label)).toEqual(['Start radio']);
  });

  it('right-click on a tile opens its menu at the pointer and suppresses the browser menu', async () => {
    const { component, entityMenu, fixture } = setup({ tasteBreakers: [song({ id: 'a' })] });
    await settle(fixture);
    const c = internals(component);
    const tile = component.tiles().find((t) => t.kind === 'song')!;
    // The stage's delegated resolution is covered by the tap tests; here the
    // event → tile step is stubbed so the assertion is about the menu.
    vi.spyOn(c, 'tileFromEvent').mockReturnValue(tile);
    const e = new MouseEvent('contextmenu', { cancelable: true, clientX: 5, clientY: 6 });
    c.onStageContextMenu(e);
    expect(e.defaultPrevented).toBe(true);
    expect(entityMenu.open).toHaveBeenCalledWith({
      actions: expect.any(Array),
      at: { x: 5, y: 6 },
    });
  });

  it("a press on a face's ⋯ is the button's, not a pan", async () => {
    const { component, fixture } = setup({ tasteBreakers: [song({ id: 'a' })] });
    await settle(fixture);
    const start = vi.spyOn(component.drag, 'start');
    const more = document.createElement('button');
    more.setAttribute('data-more', '');
    const e = new MouseEvent('pointerdown') as unknown as PointerEvent;
    Object.defineProperty(e, 'target', { value: more });
    component.onStagePointerDown(e);
    expect(start).not.toHaveBeenCalled();
  });
});

describe('mosaic depth (#1638)', () => {
  const tileEl = (): { el: HTMLElement; target: HTMLElement } => {
    const el = document.createElement('div');
    el.className = 'mosaic-tile';
    el.dataset['tileId'] = '0';
    const target = document.createElement('b');
    el.appendChild(target);
    return { el, target };
  };

  it('a hold lifts the tile whose menu it opened, and the menu closing lets it down', async () => {
    vi.useFakeTimers();
    try {
      const { component, entityMenu, fixture } = setup({ tasteBreakers: [song({ id: 'a' })] });
      await settle(fixture);
      const c = internals(component);
      const { el } = tileEl();
      c.schedulePress(
        component.tiles().find((t) => t.kind === 'song')!,
        { x: 1, y: 2 },
        el,
      );
      expect(el.classList.contains('is-held')).toBe(false);
      vi.advanceTimersByTime(450);
      expect(el.classList.contains('is-held')).toBe(true);
      expect(component.holding()).toBe(true);
      // Escape, an outside tap, Back and running an item all end in close().
      entityMenu.close();
      fixture.detectChanges();
      expect(el.classList.contains('is-held')).toBe(false);
      expect(component.holding()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('right-click lifts the tile under the pointer, and a second menu moves the lift', async () => {
    const { component, fixture } = setup({ tasteBreakers: [song({ id: 'a' })] });
    await settle(fixture);
    const c = internals(component);
    vi.spyOn(c, 'tileFromEvent').mockReturnValue(component.tiles().find((t) => t.kind === 'song')!);
    const first = tileEl();
    const second = tileEl();
    for (const { target } of [first, second]) {
      const e = new MouseEvent('contextmenu', { cancelable: true });
      Object.defineProperty(e, 'target', { value: target });
      c.onStageContextMenu(e);
      fixture.detectChanges();
    }
    expect(first.el.classList.contains('is-held')).toBe(false);
    expect(second.el.classList.contains('is-held')).toBe(true);
  });

  it("a face's type and padding scale with its size, so a small tile's label is not clipped", async () => {
    const { component, fixture } = setup({ tasteBreakers: [song({ id: 'a' })] });
    await settle(fixture);
    const html = (size: number) =>
      (component as unknown as { tileHtml(p: PackedTile, t: MosaicTile): string }).tileHtml(
        packedStub(0, size),
        component.tiles().find((t) => t.kind === 'song')!,
      );
    expect(html(60)).toContain('--face-pad:5px');
    expect(html(60)).toContain('font-size:9px');
    // Big faces keep the sizes they always had.
    expect(html(220)).toContain('--face-pad:12px');
    expect(html(220)).toContain('font-size:17px');
  });

  describe('in the loop', () => {
    const drawn = async () => {
      const { component, fixture } = setup();
      await settle(fixture);
      const c = internals(component);
      cancelAnimationFrame(c.raf);
      const realRaf = globalThis.requestAnimationFrame.bind(globalThis);
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) =>
        cb === c.frame ? 1 : realRaf(cb),
      );
      const stage = document.createElement('div');
      Object.defineProperty(component, 'stageRef', { value: () => ({ nativeElement: stage }) });
      c.raf = 0;
      c.running = true;
      c.dragging = false;
      c.vx = 0;
      c.vy = 0;
      c.packing = { W: 500, tiles: [packedStub(0, 100)] };
      c.frame();
      const el = stage.querySelector<HTMLElement>('.mosaic-tile')!;
      return { component, c, el };
    };

    afterEach(() => vi.restoreAllMocks());

    it('a pooled tile is its face plus shadow room on every side, centred where the lens put the face', async () => {
      const { el } = await drawn();
      // `contain: strict` clips paint at the box, so the shadow needs room inside it.
      expect(el.style.width).toBe(`${100 + 2 * TILE_INSET}px`);
      expect(el.style.height).toBe(`${100 + 2 * TILE_INSET}px`);
      // The lens places a 100px face at (-50, -50); the bigger box shifts back by the inset.
      expect(el.style.transform).toContain(
        `translate(${-50 - TILE_INSET}.0px,${-50 - TILE_INSET}.0px)`,
      );
    });

    /** Drive the stage's drag the way the browser does: down on the stage, the rest on document. */
    const pointer = (drag: MosaicHomeComponent['drag'], type: string, x: number): void => {
      const e = new MouseEvent(type, { clientX: x, clientY: 0, bubbles: true });
      if (type === 'pointerdown') drag.start(e as unknown as PointerEvent);
      else document.dispatchEvent(e);
    };

    it('a pan stands the rim blur down, and the coast coming to rest brings it back', async () => {
      const { component, c, el } = await drawn();
      const stage = el.parentElement!;
      pointer(component.drag, 'pointerdown', 0);
      pointer(component.drag, 'pointermove', 20);
      // Measured on a weak GPU: the blur re-renders the whole field every
      // frame of a pan and quadrupled the dropped frames (#1638).
      expect(stage.classList.contains('is-moving')).toBe(true);
      pointer(component.drag, 'pointerup', 20);
      let frames = 0;
      while ((c.vx !== 0 || c.vy !== 0) && frames++ < 1_000) c.frame();
      c.frame();
      expect(stage.classList.contains('is-moving')).toBe(false);
    });

    it('a tap or a still hold leaves the blur alone — no flicker on every press', async () => {
      const { component, c, el } = await drawn();
      const stage = el.parentElement!;
      pointer(component.drag, 'pointerdown', 0);
      pointer(component.drag, 'pointermove', 3); // inside the tap slop
      c.frame();
      expect(stage.classList.contains('is-moving')).toBe(false);
      pointer(component.drag, 'pointerup', 3);
      c.frame();
      expect(stage.classList.contains('is-moving')).toBe(false);
    });

    it('a held tile that leaves the lens is let down as it is parked', async () => {
      const { component, c, el } = await drawn();
      c.markHeld(el);
      expect(component.holding()).toBe(true);
      c.packing = { W: 500, tiles: [] };
      c.frame();
      expect(el.classList.contains('is-held')).toBe(false);
      expect(component.holding()).toBe(false);
    });
  });
});

describe('discovery cells', () => {
  it('fills a sighted cell with fresh songs, the hottest into the biggest slot', async () => {
    const { component, libraryApi, fixture } = setup();
    await settle(fixture);
    const c = internals(component);
    c.packing = { W: 500, tiles: [packedStub(0, 200), packedStub(1, 100)] };
    c.cells.set('1,0', 'loading');
    libraryApi.getRandomSongs.mockReturnValue(
      of([song({ id: 'y', popularity: 0 }), song({ id: 'x', popularity: 1 })]) as never,
    );
    await c.loadCell('1,0');
    const state = c.cells.get('1,0') as Map<number, MosaicTile>;
    expect(state.get(0)!.key).toBe('song:x');
    expect(state.get(1)!.key).toBe('song:y');
    // The accessible list mirrors what discovery surfaced.
    expect(component.discovered().map((t) => t.key)).toEqual(
      expect.arrayContaining(['song:x', 'song:y']),
    );
  });

  it('falls back to the home copy when the fetch fails — never a hole, never a retry loop', async () => {
    const { component, libraryApi, fixture } = setup();
    await settle(fixture);
    const c = internals(component);
    c.packing = { W: 500, tiles: [packedStub(0, 100)] };
    c.cells.set('0,1', 'loading');
    libraryApi.getRandomSongs.mockReturnValue(throwError(() => new Error('down')) as never);
    await c.loadCell('0,1');
    expect(c.cells.get('0,1')).toBe('base');
    expect(component.discovered()).toEqual([]);
  });

  it('fetches nothing at all while offline — a doomed request per cell is worse than a repeat', async () => {
    const { component, libraryApi, fixture } = setup({
      offline: true,
      preserved: [preservedMeta({ id: 'd1' })],
    });
    await settle(fixture);
    libraryApi.getRandomSongs.mockClear();
    const c = internals(component);
    c.packing = { W: 500, tiles: [packedStub(0, 100)] };
    expect(c.enterCell('1,1')).toBe('base');
    expect(libraryApi.getRandomSongs).not.toHaveBeenCalled();
  });

  it('drops a batch that lands after its cell was evicted', async () => {
    const { component, libraryApi, fixture } = setup();
    await settle(fixture);
    const c = internals(component);
    c.packing = { W: 500, tiles: [packedStub(0, 100)] };
    libraryApi.getRandomSongs.mockReturnValue(of([song({ id: 'late' })]) as never);
    await c.loadCell('2,2'); // never marked 'loading' — the cell was evicted meanwhile
    expect(c.cells.has('2,2')).toBe(false);
    expect(component.discovered()).toEqual([]);
  });
});

describe('the loop sleeps at rest', () => {
  let scheduled: FrameRequestCallback[];

  const ready = async () => {
    const { component, libraryApi, fixture } = setup();
    await settle(fixture);
    const c = internals(component);
    // Take the loop over from whatever the mount scheduled.
    cancelAnimationFrame(c.raf);
    scheduled = [];
    // Only the mosaic's own frames: Angular's zoneless scheduler races a
    // requestAnimationFrame of its own against a timeout.
    const realRaf = globalThis.requestAnimationFrame.bind(globalThis);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      if (cb !== c.frame) return realRaf(cb);
      scheduled.push(cb);
      return scheduled.length;
    });
    // jsdom renders no stage for this fixture's field; frames need one.
    const stage = document.createElement('div');
    Object.defineProperty(component, 'stageRef', { value: () => ({ nativeElement: stage }) });
    c.raf = 0;
    c.running = true;
    c.dragging = false;
    c.vx = 0;
    c.vy = 0;
    c.packing = { W: 500, tiles: [packedStub(0, 100)] };
    return { c, libraryApi };
  };

  afterEach(() => vi.restoreAllMocks());

  it('draws a frame and asks for no other while nothing moves', async () => {
    const { c } = await ready();
    c.frame();
    expect(scheduled).toHaveLength(0);
  });

  it('keeps drawing while it coasts, then stops once friction brings it to rest', async () => {
    const { c } = await ready();
    c.vx = 40;
    c.frame();
    let frames = 1;
    while (scheduled.length > 0 && frames < 1_000) {
      scheduled.shift()!(0);
      frames++;
    }
    expect(scheduled).toHaveLength(0);
    expect(c.vx).toBe(0);
    expect(frames).toBeGreaterThan(2);
    expect(frames).toBeLessThan(1_000);
  });

  it('keeps drawing for as long as a drag is held', async () => {
    const { c } = await ready();
    c.dragging = true;
    c.frame();
    expect(scheduled).toHaveLength(1);
  });

  it('wake asks for one frame however often it is called, and none off screen', async () => {
    const { c } = await ready();
    c.running = false;
    c.wake();
    expect(scheduled).toHaveLength(0);
    c.running = true;
    c.wake();
    c.wake();
    expect(scheduled).toHaveLength(1);
  });

  it('a discovery batch landing wakes the sleeping loop to draw it', async () => {
    const { c, libraryApi } = await ready();
    c.cells.set('1,0', 'loading');
    libraryApi.getRandomSongs.mockReturnValue(of([song({ id: 'x' })]) as never);
    await c.loadCell('1,0');
    expect(scheduled).toHaveLength(1);
  });
});

describe('offline', () => {
  it('fills with the downloaded set instead of dead server-backed tiles', async () => {
    const { component, fixture, libraryApi, historyApi } = setup({
      offline: true,
      preserved: [preservedMeta({ id: 'd1' }), preservedMeta({ id: 'd2' })],
    });
    await settle(fixture);

    expect(component.tiles().filter((t) => t.kind === 'song')).toHaveLength(2);
    // None of the online lanes should even have been attempted.
    expect(libraryApi.getRandomSongs).not.toHaveBeenCalled();
    expect(libraryApi.getGenres).not.toHaveBeenCalled();
    expect(historyApi.getRecentPlays).not.toHaveBeenCalled();
    // And no vibe tiles, whose filters can only be resolved by the server.
    expect(component.tiles().filter((t) => t.kind === 'vibe')).toHaveLength(0);
  });

  it('plays a downloaded tile with the whole downloaded set as its queue', async () => {
    const { component, player, fixture } = setup({
      offline: true,
      preserved: [preservedMeta({ id: 'd1' }), preservedMeta({ id: 'd2' })],
    });
    await settle(fixture);

    await component.start(component.tiles().find((t) => t.key === 'song:d2')!);
    expect(player.playWithContext).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'd1' }), expect.objectContaining({ id: 'd2' })],
      1,
      { type: 'saved-offline', name: 'Downloaded' },
    );
    // Radio would need the server to supply a next track.
    expect(player.startRadio).not.toHaveBeenCalled();
  });

  it('routes the downloads tile to the list rather than starting playback', async () => {
    const { component, player, router, fixture } = setup({
      offline: true,
      preserved: [preservedMeta({ id: 'd1' })],
    });
    await settle(fixture);

    await component.start(component.tiles().find((t) => t.kind === 'downloads')!);
    expect(router.navigateByUrl).toHaveBeenCalledWith('/library');
    expect(player.playWithContext).not.toHaveBeenCalled();
    // A navigation must not raise the Now Playing sheet over the page it opens.
    expect(player.nowPlayingOpen()).toBe(false);
  });

  it('swaps to the downloaded set when the network drops mid-session', async () => {
    const { component, fixture, isOffline, preserve } = setup({
      tasteBreakers: [song({ id: 'online-only' })],
      preserved: [preservedMeta({ id: 'd1' })],
    });
    await settle(fixture);
    expect(component.tiles().some((t) => t.key === 'song:online-only')).toBe(true);

    isOffline.set(true);
    fixture.detectChanges();
    await settle(fixture);

    expect(preserve.refreshList).toHaveBeenCalled();
    expect(component.tiles().some((t) => t.key === 'song:online-only')).toBe(false);
    expect(component.tiles().some((t) => t.kind === 'downloads')).toBe(true);
  });

  it('restores the real sources on reconnect', async () => {
    const { component, fixture, isOffline, reconnects } = setup({
      offline: true,
      preserved: [preservedMeta({ id: 'd1' })],
      tasteBreakers: [song({ id: 'back' })],
    });
    await settle(fixture);
    expect(component.tiles().some((t) => t.kind === 'downloads')).toBe(true);

    isOffline.set(false);
    reconnects.set(1);
    fixture.detectChanges();
    await settle(fixture);

    expect(component.tiles().some((t) => t.key === 'song:back')).toBe(true);
    expect(component.tiles().some((t) => t.kind === 'downloads')).toBe(false);
  });

  it('says it is offline rather than telling you to add music', async () => {
    const { fixture, component } = setup({ offline: true, preserved: [] });
    await settle(fixture);
    expect(component.tiles()).toEqual([]);
    expect(component.isEmpty()).toBe(true);
    const text = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="mosaic-empty"]',
    )?.textContent;
    expect(text).toContain("You're offline");
    expect(text).not.toContain('add some music');
  });
});
