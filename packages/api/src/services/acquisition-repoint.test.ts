import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { repointOrphanedAcquisitions } from './acquisition-repoint.js';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.run('CREATE TABLE library_songs (id TEXT PRIMARY KEY, path TEXT)');
  db.run(`CREATE TABLE acquisitions (
    relative_path TEXT PRIMARY KEY, method TEXT, source_ref TEXT,
    stage TEXT, started_at INTEGER, completed_at INTEGER, error TEXT)`);
  return db;
}

function addSong(db: Database, path: string): void {
  db.run('INSERT INTO library_songs (id, path) VALUES (?, ?)', [`id:${path}`, path]);
}
function addAcq(db: Database, path: string, method = 'slskd'): void {
  db.run('INSERT INTO acquisitions (relative_path, method, started_at) VALUES (?, ?, 1)', [
    path,
    method,
  ]);
}
function acqPaths(db: Database): string[] {
  return (
    db.query('SELECT relative_path p FROM acquisitions ORDER BY relative_path').all() as Array<{
      p: string;
    }>
  ).map((r) => r.p);
}

describe('repointOrphanedAcquisitions (issue #313)', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  // The prod case: 331 of the stem-matched orphans are opus → mp3.
  it('follows a file whose extension changed, when the live file has no provenance', () => {
    addSong(db, 'Acid Pauli/Mst/02 - A Clone.mp3');
    addAcq(db, 'Acid Pauli/Mst/02 - A Clone.opus');

    const r = repointOrphanedAcquisitions(db);
    expect(r.repointed).toBe(1);
    expect(acqPaths(db)).toEqual(['Acid Pauli/Mst/02 - A Clone.mp3']);
  });

  // 418 of the 435 on prod. The newer row is the true record; the orphan is history.
  it('leaves superseded history alone when the live file already has its own row', () => {
    addSong(db, 'A/B/01 - T.mp3');
    addAcq(db, 'A/B/01 - T.mp3', 'ytdlp');
    addAcq(db, 'A/B/01 - T.opus', 'slskd');

    const r = repointOrphanedAcquisitions(db);
    expect(r.repointed).toBe(0);
    expect(r.skippedCovered).toBe(1);
    // The live file keeps its own, newer provenance — not overwritten.
    expect(
      db.query('SELECT method m FROM acquisitions WHERE relative_path = ?').get('A/B/01 - T.mp3'),
    ).toEqual({ m: 'ytdlp' });
  });

  it('refuses an ambiguous stem — two live files give no basis to choose', () => {
    addSong(db, 'A/B/01 - T.mp3');
    addSong(db, 'A/B/01 - T.flac');
    addAcq(db, 'A/B/01 - T.opus');

    const r = repointOrphanedAcquisitions(db);
    expect(r.repointed).toBe(0);
    expect(r.skippedAmbiguous).toBe(1);
    expect(acqPaths(db)).toEqual(['A/B/01 - T.opus']);
  });

  it('leaves a genuinely deleted file alone — no live song shares its stem', () => {
    addSong(db, 'Other/Album/01 - Kept.mp3');
    addAcq(db, 'Deleted/Album/01 - Gone.flac');

    const r = repointOrphanedAcquisitions(db);
    expect(r.repointed).toBe(0);
    expect(acqPaths(db)).toEqual(['Deleted/Album/01 - Gone.flac']);
  });

  it('lets only the first of two orphans claim a shared live target', () => {
    addSong(db, 'A/B/01 - T.mp3');
    addAcq(db, 'A/B/01 - T.opus');
    addAcq(db, 'A/B/01 - T.flac');

    const r = repointOrphanedAcquisitions(db);
    expect(r.repointed).toBe(1);
    expect(r.skippedCovered).toBe(1);
    // Exactly one row now points at the live file; the other is untouched.
    expect(acqPaths(db)).toContain('A/B/01 - T.mp3');
    expect(acqPaths(db).length).toBe(2);
  });

  it('is idempotent — a second pass repoints nothing', () => {
    addSong(db, 'A/B/01 - T.mp3');
    addAcq(db, 'A/B/01 - T.opus');

    expect(repointOrphanedAcquisitions(db).repointed).toBe(1);
    expect(repointOrphanedAcquisitions(db).repointed).toBe(0);
  });

  it('does nothing on an empty library — a rebuild must not be read as a mass rename', () => {
    addAcq(db, 'A/B/01 - T.opus');
    expect(repointOrphanedAcquisitions(db).repointed).toBe(0);
    expect(acqPaths(db)).toEqual(['A/B/01 - T.opus']);
  });

  it('survives a schema-less DB without throwing', () => {
    expect(() => repointOrphanedAcquisitions(new Database(':memory:'))).not.toThrow();
  });
});
