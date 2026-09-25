import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { buildLibrary, buildLibraryOffThread, type ScannedTrack } from './library-scanner.js';

function library(n: number): ScannedTrack[] {
  return Array.from({ length: n }, (_, i) => ({
    relPath: `Artist ${i % 900}/Album ${i % 1800}/${i}.opus`,
    size: 1000 + i,
    mtimeMs: Date.parse('2026-01-01T00:00:00Z'),
    suffix: 'opus',
    contentType: 'audio/ogg',
    duration: 200,
    bitRate: 128,
    artist: `Artist ${i % 900}${i % 5 === 0 ? ` feat. Guest ${i % 50}` : ''}`,
    albumArtist: `Artist ${i % 900}`,
    album: `Album ${i % 1800}`,
    title: `Song ${i}`,
    track: (i % 12) + 1,
    genre: ['Rock', 'Indie'],
  }));
}

describe('a full scan builds the library off the event loop (#1313)', () => {
  it('returns exactly what the inline build returns', async () => {
    const tracks = library(300);
    expect(await buildLibraryOffThread(tracks)).toEqual(buildLibrary(tracks));
  });

  it('keeps the event loop responsive while a whole library builds', async () => {
    const tracks = library(20_000);
    let last = performance.now();
    let maxGap = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 10);
    try {
      const built = await buildLibraryOffThread(tracks);
      expect(built.songs).toHaveLength(20_000);
      // Let the timer fire once more, or a synchronous build ends before
      // any tick could record the gap it caused.
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      clearInterval(tick);
    }
    expect(maxGap).toBeLessThan(250);
  }, 60_000);

  it('falls back to the inline build when the inputs cannot cross to the worker', async () => {
    const tracks = library(50);
    // A function is not structured-cloneable, so postMessage throws; the build
    // itself never reads this entry.
    const overrides = new Map([['unused', { title: 'x', fn: () => 0 } as never]]);
    expect(await buildLibraryOffThread(tracks, undefined, overrides)).toEqual(
      buildLibrary(tracks, undefined, overrides),
    );
  });

  it('scanFull uses the worker build', () => {
    const src = readFileSync(join(import.meta.dir, 'library-scanner.ts'), 'utf8');
    const scanFull = src.slice(
      src.indexOf('async scanFull()'),
      src.indexOf('private canonicalByAlbum'),
    );
    expect(scanFull).toContain('await buildLibraryOffThread(');
    expect(scanFull).not.toMatch(/[^.\w]buildLibrary\(/);
  });
});
