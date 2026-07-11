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
      window: { start: '01:00', end: '03:00' },
      tasks: { bpm: false, genre: true },
      batchSize: 50,
      concurrency: 2,
    });
    expect(next.enabled).toBe(false);
    expect(getProcessingSettings(db)).toEqual(next);
  });

  it('deep-merges a partial patch over current values', () => {
    setProcessingSettings(db, { window: { start: '02:00', end: '04:00' } });
    // Patch only one task flag — the other must survive.
    const merged = setProcessingSettings(db, { tasks: { genre: false } as never });
    expect(merged.tasks.bpm).toBe(true); // untouched default
    expect(merged.tasks.genre).toBe(false);
    expect(merged.window).toEqual({ start: '02:00', end: '04:00' }); // earlier patch survives
  });

  it('falls back to defaults on a corrupt stored blob', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('processing', 'not json')`);
    expect(getProcessingSettings(db)).toEqual(DEFAULT_PROCESSING_SETTINGS);
  });

  it('back-fills missing nested fields from an older partial blob', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('processing', ?)`, [
      JSON.stringify({ enabled: true, window: { start: '06:00' } }),
    ]);
    const s = getProcessingSettings(db);
    expect(s.window.start).toBe('06:00');
    expect(s.window.end).toBe(DEFAULT_PROCESSING_SETTINGS.window.end);
    expect(s.tasks).toEqual(DEFAULT_PROCESSING_SETTINGS.tasks);
    expect(s.batchSize).toBe(DEFAULT_PROCESSING_SETTINGS.batchSize);
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
});
