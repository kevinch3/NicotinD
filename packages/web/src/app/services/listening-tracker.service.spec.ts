import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ListeningTrackerService, MAX_DELTA_SEC, accumulate } from './listening-tracker.service';
import { ListeningQueueService, type PlayEventPayload } from './listening-queue.service';
import type { Track } from '../types/core';

const TRACK = { id: 's1', title: 'Track', artist: 'Artist', duration: 300 } as Track;

function setup() {
  const enqueue = vi.fn();
  TestBed.configureTestingModule({
    providers: [ListeningTrackerService, { provide: ListeningQueueService, useValue: { enqueue } }],
  });
  return { svc: TestBed.inject(ListeningTrackerService), enqueue };
}

/** The single queued event, for readability in assertions. */
function queued(enqueue: ReturnType<typeof vi.fn>, nth = 0): PlayEventPayload {
  return enqueue.mock.calls[nth][0] as PlayEventPayload;
}

describe('accumulate', () => {
  it('adds ordinary forward playback', () => {
    expect(accumulate(0, 0, 0.25)).toBeCloseTo(0.25);
    expect(accumulate(10, 4, 4.25)).toBeCloseTo(10.25);
  });

  it('ignores a forward seek — scrubbing past audio is not listening', () => {
    expect(accumulate(10, 30, 90)).toBe(10);
  });

  it('ignores a backward seek', () => {
    expect(accumulate(10, 90, 30)).toBe(10);
  });

  it('counts a replayed section again, since it is real playback', () => {
    // Seek back (ignored), then play forward over the same audio (counted).
    let acc = accumulate(60, 60, 30);
    acc = accumulate(acc, 30, 30.5);
    expect(acc).toBeCloseTo(60.5);
  });

  it('treats exactly MAX_DELTA_SEC as playback and anything beyond as a seek', () => {
    expect(accumulate(0, 0, MAX_DELTA_SEC)).toBeCloseTo(MAX_DELTA_SEC);
    expect(accumulate(0, 0, MAX_DELTA_SEC + 0.01)).toBe(0);
  });

  it('ignores a zero delta (a paused timeupdate)', () => {
    expect(accumulate(5, 20, 20)).toBe(5);
  });

  it('never lets nonsense poison the accumulator', () => {
    expect(accumulate(5, Number.NaN, 10)).toBe(5);
    expect(accumulate(5, 10, Number.NaN)).toBe(5);
    expect(accumulate(Number.NaN, 0, 0.5)).toBeCloseTo(0.5);
  });
});

describe('ListeningTrackerService', () => {
  it('reports a completed session as raw facts', () => {
    const { svc, enqueue } = setup();
    svc.start(TRACK, 'album');
    for (let p = 0; p < 200; p += 0.5) svc.progress(p);
    svc.end('ended');

    const e = queued(enqueue);
    expect(e).toMatchObject({
      songId: 's1',
      reason: 'ended',
      source: 'album',
      durationMs: 300_000,
      title: 'Track',
      artist: 'Artist',
    });
    expect(e.msPlayed).toBeGreaterThan(190_000);
    // It reports ms listened — never whether that counted. That is the server's call.
    expect(e).not.toHaveProperty('counted');
  });

  it('emits nothing until a session ends', () => {
    const { svc, enqueue } = setup();
    svc.start(TRACK);
    svc.progress(10);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('closes an open session as `replaced` when another track starts', () => {
    const { svc, enqueue } = setup();
    svc.start(TRACK);
    svc.progress(0.5);
    svc.start({ ...TRACK, id: 's2' } as Track);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(queued(enqueue)).toMatchObject({ songId: 's1', reason: 'replaced' });
  });

  it('makes repeat-one two sessions, not one giant play', () => {
    const { svc, enqueue } = setup();
    svc.start(TRACK);
    svc.progress(0.5);
    svc.end('ended');
    svc.start(TRACK);
    svc.progress(0.5);
    svc.end('ended');

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(queued(enqueue, 0).clientEventId).not.toBe(queued(enqueue, 1).clientEventId);
  });

  it('ignores progress and end when no session is open', () => {
    const { svc, enqueue } = setup();
    svc.progress(10);
    svc.end('stopped');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses to start on a track with no id', () => {
    const { svc, enqueue } = setup();
    svc.start({ id: '' } as Track);
    svc.end('ended');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('reports a skip with the partial time actually listened', () => {
    const { svc, enqueue } = setup();
    svc.start(TRACK);
    for (let p = 0; p < 8; p += 0.5) svc.progress(p);
    svc.end('skipped');

    const e = queued(enqueue);
    expect(e.reason).toBe('skipped');
    expect(e.msPlayed).toBeLessThan(10_000);
  });

  it('does not credit a seek to the end as a full listen', () => {
    const { svc, enqueue } = setup();
    svc.start(TRACK);
    svc.progress(5);
    svc.progress(299); // dragged the scrubber
    svc.end('ended');

    expect(queued(enqueue).msPlayed).toBeLessThan(6_000);
  });

  it('carries a null duration through rather than inventing one', () => {
    const { svc, enqueue } = setup();
    svc.start({ ...TRACK, duration: 0 } as Track);
    svc.progress(0.5);
    svc.end('ended');
    expect(queued(enqueue).durationMs).toBeNull();
  });

  it('tracks which song is in flight', () => {
    const { svc } = setup();
    expect(svc.isTracking('s1')).toBe(false);
    svc.start(TRACK);
    expect(svc.isTracking('s1')).toBe(true);
    svc.end('ended');
    expect(svc.isTracking('s1')).toBe(false);
  });
});
