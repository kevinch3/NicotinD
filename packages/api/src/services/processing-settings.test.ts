import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PROCESSING_TASK_IDS, type ProcessingTaskId } from '@nicotind/core';
import { applySchema } from '../db.js';
import {
  DEFAULT_PROCESSING_SETTINGS,
  getProcessingSettings,
  setProcessingSettings,
} from './processing-settings.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('processing-settings', () => {
  it('returns defaults when nothing is persisted', () => {
    expect(getProcessingSettings(db)).toEqual(DEFAULT_PROCESSING_SETTINGS);
  });

  it('persists and reads back a full settings round-trip', () => {
    const next = setProcessingSettings(db, {
      enabled: false,
      tasks: { bpm: false, genre: true },
      paused: true,
    });
    expect(next.enabled).toBe(false);
    expect(getProcessingSettings(db)).toEqual(next);
  });

  it('defaults paused to false and round-trips a pause', () => {
    expect(getProcessingSettings(db).paused).toBe(false);
    expect(setProcessingSettings(db, { paused: true }).paused).toBe(true);
    expect(getProcessingSettings(db).paused).toBe(true);
  });

  it('backfills paused onto a persisted blob written before the field existed', () => {
    // Old rows have no `paused` key; the merge over defaults must supply it
    // rather than leaving the processor reading `undefined` as falsy-by-luck.
    db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('processing', ?)", [
      JSON.stringify({ enabled: true, batchSize: 25 }),
    ]);
    expect(getProcessingSettings(db).paused).toBe(false);
  });

  it('deep-merges a partial patch over current values', () => {
    setProcessingSettings(db, { tasks: { key: false } });
    // Patch only one task flag — the others must survive.
    const merged = setProcessingSettings(db, { tasks: { genre: false } as never });
    expect(merged.tasks.bpm).toBe(true); // untouched default
    expect(merged.tasks.genre).toBe(false);
    expect(merged.tasks.key).toBe(false); // earlier patch survives
  });

  it('falls back to defaults on a corrupt stored blob', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('processing', 'not json')`);
    expect(getProcessingSettings(db)).toEqual(DEFAULT_PROCESSING_SETTINGS);
  });

  it('back-fills missing nested fields from an older partial blob', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('processing', ?)`, [
      JSON.stringify({ enabled: true, tasks: { bpm: false } }),
    ]);
    const s = getProcessingSettings(db);
    expect(s.tasks.bpm).toBe(false); // the stored value wins
    expect(s.tasks.genre).toBe(DEFAULT_PROCESSING_SETTINGS.tasks.genre); // the rest back-fill
    expect(s.paused).toBe(DEFAULT_PROCESSING_SETTINGS.paused);
  });

  // The processing window and the compute regulator were removed. Their keys
  // are still sitting in every deployed instance's stored blob, and a `...parsed`
  // spread would copy them onto the result — invisible to TS as excess
  // properties — and re-persist them on the next write, so `GET
  // /api/admin/processing` would keep emitting retired fields forever.
  it('drops retired keys carried by a blob written before they were removed', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('processing', ?)`, [
      JSON.stringify({
        enabled: true,
        window: { start: '05:00', end: '08:00' },
        batchSize: 25,
        concurrency: 3,
        gpuBusyPercent: 50,
      }),
    ]);
    const s = getProcessingSettings(db) as unknown as Record<string, unknown>;
    expect(s['window']).toBeUndefined();
    expect(s['batchSize']).toBeUndefined();
    expect(s['concurrency']).toBeUndefined();
    expect(s['gpuBusyPercent']).toBeUndefined();
    expect(s['enabled']).toBe(true);

    // And a subsequent write must not resurrect them.
    const next = setProcessingSettings(db, { paused: true }) as unknown as Record<string, unknown>;
    expect(next['gpuBusyPercent']).toBeUndefined();
    expect(
      JSON.parse(
        db
          .query<{ value: string }, []>("SELECT value FROM app_settings WHERE key = 'processing'")
          .get()!.value,
      ),
    ).not.toHaveProperty('window');
  });

  // Issue #779: the top-level fields were already read field-by-field so a
  // retired one could not survive, but tasks was a bare spread — so `licence`,
  // rolled back in #683, was still in the persisted blob on prod and was
  // re-written on every save.
  it('drops a retired task from a persisted blob', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('processing', ?)`, [
      JSON.stringify({ enabled: true, tasks: { bpm: true, licence: true } }),
    ]);
    const s = getProcessingSettings(db);
    expect(s.tasks).not.toHaveProperty('licence');
    expect(s.tasks.bpm).toBe(true);
  });

  it('does not re-persist a retired task on the next write', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('processing', ?)`, [
      JSON.stringify({ enabled: true, tasks: { licence: true } }),
    ]);
    setProcessingSettings(db, { paused: true });
    const stored = JSON.parse(
      db
        .query<{ value: string }, []>("SELECT value FROM app_settings WHERE key = 'processing'")
        .get()!.value,
    ) as { tasks: Record<string, boolean> };
    expect(stored.tasks).not.toHaveProperty('licence');
  });

  // The landing gate and hold-for-review were removed with instant landing.
  // Every deployed blob still carries `gates` and `holdForReview`; they must
  // read cleanly, never surface, and never be re-persisted.
  it('drops the retired landing-gate keys (gates, holdForReview) from a stored blob', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('processing', ?)`, [
      JSON.stringify({
        enabled: true,
        tasks: { bpm: true },
        gates: { bpm: true, key: true, energy: true, genre: true },
        holdForReview: true,
      }),
    ]);
    const s = getProcessingSettings(db) as unknown as Record<string, unknown>;
    expect(s['gates']).toBeUndefined();
    expect(s['holdForReview']).toBeUndefined();
    expect(s['enabled']).toBe(true);

    setProcessingSettings(db, { paused: true });
    const stored = JSON.parse(
      db
        .query<{ value: string }, []>("SELECT value FROM app_settings WHERE key = 'processing'")
        .get()!.value,
    ) as Record<string, unknown>;
    expect(stored).not.toHaveProperty('gates');
    expect(stored).not.toHaveProperty('holdForReview');
  });

  it('does not persist a retired top-level key a stale client still sends', () => {
    setProcessingSettings(db, { paused: true, holdForReview: true } as never);
    const stored = JSON.parse(
      db
        .query<{ value: string }, []>("SELECT value FROM app_settings WHERE key = 'processing'")
        .get()!.value,
    ) as Record<string, unknown>;
    expect(stored).not.toHaveProperty('holdForReview');
    expect(stored['paused']).toBe(true);
  });

  it('PROCESSING_TASK_IDS covers exactly the shipped task flags', () => {
    expect([...PROCESSING_TASK_IDS].sort()).toEqual(
      (Object.keys(DEFAULT_PROCESSING_SETTINGS.tasks) as ProcessingTaskId[]).sort(),
    );
  });
});
