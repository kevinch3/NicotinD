import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { AutoPreserveCoordinator } from './auto-preserve-coordinator';
import { PlayerService } from './player.service';
import { PreserveService } from './preserve.service';
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
  };

  beforeEach(() => {
    player = {
      currentTrack: signal<Track | null>(null),
      queue: signal<Track[]>([]),
    };
    preserve = {
      autoPreserveMode: signal<'off' | '5' | '20' | 'full'>('off'),
      windowSize: vi.fn((n: number) => Math.min(5, Math.max(0, n))),
      ensureAutoPreservedFor: vi.fn(async () => {}),
    };

    TestBed.configureTestingModule({
      providers: [
        AutoPreserveCoordinator,
        { provide: PlayerService, useValue: player },
        { provide: PreserveService, useValue: preserve },
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
});