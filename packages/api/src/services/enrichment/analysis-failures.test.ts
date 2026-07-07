import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db.js';
import {
  MAX_ANALYSIS_ATTEMPTS,
  recordAnalysisFailure,
  clearAnalysisFailure,
  notPermanentlyFailedClause,
  countSkippedFiles,
} from './analysis-failures.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function failCount(songId: string, task: string): number {
  return (
    db
      .query<{ fail_count: number }, [string, string]>(
        'SELECT fail_count FROM library_song_analysis_failures WHERE song_id = ? AND task = ?',
      )
      .get(songId, task)?.fail_count ?? 0
  );
}

describe('recordAnalysisFailure', () => {
  it('increments the count for repeated failures of the same file', () => {
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    expect(failCount('s1', 'bpm')).toBe(3);
  });

  it('resets the count when the file size changed (a re-download)', () => {
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    expect(failCount('s1', 'bpm')).toBe(2);
    // New bytes → fresh start.
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 250);
    expect(failCount('s1', 'bpm')).toBe(1);
  });

  it('keeps separate counters per task', () => {
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    recordAnalysisFailure(db, 's1', 'key', new Error('boom'), 100);
    expect(failCount('s1', 'bpm')).toBe(1);
    expect(failCount('s1', 'key')).toBe(1);
  });

  it('stores a truncated error sample', () => {
    recordAnalysisFailure(db, 's1', 'bpm', new Error('x'.repeat(1000)), 100);
    const row = db
      .query<{ last_error: string }, [string]>(
        'SELECT last_error FROM library_song_analysis_failures WHERE song_id = ?',
      )
      .get('s1');
    expect(row!.last_error.length).toBeLessThanOrEqual(500);
  });
});

describe('clearAnalysisFailure', () => {
  it('removes the row (e.g. after a success)', () => {
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    clearAnalysisFailure(db, 's1', 'bpm');
    expect(failCount('s1', 'bpm')).toBe(0);
  });
});

describe('notPermanentlyFailedClause', () => {
  function seedSong(id: string, size: number): void {
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, synced_at)
       VALUES (?, 'alb', ?, 'A', 'art', 0, ?, ?, 1)`,
      [id, `T-${id}`, `${id}.mp3`, size],
    );
  }

  it('excludes a song only once it hits the attempt cap (same file)', () => {
    seedSong('s1', 100);
    const sql = `SELECT COUNT(*) AS n FROM library_songs WHERE 1=1${notPermanentlyFailedClause('bpm')}`;
    const count = () => db.query<{ n: number }, []>(sql).get()!.n;

    expect(count()).toBe(1);
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS - 1; i++) {
      recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    }
    expect(count()).toBe(1); // below the cap — still eligible
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    expect(count()).toBe(0); // at the cap — excluded
  });

  it('re-includes an excluded song after its file changes size', () => {
    seedSong('s1', 100);
    const sql = `SELECT COUNT(*) AS n FROM library_songs WHERE 1=1${notPermanentlyFailedClause('bpm')}`;
    const count = () => db.query<{ n: number }, []>(sql).get()!.n;
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS; i++) {
      recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    }
    expect(count()).toBe(0);
    // Re-download: the library row's size changes; the stale failure no longer matches.
    db.run('UPDATE library_songs SET size = 250 WHERE id = ?', ['s1']);
    expect(count()).toBe(1);
  });

  it('is scoped per task', () => {
    seedSong('s1', 100);
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS; i++) {
      recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    }
    const bpmCount = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM library_songs WHERE 1=1${notPermanentlyFailedClause('bpm')}`,
      )
      .get()!.n;
    const keyCount = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM library_songs WHERE 1=1${notPermanentlyFailedClause('key')}`,
      )
      .get()!.n;
    expect(bpmCount).toBe(0); // excluded for bpm
    expect(keyCount).toBe(1); // still eligible for key
  });
});

describe('countSkippedFiles', () => {
  it('counts distinct files at the cap across tasks', () => {
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS; i++) {
      recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
      recordAnalysisFailure(db, 's1', 'key', new Error('boom'), 100);
      recordAnalysisFailure(db, 's2', 'energy', new Error('boom'), 100);
    }
    // s1 (bpm+key) counts once; s2 once → 2 distinct files.
    expect(countSkippedFiles(db)).toBe(2);
  });

  it('is zero below the cap', () => {
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    expect(countSkippedFiles(db)).toBe(0);
  });
});
