import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { DEFAULT_RADIO_SETTINGS, getRadioSettings, setRadioSettings } from './radio-settings.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('radio settings', () => {
  it('defaults to the learned genre axis ON — it is an opt-OUT since #1121', () => {
    expect(DEFAULT_RADIO_SETTINGS.genreAffinity).toBe(true);
    expect(getRadioSettings(db)).toEqual({ genreAffinity: true });
  });

  it('persists a patch and reads it back', () => {
    expect(setRadioSettings(db, { genreAffinity: true })).toEqual({ genreAffinity: true });
    expect(getRadioSettings(db).genreAffinity).toBe(true);
    setRadioSettings(db, { genreAffinity: false });
    expect(getRadioSettings(db).genreAffinity).toBe(false);
  });

  /**
   * The flip in #1121 is only reachable by a deployment whose stored row does
   * not already answer the question. Persisting the RESOLVED settings made
   * every write answer it — a PUT body without the key stamped the current
   * default as an explicit choice, and that spurious opt-out would survive the
   * flip forever, indistinguishable from a deliberate one.
   */
  it('a patch that mentions nothing persists nothing — the default stays tracked', () => {
    expect(setRadioSettings(db, {})).toEqual({ genreAffinity: true });
    const stored = db
      .query<{ value: string }, []>(`SELECT value FROM app_settings WHERE key = 'radio'`)
      .get();
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!.value)).toEqual({});
    expect('genreAffinity' in (JSON.parse(stored!.value) as object)).toBe(false);
  });

  it('an explicit false is a real choice a later default flip cannot override', () => {
    setRadioSettings(db, { genreAffinity: false });
    // A no-key write afterwards must not erase the opt-out either.
    setRadioSettings(db, {});
    const stored = db
      .query<{ value: string }, []>(`SELECT value FROM app_settings WHERE key = 'radio'`)
      .get();
    expect(JSON.parse(stored!.value)).toEqual({ genreAffinity: false });
    expect(getRadioSettings(db).genreAffinity).toBe(false);
  });

  it('ignores a malformed or wrongly-typed stored value', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('radio', 'not json')`);
    expect(getRadioSettings(db)).toEqual(DEFAULT_RADIO_SETTINGS);
    db.run(`UPDATE app_settings SET value = '{"genreAffinity":"yes"}' WHERE key = 'radio'`);
    expect(getRadioSettings(db)).toEqual(DEFAULT_RADIO_SETTINGS);
  });
});
