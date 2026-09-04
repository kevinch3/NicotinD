import { describe, expect, it, vi } from 'vitest';
import { isStaleChunkError, recoverStaleChunk, STALE_CHUNK_MARKER } from './stale-chunk';

describe('isStaleChunkError', () => {
  // The two shapes browsers actually produce for a lazy chunk that 404s.
  it('recognises a failed dynamic import', () => {
    expect(
      isStaleChunkError(
        new TypeError('error loading dynamically imported module: https://x/chunk-CXIY4XhS.js'),
      ),
    ).toBe(true);
    expect(
      isStaleChunkError(new TypeError('Failed to fetch dynamically imported module: /chunk-a.js')),
    ).toBe(true);
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
  });

  // A component that throws while constructing is NOT a stale build, and
  // reloading would hide a real bug behind an infinite-looking refresh.
  it('ignores an error from inside the loaded component', () => {
    expect(isStaleChunkError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isStaleChunkError(new Error('boom'))).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
    expect(isStaleChunkError('a string')).toBe(false);
  });
});

describe('recoverStaleChunk', () => {
  function fakeStorage(seed: Record<string, string> = {}) {
    const map = new Map(Object.entries(seed));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    } as unknown as Storage;
  }

  it('reloads once so the browser fetches the current build', () => {
    const reload = vi.fn();
    const store = fakeStorage();
    expect(recoverStaleChunk(reload, store)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  /**
   * The load-bearing guard. If the chunk is genuinely missing rather than
   * merely stale, reloading finds it missing again — an unbounded refresh loop
   * that looks like the app is broken beyond use. One attempt, then let the
   * error surface honestly.
   */
  it('refuses to reload twice, so a genuinely broken build cannot loop', () => {
    const reload = vi.fn();
    const store = fakeStorage({ [STALE_CHUNK_MARKER]: '1' });
    expect(recoverStaleChunk(reload, store)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('survives storage being unavailable rather than throwing over it', () => {
    const reload = vi.fn();
    const hostile = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {},
    } as unknown as Storage;
    // Private mode / blocked storage must not turn a recoverable stale chunk
    // into an exception of its own.
    expect(() => recoverStaleChunk(reload, hostile)).not.toThrow();
  });
});
