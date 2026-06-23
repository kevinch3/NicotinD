import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import {
  setArtwork,
  resolveArtwork,
  pickAlbumCover,
  pickArtistImage,
  canonicalCacheKey,
  purgeCanonicalCache,
} from './artwork-store.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('resolveArtwork', () => {
  it('returns a direct album hit', () => {
    setArtwork(db, 'alb-1', 'album', 'https://x/cover.jpg');
    expect(resolveArtwork(db, 'alb-1')).toEqual({ url: 'https://x/cover.jpg', key: 'alb-1' });
  });

  it('returns a direct artist hit', () => {
    setArtwork(db, 'art-1', 'artist', 'https://x/poster.jpg');
    expect(resolveArtwork(db, 'art-1')).toEqual({ url: 'https://x/poster.jpg', key: 'art-1' });
  });

  it('maps a song id to its album artwork', () => {
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, synced_at)
       VALUES ('song-1', 'alb-1', 'T', 'A', 'art-1', 0, 'a/b.mp3', 1)`,
    );
    setArtwork(db, 'alb-1', 'album', 'https://x/cover.jpg');
    expect(resolveArtwork(db, 'song-1')).toEqual({ url: 'https://x/cover.jpg', key: 'alb-1' });
  });

  it('returns null when nothing matches', () => {
    expect(resolveArtwork(db, 'nope')).toBeNull();
  });
});

describe('setArtwork', () => {
  it('upserts (latest URL wins)', () => {
    setArtwork(db, 'alb-1', 'album', 'https://x/old.jpg');
    setArtwork(db, 'alb-1', 'album', 'https://x/new.jpg');
    expect(resolveArtwork(db, 'alb-1')?.url).toBe('https://x/new.jpg');
    const count = db.query<{ n: number }, []>('SELECT COUNT(*) n FROM library_artwork').get();
    expect(count?.n).toBe(1);
  });

  it('ignores an empty URL', () => {
    setArtwork(db, 'alb-1', 'album', '');
    expect(resolveArtwork(db, 'alb-1')).toBeNull();
  });

  it('purges the stale canonical cache file when the URL changes', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nd-cache-'));
    const cachedFile = join(cacheDir, canonicalCacheKey('alb-1') + '.jpg');
    setArtwork(db, 'alb-1', 'album', 'https://x/old.jpg', cacheDir);
    writeFileSync(cachedFile, new Uint8Array([1, 2, 3]));
    expect(existsSync(cachedFile)).toBe(true);

    setArtwork(db, 'alb-1', 'album', 'https://x/new.jpg', cacheDir);
    expect(existsSync(cachedFile)).toBe(false);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('does not purge when the URL is unchanged', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nd-cache-'));
    const cachedFile = join(cacheDir, canonicalCacheKey('alb-1') + '.jpg');
    setArtwork(db, 'alb-1', 'album', 'https://x/same.jpg', cacheDir);
    writeFileSync(cachedFile, new Uint8Array([1, 2, 3]));
    setArtwork(db, 'alb-1', 'album', 'https://x/same.jpg', cacheDir);
    expect(existsSync(cachedFile)).toBe(true);
    rmSync(cacheDir, { recursive: true, force: true });
  });
});

describe('purgeCanonicalCache', () => {
  it('removes cached images across known extensions', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nd-cache-'));
    const png = join(cacheDir, canonicalCacheKey('k') + '.png');
    writeFileSync(png, new Uint8Array([1]));
    purgeCanonicalCache(cacheDir, 'k');
    expect(existsSync(png)).toBe(false);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('removes resized thumbnail variants (c_<key>@<size>.<ext>) too', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'nd-cache-'));
    const full = join(cacheDir, canonicalCacheKey('k') + '.jpg');
    const thumb80 = join(cacheDir, canonicalCacheKey('k') + '@80.webp');
    const thumb320 = join(cacheDir, canonicalCacheKey('k') + '@320.webp');
    const other = join(cacheDir, canonicalCacheKey('other') + '@80.webp');
    for (const p of [full, thumb80, thumb320, other]) writeFileSync(p, new Uint8Array([1]));
    purgeCanonicalCache(cacheDir, 'k');
    expect(existsSync(full)).toBe(false);
    expect(existsSync(thumb80)).toBe(false);
    expect(existsSync(thumb320)).toBe(false);
    // A different key's variants are untouched.
    expect(existsSync(other)).toBe(true);
    rmSync(cacheDir, { recursive: true, force: true });
  });
});

describe('image pickers', () => {
  it('pickAlbumCover prefers coverType "cover" then remoteUrl', () => {
    expect(
      pickAlbumCover([
        { coverType: 'disc', url: '/d.jpg' },
        { coverType: 'cover', url: '/c.jpg', remoteUrl: 'https://r/c.jpg' },
      ]),
    ).toBe('https://r/c.jpg');
  });

  it('pickArtistImage prefers coverType "poster"', () => {
    expect(
      pickArtistImage([
        { coverType: 'banner', url: '/b.jpg' },
        { coverType: 'poster', url: '/p.jpg' },
      ]),
    ).toBe('/p.jpg');
  });

  it('falls back to the first image when no preferred type', () => {
    expect(pickAlbumCover([{ coverType: 'banner', url: '/b.jpg' }])).toBe('/b.jpg');
  });

  it('returns undefined for no images', () => {
    expect(pickAlbumCover(undefined)).toBeUndefined();
    expect(pickArtistImage([])).toBeUndefined();
  });
});
