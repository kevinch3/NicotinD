import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../db.js';
import { mutateSongMetadata } from './song-metadata-mutate.js';
import type { AudioTags } from './audio-tags.js';

let db: Database;
let musicDir: string;
const relPath = 'Wisin & Yandel/Singles/Pegao (Official Video).opus';

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, cover_art, song_count, duration, year, synced_at)
     VALUES ('album-yt', 'Pegao (Official Video)', 'Wisin & Yandel', 'artist-wy', 'album-yt', 1, 228, NULL, 0)`,
  );
  db.run(
    `INSERT INTO library_songs
      (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES ('song-yt', 'album-yt', 'Pegao (Official Video)', 'Wisin & Yandel', 'artist-wy', 228,
       '${relPath}', 1000, 128, 'opus', 'audio/ogg', '2026-08-01', 0)`,
  );
  musicDir = mkdtempSync(join(tmpdir(), 'nicotind-smm-'));
  mkdirSync(join(musicDir, 'Wisin & Yandel/Singles'), { recursive: true });
  writeFileSync(join(musicDir, relPath), 'not-really-audio');
});
afterEach(() => {
  db.close();
  rmSync(musicDir, { recursive: true, force: true });
});

describe('mutateSongMetadata', () => {
  it('writes guarded tags, rescans the one file, and reports old values', async () => {
    const written: Array<{ abs: string; tags: AudioTags }> = [];
    const rescanned: string[][] = [];
    const result = await mutateSongMetadata(
      db,
      {
        musicDir,
        writeTags: async (abs, tags) => {
          written.push({ abs, tags });
          return true;
        },
        scanIncremental: async (paths) => {
          rescanned.push(paths);
        },
      },
      'song-yt',
      { title: 'Pegao', album: 'Wisin vs. Yandel: Los Extraterrestres' },
    );
    expect(result).toMatchObject({
      ok: true,
      rescanned: true,
      old: { title: 'Pegao (Official Video)', artist: 'Wisin & Yandel' },
      applied: { title: 'Pegao', album: 'Wisin vs. Yandel: Los Extraterrestres' },
    });
    expect(written[0]?.abs.endsWith(relPath)).toBe(true);
    expect(rescanned[0]).toEqual([relPath]);
  });

  it('an album-only fix works (fake single-album dissolution)', async () => {
    const result = await mutateSongMetadata(
      db,
      { musicDir, writeTags: async () => true },
      'song-yt',
      { album: 'Los Extraterrestres' },
    );
    expect(result).toMatchObject({
      ok: true,
      rescanned: false,
      applied: { album: 'Los Extraterrestres' },
    });
  });

  it('rejects a body with no applicable fields', async () => {
    const empty = await mutateSongMetadata(db, { musicDir }, 'song-yt', {});
    expect(empty).toEqual({ ok: false, error: 'No applicable fields', status: 400 });
    // Placeholder / out-of-range values are dropped by the tag guard, not written.
    const junk = await mutateSongMetadata(db, { musicDir }, 'song-yt', {
      title: '  ',
      year: 1800,
    });
    expect(junk).toEqual({ ok: false, error: 'No applicable fields', status: 400 });
  });

  it('404s for an unknown song', async () => {
    const result = await mutateSongMetadata(db, { musicDir }, 'nope', { title: 'X' });
    expect(result).toEqual({ ok: false, error: 'Song not found', status: 404 });
  });

  it('503s when the music dir is not configured', async () => {
    const result = await mutateSongMetadata(db, {}, 'song-yt', { title: 'X' });
    expect(result).toEqual({ ok: false, error: 'Music directory not configured', status: 503 });
  });

  it('404s when the file is gone from disk', async () => {
    rmSync(join(musicDir, relPath));
    const result = await mutateSongMetadata(db, { musicDir }, 'song-yt', { title: 'X' });
    expect(result).toEqual({ ok: false, error: 'Song file not found', status: 404 });
  });

  it('500s when the tag write fails', async () => {
    const result = await mutateSongMetadata(
      db,
      { musicDir, writeTags: async () => false },
      'song-yt',
      { title: 'X' },
    );
    expect(result).toEqual({ ok: false, error: 'Failed to write tags', status: 500 });
  });
});
