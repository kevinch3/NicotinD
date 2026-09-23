import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, applyPerformancePragmas, optimizeDatabase } from './db.js';

function pragma(db: Database, name: string): number {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, number> | null;
  return row ? Number(Object.values(row)[0]) : NaN;
}

describe('applyPerformancePragmas', () => {
  it('sets synchronous=NORMAL (1) and a positive busy_timeout', () => {
    const db = new Database(':memory:');
    applyPerformancePragmas(db);
    expect(pragma(db, 'synchronous')).toBe(1);
    expect(pragma(db, 'busy_timeout')).toBeGreaterThan(0);
  });

  it('raises the page cache above the default', () => {
    const db = new Database(':memory:');
    applyPerformancePragmas(db);
    // cache_size is reported negative (KiB) when set that way, or a positive page
    // count; either way it must differ from the tiny default (-2000 KiB / 2000).
    expect(Math.abs(pragma(db, 'cache_size'))).toBeGreaterThan(2000);
  });

  it('caps the WAL at 64 MiB with journal_size_limit (#1307)', () => {
    const db = new Database(':memory:');
    expect(pragma(db, 'journal_size_limit')).toBe(-1);
    applyPerformancePragmas(db);
    expect(pragma(db, 'journal_size_limit')).toBe(67108864);
  });
});

describe('optimizeDatabase', () => {
  it('runs PRAGMA optimize', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const run = spyOn(db, 'run');
    optimizeDatabase(db);
    expect(run).toHaveBeenCalledWith('PRAGMA optimize');
  });

  it('logs instead of throwing when the pragma fails', () => {
    const db = new Database(':memory:');
    db.close();
    expect(() => optimizeDatabase(db)).not.toThrow();
  });
});

describe('library_albums grid index', () => {
  it('creates a composite (hidden, classification, created) index', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const idx = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
         WHERE type='index' AND tbl_name='library_albums' AND name='idx_library_albums_grid'`,
      )
      .get();
    expect(idx?.name).toBe('idx_library_albums_grid');
  });
});

// The "evaluate the song predicate once" plan guard lived here as two
// hand-written cases (artists/country, albums/genre). It is now every list
// route x every filter dimension in `check:library-queries`
// (scripts/check-library-queries.ts), which also fails on a route or a filter
// param it does not model — see docs/library-filters.md.
