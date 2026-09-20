import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { getDownloadsSettings, setDownloadsSettings } from './downloads-settings.js';

const CONFIGURED = { enabled: true, bitRate: 192 };

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('getDownloadsSettings', () => {
  it('falls back to the configured value when nobody has chosen', () => {
    expect(getDownloadsSettings(db, CONFIGURED).transcodeLossless).toEqual(CONFIGURED);
  });

  it('lets the configured default still move while nothing is stored', () => {
    // The whole point of storing a partial: an install that never answered the
    // question follows the config, so changing the config still reaches it.
    expect(getDownloadsSettings(db, { enabled: false, bitRate: 96 }).transcodeLossless).toEqual({
      enabled: false,
      bitRate: 96,
    });
  });

  it('a stored choice overrides the configured value', () => {
    setDownloadsSettings(db, CONFIGURED, { enabled: false });
    expect(getDownloadsSettings(db, CONFIGURED).transcodeLossless.enabled).toBe(false);
  });

  it('an unmentioned key keeps following the configured value', () => {
    setDownloadsSettings(db, CONFIGURED, { enabled: false });
    // bitRate was never chosen, so a config change still reaches it.
    expect(getDownloadsSettings(db, { enabled: true, bitRate: 320 }).transcodeLossless).toEqual({
      enabled: false,
      bitRate: 320,
    });
  });

  it('reads an unparseable row as absent rather than throwing', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('downloads', 'not json')`);
    expect(getDownloadsSettings(db, CONFIGURED).transcodeLossless).toEqual(CONFIGURED);
  });

  it('reads a wrongly typed value as absent', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('downloads', ?)`, [
      JSON.stringify({ transcodeLossless: { enabled: 'yes', bitRate: 'loud' } }),
    ]);
    expect(getDownloadsSettings(db, CONFIGURED).transcodeLossless).toEqual(CONFIGURED);
  });
});

describe('setDownloadsSettings', () => {
  it('returns the effective settings', () => {
    const next = setDownloadsSettings(db, CONFIGURED, { bitRate: 128 });
    expect(next.transcodeLossless).toEqual({ enabled: true, bitRate: 128 });
  });

  it('merges successive patches instead of replacing them', () => {
    setDownloadsSettings(db, CONFIGURED, { enabled: false });
    setDownloadsSettings(db, CONFIGURED, { bitRate: 128 });
    expect(getDownloadsSettings(db, CONFIGURED).transcodeLossless).toEqual({
      enabled: false,
      bitRate: 128,
    });
  });

  it('never stamps a value the caller did not mention', () => {
    setDownloadsSettings(db, CONFIGURED, { enabled: false });
    const row = db
      .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
      .get('downloads');
    // Persisting the resolved value here would pin bitRate forever (#1121).
    expect(JSON.parse(row!.value).transcodeLossless).toEqual({ enabled: false });
  });

  it('rejects an out-of-range bitRate rather than storing it', () => {
    setDownloadsSettings(db, CONFIGURED, { bitRate: 3200 });
    expect(getDownloadsSettings(db, CONFIGURED).transcodeLossless.bitRate).toBe(192);
    setDownloadsSettings(db, CONFIGURED, { bitRate: 8 });
    expect(getDownloadsSettings(db, CONFIGURED).transcodeLossless.bitRate).toBe(192);
  });

  it('accepts the clamp boundaries', () => {
    expect(setDownloadsSettings(db, CONFIGURED, { bitRate: 64 }).transcodeLossless.bitRate).toBe(
      64,
    );
    expect(setDownloadsSettings(db, CONFIGURED, { bitRate: 320 }).transcodeLossless.bitRate).toBe(
      320,
    );
  });
});
