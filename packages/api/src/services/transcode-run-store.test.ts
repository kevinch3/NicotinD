/**
 * Tests for the durable transcode run record.
 *
 * The question these exist to answer is the one an interrupted run cannot
 * answer for itself: "did that pass finish, and what had it done when it
 * stopped?" So the interruption cases matter more than the happy path.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  INTERRUPTED_ERROR,
  finishTranscodeRun,
  getTranscodeRun,
  listTranscodeRuns,
  reconcileTranscodeRunsOnBoot,
  startTranscodeRun,
} from './transcode-run-store.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('transcode run records', () => {
  it('records a run from the moment it starts, not when it ends', () => {
    // The whole design. A row written only on completion cannot say a pass was
    // interrupted, because an interrupted pass never reaches that code.
    const id = startTranscodeRun(db, { apply: true, bitRate: 96 }, 1000);

    const run = getTranscodeRun(db, id);
    expect(run?.state).toBe('running');
    expect(run?.apply).toBe(true);
    expect(run?.bitRate).toBe(96);
    expect(run?.startedAt).toBe(1000);
    expect(run?.finishedAt).toBeNull();
  });

  it('closes a run with its counters and quarantine location', () => {
    const id = startTranscodeRun(db, { apply: true, bitRate: 96 }, 1000);

    finishTranscodeRun(
      db,
      id,
      {
        state: 'done',
        quarantineRun: '/data/quarantine/transcode-20260920-120000',
        candidates: 10,
        converted: 9,
        skipped: 1,
        failed: 0,
        bytesReclaimed: 12345,
      },
      2000,
    );

    const run = getTranscodeRun(db, id)!;
    expect(run.state).toBe('done');
    expect(run.converted).toBe(9);
    expect(run.bytesReclaimed).toBe(12345);
    expect(run.quarantineRun).toContain('transcode-20260920-120000');
    expect(run.finishedAt).toBe(2000);
  });

  it('marks a run that outlived its process as interrupted', () => {
    // Nothing survives a restart mid-pass, so a `running` row at boot is
    // orphaned by definition.
    const dead = startTranscodeRun(db, { apply: true, bitRate: 96 }, 1000);

    const swept = reconcileTranscodeRunsOnBoot(db, 5000);

    expect(swept).toEqual([dead]);
    const run = getTranscodeRun(db, dead)!;
    expect(run.state).toBe('interrupted');
    expect(run.error).toBe(INTERRUPTED_ERROR);
    expect(run.finishedAt).toBe(5000);
  });

  it('keeps the interrupted run’s counters rather than zeroing them', () => {
    // A run that converted 4,000 files before dying is a completely different
    // situation from one that converted none, and the operator has to be able
    // to tell them apart.
    const id = startTranscodeRun(db, { apply: true, bitRate: 96 }, 1000);
    db.run('UPDATE transcode_runs SET converted = 4000, candidates = 13864 WHERE id = ?', [id]);

    reconcileTranscodeRunsOnBoot(db, 5000);

    const run = getTranscodeRun(db, id)!;
    expect(run.converted).toBe(4000);
    expect(run.candidates).toBe(13864);
  });

  it('leaves finished runs alone on boot', () => {
    const done = startTranscodeRun(db, { apply: true, bitRate: 96 }, 1000);
    finishTranscodeRun(
      db,
      done,
      { state: 'done', candidates: 1, converted: 1, skipped: 0, failed: 0, bytesReclaimed: 1 },
      1500,
    );

    expect(reconcileTranscodeRunsOnBoot(db, 5000)).toEqual([]);
    expect(getTranscodeRun(db, done)!.state).toBe('done');
    expect(getTranscodeRun(db, done)!.finishedAt).toBe(1500);
  });

  it('is safe to run the boot sweep twice', () => {
    const id = startTranscodeRun(db, { apply: true, bitRate: 96 }, 1000);

    reconcileTranscodeRunsOnBoot(db, 5000);
    const second = reconcileTranscodeRunsOnBoot(db, 6000);

    expect(second).toEqual([]);
    expect(getTranscodeRun(db, id)!.finishedAt).toBe(5000);
  });

  it('lists most recent first and honours the limit', () => {
    for (let i = 1; i <= 5; i++) startTranscodeRun(db, { apply: false, bitRate: 96 }, i * 1000);

    const runs = listTranscodeRuns(db, 3);

    expect(runs.length).toBe(3);
    expect(runs.map((r) => r.startedAt)).toEqual([5000, 4000, 3000]);
  });

  it('records a failed run distinctly from an interrupted one', () => {
    // A preflight refusal and a power cut are different stories, and a boot
    // sweep must not relabel the first as the second.
    const id = startTranscodeRun(db, { apply: true, bitRate: 96 }, 1000);
    finishTranscodeRun(
      db,
      id,
      {
        state: 'failed',
        candidates: 0,
        converted: 0,
        skipped: 0,
        failed: 0,
        bytesReclaimed: 0,
        error: 'Not enough free space',
      },
      1200,
    );

    reconcileTranscodeRunsOnBoot(db, 5000);

    const run = getTranscodeRun(db, id)!;
    expect(run.state).toBe('failed');
    expect(run.error).toBe('Not enough free space');
  });
});
