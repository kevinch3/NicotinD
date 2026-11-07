import { describe, expect, it, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import { applyAlbumCover } from './album-cover-mutate.js';
import { libraryEvents, type StampedEvent } from './library-events.js';

let db: Database;
const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-cover-mutate-'));
afterAll(() => rmSync(musicDir, { recursive: true, force: true }));

const relPath = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, year, synced_at)
     VALUES ('al1', 'Drukqs', 'Aphex Twin', 'ar1', 'al1', 1, 120, 2001, 0)`,
  );
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
     VALUES ('s1', 'al1', 'Avril 14th', 'Aphex Twin', 'ar1', 120, ?, 1000, '2024', 0)`,
    [relPath],
  );
});

function artworkRow(id: string): { kind: string; cover_url: string } | null {
  return (
    db
      .query<{ kind: string; cover_url: string }, [string]>(
        'SELECT kind, cover_url FROM library_artwork WHERE id = ?',
      )
      .get(id) ?? null
  );
}

describe('applyAlbumCover', () => {
  it('404s an unknown album', async () => {
    const res = await applyAlbumCover(db, {}, 'nope', { coverUrl: 'https://x/c.jpg' });
    expect(res).toEqual({ ok: false, error: 'Album not found', status: 404 });
  });

  it('coverUrl mode stores the canonical album-kind artwork row', async () => {
    const res = await applyAlbumCover(db, {}, 'al1', { coverUrl: 'https://x/c.jpg' });
    expect(res).toEqual({ ok: true, mode: 'canonical-url', coverRev: 1 });
    expect(artworkRow('al1')).toEqual({ kind: 'album', cover_url: 'https://x/c.jpg' });
  });

  it('re-applying the same coverUrl is not a cover change: the rev stays (#1666)', async () => {
    await applyAlbumCover(db, {}, 'al1', { coverUrl: 'https://x/c.jpg' });
    const again = await applyAlbumCover(db, {}, 'al1', { coverUrl: 'https://x/c.jpg' });
    expect(again).toEqual({ ok: true, mode: 'canonical-url', coverRev: 1 });
    const other = await applyAlbumCover(db, {}, 'al1', { coverUrl: 'https://x/d.jpg' });
    expect(other).toEqual({ ok: true, mode: 'canonical-url', coverRev: 2 });
  });

  it('announces the new rev as artwork.changed (#1666)', async () => {
    libraryEvents.flush(); // earlier tests' changes are still in the coalescing window
    const seen: StampedEvent[] = [];
    const off = libraryEvents.on((e) => seen.push(e));
    try {
      await applyAlbumCover(db, {}, 'al1', { coverUrl: 'https://x/c.jpg' });
      libraryEvents.flush();
    } finally {
      off();
    }
    expect(seen.map((e) => e.event)).toEqual([
      { type: 'artwork.changed', changes: [{ kind: 'album', id: 'al1', rev: 1 }] },
    ]);
  });

  it('400s when neither coverUrl nor songId is given', async () => {
    const res = await applyAlbumCover(db, {}, 'al1', {});
    expect(res).toEqual({ ok: false, error: 'Provide coverUrl or songId', status: 400 });
  });

  it('503s songId mode without a music dir', async () => {
    const res = await applyAlbumCover(db, {}, 'al1', { songId: 's1' });
    expect(res).toEqual({ ok: false, error: 'Music directory not configured', status: 503 });
  });

  it("404s a songId that is not the album's", async () => {
    const res = await applyAlbumCover(db, { musicDir }, 'al1', { songId: 'other' });
    expect(res).toEqual({ ok: false, error: 'Song not in this album', status: 404 });
  });

  it('404s when the song file is missing on disk', async () => {
    const res = await applyAlbumCover(db, { musicDir }, 'al1', { songId: 's1' });
    expect(res).toEqual({ ok: false, error: 'Song file not found', status: 404 });
  });

  it('songId mode writes the embedded picture as the folder cover and clears the canonical row', async () => {
    const abs = join(musicDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
    db.run(
      `INSERT INTO library_artwork (id, kind, cover_url, updated_at) VALUES ('al1', 'album', 'https://old/c.jpg', 1)`,
    );
    const res = await applyAlbumCover(
      db,
      {
        musicDir,
        extractPicture: async () => ({ contentType: 'image/jpeg', data: Buffer.from('jpg') }),
      },
      'al1',
      { songId: 's1' },
    );
    // One change, one bump: clearing the canonical row and writing the folder art
    // together move the rev once.
    expect(res).toEqual({ ok: true, mode: 'folder-cover', coverRev: 1 });
    expect(artworkRow('al1')).toBeNull(); // canonical cleared so the file art wins
    const written = readdirSync(dirname(abs)).filter((f) => f.startsWith('cover'));
    expect(written.length).toBe(1);
    expect(existsSync(join(dirname(abs), written[0]!))).toBe(true);
  });

  it('songId mode replaces an existing cover.jpg rather than leaving it to shadow the pick (#1336)', async () => {
    const abs = join(musicDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
    writeFileSync(join(dirname(abs), 'cover.jpg'), 'old');
    const res = await applyAlbumCover(
      db,
      {
        musicDir,
        extractPicture: async () => ({ contentType: 'image/png', data: Buffer.from('png') }),
      },
      'al1',
      { songId: 's1' },
    );
    expect(res).toEqual({ ok: true, mode: 'folder-cover', coverRev: 1 });
    expect(readdirSync(dirname(abs)).filter((f) => f.startsWith('cover'))).toEqual(['cover.png']);
    rmSync(join(dirname(abs), 'cover.png'));
  });

  it('400s a track with no embedded artwork', async () => {
    const abs = join(musicDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
    const res = await applyAlbumCover(db, { musicDir, extractPicture: async () => null }, 'al1', {
      songId: 's1',
    });
    expect(res).toEqual({
      ok: false,
      error: 'That track has no embedded artwork',
      status: 400,
    });
  });
});

describe('applyAlbumCover upload mode (PUT /albums/:id/cover)', () => {
  async function pngBytes(): Promise<Uint8Array> {
    const sharp = (await import('sharp')).default;
    return new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } })
        .png()
        .toBuffer(),
    );
  }

  it('writes a standardized folder cover and bumps the rev', async () => {
    const abs = join(musicDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
    const res = await applyAlbumCover(db, { musicDir }, 'al1', {
      upload: { data: await pngBytes(), contentType: 'image/png' },
    });
    expect(res).toEqual({ ok: true, mode: 'upload', coverRev: 1 });
    const written = readdirSync(dirname(abs)).filter((f) => f.startsWith('cover'));
    expect(written).toEqual(['cover.webp']);
    rmSync(join(dirname(abs), 'cover.webp'));
  });

  it('400s bytes that are not an image, and bumps nothing', async () => {
    const abs = join(musicDir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
    const res = await applyAlbumCover(db, { musicDir }, 'al1', {
      upload: { data: new Uint8Array([1, 2, 3]), contentType: 'image/png' },
    });
    expect(res).toEqual({ ok: false, error: 'Could not read that image', status: 400 });
    expect(
      db.query<{ cover_rev: number }, []>(`SELECT cover_rev FROM library_albums`).get()!.cover_rev,
    ).toBe(0);
  });

  it('404s an album with no track file to store the cover next to', async () => {
    rmSync(join(musicDir, relPath), { force: true });
    const res = await applyAlbumCover(db, { musicDir }, 'al1', {
      upload: { data: await pngBytes(), contentType: 'image/png' },
    });
    expect(res).toEqual({
      ok: false,
      error: 'Album has no track files to store a cover next to',
      status: 404,
    });
  });
});
