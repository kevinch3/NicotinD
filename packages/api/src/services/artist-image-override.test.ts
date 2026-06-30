import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  hasArtistImageOverride,
  readArtistImageOverride,
  writeArtistImageOverride,
  deleteArtistImageOverride,
} from './artist-image-override.js';

let dataDir: string;
const BYTES = new Uint8Array([1, 2, 3, 4]);

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nd-artist-override-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe('artist-image-override store', () => {
  it('round-trips bytes with a content-type derived from the stored extension', async () => {
    expect(hasArtistImageOverride(dataDir, 'a1')).toBe(false);
    writeArtistImageOverride(dataDir, 'a1', BYTES, 'image/png');
    expect(hasArtistImageOverride(dataDir, 'a1')).toBe(true);
    const got = await readArtistImageOverride(dataDir, 'a1');
    expect(got?.contentType).toBe('image/png');
    expect(Array.from(got!.data)).toEqual([1, 2, 3, 4]);
  });

  it('maps webp/jpeg/unknown content-types to a sensible stored extension', async () => {
    writeArtistImageOverride(dataDir, 'webp', BYTES, 'image/webp');
    writeArtistImageOverride(dataDir, 'jpg', BYTES, 'image/jpeg');
    writeArtistImageOverride(dataDir, 'weird', BYTES, 'application/octet-stream');
    expect((await readArtistImageOverride(dataDir, 'webp'))?.contentType).toBe('image/webp');
    expect((await readArtistImageOverride(dataDir, 'jpg'))?.contentType).toBe('image/jpeg');
    // Unknown type falls back to .jpg → served as image/jpeg.
    expect((await readArtistImageOverride(dataDir, 'weird'))?.contentType).toBe('image/jpeg');
  });

  it('replaces a prior variant rather than leaving two files for one id', async () => {
    writeArtistImageOverride(dataDir, 'a1', BYTES, 'image/png');
    writeArtistImageOverride(dataDir, 'a1', new Uint8Array([9]), 'image/jpeg');
    expect(existsSync(join(dataDir, 'artist-overrides', 'a1.png'))).toBe(false);
    expect(existsSync(join(dataDir, 'artist-overrides', 'a1.jpg'))).toBe(true);
    expect(Array.from((await readArtistImageOverride(dataDir, 'a1'))!.data)).toEqual([9]);
  });

  it('delete removes the override (idempotent)', async () => {
    writeArtistImageOverride(dataDir, 'a1', BYTES, 'image/png');
    deleteArtistImageOverride(dataDir, 'a1');
    deleteArtistImageOverride(dataDir, 'a1'); // no throw on a missing one
    expect(hasArtistImageOverride(dataDir, 'a1')).toBe(false);
    expect(await readArtistImageOverride(dataDir, 'a1')).toBeNull();
  });

  it('returns null for an id with no override', async () => {
    expect(await readArtistImageOverride(dataDir, 'missing')).toBeNull();
  });
});
