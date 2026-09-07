import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  createCurationFlag,
  recordListenerReport,
  listOpenCurationFlags,
} from './curation-flags.js';

function freshDb(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

const report = (
  db: Database,
  userId: string,
  reason = 'mistagged',
  targetId = 'song-1',
  note: string | null = null,
) =>
  recordListenerReport(db, {
    targetKind: 'song',
    targetId,
    reason: note ? `${reason}: ${note}` : reason,
    reasonId: reason,
    note,
    userId,
  });

describe('recordListenerReport', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('opens a listener flag on the shared queue', () => {
    const r = report(db, 'u1');
    expect(r.created).toBe(true);
    expect(r.flag.source).toBe('listener');
    expect(r.flag.reportCount).toBe(1);
    expect(listOpenCurationFlags(db)).toHaveLength(1);
  });

  /**
   * The rate limit is structural: the abuse worth stopping is one person
   * inflating a tally, not somebody reporting two tracks quickly.
   */
  it('counts people, not clicks — a repeat report from one user moves nothing', () => {
    report(db, 'u1');
    const second = report(db, 'u1', 'misnamed');
    expect(second.counted).toBe(false);
    expect(second.flag.reportCount).toBe(1);
  });

  it('corroborates across users, carrying a genuinely new reason but not a repeat', () => {
    report(db, 'u1', 'mistagged');
    const b = report(db, 'u2', 'misnamed');
    expect(b.counted).toBe(true);
    expect(b.flag.reportCount).toBe(2);
    expect(b.flag.reason).toContain('mistagged');
    expect(b.flag.reason).toContain('misnamed');

    const c = report(db, 'u3', 'mistagged');
    expect(c.flag.reportCount).toBe(3);
    // Already said — repeating it would only add noise.
    expect(c.flag.reason.split(' · ').filter((r) => r.startsWith('mistagged'))).toHaveLength(1);
  });

  /**
   * The reason `createCurationFlag` could not be reused: it overwrites the open
   * flag's reason, so a listener would silently rewrite a curator's wording.
   */
  it("never rewrites a curator's flag — only its tally moves", () => {
    createCurationFlag(db, {
      targetKind: 'song',
      targetId: 'song-1',
      reason: 'b2b credit needs a human ruling',
      createdBy: 'curator-1',
    });

    const r = report(db, 'u1', 'mistagged');

    expect(r.deferredToCurator).toBe(true);
    expect(r.flag.reason).toBe('b2b credit needs a human ruling');
    // The count means *listeners who reported*, so a curator's own finding is
    // not one of them: this reads "a curator flagged it, and 1 listener agrees".
    expect(r.flag.reportCount).toBe(1);
    expect(r.flag.source).toBe('curator');
  });

  it("keeps each reporter's own words, which one merged string loses", () => {
    report(db, 'u1', 'quality', 'song-1', 'clips at 0:42');
    report(db, 'u2', 'misnamed', 'song-1', 'title is a filename');
    const rows = db
      .query<{ user_id: string; reason: string; note: string | null }, [string]>(
        `SELECT user_id, reason, note FROM curation_flag_reports WHERE target_id = ? ORDER BY user_id`,
      )
      .all('song-1');
    expect(rows).toEqual([
      { user_id: 'u1', reason: 'quality', note: 'clips at 0:42' },
      { user_id: 'u2', reason: 'misnamed', note: 'title is a filename' },
    ]);
  });

  it('keeps separate targets separate', () => {
    report(db, 'u1', 'mistagged', 'song-1');
    report(db, 'u1', 'mistagged', 'song-2');
    expect(listOpenCurationFlags(db)).toHaveLength(2);
  });

  it('reads a pre-existing row as a curator flag (the column defaults)', () => {
    const { flag } = createCurationFlag(db, {
      targetKind: 'album',
      targetId: 'alb-1',
      reason: 'x',
      createdBy: 'c',
    });
    expect(flag.source).toBe('curator');
    expect(flag.reportCount).toBe(1);
  });
});
