import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { applyJobMetadataPrefill } from './job-metadata-prefill.js';
import type { CompletedDownloadFile } from './path-inference.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES ('al', 'Heathen', 'Bowie', 'art', 1, 0, 1)`,
  );
});

function seedSong(id: string, path: string, cols: { genre?: string | null; year?: number | null } = {}): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, genre, year, synced_at)
     VALUES (?, 'al', 'T', 'Bowie', 'art', 0, ?, 10, '2024-01-01', ?, ?, 1)`,
    [id, path, cols.genre ?? null, cols.year ?? null],
  );
}

function fileWithMeta(
  relativePath: string,
  meta: { genres?: string[] | null; year?: number | null },
): CompletedDownloadFile {
  return {
    username: 'peer',
    directory: 'dir',
    filename: 'f.opus',
    relativePath,
    jobMeta: {
      jobId: 'j1',
      kind: 'album-hunt',
      artistName: 'Bowie',
      albumTitle: 'Heathen',
      lidarrAlbumId: null,
      genres: meta.genres ?? null,
      year: meta.year ?? null,
      canonicalTracks: null,
    },
  };
}

const song = (id: string) =>
  db
    .query<{ genre: string | null; year: number | null }, [string]>(
      'SELECT genre, year FROM library_songs WHERE id = ?',
    )
    .get(id);

describe('applyJobMetadataPrefill', () => {
  it('fills empty genre + year from the job metadata and writes the file tag', async () => {
    seedSong('s1', 'B/H/01.opus');
    const writeTags = mock(async () => true);
    await applyJobMetadataPrefill(db, [fileWithMeta('B/H/01.opus', { genres: ['Rock', 'Art Rock'], year: 2002 })], {
      musicDir: '/music',
      writeTags,
      fileExists: () => true,
    });

    expect(song('s1')).toEqual({ genre: 'Rock', year: 2002 });
    // Full multi-genre set lands in the join table (position 0 = primary).
    const genres = db
      .query<{ genre: string }, [string]>(
        'SELECT genre FROM library_song_genres WHERE song_id = ? ORDER BY position',
      )
      .all('s1')
      .map((r) => r.genre);
    expect(genres).toEqual(['Rock', 'Art Rock']);
    // Rescan-proof: the tag write is what survives a full rescan.
    expect(writeTags).toHaveBeenCalledWith('/music/B/H/01.opus', {
      genre: 'Rock; Art Rock',
      year: 2002,
    });
  });

  it('never overwrites an existing genre or year (fill-only-empty)', async () => {
    seedSong('s1', 'B/H/01.opus', { genre: 'Jazz', year: 1999 });
    const writeTags = mock(async () => true);
    await applyJobMetadataPrefill(db, [fileWithMeta('B/H/01.opus', { genres: ['Rock'], year: 2002 })], {
      musicDir: '/music',
      writeTags,
      fileExists: () => true,
    });
    expect(song('s1')).toEqual({ genre: 'Jazz', year: 1999 });
    expect(writeTags).not.toHaveBeenCalled();
  });

  it('leaves the genre enrichment task nothing to do for a pre-filled song', async () => {
    seedSong('s1', 'B/H/01.opus');
    await applyJobMetadataPrefill(db, [fileWithMeta('B/H/01.opus', { genres: ['Rock'] })], {
      musicDir: '/music',
      writeTags: async () => true,
      fileExists: () => true,
    });
    // Same pending predicate the genre task uses.
    const pending = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) n FROM library_songs WHERE (genre IS NULL OR genre = '')`,
      )
      .get();
    expect(pending?.n).toBe(0);
  });

  it('ignores files without job metadata or without a scanned song', async () => {
    const plain: CompletedDownloadFile = {
      username: 'peer',
      directory: 'dir',
      filename: 'f.opus',
      relativePath: 'nowhere.opus',
    };
    await applyJobMetadataPrefill(db, [plain, fileWithMeta('missing.opus', { genres: ['Rock'] })], {
      musicDir: '/music',
      writeTags: async () => true,
      fileExists: () => true,
    });
    // Nothing thrown, nothing written.
    const count = db
      .query<{ n: number }, []>('SELECT COUNT(*) n FROM library_song_genres')
      .get();
    expect(count?.n).toBe(0);
  });
});
