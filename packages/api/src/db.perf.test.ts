import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema, applyPerformancePragmas } from './db.js';
import { albumFilterWheres, artistFilterWheres } from './services/library-filter-sql.js';

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

describe('library filter query plan', () => {
  // The filtered artists/albums lists must evaluate the song predicate ONCE
  // and test entity membership, never re-derive it per entity row. Asserted on
  // the plan rather than the clock: the correlated form measured 176s on prod
  // for country=CL,AR and 211s for genre=Rock, but a wall-clock threshold would
  // flake on a loaded box and says nothing about why (#1055).
  function plan(db: Database, sql: string, params: Array<string | number>): string {
    return db
      .query<{ detail: string }, Array<string | number>>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((r) => r.detail)
      .join('\n');
  }

  it('scans library_songs once for a filtered artists list, not once per artist', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const frag = artistFilterWheres({ countries: ['CL', 'AR'] });
    const detail = plan(
      db,
      `SELECT id, name FROM library_artists WHERE hidden = 0 AND ${frag.wheres.join(' AND ')}`,
      frag.params,
    );
    // A per-artist re-derivation shows up as the song scan being CORRELATED.
    expect(detail).not.toMatch(/CORRELATED[^\n]*\n?[^\n]*library_songs/);
    expect(detail).not.toContain('SEARCH ls EXISTS');
  });

  it('scans library_songs once for a filtered albums list', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const frag = albumFilterWheres({ genres: ['Rock'] });
    const detail = plan(
      db,
      `SELECT id, name FROM library_albums WHERE hidden = 0 AND ${frag.wheres.join(' AND ')}`,
      frag.params,
    );
    expect(detail).not.toContain('SEARCH ls EXISTS');
  });
});
