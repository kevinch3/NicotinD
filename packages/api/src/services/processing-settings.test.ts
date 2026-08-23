import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
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
      holdForReview: true,
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
    setProcessingSettings(db, { gates: { bpm: false } });
    // Patch only one task flag — the other must survive.
    const merged = setProcessingSettings(db, { tasks: { genre: false } as never });
    expect(merged.tasks.bpm).toBe(true); // untouched default
    expect(merged.tasks.genre).toBe(false);
    expect(merged.gates.bpm).toBe(false); // earlier patch survives
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
    expect(s.gates).toEqual(DEFAULT_PROCESSING_SETTINGS.gates);
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

  it('back-fills the gates map from a legacy blob that predates it', () => {
    // A blob written before the landing-gate feature has no `gates` key.
    db.run(`INSERT INTO app_settings (key, value) VALUES ('processing', ?)`, [
      JSON.stringify({ enabled: true, tasks: { bpm: true } }),
    ]);
    expect(getProcessingSettings(db).gates).toEqual(DEFAULT_PROCESSING_SETTINGS.gates);
  });

  it('deep-merges a partial gates patch without dropping other gate flags', () => {
    const merged = setProcessingSettings(db, { gates: { bpm: false } });
    expect(merged.gates.bpm).toBe(false); // patched
    expect(merged.gates.key).toBe(DEFAULT_PROCESSING_SETTINGS.gates.key); // untouched default
  });

  it('holdForReview defaults false and persists', () => {
    expect(getProcessingSettings(db).holdForReview).toBe(false);
    setProcessingSettings(db, { holdForReview: true });
    expect(getProcessingSettings(db).holdForReview).toBe(true);
  });
});
