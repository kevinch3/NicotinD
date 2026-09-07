import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { libraryEvents, type StampedEvent } from './library-events.js';
import { recomputeStage } from './acquisition-job-store.js';

/**
 * Service emit sites fire on the process-wide bus. The scanner and deletion
 * paths run inside their own suites' fixtures; the job store's stage recompute
 * is the cheapest emitter to pin the contract with: a change announces itself,
 * an unchanged stage stays silent.
 */
describe('library events — service emit sites', () => {
  it('recomputeStage emits job.changed only when the stage actually moved', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO acquisition_jobs (id, kind, method, state, stage, created_at, updated_at)
       VALUES ('j1', 'network', 'test', 'active', 'downloading', 0, 0)`,
    );
    db.run(
      `INSERT INTO acquisition_job_items (job_id, track_title, state, updated_at)
       VALUES ('j1', 't1', 'scanned', 0)`,
    );
    const seen: StampedEvent[] = [];
    const off = libraryEvents.on((e) => seen.push(e));
    try {
      recomputeStage(db, 'j1');
      libraryEvents.flush();
      expect(seen.filter((e) => e.event.type === 'job.changed')).toHaveLength(1);
      seen.length = 0;
      recomputeStage(db, 'j1');
      libraryEvents.flush();
      expect(seen.filter((e) => e.event.type === 'job.changed')).toHaveLength(0);
    } finally {
      off();
    }
  });
});
