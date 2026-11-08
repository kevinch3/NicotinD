import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import {
  hasArtistImageOverride,
  readArtistImageOverride,
  writeArtistImageOverride,
  deleteArtistImageOverride,
} from './artist-image-override.js';

let dataDir: string;
let db: Database;
const BYTES = new Uint8Array([1, 2, 3, 4]);

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nd-artist-override-'));
  db = new Database(':memory:');
  applySchema(db);
  db.run(`INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('a1', 'A', 1, 0)`);
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const rev = (): number =>
  db
    .query<{ cover_rev: number }, []>(`SELECT cover_rev FROM library_artists WHERE id = 'a1'`)
    .get()!.cover_rev;

describe('artist-image-override store', () => {
  it('round-trips bytes with a content-type derived from the stored extension', async () => {
    expect(hasArtistImageOverride(dataDir, 'a1')).toBe(false);
    writeArtistImageOverride(db, dataDir, 'a1', BYTES, 'image/png');
    expect(hasArtistImageOverride(dataDir, 'a1')).toBe(true);
    const got = await readArtistImageOverride(dataDir, 'a1');
    expect(got?.contentType).toBe('image/png');
    expect(Array.from(got!.data)).toEqual([1, 2, 3, 4]);
  });

  it('maps webp/jpeg/unknown content-types to a sensible stored extension', async () => {
    writeArtistImageOverride(db, dataDir, 'webp', BYTES, 'image/webp');
    writeArtistImageOverride(db, dataDir, 'jpg', BYTES, 'image/jpeg');
    writeArtistImageOverride(db, dataDir, 'weird', BYTES, 'application/octet-stream');
    expect((await readArtistImageOverride(dataDir, 'webp'))?.contentType).toBe('image/webp');
    expect((await readArtistImageOverride(dataDir, 'jpg'))?.contentType).toBe('image/jpeg');
    // Unknown type falls back to .jpg → served as image/jpeg.
    expect((await readArtistImageOverride(dataDir, 'weird'))?.contentType).toBe('image/jpeg');
  });

  it('replaces a prior variant rather than leaving two files for one id', async () => {
    writeArtistImageOverride(db, dataDir, 'a1', BYTES, 'image/png');
    writeArtistImageOverride(db, dataDir, 'a1', new Uint8Array([9]), 'image/jpeg');
    expect(existsSync(join(dataDir, 'artist-overrides', 'a1.png'))).toBe(false);
    expect(existsSync(join(dataDir, 'artist-overrides', 'a1.jpg'))).toBe(true);
    expect(Array.from((await readArtistImageOverride(dataDir, 'a1'))!.data)).toEqual([9]);
  });

  it('delete removes the override (idempotent)', async () => {
    writeArtistImageOverride(db, dataDir, 'a1', BYTES, 'image/png');
    deleteArtistImageOverride(db, dataDir, 'a1');
    deleteArtistImageOverride(db, dataDir, 'a1'); // no throw on a missing one
    expect(hasArtistImageOverride(dataDir, 'a1')).toBe(false);
    expect(await readArtistImageOverride(dataDir, 'a1')).toBeNull();
  });

  it('returns null for an id with no override', async () => {
    expect(await readArtistImageOverride(dataDir, 'missing')).toBeNull();
  });
});

describe('artist-image-override cover_rev (#1666)', () => {
  it('a write bumps the artist rev and returns it', () => {
    expect(rev()).toBe(0);
    expect(writeArtistImageOverride(db, dataDir, 'a1', BYTES, 'image/png')).toBe(1);
    expect(writeArtistImageOverride(db, dataDir, 'a1', new Uint8Array([9]), 'image/png')).toBe(2);
    expect(rev()).toBe(2);
  });

  it('re-writing the same bytes under the same type bumps nothing', () => {
    writeArtistImageOverride(db, dataDir, 'a1', BYTES, 'image/png');
    expect(writeArtistImageOverride(db, dataDir, 'a1', BYTES, 'image/png')).toBe(1);
    // Same bytes as another type is a different stored file: a change.
    expect(writeArtistImageOverride(db, dataDir, 'a1', BYTES, 'image/webp')).toBe(2);
  });

  it('a delete bumps only when it removed an override', () => {
    expect(deleteArtistImageOverride(db, dataDir, 'a1')).toBe(false);
    expect(rev()).toBe(0);
    writeArtistImageOverride(db, dataDir, 'a1', BYTES, 'image/png');
    expect(deleteArtistImageOverride(db, dataDir, 'a1')).toBe(true);
    expect(rev()).toBe(2);
  });
});
