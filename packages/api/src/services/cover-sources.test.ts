/**
 * Unit tests for the cover-source helpers. The pure logic (dedupe, byte hashing,
 * distinct-embedded selection) is tested directly; the fs side (writeFolderCover,
 * extractEmbeddedPicture) uses a real temp dir + an injected stub loader so no
 * node builtins are mocked (mock.module leaks across files — see project memory).
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dedupeCoverUrls,
  hashBytes,
  selectDistinctEmbeddedCovers,
  extractEmbeddedPicture,
  writeFolderCover,
  type EmbeddedPicture,
} from './cover-sources.js';

describe('dedupeCoverUrls', () => {
  it('drops blanks and duplicates, preserving first-seen order', () => {
    expect(
      dedupeCoverUrls(['a', null, 'b', undefined, 'a', '', 'c', 'b']),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('hashBytes', () => {
  it('is stable and discriminates different content', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    const c = new Uint8Array([1, 2, 3, 5]);
    expect(hashBytes(a)).toBe(hashBytes(b));
    expect(hashBytes(a)).not.toBe(hashBytes(c));
  });
});

describe('selectDistinctEmbeddedCovers', () => {
  const pic = (bytes: number[]): EmbeddedPicture => ({
    data: new Uint8Array(bytes),
    contentType: 'image/jpeg',
  });

  it('returns one entry per distinct image, skipping empty/none', async () => {
    const songs = [
      { id: 's1', absPath: '/a' },
      { id: 's2', absPath: '/b' }, // same image as s1 → collapsed
      { id: 's3', absPath: '/c' }, // no art → skipped
      { id: 's4', absPath: '/d' }, // distinct
    ];
    const arts: Record<string, EmbeddedPicture | null> = {
      '/a': pic([1, 2, 3]),
      '/b': pic([1, 2, 3]),
      '/c': null,
      '/d': pic([9, 9, 9]),
    };
    const out = await selectDistinctEmbeddedCovers(songs, async (p) => arts[p] ?? null);
    expect(out).toEqual([{ songId: 's1' }, { songId: 's4' }]);
  });

  it('respects the limit', async () => {
    const songs = [
      { id: 's1', absPath: '/a' },
      { id: 's2', absPath: '/b' },
      { id: 's3', absPath: '/c' },
    ];
    const arts: Record<string, EmbeddedPicture> = {
      '/a': pic([1]),
      '/b': pic([2]),
      '/c': pic([3]),
    };
    const out = await selectDistinctEmbeddedCovers(songs, async (p) => arts[p]!, 2);
    expect(out).toHaveLength(2);
  });

  it('treats an extractor throw as no art', async () => {
    const out = await selectDistinctEmbeddedCovers(
      [{ id: 's1', absPath: '/x' }],
      async () => {
        throw new Error('boom');
      },
    );
    expect(out).toEqual([]);
  });
});

describe('extractEmbeddedPicture', () => {
  it('returns the first embedded picture via the injected loader', async () => {
    const loadMM = async () => ({
      parseFile: async () => ({
        common: { picture: [{ format: 'image/png', data: new Uint8Array([7, 7]) }] },
        format: {},
      }),
    });
    const pic = await extractEmbeddedPicture('/whatever', loadMM as never);
    expect(pic?.contentType).toBe('image/png');
    expect(Array.from(pic!.data)).toEqual([7, 7]);
  });

  it('returns null when the file has no picture', async () => {
    const loadMM = async () => ({
      parseFile: async () => ({ common: {}, format: {} }),
    });
    expect(await extractEmbeddedPicture('/whatever', loadMM as never)).toBeNull();
  });

  it('returns null when music-metadata is unavailable', async () => {
    expect(await extractEmbeddedPicture('/whatever', async () => null)).toBeNull();
  });
});

describe('writeFolderCover', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cover-sources-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes cover.jpg with the picture bytes', () => {
    const name = writeFolderCover(dir, {
      data: new Uint8Array([1, 2, 3]),
      contentType: 'image/jpeg',
    });
    expect(name).toBe('cover.jpg');
    expect(existsSync(join(dir, 'cover.jpg'))).toBe(true);
    expect(Array.from(readFileSync(join(dir, 'cover.jpg')))).toEqual([1, 2, 3]);
  });

  it('uses the matching extension for png/webp', () => {
    expect(writeFolderCover(dir, { data: new Uint8Array([1]), contentType: 'image/png' })).toBe(
      'cover.png',
    );
    expect(writeFolderCover(dir, { data: new Uint8Array([1]), contentType: 'image/webp' })).toBe(
      'cover.webp',
    );
  });
});
