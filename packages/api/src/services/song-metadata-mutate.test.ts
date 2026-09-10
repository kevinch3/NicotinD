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
        // Stands in for the real scan: a retag is only "applied" once the
        // rescan has refreshed the row from disk (issue #776).
        scanIncremental: async (paths) => {
          rescanned.push(paths);
          db.run('UPDATE library_songs SET title = ? WHERE id = ?', ['Pegao', 'song-yt']);
          db.run('UPDATE library_albums SET name = ? WHERE id = ?', [
            'Wisin vs. Yandel: Los Extraterrestres',
            'album-yt',
          ]);
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

// Issue #776: `applied` used to echo the REQUEST, so a write that never landed
// was indistinguishable from success — the caller (an MCP agent, or the bulk
// normalize pass of #775) reported a clean run while changing nothing.
describe('mutateSongMetadata — verifies the write actually persisted', () => {
  /** A scanIncremental that behaves like the real one: refreshes the row from "disk". */
  const scanThatPersists = (title: string) => async () => {
    db.run('UPDATE library_songs SET title = ? WHERE id = ?', [title, 'song-yt']);
  };

  it('fails with the actual value when the rescan did not persist the request', async () => {
    const result = await mutateSongMetadata(
      db,
      {
        musicDir,
        writeTags: async () => true,
        scanIncremental: async () => {
          /* the #776 canonical-tracklist drop: row never refreshed */
        },
      },
      'song-yt',
      { title: 'Pegao' },
    );
    expect(result).toMatchObject({
      ok: false,
      requested: { title: 'Pegao' },
      actual: { title: 'Pegao (Official Video)' },
    });
  });

  it('reports the read-back value in `applied`, not the request', async () => {
    const result = await mutateSongMetadata(
      db,
      { musicDir, writeTags: async () => true, scanIncremental: scanThatPersists('Pegao') },
      'song-yt',
      { title: 'Pegao' },
    );
    expect(result).toMatchObject({ ok: true, verified: true, applied: { title: 'Pegao' } });
  });

  it('does not claim verification when there is no rescanner to read back through', async () => {
    const result = await mutateSongMetadata(
      db,
      { musicDir, writeTags: async () => true },
      'song-yt',
      { title: 'Pegao' },
    );
    expect(result).toMatchObject({ ok: true, rescanned: false, verified: false });
  });
});

// Issue #865: `albumArtist` was written into the file tag by writeAudioTags
// but was completely absent from SongMetadataSnapshot/readSnapshot/the
// divergence check/pickApplied — so a request that failed to land on the row
// (e.g. the scanner's VA/compilation branch silently dropping it) still came
// back `ok:true, verified:true` with `applied.albumArtist` just echoing the
// request, never the read-back DB value.
describe('mutateSongMetadata — verifies albumArtist like every other field (#865)', () => {
  it('fails with the actual value when albumArtist did not persist the rescan', async () => {
    const result = await mutateSongMetadata(
      db,
      {
        musicDir,
        writeTags: async () => true,
        // Stands in for the scanner silently declining to apply albumArtist
        // for this file shape (e.g. a COMPILATION=1 tag) — the row's
        // album_artist column never changes.
        scanIncremental: async () => {},
      },
      'song-yt',
      { title: 'Pegao', albumArtist: 'Sanampay' },
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'Tag write did not persist',
      requested: { title: 'Pegao', albumArtist: 'Sanampay' },
      // title landed (default row value equals the request), only
      // albumArtist diverges — the DB column defaults to '' on insert.
      actual: { albumArtist: '' },
    });
  });

  it('reports the read-back albumArtist in `applied`, not the request, once it lands', async () => {
    const result = await mutateSongMetadata(
      db,
      {
        musicDir,
        writeTags: async () => true,
        scanIncremental: async () => {
          db.run('UPDATE library_songs SET album_artist = ? WHERE id = ?', ['Sanampay', 'song-yt']);
        },
      },
      'song-yt',
      { albumArtist: 'Sanampay' },
    );
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      applied: { albumArtist: 'Sanampay' },
    });
  });
});

/**
 * Issue #959: 101 prod albums have several DIFFERENT songs sharing one
 * `(disc, track)` slot — all 14 tracks of *With the Beatles* are numbered 63 —
 * and 490 songs on multi-track albums carry no number at all. A curation session
 * could identify every case and repair none, because these two fields were
 * simply missing from the accepted set.
 */
describe('mutateSongMetadata — track and disc (issue #959)', () => {
  it('writes both to the file tag and verifies them on read-back', async () => {
    const written: AudioTags[] = [];
    const result = await mutateSongMetadata(
      db,
      {
        musicDir,
        writeTags: async (_abs, tags) => {
          written.push(tags);
          return true;
        },
        scanIncremental: async () => {
          db.run('UPDATE library_songs SET track = 3, disc = 2 WHERE id = ?', ['song-yt']);
        },
      },
      'song-yt',
      { track: 3, disc: 2 },
    );
    expect(result.ok).toBe(true);
    expect(written[0]).toEqual({ trackNumber: 3, discNumber: 2 });
    if (result.ok) expect(result.applied).toMatchObject({ trackNumber: 3, discNumber: 2 });
  });

  it('reports non-persistence rather than claiming success', async () => {
    const result = await mutateSongMetadata(
      db,
      {
        musicDir,
        writeTags: async () => true,
        scanIncremental: async () => {
          /* the row keeps its old numbering */
        },
      },
      'song-yt',
      { track: 3 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Tag write did not persist');
      expect(result.actual).toEqual({ track: null });
    }
  });

  it('still refuses a request with no applicable field', async () => {
    // 0 is not a track number, so this must not become an empty tag write.
    const result = await mutateSongMetadata(
      db,
      { musicDir, writeTags: async () => true },
      'song-yt',
      { track: 0 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('No applicable fields');
  });
});

/**
 * Issue #964: the divergence check audited the ROW and nothing else, so every
 * post-write divergence was blamed on the tag write — including a rescan that
 * never ran, threw, or de-selected the file (see the `library-scanner`
 * de-selection test). The file itself is now re-read before the report is
 * written, so the two failures are told apart.
 */
describe('mutateSongMetadata — a divergence names the right culprit (#964)', () => {
  const rowNeverRefreshed = { musicDir: '', writeTags: async () => true };

  it('says the rescan did not apply it when the file already carries the request', async () => {
    const result = await mutateSongMetadata(
      db,
      {
        ...rowNeverRefreshed,
        musicDir,
        // The scanner de-selected this file as a duplicate: the tag is on disk,
        // the row is a stale leftover.
        scanIncremental: async () => {},
        readTags: async () => ({ title: 'Pegao' }),
      },
      'song-yt',
      { title: 'Pegao' },
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'Tag write landed but the rescan did not apply it',
      status: 500,
      requested: { title: 'Pegao' },
      actual: { title: 'Pegao (Official Video)' },
      onDisk: { title: 'Pegao' },
    });
  });

  it('still blames the tag write when the file carries the OLD value', async () => {
    const result = await mutateSongMetadata(
      db,
      {
        ...rowNeverRefreshed,
        musicDir,
        scanIncremental: async () => {},
        readTags: async () => ({ title: 'Pegao (Official Video)' }),
      },
      'song-yt',
      { title: 'Pegao' },
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'Tag write did not persist',
      actual: { title: 'Pegao (Official Video)' },
    });
    expect(result).not.toHaveProperty('onDisk');
  });

  it('blames the tag write when only SOME of the diverged fields reached disk', async () => {
    const result = await mutateSongMetadata(
      db,
      {
        ...rowNeverRefreshed,
        musicDir,
        scanIncremental: async () => {},
        readTags: async () => ({ title: 'Pegao' }),
      },
      'song-yt',
      { title: 'Pegao', albumArtist: 'Wisin & Yandel' },
    );
    expect(result).toMatchObject({ ok: false, error: 'Tag write did not persist' });
  });

  it('does not re-read the file when nothing diverged', async () => {
    let reads = 0;
    const result = await mutateSongMetadata(
      db,
      {
        musicDir,
        writeTags: async () => true,
        scanIncremental: async () => {
          db.run('UPDATE library_songs SET title = ? WHERE id = ?', ['Pegao', 'song-yt']);
        },
        readTags: async () => {
          reads++;
          return {};
        },
      },
      'song-yt',
      { title: 'Pegao' },
    );
    expect(result.ok).toBe(true);
    expect(reads).toBe(0);
  });

  it('falls back to blaming the tag write when the file cannot be read', async () => {
    const result = await mutateSongMetadata(
      db,
      {
        ...rowNeverRefreshed,
        musicDir,
        scanIncremental: async () => {},
        readTags: async () => {
          throw new Error('unreadable');
        },
      },
      'song-yt',
      { title: 'Pegao' },
    );
    expect(result).toMatchObject({ ok: false, error: 'Tag write did not persist' });
  });
});

describe('mutateSongMetadata — verifies an artist through the alias map (#1071)', () => {
  const scanStoring = (column: 'artist' | 'album_artist', value: string) => async () => {
    db.run(`UPDATE library_songs SET ${column} = ? WHERE id = ?`, [value, 'song-yt']);
  };
  const alias = (norm: string, canonical: string) =>
    db.run(
      `INSERT INTO library_artist_aliases (alias_norm, canonical_name, source, created_at)
       VALUES (?, ?, 'mbid', 0)`,
      [norm, canonical],
    );

  it('accepts the canonical spelling the scanner stored for the requested artist', async () => {
    alias('maria becerra', 'María Becerra');
    const result = await mutateSongMetadata(
      db,
      {
        musicDir,
        writeTags: async () => true,
        scanIncremental: scanStoring('artist', 'María Becerra'),
        readTags: async () => ({ artist: 'Maria Becerra' }),
      },
      'song-yt',
      { artist: 'Maria Becerra' },
    );
    expect(result).toMatchObject({
      ok: true,
      verified: true,
      applied: { artist: 'María Becerra' },
    });
  });

  it('accepts the canonical spelling for albumArtist too', async () => {
    alias('karol g', 'KAROL G');
    const result = await mutateSongMetadata(
      db,
      {
        musicDir,
        writeTags: async () => true,
        scanIncremental: scanStoring('album_artist', 'KAROL G'),
      },
      'song-yt',
      { albumArtist: 'Karol G' },
    );
    expect(result).toMatchObject({ ok: true, applied: { albumArtist: 'KAROL G' } });
  });

  it('still reports a divergence the alias map does not explain', async () => {
    const result = await mutateSongMetadata(
      db,
      {
        musicDir,
        writeTags: async () => true,
        scanIncremental: scanStoring('artist', 'KAROL G'),
        readTags: async () => ({ artist: 'Karol G' }),
      },
      'song-yt',
      { artist: 'Karol G' },
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'Tag write landed but the rescan did not apply it',
      actual: { artist: 'KAROL G' },
    });
  });
});
