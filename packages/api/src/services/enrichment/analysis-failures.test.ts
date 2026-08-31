import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../../db.js';
import {
  MAX_ANALYSIS_ATTEMPTS,
  recordAnalysisFailure,
  clearAnalysisFailure,
  notPermanentlyFailedClause,
  permanentlyFailedClause,
  countSkippedFiles,
  rebaseAnalysisFileSize,
  noteAnalysisAttempt,
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

describe('permanentlyFailedClause', () => {
  function seedSong(id: string, size: number): void {
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, synced_at)
       VALUES (?, 'alb', ?, 'A', 'art', 0, ?, ?, 1)`,
      [id, `T-${id}`, `${id}.mp3`, size],
    );
  }

  // It's the exact complement of notPermanentlyFailedClause: true only once a file
  // is at the attempt cap for the task (and unchanged in size). Composed into an
  // OR in the graduation predicate.
  it('matches a song only once it hits the attempt cap (same file)', () => {
    seedSong('s1', 100);
    const sql = `SELECT COUNT(*) AS n FROM library_songs WHERE ${permanentlyFailedClause('bpm')}`;
    const count = () => db.query<{ n: number }, []>(sql).get()!.n;

    expect(count()).toBe(0); // no failures yet
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS; i++) {
      recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    }
    expect(count()).toBe(1); // at the cap — permanently failed
    // A re-download (size change) clears the permanent-failure state.
    db.run('UPDATE library_songs SET size = 250 WHERE id = ?', ['s1']);
    expect(count()).toBe(0);
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

describe('rebaseAnalysisFileSize (issue #690)', () => {
  function seedSong(id: string, size: number): void {
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, synced_at)
       VALUES (?, 'alb', ?, 'A', 'art', 0, ?, ?, 1)`,
      [id, `T-${id}`, `${id}.opus`, size],
    );
  }

  const pendingIds = (): string[] =>
    db
      .query<{ id: string }, []>(
        `SELECT id FROM library_songs WHERE 1 = 1${notPermanentlyFailedClause('bpm')}`,
      )
      .all()
      .map((r) => r.id);

  it('a tag write that grows the file does not reset the attempt counter', () => {
    seedSong('s1', 100);
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);

    // Enrichment writes its own BPM/KEY/ENERGY tags back into the same file.
    rebaseAnalysisFileSize(db, 's1', 269);
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 269);

    expect(failCount('s1', 'bpm')).toBe(2);
  });

  it('keeps the ledger matched to library_songs.size so the cap still excludes the file', () => {
    seedSong('s1', 100);
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS; i++) {
      recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    }
    expect(pendingIds()).toEqual([]);

    // Our own write must not silently re-open a file that already hit the cap.
    rebaseAnalysisFileSize(db, 's1', 269);

    expect(pendingIds()).toEqual([]);
  });

  it('leaves a genuine re-download resetting the counter', () => {
    seedSong('s1', 100);
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    // No rebase — the bytes changed underneath us, so this is a fresh file.
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 900);

    expect(failCount('s1', 'bpm')).toBe(1);
  });
});

describe('noteAnalysisAttempt — a stamp, not a strike (issue #851)', () => {
  function seedSong(id: string, size: number): void {
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, synced_at)
       VALUES (?, 'alb', ?, 'A', 'art', 0, ?, ?, 1)`,
      [id, `T-${id}`, `${id}.mp3`, size],
    );
  }

  function pendingIds(task: 'bpm' | 'popularity'): string[] {
    return db
      .query<{ id: string }, []>(
        `SELECT id FROM library_songs WHERE 1=1${notPermanentlyFailedClause(task)} ORDER BY id`,
      )
      .all()
      .map((r) => r.id);
  }

  function row(songId: string, task: string) {
    return db
      .query<
        { fail_count: number; terminal: number; file_size: number | null; last_attempt: number },
        [string, string]
      >(
        'SELECT fail_count, terminal, file_size, last_attempt FROM library_song_analysis_failures WHERE song_id = ? AND task = ?',
      )
      .get(songId, task);
  }

  it('inserts a zero-strike row so the song stays in the pending pool', () => {
    seedSong('s1', 100);
    noteAnalysisAttempt(db, 's1', 'popularity', 100);

    expect(row('s1', 'popularity')?.fail_count).toBe(0);
    expect(row('s1', 'popularity')?.terminal).toBe(0);
    expect(row('s1', 'popularity')?.last_attempt).toBeGreaterThan(0);
    expect(pendingIds('popularity')).toEqual(['s1']);
  });

  it('repeated stamps never accumulate into an exclusion', () => {
    seedSong('s1', 100);
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS + 3; i++) {
      noteAnalysisAttempt(db, 's1', 'popularity', 100);
    }
    expect(row('s1', 'popularity')?.fail_count).toBe(0);
    expect(pendingIds('popularity')).toEqual(['s1']);
  });

  it("never disturbs a real failure's bookkeeping", () => {
    seedSong('s1', 100);
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    recordAnalysisFailure(db, 's1', 'bpm', new Error('boom'), 100);
    const before = row('s1', 'bpm')!;

    noteAnalysisAttempt(db, 's1', 'bpm', 100);

    const after = row('s1', 'bpm')!;
    // A stamp that reset the count would let a broken file evade the cap forever.
    expect(after.fail_count).toBe(before.fail_count);
    expect(after.file_size).toBe(before.file_size);
    expect(after.terminal).toBe(before.terminal);
  });

  it('does not resurrect a song already settled by a confident negative', () => {
    seedSong('s1', 100);
    recordAnalysisFailure(db, 's1', 'popularity', new Error('no listen data'), 100, true);
    noteAnalysisAttempt(db, 's1', 'popularity', 100);

    expect(row('s1', 'popularity')?.terminal).toBe(1);
    expect(pendingIds('popularity')).toEqual([]);
  });
});
