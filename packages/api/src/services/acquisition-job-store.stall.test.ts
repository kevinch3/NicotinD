import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  createJob,
  isCardStalled,
  recomputeStage,
  stalledResourceCandidates,
  type StallFacts,
} from './acquisition-job-store.js';

const MIN = 60_000;
const NOW = 100 * MIN;
const STALL = 10 * MIN;

describe('isCardStalled (#2048)', () => {
  const card = (items: StallFacts['items'], createdAt = 0): StallFacts => ({ createdAt, items });

  it('is stalled when nothing still waiting has moved for the whole window', () => {
    const facts = card([
      { state: 'scanned', progressAt: NOW - 60 * MIN },
      { state: 'downloading', progressAt: NOW - 30 * MIN },
      { state: 'queued', progressAt: NOW - 30 * MIN },
    ]);
    expect(isCardStalled(facts, NOW, STALL)).toBe(true);
  });

  it('is not stalled while one item is still moving, even if another is frozen', () => {
    // The peer is delivering track 3; track 9 waiting behind it is not a dead end.
    const facts = card([
      { state: 'downloading', progressAt: NOW - 1 * MIN },
      { state: 'queued', progressAt: NOW - 3 * 60 * MIN },
    ]);
    expect(isCardStalled(facts, NOW, STALL)).toBe(false);
  });

  it('counts a peer that never started (queued, no bytes) as stalled', () => {
    const facts = card([{ state: 'queued', progressAt: NOW - 11 * MIN }]);
    expect(isCardStalled(facts, NOW, STALL)).toBe(true);
  });

  it('is not stalled while a landed file is still being organized', () => {
    const facts = card([
      { state: 'completed', progressAt: NOW - 2 * MIN },
      { state: 'queued', progressAt: NOW - 40 * MIN },
    ]);
    expect(isCardStalled(facts, NOW, STALL)).toBe(false);
  });

  it('never calls a card younger than the window stalled', () => {
    const facts = card([{ state: 'queued', progressAt: NOW - 30 * MIN }], NOW - 5 * MIN);
    expect(isCardStalled(facts, NOW, STALL)).toBe(false);
  });

  it('is not stalled when nothing is left to wait for', () => {
    const facts = card([
      { state: 'scanned', progressAt: NOW - 60 * MIN },
      { state: 'unavailable', progressAt: NOW - 60 * MIN },
    ]);
    expect(isCardStalled(facts, NOW, STALL)).toBe(false);
  });
});

describe('stalledResourceCandidates (#2048)', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  function frozenCard(kind: 'album-hunt' | 'direct' = 'album-hunt'): string {
    const jobId = createJob(db, {
      kind,
      method: 'fixture-addon',
      userId: 'u',
      artistName: 'Luis Alberto Spinetta',
      albumTitle: "A 18' del sol",
      canonicalTracks: ['Viejas mascotas', 'Toda la tarde'],
      sourceRef: 'addon:fixture-addon:aj-1',
      username: 'slow-peer',
      files: [
        { filename: 'S\\A18\\01 Viejas mascotas.flac', size: 1, trackTitle: 'Viejas mascotas' },
        { filename: 'S\\A18\\02 Toda la tarde.flac', size: 1, trackTitle: 'Toda la tarde' },
      ],
    });
    db.run(
      `UPDATE acquisition_job_items SET state = 'scanned', progress_at = ?
        WHERE job_id = ? AND track_title = 'Viejas mascotas'`,
      [NOW - 3 * 60 * MIN, jobId],
    );
    db.run(
      `UPDATE acquisition_job_items SET state = 'downloading', progress_at = ?
        WHERE job_id = ? AND track_title = 'Toda la tarde'`,
      [NOW - 3 * 60 * MIN, jobId],
    );
    recomputeStage(db, jobId);
    db.run(`UPDATE acquisition_jobs SET state = 'active', created_at = 0 WHERE id = ?`, [jobId]);
    return jobId;
  }

  const candidates = (jobId?: string) =>
    stalledResourceCandidates(db, { maxAttempts: 2, stallMs: STALL, now: NOW, jobId });

  it('lists a running album card that has stopped moving', () => {
    const jobId = frozenCard();
    expect(candidates()).toEqual([jobId]);
    expect(candidates(jobId)).toEqual([jobId]);
  });

  it('skips a card that moved within the window', () => {
    const jobId = frozenCard();
    db.run(
      `UPDATE acquisition_job_items SET progress_at = ? WHERE job_id = ? AND state = 'downloading'`,
      [NOW - MIN, jobId],
    );
    expect(candidates()).toEqual([]);
  });

  it('honours cancel, budget, give-up and kind', () => {
    const cancelled = frozenCard();
    db.run(`UPDATE acquisition_jobs SET cancel_requested_at = 1 WHERE id = ?`, [cancelled]);
    const spent = frozenCard();
    db.run(`UPDATE acquisition_jobs SET auto_resource_attempts = 2 WHERE id = ?`, [spent]);
    const givenUp = frozenCard();
    db.run(`UPDATE acquisition_jobs SET auto_resource_exhausted_at = 1 WHERE id = ?`, [givenUp]);
    frozenCard('direct');
    expect(candidates()).toEqual([]);
  });

  it('ignores a superseded row: that title already belongs to another peer', () => {
    const jobId = frozenCard();
    db.run(
      `UPDATE acquisition_job_items SET state = 'superseded', progress_at = ?
        WHERE job_id = ? AND state = 'downloading'`,
      [NOW - 3 * 60 * MIN, jobId],
    );
    db.run(
      `INSERT INTO acquisition_job_items (job_id, track_title, state, updated_at, progress_at)
       VALUES (?, 'Toda la tarde', 'downloading', ?, ?)`,
      [jobId, NOW, NOW - MIN],
    );
    expect(candidates()).toEqual([]);
  });
});
