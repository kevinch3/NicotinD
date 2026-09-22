import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { LibraryFilter } from '@nicotind/core';
import { RadioSourceService } from './radio-source.service';
import { PlayerService, type RadioProvider, type Track } from './player.service';
import { LibraryApiService } from './api/library-api.service';
import { SystemApiService } from './api/system-api.service';

function song(id: string) {
  return { id, title: id, artist: 'A' };
}

function radioSettings(queueTarget = 20) {
  return { genreAffinity: true, queueTarget, centroids: 0, computedAt: null };
}

function setup(queueTarget = 20) {
  const api = {
    getRadioNext: vi.fn(() => of([song('seeded')])),
    getFilterRadio: vi.fn(() => of([song('in-vibe')])),
    getAllSongs: vi.fn(() => of([song('recent')])),
  };
  const system = { getRadioSettings: vi.fn(() => of(radioSettings(queueTarget))) };
  TestBed.configureTestingModule({
    providers: [
      { provide: LibraryApiService, useValue: api },
      { provide: SystemApiService, useValue: system },
    ],
  });
  const player = TestBed.inject(PlayerService);
  const setRadioProvider = vi.spyOn(player, 'setRadioProvider');
  TestBed.inject(RadioSourceService).install();
  const provider = setRadioProvider.mock.calls[0]?.[0] as RadioProvider | undefined;
  return { api, system, player, setRadioProvider, provider };
}

/** Let the settings fetch and the fetch chain behind it run to a standstill. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const track: Track = { id: 's1', title: 'S', artist: 'A' };

describe('RadioSourceService', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('hands PlayerService a radio provider — the registration a shell used to own (#1127)', () => {
    const { setRadioProvider, provider } = setup();

    expect(setRadioProvider).toHaveBeenCalledTimes(1);
    expect(typeof provider).toBe('function');
  });

  it('installs once, however many times it is asked', () => {
    const { setRadioProvider } = setup();

    TestBed.inject(RadioSourceService).install();

    expect(setRadioProvider).toHaveBeenCalledTimes(1);
  });

  it('pulls in-vibe tracks while a filter radio is running', async () => {
    const { api, player, provider } = setup();
    const filter: LibraryFilter = { genres: ['Ambient'] };
    player.radioFilter.set(filter);

    const more = await provider!({
      currentTrack: track,
      context: null,
      strategy: 'balanced',
      count: 10,
    });

    expect(api.getFilterRadio).toHaveBeenCalledWith(filter, ['s1'], 10, 'balanced', {
      provenance: true,
    });
    expect(more.map((t) => t.id)).toEqual(['in-vibe']);
  });

  it('falls through to the seed lane when the filter is exhausted, so playback continues', async () => {
    const { api, player, provider } = setup();
    player.radioFilter.set({ genres: ['Nothing'] });
    api.getFilterRadio.mockReturnValue(of([]));

    const more = await provider!({
      currentTrack: track,
      context: null,
      strategy: 'similar',
      count: 10,
    });

    expect(api.getRadioNext).toHaveBeenCalledWith('s1', ['s1'], 10, 'similar', {
      provenance: true,
    });
    expect(more.map((t) => t.id)).toEqual(['seeded']);
  });

  it('asks for provenance on both refill lanes — this IS the player lane (#1124)', async () => {
    // The chip reports the radio you are hearing, and only a call made with
    // `{ provenance: true }` sets what it reads. This registration used to live
    // in `layout.component.ts`; when it moved here (#1127) the flag had to move
    // with it, and nothing else in the suite would notice if it were dropped —
    // the chip would simply go quiet, with every other test still green.
    const { api, player, provider } = setup();

    await provider!({ currentTrack: track, context: null, strategy: 'balanced', count: 10 });
    player.radioFilter.set({ genres: ['Ambient'] });
    await provider!({ currentTrack: track, context: null, strategy: 'balanced', count: 10 });

    for (const call of [...api.getRadioNext.mock.calls, ...api.getFilterRadio.mock.calls]) {
      expect(call.at(-1)).toEqual({ provenance: true });
    }
    expect(api.getRadioNext).toHaveBeenCalled();
    expect(api.getFilterRadio).toHaveBeenCalled();
  });

  it('shuffles recent songs when there is no seed at all', async () => {
    const { api, provider } = setup();

    const more = await provider!({
      currentTrack: null,
      context: null,
      strategy: 'balanced',
      count: 10,
    });

    expect(api.getAllSongs).toHaveBeenCalledWith(200, 0, { sort: 'newest' });
    expect(more.map((t) => t.id)).toEqual(['recent']);
  });

  it('excludes what is already queued or just played, so radio does not repeat itself', async () => {
    const { api, player, provider } = setup();
    player.queue.set([{ id: 'q1', title: 'Q', artist: 'A' }]);
    player.history.set([{ id: 'h1', title: 'H', artist: 'A' }]);

    await provider!({ currentTrack: track, context: null, strategy: 'balanced', count: 10 });

    expect(api.getRadioNext).toHaveBeenCalledWith('s1', ['s1', 'q1', 'h1'], 10, 'balanced', {
      provenance: true,
    });
  });

  it('keeps the queue alive end to end: radio on with an empty queue replenishes', async () => {
    // The whole point of the fix. Before it, `replenishRadio` returned on its
    // first line (`if (!this.radioProvider …) return`) and this queue stayed
    // empty forever — which is what silence on a TV looked like (#1127).
    const { player } = setup();
    player.play(track);
    player.ensureRadioOn();

    await settle();

    expect(player.queue().map((t) => t.id)).toEqual(['seeded']);
  });

  /**
   * The batch size used to be a `10` written in this file, so the depth the
   * listener saw and the depth an admin set lived in different places (#1263).
   * Every lane now asks for exactly what the queue is short of.
   */
  it('asks each lane for the shortfall the player names, not a fixed batch', async () => {
    const { api, player, provider } = setup();

    await provider!({ currentTrack: track, context: null, strategy: 'balanced', count: 3 });
    expect(api.getRadioNext).toHaveBeenCalledWith('s1', ['s1'], 3, 'balanced', {
      provenance: true,
    });

    player.radioFilter.set({ genres: ['Ambient'] });
    await provider!({ currentTrack: track, context: null, strategy: 'balanced', count: 7 });
    expect(api.getFilterRadio).toHaveBeenCalledWith(
      { genres: ['Ambient'] },
      ['s1'],
      7,
      'balanced',
      { provenance: true },
    );
  });

  it('trims the no-seed shuffle to the depth asked for, rather than dumping the pool in', async () => {
    const { api, provider } = setup();
    api.getAllSongs.mockReturnValue(of([song('a'), song('b'), song('c'), song('d')]));

    const more = await provider!({
      currentTrack: null,
      context: null,
      strategy: 'balanced',
      count: 2,
    });

    expect(more.length).toBe(2);
  });

  it("carries the admin's queue depth into the player", async () => {
    const { player, system } = setup(35);

    await settle();

    expect(system.getRadioSettings).toHaveBeenCalled();
    expect(player.radioQueueTarget()).toBe(35);
  });

  /** A server too old to have the field still answers; the built-in default stands. */
  it('keeps its default depth against a server that has no opinion', async () => {
    const api = {
      getRadioNext: vi.fn(() => of([song('seeded')])),
      getFilterRadio: vi.fn(() => of([])),
      getAllSongs: vi.fn(() => of([])),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryApiService, useValue: api },
        {
          provide: SystemApiService,
          useValue: { getRadioSettings: vi.fn(() => of({ genreAffinity: true })) },
        },
      ],
    });
    const player = TestBed.inject(PlayerService);
    TestBed.inject(RadioSourceService).install();

    await settle();

    expect(player.radioQueueTarget()).toBe(20);
  });

  it('without the install, radio has no source and the queue never refills', async () => {
    const api = {
      getRadioNext: vi.fn(() => of([song('seeded')])),
      getFilterRadio: vi.fn(() => of([])),
      getAllSongs: vi.fn(() => of([])),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: LibraryApiService, useValue: api },
        {
          provide: SystemApiService,
          useValue: { getRadioSettings: vi.fn(() => of(radioSettings())) },
        },
      ],
    });
    const player = TestBed.inject(PlayerService);
    player.play(track);
    player.ensureRadioOn();

    await settle();

    expect(api.getRadioNext).not.toHaveBeenCalled();
    expect(player.queue()).toEqual([]);
  });
});
