import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import {
  ORPHAN_PROBE_TABLES,
  assertReadOnlySql,
  openReadOnlyDb,
  probeJobs,
  probeOrphans,
  probeTransfers,
} from './prod-probe.js';

describe('assertReadOnlySql — the --sql escape hatch cannot mutate prod', () => {
  it('accepts the read forms', () => {
    for (const sql of [
      'SELECT 1',
      '  select * from library_songs  ',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'PRAGMA table_info(library_songs)',
      'select 1 -- trailing comment',
      '/* leading block */ SELECT 1',
      'SELECT 1;', // a single trailing semicolon is not a second statement
    ]) {
      expect(() => assertReadOnlySql(sql), sql).not.toThrow();
    }
  });

  it('rejects every mutating verb', () => {
    for (const sql of [
      'DELETE FROM library_songs',
      "UPDATE library_songs SET title = 'x'",
      "INSERT INTO library_songs (id) VALUES ('x')",
      'DROP TABLE library_songs',
      'ALTER TABLE library_songs ADD COLUMN x TEXT',
      'CREATE TABLE t (a TEXT)',
      'REPLACE INTO library_songs (id) VALUES (1)',
      'TRUNCATE library_songs',
      'VACUUM',
      "ATTACH DATABASE '/tmp/x.db' AS x",
    ]) {
      expect(() => assertReadOnlySql(sql), sql).toThrow();
    }
  });

  /**
   * The interesting attacks are not a bare `DELETE` — they are a read that
   * smuggles a write past a naive "starts with SELECT" check.
   */
  it('rejects a write smuggled behind a leading read', () => {
    expect(() => assertReadOnlySql('SELECT 1; DELETE FROM library_songs')).toThrow(
      /single statement/i,
    );
    expect(() => assertReadOnlySql('WITH x AS (SELECT 1) DELETE FROM library_songs')).toThrow();
  });

  it('rejects a write hidden inside a comment-prefixed statement', () => {
    // A guard that strips comments *after* checking the first keyword would
    // read this as a SELECT.
    expect(() => assertReadOnlySql('-- SELECT 1\nDELETE FROM library_songs')).toThrow();
    expect(() => assertReadOnlySql('/* SELECT */ UPDATE library_songs SET title = 1')).toThrow();
  });

  it('rejects a PRAGMA that assigns (some pragmas write)', () => {
    expect(() => assertReadOnlySql('PRAGMA journal_mode = WAL')).toThrow(/assign/i);
    expect(() => assertReadOnlySql('PRAGMA user_version=4')).toThrow(/assign/i);
  });

  it('rejects empty or comment-only input rather than passing it through', () => {
    expect(() => assertReadOnlySql('')).toThrow();
    expect(() => assertReadOnlySql('   -- nothing here')).toThrow();
  });

  it('does not reject a read whose text merely contains a verb substring', () => {
    // "deleted_at" contains "delete"; a substring check would false-positive.
    expect(() => assertReadOnlySql('SELECT deleted_at FROM library_songs')).not.toThrow();
    expect(() => assertReadOnlySql('SELECT * FROM updates')).not.toThrow();
  });

  it('does not reject a keyword appearing inside a string literal', () => {
    // A whole-word check alone rejects these, which is a real nuisance when
    // grepping the library for titles. A literal cannot execute, so it is
    // stripped before the keyword scan.
    expect(() =>
      assertReadOnlySql("SELECT * FROM library_songs WHERE title = 'update me'"),
    ).not.toThrow();
    expect(() =>
      assertReadOnlySql("SELECT * FROM library_songs WHERE title LIKE '%drop%'"),
    ).not.toThrow();
    // …and a semicolon inside a literal is not a statement separator.
    expect(() =>
      assertReadOnlySql("SELECT * FROM library_songs WHERE title = 'a;b'"),
    ).not.toThrow();
  });

  it('still catches a real write that follows a literal', () => {
    expect(() => assertReadOnlySql("SELECT 'x' AS a; DELETE FROM library_songs")).toThrow(
      /single statement/i,
    );
  });
});

describe('openReadOnlyDb — read-only is asserted, not assumed', () => {
  const path = join(tmpdir(), `prod-probe-test-${process.pid}.db`);

  beforeEach(() => {
    rmSync(path, { force: true });
    const seed = new Database(path);
    // Throwaway seed: under the default journal/sync settings every DDL of the
    // full applySchema fsyncs, which blows bun's 5s hook timeout on a busy CI
    // runner disk (issue #538). Only the file's readability matters here.
    seed.run('PRAGMA journal_mode = MEMORY');
    seed.run('PRAGMA synchronous = OFF');
    applySchema(seed);
    seed.close();
  });

  afterEach(() => rmSync(path, { force: true }));

  it('returns a handle that throws on any write', () => {
    const db = openReadOnlyDb(path);
    expect(() =>
      db.run(
        `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
         VALUES ('a','A','B','c',1,0,1)`,
      ),
    ).toThrow();
    db.close();
  });

  it('still reads', () => {
    const db = openReadOnlyDb(path);
    expect(db.query('SELECT COUNT(*) c FROM library_songs').get()).toEqual({ c: 0 });
    db.close();
  });
});

describe('probes', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
       VALUES ('al','Album','Artist','art',1,0,1)`,
    );
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, synced_at)
       VALUES ('s1','al','T','Artist','art',0,'/m/a.opus',100,'2024-01-01',1)`,
    );
  });

  it('counts rows and orphans per side table', () => {
    db.run(
      `INSERT INTO library_embeddings (song_id, model, dim, vec, updated_at) VALUES ('s1','m',1,?,1)`,
      [Buffer.from(new Float32Array([1]).buffer)],
    );
    db.run(
      `INSERT INTO library_embeddings (song_id, model, dim, vec, updated_at) VALUES ('gone','m',1,?,1)`,
      [Buffer.from(new Float32Array([1]).buffer)],
    );

    const emb = probeOrphans(db).find((r) => r.table === 'library_embeddings')!;
    expect(emb.rows).toBe(2);
    expect(emb.orphans).toBe(1);
  });

  /**
   * The probe's table list is deliberately WIDER than the pruner's: measuring
   * a table you would never prune (lyrics are network-sourced + user-editable)
   * is exactly what tells you whether the policy is right. See docs.
   */
  it('measures tables the pruner deliberately leaves alone', () => {
    const tables = ORPHAN_PROBE_TABLES.map((t) => t.table);
    expect(tables).toContain('library_lyrics');
    expect(tables).toContain('library_song_genres');
  });

  it('skips a table that does not exist yet rather than throwing', () => {
    const bare = new Database(':memory:');
    expect(() => probeOrphans(bare)).not.toThrow();
    expect(probeOrphans(bare)).toEqual([]);
  });

  it('breaks acquisition jobs down by state and stage', () => {
    db.run(
      `INSERT INTO acquisition_jobs (id, kind, method, state, stage, created_at, updated_at)
       VALUES ('j1','hunt','slskd','active','scanning',1,1)`,
    );
    db.run(
      `INSERT INTO acquisition_jobs (id, kind, method, state, stage, created_at, updated_at)
       VALUES ('j2','hunt','slskd','done','complete',1,1)`,
    );

    const rows = probeJobs(db);
    expect(rows.find((r) => r.state === 'active' && r.stage === 'scanning')?.count).toBe(1);
    expect(rows.find((r) => r.state === 'done')?.count).toBe(1);
  });

  it('reports the hidden-transfer fallback size', () => {
    db.run(`INSERT INTO hidden_transfers (id) VALUES ('t1')`);
    expect(probeTransfers(db).hiddenTransfers).toBe(1);
  });
});
