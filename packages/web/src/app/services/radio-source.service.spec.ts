import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import type { LibraryFilter } from '@nicotind/core';
import { RadioSourceService } from './radio-source.service';
import { PlayerService, type RadioProvider, type Track } from './player.service';
import { LibraryApiService } from './api/library-api.service';

function song(id: string) {
  return { id, title: id, artist: 'A' };
}

function setup() {
  const api = {
    getRadioNext: vi.fn(() => of([song('seeded')])),
    getFilterRadio: vi.fn(() => of([song('in-vibe')])),
    getAllSongs: vi.fn(() => of([song('recent')])),
  };
  TestBed.configureTestingModule({
    providers: [{ provide: LibraryApiService, useValue: api }],
  });
  const player = TestBed.inject(PlayerService);
  const setRadioProvider = vi.spyOn(player, 'setRadioProvider');
  TestBed.inject(RadioSourceService).install();
  const provider = setRadioProvider.mock.calls[0]?.[0] as RadioProvider | undefined;
  return { api, player, setRadioProvider, provider };
}

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

    const more = await provider!({ currentTrack: track, context: null, strategy: 'balanced' });

    expect(api.getFilterRadio).toHaveBeenCalledWith(filter, ['s1'], 10, 'balanced');
    expect(more.map((t) => t.id)).toEqual(['in-vibe']);
  });

  it('falls through to the seed lane when the filter is exhausted, so playback continues', async () => {
    const { api, player, provider } = setup();
    player.radioFilter.set({ genres: ['Nothing'] });
    api.getFilterRadio.mockReturnValue(of([]));

    const more = await provider!({ currentTrack: track, context: null, strategy: 'similar' });

    expect(api.getRadioNext).toHaveBeenCalledWith('s1', ['s1'], 10, 'similar');
    expect(more.map((t) => t.id)).toEqual(['seeded']);
  });

  it('shuffles recent songs when there is no seed at all', async () => {
    const { api, provider } = setup();

    const more = await provider!({ currentTrack: null, context: null, strategy: 'balanced' });

    expect(api.getAllSongs).toHaveBeenCalledWith(200, 0, { sort: 'newest' });
    expect(more.map((t) => t.id)).toEqual(['recent']);
  });

  it('excludes what is already queued or just played, so radio does not repeat itself', async () => {
    const { api, player, provider } = setup();
    player.queue.set([{ id: 'q1', title: 'Q', artist: 'A' }]);
    player.history.set([{ id: 'h1', title: 'H', artist: 'A' }]);

    await provider!({ currentTrack: track, context: null, strategy: 'balanced' });

    expect(api.getRadioNext).toHaveBeenCalledWith('s1', ['s1', 'q1', 'h1'], 10, 'balanced');
  });

  it('keeps the queue alive end to end: radio on with an empty queue replenishes', async () => {
    // The whole point of the fix. Before it, `replenishRadio` returned on its
    // first line (`if (!this.radioProvider …) return`) and this queue stayed
    // empty forever — which is what silence on a TV looked like (#1127).
    const { player } = setup();
    player.play(track);
    player.ensureRadioOn();

    await Promise.resolve();
    await Promise.resolve();

    expect(player.queue().map((t) => t.id)).toEqual(['seeded']);
  });

  it('without the install, radio has no source and the queue never refills', async () => {
    const api = {
      getRadioNext: vi.fn(() => of([song('seeded')])),
      getFilterRadio: vi.fn(() => of([])),
      getAllSongs: vi.fn(() => of([])),
    };
    TestBed.configureTestingModule({
      providers: [{ provide: LibraryApiService, useValue: api }],
    });
    const player = TestBed.inject(PlayerService);
    player.play(track);
    player.ensureRadioOn();

    await Promise.resolve();
    await Promise.resolve();

    expect(api.getRadioNext).not.toHaveBeenCalled();
    expect(player.queue()).toEqual([]);
  });
});
