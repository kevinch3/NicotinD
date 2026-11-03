import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { AutoPreserveCoordinator } from './auto-preserve-coordinator';
import { PlayerService } from './player.service';
import { PRESERVE_STORE, PreserveService } from './preserve.service';
import type { PreserveStore } from './preserve.service';
import { SetupService } from './setup.service';
import { AuthService } from './auth.service';
import type { Track } from './player.service';

function track(id: string): Track {
  return { id, title: `Title ${id}`, artist: 'Artist' };
}

/**
 * Pure-logic tests for the coordinator. We mock both services so the test
 * stays focused on which tracks get passed to `ensureAutoPreservedFor` given
 * a (mode, queue) pair — the actual fetch+store path is covered by
 * PreserveService.spec.
 */
describe('AutoPreserveCoordinator', () => {
  let player: {
    currentTrack: ReturnType<typeof signal<Track | null>>;
    queue: ReturnType<typeof signal<Track[]>>;
  };
  let preserve: {
    autoPreserveMode: ReturnType<typeof signal<'off' | '5' | '20' | 'full'>>;
    windowSize: ReturnType<typeof vi.fn>;
    ensureAutoPreservedFor: ReturnType<typeof vi.fn>;
    forgetAutoPreserveFailures: ReturnType<typeof vi.fn>;
  };
  let setup: { isOffline: ReturnType<typeof signal<boolean>> };

  beforeEach(() => {
    player = {
      currentTrack: signal<Track | null>(null),
      queue: signal<Track[]>([]),
    };
    preserve = {
      autoPreserveMode: signal<'off' | '5' | '20' | 'full'>('off'),
      windowSize: vi.fn((n: number) => Math.min(5, Math.max(0, n))),
      ensureAutoPreservedFor: vi.fn(async () => {}),
      forgetAutoPreserveFailures: vi.fn(),
    };
    setup = { isOffline: signal(false) };

    TestBed.configureTestingModule({
      providers: [
        AutoPreserveCoordinator,
        { provide: PlayerService, useValue: player },
        { provide: PreserveService, useValue: preserve },
        { provide: SetupService, useValue: setup },
      ],
    });
    // Constructing the coordinator subscribes the effect.
    TestBed.inject(AutoPreserveCoordinator);
  });

  it('does nothing when mode is off', async () => {
    preserve.autoPreserveMode.set('off');
    player.currentTrack.set(track('a'));
    player.queue.set([track('b'), track('c')]);

    await new Promise((r) => setTimeout(r, 0));
    expect(preserve.ensureAutoPreservedFor).not.toHaveBeenCalled();
  });

  it('passes [current, ...queue] to ensureAutoPreservedFor, sliced to windowSize', async () => {
    preserve.autoPreserveMode.set('5');
    preserve.windowSize.mockImplementation((n: number) => Math.min(5, n));
    player.currentTrack.set(track('a'));
    player.queue.set([track('b'), track('c'), track('d'), track('e'), track('f')]);

    await new Promise((r) => setTimeout(r, 0));
    const arg = preserve.ensureAutoPreservedFor.mock.calls[0]?.[0] as Track[];
    expect(arg.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('windowSize of 0 means no call (e.g. queue empty)', async () => {
    preserve.autoPreserveMode.set('full');
    preserve.windowSize.mockReturnValue(0);
    player.queue.set([track('a'), track('b')]);

    await new Promise((r) => setTimeout(r, 0));
    expect(preserve.ensureAutoPreservedFor).not.toHaveBeenCalled();
  });

  it('window respects actual queue length (no padding)', async () => {
    preserve.autoPreserveMode.set('full');
    preserve.windowSize.mockImplementation((n: number) => Math.min(200, n));
    player.currentTrack.set(track('a'));
    player.queue.set([track('b'), track('c')]);

    await new Promise((r) => setTimeout(r, 0));
    const arg = preserve.ensureAutoPreservedFor.mock.calls[0]?.[0] as Track[];
    expect(arg.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('re-fires when the queue grows (radio replenishment)', async () => {
    preserve.autoPreserveMode.set('20');
    preserve.windowSize.mockImplementation((n: number) => Math.min(20, n));

    player.currentTrack.set(track('a'));
    player.queue.set([track('b'), track('c')]);
    await new Promise((r) => setTimeout(r, 0));

    // Radio adds two more — coordinator should pick them up.
    player.queue.set([track('b'), track('c'), track('d'), track('e')]);
    await new Promise((r) => setTimeout(r, 0));

    expect(preserve.ensureAutoPreservedFor).toHaveBeenCalledTimes(2);
    const lastArg = preserve.ensureAutoPreservedFor.mock.calls.at(-1)?.[0] as Track[];
    expect(lastArg.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('passes only the queue when there is no current track', async () => {
    preserve.autoPreserveMode.set('20');
    preserve.windowSize.mockImplementation((n: number) => Math.min(20, n));
    player.queue.set([track('a'), track('b'), track('c')]);

    await new Promise((r) => setTimeout(r, 0));
    const arg = preserve.ensureAutoPreservedFor.mock.calls[0]?.[0] as Track[];
    expect(arg.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('asks for nothing while offline, and resumes on reconnect with failures forgotten', async () => {
    preserve.autoPreserveMode.set('5');
    setup.isOffline.set(true);
    player.currentTrack.set(track('a'));
    player.queue.set([track('b')]);
    await new Promise((r) => setTimeout(r, 0));
    expect(preserve.ensureAutoPreservedFor).not.toHaveBeenCalled();

    setup.isOffline.set(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(preserve.forgetAutoPreserveFailures).toHaveBeenCalledTimes(1);
    const arg = preserve.ensureAutoPreservedFor.mock.calls[0]?.[0] as Track[];
    expect(arg.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('never re-runs on the signals ensureAutoPreservedFor reads and writes', async () => {
    // The real service reads `preserving` synchronously, then writes it again
    // once the fetch settles — after the effect's run, which is what re-ran a
    // tracked call: offline that settle comes milliseconds later, every time.
    const preserving = signal(new Set<string>());
    preserve.ensureAutoPreservedFor.mockImplementation(async (tracks: Track[]) => {
      const seen = preserving();
      await Promise.resolve();
      preserving.set(new Set([...seen, ...tracks.map((t) => t.id)]));
    });
    preserve.autoPreserveMode.set('5');
    player.currentTrack.set(track('a'));
    for (let i = 0; i < 5; i++) {
      TestBed.tick();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(preserve.ensureAutoPreservedFor).toHaveBeenCalledTimes(1);
  });

  it('does not forget failures on an ordinary queue change', async () => {
    preserve.autoPreserveMode.set('5');
    player.currentTrack.set(track('a'));
    await new Promise((r) => setTimeout(r, 0));
    player.queue.set([track('b')]);
    await new Promise((r) => setTimeout(r, 0));
    expect(preserve.forgetAutoPreserveFailures).not.toHaveBeenCalled();
  });
});

/**
 * The coordinator against the REAL PreserveService. The suite above mocks the
 * service, which is exactly why it never saw the loop: the bug lived in what
 * the effect tracked through the service's own signal reads and writes.
 */
describe('AutoPreserveCoordinator × PreserveService (failing fetch)', () => {
  it('fetches each failing track once instead of looping on its own writes', async () => {
    // What WebKit's fetch does offline: reject at once.
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('Load failed');
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const store = {
      getAll: vi.fn(async () => []),
      evictAutoLRU: vi.fn(async () => []),
      preserve: vi.fn(async () => {}),
    } as unknown as PreserveStore;
    const player = {
      currentTrack: signal<Track | null>(track('a')),
      queue: signal<Track[]>([track('b'), track('c')]),
    };

    TestBed.configureTestingModule({
      providers: [
        AutoPreserveCoordinator,
        { provide: PlayerService, useValue: player },
        // Online as far as the app knows: the case the offline gate cannot
        // catch (the server only just went away), so the loop guard must.
        { provide: SetupService, useValue: { isOffline: signal(false) } },
        { provide: AuthService, useValue: { token: signal('tok'), mediaToken: signal('tok') } },
        { provide: PRESERVE_STORE, useValue: store },
      ],
    });
    TestBed.inject(PreserveService).autoPreserveMode.set('5');
    TestBed.inject(AutoPreserveCoordinator);

    // Give a self-retriggering effect every chance to spin: before the fix
    // this window saw hundreds of fetches for a three-track queue.
    for (let i = 0; i < 50; i++) {
      TestBed.tick();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
