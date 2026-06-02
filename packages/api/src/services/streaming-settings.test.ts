import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  getStreamingSettings,
  setStreamingSettings,
  DEFAULT_STREAMING_SETTINGS,
} from './streaming-settings.js';

describe('streaming settings store', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('returns defaults when nothing is persisted', () => {
    expect(getStreamingSettings(db)).toEqual(DEFAULT_STREAMING_SETTINGS);
  });

  it('round-trips a partial update merged onto the defaults', () => {
    const next = setStreamingSettings(db, { transcodeEnabled: true, maxBitRate: 128 });
    expect(next.transcodeEnabled).toBe(true);
    expect(next.maxBitRate).toBe(128);
    // Untouched fields keep their defaults.
    expect(next.format).toBe(DEFAULT_STREAMING_SETTINGS.format);
    // Persisted across reads.
    expect(getStreamingSettings(db)).toEqual(next);
  });

  it('tolerates corrupt stored JSON by falling back to defaults', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('streaming', 'not-json')`);
    expect(getStreamingSettings(db)).toEqual(DEFAULT_STREAMING_SETTINGS);
  });
});
