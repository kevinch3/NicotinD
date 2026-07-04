import { describe, it, expect, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { createCachedObservable } from './cached-observable';

describe('createCachedObservable', () => {
  it('calls the source once and replays the value to repeat subscribers within the TTL', () => {
    let calls = 0;
    const cache = createCachedObservable(() => {
      calls++;
      return of(calls);
    }, 1000);

    let first: number | undefined;
    let second: number | undefined;
    cache.get().subscribe((v) => (first = v));
    cache.get().subscribe((v) => (second = v));

    expect(calls).toBe(1);
    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  it('re-fetches after the TTL elapses', () => {
    let clock = 0;
    let calls = 0;
    const cache = createCachedObservable(
      () => {
        calls++;
        return of(calls);
      },
      1000,
      () => clock,
    );

    cache.get().subscribe();
    expect(calls).toBe(1);

    clock = 1500; // past the 1000ms TTL
    cache.get().subscribe();
    expect(calls).toBe(2);
  });

  it('re-fetches after an explicit invalidate()', () => {
    let calls = 0;
    const cache = createCachedObservable(() => {
      calls++;
      return of(calls);
    }, 10_000);

    cache.get().subscribe();
    cache.invalidate();
    let v: number | undefined;
    cache.get().subscribe((x) => (v = x));

    expect(calls).toBe(2);
    expect(v).toBe(2);
  });

  it('does not cache a failed fetch — the next get() retries', () => {
    let calls = 0;
    const cache = createCachedObservable(() => {
      calls++;
      return calls === 1 ? throwError(() => new Error('boom')) : of(calls);
    }, 10_000);

    let firstErr: unknown;
    cache.get().subscribe({ error: (e) => (firstErr = e) });
    expect(firstErr).toBeInstanceOf(Error);

    // The error must not be retained; the next call re-hits the source.
    let v: number | undefined;
    cache.get().subscribe((x) => (v = x));
    expect(calls).toBe(2);
    expect(v).toBe(2);
  });
});
