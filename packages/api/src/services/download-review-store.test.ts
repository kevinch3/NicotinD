import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  recordReviewDecision,
  getReviewDecision,
  loadReviewQueue,
  pendingReviewStats,
  armReviewHold,
} from './download-review-store.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function seedQuarantined(
  id: string,
  albumId: string,
  created = '2026-08-01T00:00:00.000Z',
  hidden = 0,
): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, hidden, synced_at)
     VALUES (?, ?, ?, 'A', 'ar1', 0, ?, 10, 320, 'flac', 'audio/flac', ?, ?, 1)`,
    [id, albumId, id, `/m/${id}.flac`, created, hidden],
  );
  db.run(
    `INSERT OR IGNORE INTO library_albums (id, name, artist, artist_id, synced_at) VALUES (?, 'Alb', 'A', 'ar1', 1)`,
    [albumId],
  );
}

describe('download-review-store', () => {
  it('quarantined album with no decision is pending', () => {
    seedQuarantined('s1', 'al1');
    armReviewHold(db);
    expect(pendingReviewStats(db, true).pending).toBe(1);
    expect(loadReviewQueue(db).map((a) => a.albumId)).toEqual(['al1']);
  });

  it('approved decision covers the album (not pending) and round-trips', () => {
    seedQuarantined('s1', 'al1');
    armReviewHold(db);
    recordReviewDecision(db, 'al1', 'approved', 'u1', new Date('2026-08-02T00:00:00.000Z'));
    expect(getReviewDecision(db, 'al1')?.state).toBe('approved');
    expect(pendingReviewStats(db, true).pending).toBe(0);
  });

  it('a song quarantined AFTER the decision re-pends the album (re-download after discard)', () => {
    seedQuarantined('s1', 'al1', '2026-08-01T00:00:00.000Z');
    armReviewHold(db);
    recordReviewDecision(db, 'al1', 'discarded', 'u1', new Date('2026-08-02T00:00:00.000Z'));
    expect(pendingReviewStats(db, true).pending).toBe(0);
    seedQuarantined('s2', 'al1', '2026-08-03T00:00:00.000Z');
    expect(pendingReviewStats(db, true).pending).toBe(1);
  });

  it('landed songs never count', () => {
    seedQuarantined('s1', 'al1');
    armReviewHold(db);
    db.run(`UPDATE library_songs SET landed_at = 1 WHERE id = 's1'`);
    expect(pendingReviewStats(db, true).pending).toBe(0);
  });

  // Issue #416: hidden rows (dedupe/audit suppressions) must neither surface in
  // the queue nor inflate the pending badge — a curator can't act on a song no
  // listing will ever show.
  it('hidden songs never count (queue + stats)', () => {
    seedQuarantined('s1', 'al1', '2026-08-01T00:00:00.000Z', 1);
    armReviewHold(db);
    expect(pendingReviewStats(db, true)).toEqual({ pending: 0, oldestCreated: null });
    expect(loadReviewQueue(db)).toEqual([]);
    // A visible sibling still pends — the exclusion is per-row, not per-album.
    seedQuarantined('s2', 'al1', '2026-08-02T00:00:00.000Z');
    expect(pendingReviewStats(db, true).pending).toBe(1);
  });

  it('recordReviewDecision upserts (idempotent re-approve)', () => {
    seedQuarantined('s1', 'al1');
    recordReviewDecision(db, 'al1', 'approved', 'u1');
    recordReviewDecision(db, 'al1', 'approved', 'u2');
    expect(getReviewDecision(db, 'al1')?.reviewedBy).toBe('u2');
  });

  describe('pendingReviewStats', () => {
    it('oldestCreated is the MIN(created) across pending albums', () => {
      seedQuarantined('s1', 'al1', '2026-08-03T00:00:00.000Z');
      seedQuarantined('s2', 'al2', '2026-08-01T00:00:00.000Z');
      armReviewHold(db);
      const stats = pendingReviewStats(db, true);
      expect(stats.pending).toBe(2);
      expect(stats.oldestCreated).toBe('2026-08-01T00:00:00.000Z');
    });

    it('holdForReview off reports zeros even when armed with pending albums', () => {
      seedQuarantined('s1', 'al1');
      armReviewHold(db);
      expect(pendingReviewStats(db, false)).toEqual({ pending: 0, oldestCreated: null });
    });

    it('unarmed (bootstrap-exempt) reports zeros even with holdForReview on', () => {
      seedQuarantined('s1', 'al1');
      expect(pendingReviewStats(db, true)).toEqual({ pending: 0, oldestCreated: null });
    });
  });
});
