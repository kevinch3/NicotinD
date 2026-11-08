import { describe, expect, it } from 'bun:test';
import { BUFFER_SIZE, createLibraryEvents, type StampedEvent } from './library-events.js';

function manual() {
  let clock = 1_000;
  const timers: Array<() => void> = [];
  const bus = createLibraryEvents({
    now: () => clock,
    schedule: (fn) => void timers.push(fn),
  });
  const tick = () => {
    const fns = timers.splice(0);
    for (const fn of fns) fn();
  };
  const advance = (ms: number) => (clock += ms);
  return { bus, tick, advance };
}

describe('library events — coalescing', () => {
  it('merges same-type song events inside one window into a single delivery', () => {
    const { bus, tick } = manual();
    const seen: StampedEvent[] = [];
    bus.on((e) => seen.push(e));
    bus.emit({ type: 'songs.landed', songIds: ['a'], albumIds: ['x'] });
    bus.emit({ type: 'songs.landed', songIds: ['b', 'a'], albumIds: ['y'] });
    expect(seen).toHaveLength(0);
    tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toEqual({
      type: 'songs.landed',
      songIds: ['a', 'b'],
      albumIds: ['x', 'y'],
    });
    expect(seen[0]!.seq).toBe(1);
  });

  it('never merges across types, and keeps the last per-id event for single-id types', () => {
    const { bus, tick } = manual();
    const seen: StampedEvent[] = [];
    bus.on((e) => seen.push(e));
    bus.emit({ type: 'songs.landed', songIds: ['a'], albumIds: [] });
    bus.emit({ type: 'songs.deleted', songIds: ['b'], albumIds: [] });
    bus.emit({ type: 'album.changed', albumId: 'x' });
    bus.emit({ type: 'album.changed', albumId: 'x' });
    bus.emit({ type: 'album.changed', albumId: 'y' });
    tick();
    expect(seen.map((e) => e.event.type)).toEqual([
      'songs.landed',
      'songs.deleted',
      'album.changed',
      'album.changed',
    ]);
  });

  it('artwork.changed is one frame per window: changes unioned, highest rev per entity (#1666)', () => {
    const { bus, tick } = manual();
    const seen: StampedEvent[] = [];
    bus.on((e) => seen.push(e));
    bus.emit({ type: 'artwork.changed', changes: [{ kind: 'album', id: 'x', rev: 1 }] });
    bus.emit({ type: 'artwork.changed', changes: [{ kind: 'album', id: 'x', rev: 2 }] });
    bus.emit({ type: 'artwork.changed', changes: [{ kind: 'artist', id: 'x', rev: 5 }] });
    // A late, lower rev for the same entity never rewinds it.
    bus.emit({ type: 'artwork.changed', changes: [{ kind: 'album', id: 'x', rev: 1 }] });
    tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toEqual({
      type: 'artwork.changed',
      changes: [
        { kind: 'album', id: 'x', rev: 2 },
        { kind: 'artist', id: 'x', rev: 5 },
      ],
    });
  });

  it('a backfill-sized burst of cover changes cannot overflow the replay buffer', () => {
    const { bus, tick } = manual();
    bus.emit({ type: 'job.changed', jobId: 'before' });
    tick();
    const from = bus.lastSeq();
    for (let i = 0; i < BUFFER_SIZE * 3; i++) {
      bus.emit({ type: 'artwork.changed', changes: [{ kind: 'artist', id: `a${i}`, rev: 1 }] });
    }
    tick();
    const replay = bus.since(from);
    expect(replay).not.toBeNull(); // not a gap: every client keeps its place
    expect(replay).toHaveLength(1);
    expect((replay![0]!.event as { changes: unknown[] }).changes).toHaveLength(BUFFER_SIZE * 3);
  });

  it('a subscriber that throws does not stop delivery to the others', () => {
    const { bus, tick } = manual();
    const seen: number[] = [];
    bus.on(() => {
      throw new Error('boom');
    });
    bus.on((e) => seen.push(e.seq));
    bus.emit({ type: 'job.changed', jobId: 'j' });
    tick();
    expect(seen).toEqual([1]);
  });
});

describe('library events — replay', () => {
  it('since(seq) returns everything after seq, [] when caught up, null on a gap', () => {
    const { bus, tick } = manual();
    for (let i = 0; i < 3; i++) {
      bus.emit({ type: 'job.changed', jobId: `j${i}` });
      tick();
    }
    expect(bus.lastSeq()).toBe(3);
    expect(bus.since(1)?.map((e) => e.seq)).toEqual([2, 3]);
    expect(bus.since(3)).toEqual([]);
    expect(bus.since(0)?.map((e) => e.seq)).toEqual([1, 2, 3]);

    for (let i = 0; i < BUFFER_SIZE + 5; i++) {
      bus.emit({ type: 'job.changed', jobId: `k${i}` });
      tick();
    }
    // seq 1 fell out of the buffer: asking for "since 0" or "since 1" is a gap.
    expect(bus.since(0)).toBeNull();
    expect(bus.since(1)).toBeNull();
    expect(bus.since(bus.lastSeq() - 2)?.length).toBe(2);
  });

  it('forgets events older than the retention window even under the size cap', () => {
    const { bus, tick, advance } = manual();
    bus.emit({ type: 'job.changed', jobId: 'old' });
    tick();
    advance(11 * 60_000);
    bus.emit({ type: 'job.changed', jobId: 'new' });
    tick();
    expect(bus.since(0)).toBeNull();
    expect(bus.since(1)?.map((e) => e.seq)).toEqual([2]);
  });

  it('unsubscribe stops delivery', () => {
    const { bus, tick } = manual();
    const seen: number[] = [];
    const off = bus.on((e) => seen.push(e.seq));
    bus.emit({ type: 'job.changed', jobId: 'a' });
    tick();
    off();
    bus.emit({ type: 'job.changed', jobId: 'b' });
    tick();
    expect(seen).toEqual([1]);
  });
});
