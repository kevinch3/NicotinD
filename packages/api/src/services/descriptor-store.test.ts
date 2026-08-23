import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  DESCRIPTOR_VERSION,
  descriptorsPendingClause,
  loadDescriptors,
  upsertDescriptors,
} from './descriptor-store.js';
import { DEFAULT_ORPHAN_GRACE_MS, ORPHAN_TABLES, pruneOrphanRows } from './orphan-prune.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES ('al', 'Album', 'Artist', 'art', 1, 0, 1)`,
  );
});

function seedSong(id: string, size: number): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
     VALUES (?, 'al', ?, 'Artist', 'art', 0, ?, ?, '2024-01-01', 1)`,
    [id, id, `Artist/Album/${id}.opus`, size],
  );
}

const FEATURES = { mfcc_0: -665.7, spectral_centroid: 1138.7, swing_ratio: null, band_bass: 0.32 };

function pendingCount(): number {
  return (
    db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM library_songs s WHERE ${descriptorsPendingClause('s')}`,
      )
      .get()?.n ?? 0
  );
}

describe('upsertDescriptors + loadDescriptors', () => {
  it('round-trips the raw feature map, nulls included', () => {
    seedSong('s1', 1000);
    upsertDescriptors(db, {
      songId: 's1',
      version: DESCRIPTOR_VERSION,
      features: FEATURES,
      fileSize: 1000,
    });
    expect(loadDescriptors(db, ['s1']).get('s1')).toEqual(FEATURES);
  });

  it('a re-analysis replaces the previous row', () => {
    seedSong('s1', 1000);
    upsertDescriptors(db, {
      songId: 's1',
      version: DESCRIPTOR_VERSION,
      features: FEATURES,
      fileSize: 1000,
    });
    upsertDescriptors(db, {
      songId: 's1',
      version: DESCRIPTOR_VERSION,
      features: { ...FEATURES, band_bass: 0.59 },
      fileSize: 1000,
    });
    expect(loadDescriptors(db, ['s1']).get('s1')?.band_bass).toBe(0.59);
    expect(db.query('SELECT COUNT(*) AS c FROM library_song_descriptors').get()).toEqual({ c: 1 });
  });

  /** Issue #258: ids derive from the path, so a file replaced in place keeps its
   *  id — the stored size is what tells a stale descriptor from a live one. */
  it('hides a row whose recorded file size no longer matches the song', () => {
    seedSong('s1', 2000);
    upsertDescriptors(db, {
      songId: 's1',
      version: DESCRIPTOR_VERSION,
      features: FEATURES,
      fileSize: 1000,
    });
    expect(loadDescriptors(db, ['s1']).has('s1')).toBe(false);
  });

  it('keeps a row with no recorded size (written before the column existed)', () => {
    seedSong('s1', 2000);
    upsertDescriptors(db, {
      songId: 's1',
      version: DESCRIPTOR_VERSION,
      features: FEATURES,
      fileSize: null,
    });
    expect(loadDescriptors(db, ['s1']).has('s1')).toBe(true);
  });

  it('hides a row analysed under an older descriptor version', () => {
    seedSong('s1', 1000);
    upsertDescriptors(db, {
      songId: 's1',
      version: DESCRIPTOR_VERSION - 1,
      features: FEATURES,
      fileSize: 1000,
    });
    expect(loadDescriptors(db, ['s1']).has('s1')).toBe(false);
  });

  it('loads a pool larger than one IN-list chunk', () => {
    const ids = Array.from({ length: 1203 }, (_, i) => `s${i}`);
    for (const id of ids) {
      seedSong(id, 10);
      upsertDescriptors(db, {
        songId: id,
        version: DESCRIPTOR_VERSION,
        features: FEATURES,
        fileSize: 10,
      });
    }
    expect(loadDescriptors(db, ids).size).toBe(1203);
  });
});

describe('descriptorsPendingClause', () => {
  it('counts songs with no usable current-version row', () => {
    seedSong('none', 10); // no row at all
    seedSong('stale', 10); // size changed since analysis
    upsertDescriptors(db, {
      songId: 'stale',
      version: DESCRIPTOR_VERSION,
      features: FEATURES,
      fileSize: 9,
    });
    seedSong('old', 10); // analysed under a previous definition
    upsertDescriptors(db, {
      songId: 'old',
      version: DESCRIPTOR_VERSION - 1,
      features: FEATURES,
      fileSize: 10,
    });
    seedSong('done', 10);
    upsertDescriptors(db, {
      songId: 'done',
      version: DESCRIPTOR_VERSION,
      features: FEATURES,
      fileSize: 10,
    });
    expect(pendingCount()).toBe(3);
  });
});

describe('orphan pruning', () => {
  it('is registered as a regenerable per-song artifact', () => {
    expect(ORPHAN_TABLES.map((t) => t.table)).toContain('library_song_descriptors');
  });

  it('a descriptor whose song is gone is swept after the grace period, not before', () => {
    seedSong('s1', 10);
    seedSong('s2', 10);
    upsertDescriptors(db, {
      songId: 's1',
      version: DESCRIPTOR_VERSION,
      features: FEATURES,
      fileSize: 10,
    });
    upsertDescriptors(db, {
      songId: 's2',
      version: DESCRIPTOR_VERSION,
      features: FEATURES,
      fileSize: 10,
    });
    db.run(`DELETE FROM library_songs WHERE id = 's2'`);
    const t0 = 1_700_000_000_000;
    pruneOrphanRows(db, { now: t0 });
    expect(db.query('SELECT COUNT(*) AS c FROM library_song_descriptors').get()).toEqual({ c: 2 });
    pruneOrphanRows(db, { now: t0 + DEFAULT_ORPHAN_GRACE_MS + 1 });
    expect(
      db.query<{ song_id: string }, []>('SELECT song_id FROM library_song_descriptors').all(),
    ).toEqual([{ song_id: 's1' }]);
  });
});
