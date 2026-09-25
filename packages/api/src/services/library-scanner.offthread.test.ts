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
    expect(await buildLibraryOffThread([tracks])).toEqual(buildLibrary(tracks));
  });

  it('keeps the event loop responsive while a whole library builds', async () => {
    // 10k tracks: ~350 ms inline, well over the bar, without cloning a
    // whole-library heap into a worker inside a shared test process.
    const tracks = library(10_000);
    let last = performance.now();
    let maxGap = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 10);
    try {
      const built = await buildLibraryOffThread([tracks]);
      expect(built.songs).toHaveLength(10_000);
      // Let the timer fire once more, or a synchronous build ends before
      // any tick could record the gap it caused.
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      clearInterval(tick);
    }
    expect(maxGap).toBeLessThan(150);
  }, 60_000);

  it('falls back to the inline build when the worker fails', async () => {
    const tracks = library(50);
    // A worker that loads and then throws, not one terminated mid-boot: an
    // uncloneable input used to throw from postMessage while the worker was
    // still starting, and CI's bun crashed shortly after, twice (#1399).
    const failing = URL.createObjectURL(
      new Blob(["self.onmessage = () => { throw new Error('boom'); };"], {
        type: 'application/typescript',
      }),
    );
    expect(await buildLibraryOffThread([tracks], failing)).toEqual(buildLibrary(tracks));
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
