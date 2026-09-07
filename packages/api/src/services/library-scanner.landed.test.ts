/**
 * Instant landing: `library_songs.landed_at` means "first scanned". The scanner
 * stamps it on INSERT, a rescan preserves it, and nothing between the scan and
 * the listing routes filters on it — a scanned song is library-visible at once.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { libraryRoutes } from '../routes/library.js';
import { buildLibrary, LibraryScanner, songId, type ScannedTrack } from './library-scanner.js';

let testDb: Database = (() => {
  const d = new Database(':memory:');
  applySchema(d);
  return d;
})();

mock.module('../db.js', () => ({
  getDatabase: () => testDb,
  initDatabase: () => testDb,
  applySchema,
}));

function track(p: Partial<ScannedTrack> & { relPath: string }): ScannedTrack {
  return {
    size: 1000,
    mtimeMs: Date.parse('2026-01-01T00:00:00Z'),
    suffix: 'mp3',
    contentType: 'audio/mpeg',
    duration: 200,
    bitRate: 320,
    ...p,
  };
}

function landedAt(db: Database, id: string): number | null {
  return (
    db
      .query<{ landed_at: number | null }, [string]>(
        'SELECT landed_at FROM library_songs WHERE id = ?',
      )
      .get(id)?.landed_at ?? null
  );
}

describe('LibraryScanner.persist — landed_at is the first-scan stamp', () => {
  let scanner: LibraryScanner;
  const REL = 'A/Album/01.mp3';

  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
    scanner = new LibraryScanner('/music', testDb);
  });

  it('stamps landed_at on a fresh INSERT with the scan time', () => {
    const syncedAt = 1_700_000_000_000;
    scanner.persist(
      buildLibrary([track({ relPath: REL, artist: 'A', album: 'Album', title: 'T1' })]),
      syncedAt,
      true,
    );
    expect(landedAt(testDb, songId(REL))).toBe(syncedAt);
  });

  it('preserves the original landed_at on a rescan of the same path', () => {
    const first = 1_700_000_000_000;
    const built = buildLibrary([track({ relPath: REL, artist: 'A', album: 'Album', title: 'T1' })]);
    scanner.persist(built, first, true);
    scanner.persist(
      buildLibrary([track({ relPath: REL, artist: 'A', album: 'Album', title: 'T1 (retagged)' })]),
      first + 60_000,
      true,
    );
    const row = testDb
      .query<{ landed_at: number; synced_at: number; title: string }, [string]>(
        'SELECT landed_at, synced_at, title FROM library_songs WHERE id = ?',
      )
      .get(songId(REL))!;
    expect(row.landed_at).toBe(first); // first-seen survives
    expect(row.synced_at).toBe(first + 60_000); // the rescan itself was recorded
    expect(row.title).toBe('T1 (retagged)');
  });

  it('is served by GET /songs immediately after the scan', async () => {
    scanner.persist(
      buildLibrary([track({ relPath: REL, artist: 'A', album: 'Album', title: 'T1' })]),
      Date.now(),
      true,
    );
    const app = new Hono();
    app.route('/', libraryRoutes('/music'));
    const res = await app.request('/songs?size=50');
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toEqual([songId(REL)]);
  });
});
