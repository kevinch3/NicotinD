import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  recordPendingFeedback,
  resolveFeedback,
  listFeedback,
  feedbackCaptureEnabled,
  captureHuntMatchFeedback,
  PENDING_TTL_MS,
} from './generation-feedback.js';
import { huntFixtureFromRecord } from './generation-feedback.js';
import type {
  HuntMatchInput,
  HuntMatchOutput,
  GenerationFeedbackRecord,
} from '@nicotind/core';

let db: Database;

const INPUT: HuntMatchInput = {
  artistName: 'Soda Stereo',
  albumTitle: 'Canción Animal',
  lidarrAlbumId: 42,
  releaseGroupMbid: 'rg-1',
  artistMbid: 'ar-1',
  canonicalTracks: [{ title: 'Canción Animal' }, { title: 'De Música Ligera' }],
};

const OUTPUT: HuntMatchOutput = {
  rawResponses: [
    {
      username: 'alice',
      fileCount: 2,
      lockedFileCount: 0,
      freeUploadSlots: 1,
      uploadSpeed: 100,
      queueLength: 0,
      files: [
        { filename: 'A/Album/01 Cancion Animal.flac', size: 1, code: '1' },
        { filename: 'A/Album/02 De Musica Ligera.flac', size: 1, code: '1' },
      ],
    },
  ],
  candidates: [
    {
      username: 'alice',
      directory: 'A/Album',
      matchPct: 100,
      matchedTracks: 2,
      totalTracks: 2,
      format: 'FLAC',
      files: [{ filename: 'A/Album/01 Cancion Animal.flac', size: 1 }],
    },
  ],
  chosen: null,
};

function record(now?: number): number {
  return recordPendingFeedback(db, {
    userId: 'u1',
    username: 'admin',
    resourceType: 'hunt-match',
    resourceRef: '42',
    input: INPUT,
    output: OUTPUT,
    engineVersion: '0.1.238',
    now,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('recordPendingFeedback', () => {
  it('inserts a pending (verdict NULL) row and returns its id', () => {
    const id = record();
    expect(id).toBeGreaterThan(0);

    const [row] = listFeedback(db, {});
    expect(row.id).toBe(id);
    expect(row.verdict).toBeNull();
    expect(row.resourceType).toBe('hunt-match');
    expect(row.resourceRef).toBe('42');
    expect(row.engineVersion).toBe('0.1.238');
  });

  it('round-trips the full input/output snapshot as parsed JSON', () => {
    record();
    const [row] = listFeedback(db, {});
    const input = row.input as HuntMatchInput;
    expect(input.artistName).toBe('Soda Stereo');
    expect(input.canonicalTracks).toHaveLength(2);
    const output = row.output as HuntMatchOutput;
    expect(output.rawResponses[0].files).toHaveLength(2);
  });

  it('prunes stale pending rows on insert (TTL)', () => {
    const stale = record(Date.now() - PENDING_TTL_MS - 1);
    const fresh = record();
    const ids = listFeedback(db, {}).map((r) => r.id);
    expect(ids).toContain(fresh);
    expect(ids).not.toContain(stale);
  });

  it('does not prune a graded row even if it is old', () => {
    const old = record(Date.now() - PENDING_TTL_MS - 1);
    resolveFeedback(db, old, 'u1', { verdict: 'good' });
    record(); // triggers prune
    const ids = listFeedback(db, {}).map((r) => r.id);
    expect(ids).toContain(old);
  });
});

describe('resolveFeedback', () => {
  it('sets verdict/note/itemFlags on a pending row owned by the user', () => {
    const id = record();
    const ok = resolveFeedback(db, id, 'u1', {
      verdict: 'bad',
      note: 'picked the live bootleg',
      itemFlags: { correctFolder: { username: 'bob', directory: 'B/Album' } },
    });
    expect(ok).toBe(true);

    const [row] = listFeedback(db, {});
    expect(row.verdict).toBe('bad');
    expect(row.note).toBe('picked the live bootleg');
    expect(row.itemFlags?.correctFolder).toEqual({ username: 'bob', directory: 'B/Album' });
  });

  it('returns false for a non-existent id', () => {
    expect(resolveFeedback(db, 9999, 'u1', { verdict: 'good' })).toBe(false);
  });

  it('refuses to resolve a row owned by another user', () => {
    const id = record();
    expect(resolveFeedback(db, id, 'someone-else', { verdict: 'good' })).toBe(false);
    const [row] = listFeedback(db, {});
    expect(row.verdict).toBeNull();
  });
});

describe('feedbackCaptureEnabled', () => {
  beforeEach(() => {
    db.run(
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'admin', 'x', 'admin', '2020-01-01')",
    );
  });

  it('is false when the user has no settings row', () => {
    expect(feedbackCaptureEnabled(db, 'u1')).toBe(false);
  });

  it('reflects the feedback_capture flag', () => {
    db.run("INSERT INTO user_settings (user_id, feedback_capture) VALUES ('u1', 1)");
    expect(feedbackCaptureEnabled(db, 'u1')).toBe(true);
    db.run('UPDATE user_settings SET feedback_capture = 0 WHERE user_id = ?', ['u1']);
    expect(feedbackCaptureEnabled(db, 'u1')).toBe(false);
  });
});

describe('captureHuntMatchFeedback (admin + toggle gate)', () => {
  const args = {
    input: INPUT,
    rawResponses: OUTPUT.rawResponses,
    candidates: OUTPUT.candidates,
    chosen: null,
    engineVersion: '0.1.0',
  };

  beforeEach(() => {
    db.run(
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'admin', 'x', 'admin', '2020-01-01')",
    );
  });

  function withToggle(on: boolean) {
    db.run('INSERT INTO user_settings (user_id, feedback_capture) VALUES (?, ?)', ['u1', on ? 1 : 0]);
  }

  it('returns 0 and records nothing for a non-admin', () => {
    withToggle(true);
    const id = captureHuntMatchFeedback(db, { sub: 'u1', role: 'user' }, args);
    expect(id).toBe(0);
    expect(listFeedback(db, {})).toHaveLength(0);
  });

  it('returns 0 when the admin has the toggle off', () => {
    withToggle(false);
    const id = captureHuntMatchFeedback(db, { sub: 'u1', role: 'admin' }, args);
    expect(id).toBe(0);
    expect(listFeedback(db, {})).toHaveLength(0);
  });

  it('records a pending row for an admin with the toggle on', () => {
    withToggle(true);
    const id = captureHuntMatchFeedback(db, { sub: 'u1', username: 'admin', role: 'admin' }, args);
    expect(id).toBeGreaterThan(0);
    const [row] = listFeedback(db, {});
    expect(row.resourceType).toBe('hunt-match');
    expect(row.verdict).toBeNull();
    expect((row.input as HuntMatchInput).albumTitle).toBe('Canción Animal');
  });
});

describe('huntFixtureFromRecord', () => {
  function record(over: Partial<GenerationFeedbackRecord>): GenerationFeedbackRecord {
    return {
      id: 7,
      at: 0,
      userId: 'u1',
      username: 'admin',
      resourceType: 'hunt-match',
      resourceRef: '42',
      verdict: 'good',
      note: null,
      input: INPUT,
      output: OUTPUT,
      itemFlags: null,
      engineVersion: '0.1.0',
      ...over,
    };
  }

  it('returns null for an ungraded record', () => {
    expect(huntFixtureFromRecord(record({ verdict: null }))).toBeNull();
  });

  it('returns null for a non-hunt-match record', () => {
    expect(huntFixtureFromRecord(record({ resourceType: 'radio' }))).toBeNull();
  });

  it('👍: expected.correctFolder is the top candidate', () => {
    const fx = huntFixtureFromRecord(record({ verdict: 'good' }))!;
    expect(fx.canonicalTracks.map((t) => t.title)).toContain('Canción Animal');
    expect(fx.rawResponses[0].username).toBe('alice');
    expect(fx.expected.correctFolder).toEqual({ username: 'alice', directory: 'A/Album' });
    expect(fx.meta).toMatchObject({ id: 7, verdict: 'good' });
  });

  it('👎: expected.correctFolder comes from itemFlags', () => {
    const fx = huntFixtureFromRecord(
      record({
        verdict: 'bad',
        itemFlags: { correctFolder: { username: 'bob', directory: 'B/Album' } },
      }),
    )!;
    expect(fx.expected.correctFolder).toEqual({ username: 'bob', directory: 'B/Album' });
  });

  it('👎 "none of these": expected.correctFolder is null', () => {
    const fx = huntFixtureFromRecord(
      record({ verdict: 'bad', itemFlags: { correctFolder: null } }),
    )!;
    expect(fx.expected.correctFolder).toBeNull();
  });
});

describe('listFeedback', () => {
  it('filters to graded rows only when graded=true', () => {
    const graded = record();
    resolveFeedback(db, graded, 'u1', { verdict: 'good' });
    record(); // pending

    const gradedRows = listFeedback(db, { graded: true });
    expect(gradedRows).toHaveLength(1);
    expect(gradedRows[0].id).toBe(graded);
  });

  it('filters by resourceType', () => {
    record();
    expect(listFeedback(db, { resourceType: 'hunt-match' })).toHaveLength(1);
    expect(listFeedback(db, { resourceType: 'radio' })).toHaveLength(0);
  });
});
