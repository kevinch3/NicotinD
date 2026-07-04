import { type Observable, catchError, shareReplay, throwError } from 'rxjs';

/**
 * A lazily-memoized wrapper around a cold `Observable` source (e.g. an
 * `HttpClient.get`). Repeat `get()` calls within `ttlMs` share **one**
 * underlying request and replay its value, so re-navigating to a view that
 * fetches a stable list (artists, genres) doesn't re-hit the network each time.
 *
 * - A failed fetch is **not** retained (it would otherwise poison the cache for
 *   the whole TTL — a transient blip leaving a view blank); the next `get()`
 *   retries.
 * - `invalidate()` drops the cached value so the next `get()` re-fetches — call
 *   it when the underlying data changes (a download landed, a delete happened).
 * - `now` is injectable for deterministic tests.
 */
export interface CachedObservable<T> {
  get(): Observable<T>;
  invalidate(): void;
}

export function createCachedObservable<T>(
  source: () => Observable<T>,
  ttlMs = 30_000,
  now: () => number = Date.now,
): CachedObservable<T> {
  let cached: Observable<T> | null = null;
  let fetchedAt = 0;

  const api: CachedObservable<T> = {
    get() {
      if (cached && now() - fetchedAt < ttlMs) return cached;
      fetchedAt = now();
      cached = source().pipe(
        catchError((err) => {
          // Don't retain an error — let the next get() retry a fresh request.
          cached = null;
          return throwError(() => err);
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
      return cached;
    },
    invalidate() {
      cached = null;
    },
  };
  return api;
}
