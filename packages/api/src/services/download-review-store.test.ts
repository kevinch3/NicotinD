import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  recordReviewDecision,
  getReviewDecision,
  loadReviewQueue,
  pendingReviewCount,
} from './download-review-store.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function seedQuarantined(id: string, albumId: string, created = '2026-08-01T00:00:00.000Z'): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, hidden, synced_at)
     VALUES (?, ?, ?, 'A', 'ar1', 0, ?, 10, 320, 'flac', 'audio/flac', ?, 0, 1)`,
    [id, albumId, id, `/m/${id}.flac`, created],
  );
  db.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, synced_at) VALUES (?, 'Alb', 'A', 'ar1', 1)`,
    [albumId],
  );
}

describe('download-review-store', () => {
  it('quarantined album with no decision is pending', () => {
    seedQuarantined('s1', 'al1');
    expect(pendingReviewCount(db)).toBe(1);
    expect(loadReviewQueue(db).map((a) => a.albumId)).toEqual(['al1']);
  });

  it('approved decision covers the album (not pending) and round-trips', () => {
    seedQuarantined('s1', 'al1');
    recordReviewDecision(db, 'al1', 'approved', 'u1', new Date('2026-08-02T00:00:00.000Z'));
    expect(getReviewDecision(db, 'al1')?.state).toBe('approved');
    expect(pendingReviewCount(db)).toBe(0);
  });

  it('a song quarantined AFTER the decision re-pends the album (re-download after discard)', () => {
    seedQuarantined('s1', 'al1', '2026-08-01T00:00:00.000Z');
    recordReviewDecision(db, 'al1', 'discarded', 'u1', new Date('2026-08-02T00:00:00.000Z'));
    expect(pendingReviewCount(db)).toBe(0);
    seedQuarantined('s2', 'al1', '2026-08-03T00:00:00.000Z');
    expect(pendingReviewCount(db)).toBe(1);
  });

  it('landed songs never count', () => {
    seedQuarantined('s1', 'al1');
    db.run(`UPDATE library_songs SET landed_at = 1 WHERE id = 's1'`);
    expect(pendingReviewCount(db)).toBe(0);
  });

  it('recordReviewDecision upserts (idempotent re-approve)', () => {
    seedQuarantined('s1', 'al1');
    recordReviewDecision(db, 'al1', 'approved', 'u1');
    recordReviewDecision(db, 'al1', 'approved', 'u2');
    expect(getReviewDecision(db, 'al1')?.reviewedBy).toBe('u2');
  });
});
