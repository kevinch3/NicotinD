import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { buildLibrary, LibraryScanner, songId, type ScannedTrack } from './library-scanner.js';
import { songUnchanged } from './scan-diff.js';

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

function library(n: number, featuring = 'Guest'): ScannedTrack[] {
  return Array.from({ length: n }, (_, i) =>
    track({
      relPath: `Artist ${i % 7}/Album ${i % 13}/${String(i).padStart(4, '0')}.mp3`,
      artist: `Artist ${i % 7} feat. ${featuring}`,
      albumArtist: `Artist ${i % 7}`,
      album: `Album ${i % 13}`,
      title: `Song ${i}`,
      track: (i % 12) + 1,
      genre: ['Rock', 'Indie'],
    }),
  );
}

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  return { db, scanner: new LibraryScanner('/music', db) };
}

const changes = (db: Database) =>
  (db.query('SELECT total_changes() AS n').get() as { n: number }).n;

describe('persist writes only what changed (#1309)', () => {
  it('a full rescan of an unchanged library rewrites no song row and no link row', () => {
    const { db, scanner } = setup();
    const built = buildLibrary(library(300));
    scanner.persist(built, 1_000, true);
    const linkRows = (
      db.query('SELECT COUNT(*) AS n FROM library_song_artists').get() as {
        n: number;
      }
    ).n;
    expect(linkRows).toBeGreaterThan(300);

    const before = changes(db);
    const result = scanner.persist(buildLibrary(library(300)), 2_000, true);
    const writes = changes(db) - before;

    expect(result.unchangedSongs).toBe(300);
    expect(result.removedSongs).toBe(0);
    // 300 narrow synced_at stamps, plus the few hundred album/artist/genre and
    // bookkeeping upserts — not the ~1,500 song + credit + genre rewrites.
    const aggregates = built.albums.length + built.artists.length + built.genres.length;
    expect(writes).toBeLessThanOrEqual(300 + aggregates + built.albumArtists.length + 5);
    // Every surviving row was stamped, so the prune contract still holds.
    expect(
      (
        db.query('SELECT COUNT(*) AS n FROM library_songs WHERE synced_at = 2000').get() as {
          n: number;
        }
      ).n,
    ).toBe(300);
  });

  it('rewrites just the songs whose credits moved, and still prunes a vanished file', () => {
    const { db, scanner } = setup();
    scanner.persist(buildLibrary(library(50)), 1_000, true);

    const next = library(50);
    next[3] = { ...next[3]!, artist: 'Artist 3 feat. Someone Else' };
    next.pop(); // file 49 is gone from disk
    const result = scanner.persist(buildLibrary(next), 2_000, true);

    expect(result.unchangedSongs).toBe(48);
    expect(result.removedSongs).toBe(1);
    const credits = db
      .query<{ name: string }, [string]>(
        `SELECT a.name FROM library_song_artists sa JOIN library_artists a ON a.id = sa.artist_id
          WHERE sa.song_id = ? ORDER BY sa.role, sa.position`,
      )
      .all(songId(next[3]!.relPath))
      .map((r) => r.name);
    expect(credits).toContain('Someone Else');
    expect(credits).not.toContain('Guest');
  });

  it('an incremental scan of unchanged files writes nothing to library_songs', () => {
    const { db, scanner } = setup();
    scanner.persist(buildLibrary(library(20)), 1_000, true);
    const stamps = () =>
      (
        db.query('SELECT COUNT(*) AS n FROM library_songs WHERE synced_at = 1000').get() as {
          n: number;
        }
      ).n;
    scanner.persist(buildLibrary(library(20).slice(0, 5)), 3_000, false);
    expect(stamps()).toBe(20);
  });
});

describe('songUnchanged mirrors the upsert', () => {
  const base = buildLibrary([
    track({ relPath: 'A/B/1.mp3', artist: 'A', album: 'B', title: 'T', genre: ['Rock'] }),
  ]).songs[0]!;
  const stored = (over: Record<string, unknown> = {}) => {
    const { db, scanner } = setup();
    scanner.persist(
      buildLibrary([
        track({ relPath: 'A/B/1.mp3', artist: 'A', album: 'B', title: 'T', genre: ['Rock'] }),
      ]),
      1,
      true,
    );
    for (const [col, v] of Object.entries(over)) {
      db.run(`UPDATE library_songs SET ${col} = ?`, [v as string | number | null]);
    }
    return db.query('SELECT * FROM library_songs').get() as Record<string, unknown>;
  };

  it('is unchanged against its own write', () => {
    expect(songUnchanged(stored(), base)).toBe(true);
  });

  it('treats a tag-less genre/bpm as keeping the enriched value, as COALESCE does', () => {
    const enriched = stored({ genre: 'Jazz', bpm: 120 });
    expect(songUnchanged(enriched, { ...base, genre: null, bpm: null })).toBe(true);
    expect(songUnchanged(enriched, { ...base, genre: 'Rock', bpm: null })).toBe(false);
  });

  it('sees a change in any overwritten column', () => {
    expect(songUnchanged(stored(), { ...base, title: 'Other' })).toBe(false);
    expect(songUnchanged(stored(), { ...base, size: base.size + 1 })).toBe(false);
    expect(songUnchanged(stored(), { ...base, sampleRate: 44100 })).toBe(false);
  });
});
