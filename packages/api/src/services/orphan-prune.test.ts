import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  countOrphanRows,
  maybeRunDailyOrphanPrune,
  pruneOrphanRows,
  DEFAULT_ORPHAN_GRACE_MS,
} from './orphan-prune.js';

const MODEL = 'discogs-effnet-bs64-1';
const DAY = 24 * 3_600_000;

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES ('al', 'Album', 'Artist', 'art', 1, 0, 1)`,
  );
});

function seedSong(id: string): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
     VALUES (?, 'al', ?, 'Artist', 'art', 0, ?, 100, '2024-01-01', 1)`,
    [id, id, `Artist/Album/${id}.opus`],
  );
}

function seedEmbedding(songId: string): void {
  db.run(
    `INSERT INTO library_embeddings (song_id, model, dim, vec, file_size, updated_at)
     VALUES (?, ?, 2, ?, 100, 1)`,
    [songId, MODEL, Buffer.from(new Float32Array([0.5, 0.5]).buffer)],
  );
}

function embeddingIds(): string[] {
  return (
    db.query('SELECT song_id FROM library_embeddings ORDER BY song_id').all() as Array<{
      song_id: string;
    }>
  ).map((r) => r.song_id);
}

function orphanedAt(songId: string): number | null {
  return (
    (
      db.query('SELECT orphaned_at FROM library_embeddings WHERE song_id = ?').get(songId) as {
        orphaned_at: number | null;
      } | null
    )?.orphaned_at ?? null
  );
}

describe('pruneOrphanRows (#259)', () => {
  it('marks an orphan but does not delete it within the grace period', () => {
    seedSong('kept');
    seedEmbedding('kept');
    seedEmbedding('gone'); // no library_songs row

    const now = 1_000_000_000;
    const r = pruneOrphanRows(db, { now, graceMs: 30 * DAY });

    expect(r.marked).toBe(1);
    expect(r.deleted).toBe(0);
    expect(orphanedAt('gone')).toBe(now);
    expect(orphanedAt('kept')).toBeNull();
    expect(embeddingIds()).toEqual(['gone', 'kept']);
  });

  it('deletes an orphan once the grace period has passed', () => {
    seedSong('kept');
    seedEmbedding('kept');
    seedEmbedding('gone');

    const t0 = 1_000_000_000;
    pruneOrphanRows(db, { now: t0, graceMs: 30 * DAY });
    const r = pruneOrphanRows(db, { now: t0 + 31 * DAY, graceMs: 30 * DAY });

    expect(r.deleted).toBe(1);
    expect(embeddingIds()).toEqual(['kept']);
  });

  /**
   * The point of the grace period: song ids are deterministic, so deleting a
   * track and re-downloading the same file reuses the id — and the cached
   * embedding should still be there rather than needing a sidecar recompute.
   */
  it('un-marks a row whose song came back, so a re-download restores it', () => {
    seedSong('unrelated'); // library must be non-empty for a pass to run at all
    seedEmbedding('unrelated');
    seedEmbedding('returning');
    const t0 = 1_000_000_000;
    pruneOrphanRows(db, { now: t0, graceMs: 30 * DAY });
    expect(orphanedAt('returning')).toBe(t0);

    seedSong('returning'); // re-downloaded
    const r = pruneOrphanRows(db, { now: t0 + 1 * DAY, graceMs: 30 * DAY });

    expect(r.unmarked).toBe(1);
    expect(orphanedAt('returning')).toBeNull();

    // …and it survives well past the original grace window.
    pruneOrphanRows(db, { now: t0 + 90 * DAY, graceMs: 30 * DAY });
    expect(embeddingIds()).toEqual(['returning', 'unrelated']);
  });

  /**
   * The failure mode the no-cascade design exists to prevent. The scanner
   * upserts inside a transaction and prunes by stale `synced_at`, so a rescan
   * never leaves songs missing — nothing may be marked, let alone deleted.
   */
  it('a rescan does not mark or delete anything', () => {
    for (const id of ['a', 'b', 'c']) {
      seedSong(id);
      seedEmbedding(id);
    }
    const t0 = 1_000_000_000;

    // Rescan: same deterministic ids re-upserted with a fresh synced_at.
    for (const id of ['a', 'b', 'c']) {
      db.run('UPDATE library_songs SET synced_at = ? WHERE id = ?', [2, id]);
    }

    const r = pruneOrphanRows(db, { now: t0, graceMs: 30 * DAY });
    expect(r).toEqual({ marked: 0, unmarked: 0, deleted: 0 });
    expect(embeddingIds()).toEqual(['a', 'b', 'c']);
  });

  it('never touches curator side tables', () => {
    // Lyrics are network-sourced and user-editable — exactly what the
    // no-cascade design protects. Measured at 35 prod orphans; not worth it.
    db.run(
      `INSERT INTO library_lyrics (song_id, plain_text, source, updated_at) VALUES ('gone', 'x', 's', 1)`,
    );
    db.run(`INSERT INTO library_song_genres (song_id, genre, position) VALUES ('gone', 'Rock', 0)`);
    seedSong('kept');

    pruneOrphanRows(db, { now: 1_000_000_000 + 400 * DAY, graceMs: 30 * DAY });

    expect(db.query('SELECT COUNT(*) c FROM library_lyrics').get()).toEqual({ c: 1 });
    expect(db.query('SELECT COUNT(*) c FROM library_song_genres').get()).toEqual({ c: 1 });
  });

  it('refuses to run against an empty library', () => {
    // A truncated/mid-rebuild library is not a reason to drop every embedding.
    seedEmbedding('a');
    seedEmbedding('b');

    const r = pruneOrphanRows(db, { now: 1_000_000_000 });
    expect(r).toEqual({ marked: 0, unmarked: 0, deleted: 0 });
    expect(embeddingIds()).toEqual(['a', 'b']);
  });

  it('skips a table whose orphan ratio is implausibly high', () => {
    seedSong('one');
    // 1 owned, 9 orphaned = 90% — looks like a rebuild, not normal churn.
    seedEmbedding('one');
    for (let i = 0; i < 9; i++) seedEmbedding(`ghost${i}`);

    const r = pruneOrphanRows(db, { now: 1_000_000_000 });
    expect(r.marked).toBe(0);
    expect(embeddingIds()).toHaveLength(10);
  });

  it('prunes the analysis-failure ledger too', () => {
    seedSong('kept');
    db.run(
      `INSERT INTO library_song_analysis_failures (song_id, task, fail_count, last_attempt) VALUES ('kept', 'bpm', 1, 1)`,
    );
    db.run(
      `INSERT INTO library_song_analysis_failures (song_id, task, fail_count, last_attempt) VALUES ('gone', 'bpm', 1, 1)`,
    );

    const t0 = 1_000_000_000;
    pruneOrphanRows(db, { now: t0, graceMs: 30 * DAY });
    pruneOrphanRows(db, { now: t0 + 31 * DAY, graceMs: 30 * DAY });

    const left = (
      db.query('SELECT song_id FROM library_song_analysis_failures').all() as Array<{
        song_id: string;
      }>
    ).map((r) => r.song_id);
    expect(left).toEqual(['kept']);
  });

  it('degrades to a no-op on a schema-less DB', () => {
    const bare = new Database(':memory:');
    expect(() => pruneOrphanRows(bare)).not.toThrow();
  });
});

describe('countOrphanRows', () => {
  it('reports rows and orphans per table', () => {
    seedSong('kept');
    seedEmbedding('kept');
    seedEmbedding('gone');

    const counts = countOrphanRows(db);
    const emb = counts.find((c) => c.table === 'library_embeddings')!;
    expect(emb).toEqual({ table: 'library_embeddings', rows: 2, orphans: 1 });
  });
});

describe('maybeRunDailyOrphanPrune', () => {
  it('runs at most once per calendar day', () => {
    seedSong('kept');
    seedEmbedding('kept');
    seedEmbedding('gone');
    const now = Date.parse('2026-07-26T10:00:00Z');

    expect(maybeRunDailyOrphanPrune(db, { now })).toBe(true);
    expect(maybeRunDailyOrphanPrune(db, { now: now + 3_600_000 })).toBe(false);
    expect(maybeRunDailyOrphanPrune(db, { now: now + DAY })).toBe(true);
  });

  it('is disabled by the enabled flag', () => {
    seedSong('kept');
    seedEmbedding('gone');
    expect(maybeRunDailyOrphanPrune(db, { enabled: false })).toBe(false);
    expect(orphanedAt('gone')).toBeNull();
  });

  it('defaults to a 30-day grace period', () => {
    expect(DEFAULT_ORPHAN_GRACE_MS).toBe(30 * DAY);
  });
});

/**
 * `scan_cache` is the first **path-keyed** entry in ORPHAN_TABLES — every other
 * table references `library_songs.id`. These cover the reference-column
 * generalization specifically (issue #313).
 */
describe('scan_cache orphan pruning (path-keyed)', () => {
  function makeDb(): Database {
    const db = new Database(':memory:');
    db.run('CREATE TABLE library_songs (id TEXT PRIMARY KEY, path TEXT)');
    db.run(`CREATE TABLE scan_cache (
      path TEXT PRIMARY KEY, size INTEGER, mtime_ms REAL,
      track_json TEXT, orphaned_at INTEGER)`);
    return db;
  }
  const addSong = (db: Database, p: string) =>
    db.run('INSERT INTO library_songs (id, path) VALUES (?, ?)', [`id:${p}`, p]);
  const addCache = (db: Database, p: string) =>
    db.run('INSERT INTO scan_cache (path, size, mtime_ms, track_json) VALUES (?, 1, 1, ?)', [
      p,
      '{}',
    ]);
  const cachePaths = (db: Database) =>
    (db.query('SELECT path p FROM scan_cache ORDER BY path').all() as Array<{ p: string }>).map(
      (r) => r.p,
    );

  it('matches on path, not id — a live file is never marked', () => {
    const db = makeDb();
    addSong(db, 'A/live.mp3');
    addCache(db, 'A/live.mp3');

    const r = pruneOrphanRows(db, { now: 1_000 });
    expect(r.marked).toBe(0);
    expect(cachePaths(db)).toEqual(['A/live.mp3']);
  });

  it('marks then sweeps an entry whose file is gone, only after the grace period', () => {
    const db = makeDb();
    addSong(db, 'A/live.mp3');
    addCache(db, 'A/live.mp3');
    addCache(db, 'A/deleted.mp3');

    expect(pruneOrphanRows(db, { now: 1_000, graceMs: 100 }).marked).toBe(1);
    // Still inside the grace window: marked, not swept.
    expect(pruneOrphanRows(db, { now: 1_050, graceMs: 100 }).deleted).toBe(0);
    expect(cachePaths(db)).toEqual(['A/deleted.mp3', 'A/live.mp3']);

    expect(pruneOrphanRows(db, { now: 2_000, graceMs: 100 }).deleted).toBe(1);
    expect(cachePaths(db)).toEqual(['A/live.mp3']);
  });

  it('unmarks when the file comes back, preserving the re-download restore property', () => {
    const db = makeDb();
    addSong(db, 'A/keep.mp3');
    addCache(db, 'A/keep.mp3');
    addCache(db, 'A/gone.mp3');
    expect(pruneOrphanRows(db, { now: 1_000, graceMs: 100 }).marked).toBe(1);

    addSong(db, 'A/gone.mp3'); // re-downloaded
    expect(pruneOrphanRows(db, { now: 1_100, graceMs: 100 }).unmarked).toBe(1);
    // Past the grace window it is still here, because it is no longer an orphan.
    expect(pruneOrphanRows(db, { now: 9_000, graceMs: 100 }).deleted).toBe(0);
    expect(cachePaths(db)).toEqual(['A/gone.mp3', 'A/keep.mp3']);
  });

  it('reports scan_cache in the admin orphan counts', () => {
    const db = makeDb();
    addSong(db, 'A/live.mp3');
    addCache(db, 'A/live.mp3');
    addCache(db, 'A/dead.mp3');

    const row = countOrphanRows(db).find((c) => c.table === 'scan_cache');
    expect(row).toEqual({ table: 'scan_cache', rows: 2, orphans: 1 });
  });
});

/**
 * Download provenance is the second path-keyed table (references
 * `library_songs.path`) and, unlike the others, it is *history* rather than a
 * regenerable artifact — pruned by explicit product decision (issue #319). The
 * daily pass repoints first (acquisition-repoint.ts) so only genuinely-deleted
 * rows reach the sweep; these cover the mark→grace→sweep + count on the real
 * schema.
 */
describe('acquisitions orphan pruning (path-keyed, #319)', () => {
  const addAcq = (p: string) =>
    db.run(
      `INSERT INTO acquisitions (relative_path, method, stage, started_at) VALUES (?, 'direct', 'done', 1)`,
      [p],
    );
  const acqPaths = () =>
    (
      db.query('SELECT relative_path p FROM acquisitions ORDER BY relative_path').all() as Array<{
        p: string;
      }>
    ).map((r) => r.p);

  it('never marks provenance for a live file', () => {
    seedSong('kept');
    addAcq('Artist/Album/kept.opus');

    const r = pruneOrphanRows(db, { now: 1_000, graceMs: 100 });
    expect(r.marked).toBe(0);
    expect(acqPaths()).toEqual(['Artist/Album/kept.opus']);
  });

  it('marks then sweeps provenance whose file is gone, only after the grace period', () => {
    seedSong('kept');
    addAcq('Artist/Album/kept.opus');
    addAcq('Artist/Album/deleted.opus'); // no song at this path

    expect(pruneOrphanRows(db, { now: 1_000, graceMs: 100 }).marked).toBe(1);
    expect(pruneOrphanRows(db, { now: 1_050, graceMs: 100 }).deleted).toBe(0);
    expect(pruneOrphanRows(db, { now: 2_000, graceMs: 100 }).deleted).toBe(1);
    expect(acqPaths()).toEqual(['Artist/Album/kept.opus']);
  });

  it('reports acquisitions in the admin orphan counts', () => {
    seedSong('kept');
    addAcq('Artist/Album/kept.opus');
    addAcq('Artist/Album/dead.opus');

    const row = countOrphanRows(db).find((c) => c.table === 'acquisitions');
    expect(row).toEqual({ table: 'acquisitions', rows: 2, orphans: 1 });
  });
});

/**
 * Issue #965: the entry shape could only express "keyed on library_songs", so
 * album- and artist-keyed side tables had no sweep at all — 1,259 orphan rows on
 * prod. Because those ids are NAME-derived, an orphan row is a correctness
 * hazard, not disk waste: the same name minted again inherits the stale row.
 */
describe('album- and artist-keyed side tables (issue #965)', () => {
  function seedArtwork(id: string, kind: 'album' | 'artist'): void {
    db.run(`INSERT INTO library_artwork (id, kind, cover_url, updated_at) VALUES (?, ?, 'u', 1)`, [
      id,
      kind,
    ]);
  }

  it('marks an album artwork row whose album is gone, and sweeps it after the grace', () => {
    seedSong('s1');
    seedArtwork('al', 'album');
    seedArtwork('gone-album', 'album');
    const now = Date.now();

    expect(pruneOrphanRows(db, { now }).marked).toBe(1);
    // The live album's row is untouched.
    expect(db.query("SELECT orphaned_at FROM library_artwork WHERE id = 'al'").get()).toEqual({
      orphaned_at: null,
    });

    pruneOrphanRows(db, { now: now + DEFAULT_ORPHAN_GRACE_MS + DAY });
    expect(db.query("SELECT id FROM library_artwork WHERE id = 'gone-album'").get()).toBeNull();
  });

  it('checks each library_artwork kind against its OWN parent table', () => {
    seedSong('s1');
    db.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('art', 'Artist', 1, 1)`,
    );
    // `art` is a live ARTIST and no album at all. One `id NOT IN library_albums`
    // sweep over the whole table — the shape before #965 — would orphan it.
    seedArtwork('art', 'artist');
    seedArtwork('al', 'album');
    seedArtwork('gone-album', 'album');

    pruneOrphanRows(db, { now: Date.now() });
    expect(
      db
        .query<{ id: string }, []>(
          'SELECT id FROM library_artwork WHERE orphaned_at IS NOT NULL ORDER BY id',
        )
        .all(),
    ).toEqual([{ id: 'gone-album' }]);
  });

  it('unmarks when a renamed-back album mints the same id again', () => {
    seedSong('s1');
    // A live sibling keeps the orphan ratio under SANITY_MAX_ORPHAN_RATIO — a
    // table that is >50% orphaned is treated as mid-rebuild and skipped.
    seedArtwork('al', 'album');
    seedArtwork('resurrected', 'album');
    const now = Date.now();
    expect(pruneOrphanRows(db, { now }).marked).toBe(1);

    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
       VALUES ('resurrected', 'B', 'A', 'art', 1, 0, 1)`,
    );
    expect(pruneOrphanRows(db, { now: now + DAY }).unmarked).toBe(1);
  });

  it('counts but never deletes library_artist_meta — it holds curator bios', () => {
    seedSong('s1');
    db.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES ('art', 'Artist', 1, 1)`,
    );
    db.run(
      `INSERT INTO library_artist_meta (artist_id, bio, urls, fetched_at, source)
       VALUES ('art', 'b', '[]', 1, 'user')`,
    );
    db.run(
      `INSERT INTO library_artist_meta (artist_id, bio, urls, fetched_at, source)
       VALUES ('gone-artist', 'b', '[]', 1, 'user')`,
    );
    const now = Date.now();
    pruneOrphanRows(db, { now: now + DEFAULT_ORPHAN_GRACE_MS + DAY });
    expect(
      db.query("SELECT artist_id FROM library_artist_meta WHERE artist_id = 'gone-artist'").get(),
    ).not.toBeNull();
    expect(countOrphanRows(db).find((c) => c.table === 'library_artist_meta')?.orphans).toBe(1);
  });
});
