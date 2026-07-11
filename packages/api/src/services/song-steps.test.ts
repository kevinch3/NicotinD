import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { MAX_ANALYSIS_ATTEMPTS } from './enrichment/analysis-failures.js';
import { loadQuarantineQueue } from './song-steps.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES ('al', 'Album', 'Artist', 'art', 1, 0, 1)`,
  );
});

/** Insert a quarantined song with the given analysis columns. */
function seed(id: string, cols: { bpm?: number; key?: string; energy?: number; genre?: string; danceability?: number } = {}): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, created, bpm, key, energy, genre, danceability, synced_at)
     VALUES (?, 'al', ?, 'Artist', 'art', 0, ?, 10, '2024-01-01', ?, ?, ?, ?, ?, 1)`,
    [id, `T-${id}`, `${id}.opus`, cols.bpm ?? null, cols.key ?? null, cols.energy ?? null, cols.genre ?? null, cols.danceability ?? null],
  );
}

describe('loadQuarantineQueue', () => {
  it('returns quarantined songs grouped by album with per-step state', () => {
    seed('s1', { bpm: 120 }); // bpm done, rest pending
    const queue = loadQuarantineQueue(db);
    expect(queue).toHaveLength(1);
    expect(queue[0].albumId).toBe('al');
    expect(queue[0].songs).toHaveLength(1);
    const steps = queue[0].songs[0].steps;
    expect(steps.download).toBe('done');
    expect(steps.bpm).toBe('done');
    expect(steps.key).toBe('pending');
    expect(steps.energy).toBe('pending');
  });

  it('marks a permanently-failed step as skipped, not pending', () => {
    seed('s1'); // no bpm value
    db.run(
      `INSERT INTO library_song_analysis_failures (song_id, task, fail_count, last_error, file_size, last_attempt)
       VALUES ('s1', 'bpm', ?, 'corrupt', 10, 1)`,
      [MAX_ANALYSIS_ATTEMPTS],
    );
    const steps = loadQuarantineQueue(db)[0].songs[0].steps;
    expect(steps.bpm).toBe('skipped');
  });

  it('excludes already-landed songs', () => {
    seed('s1', { bpm: 120 });
    db.run(`UPDATE library_songs SET landed_at = 1 WHERE id = 's1'`);
    expect(loadQuarantineQueue(db)).toEqual([]);
  });

  it('maps the mood step to the sidecar danceability column', () => {
    seed('s1', { danceability: 0.8 });
    expect(loadQuarantineQueue(db)[0].songs[0].steps.mood).toBe('done');
  });
});
