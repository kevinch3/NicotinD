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
  it('defaults to the learned genre axis OFF — the regular radio must not change unasked', () => {
    expect(DEFAULT_RADIO_SETTINGS.genreAffinity).toBe(false);
    expect(getRadioSettings(db)).toEqual({ genreAffinity: false });
  });

  it('persists a patch and reads it back', () => {
    expect(setRadioSettings(db, { genreAffinity: true })).toEqual({ genreAffinity: true });
    expect(getRadioSettings(db).genreAffinity).toBe(true);
    setRadioSettings(db, { genreAffinity: false });
    expect(getRadioSettings(db).genreAffinity).toBe(false);
  });

  it('ignores a malformed or wrongly-typed stored value', () => {
    db.run(`INSERT INTO app_settings (key, value) VALUES ('radio', 'not json')`);
    expect(getRadioSettings(db)).toEqual(DEFAULT_RADIO_SETTINGS);
    db.run(`UPDATE app_settings SET value = '{"genreAffinity":"yes"}' WHERE key = 'radio'`);
    expect(getRadioSettings(db)).toEqual(DEFAULT_RADIO_SETTINGS);
  });
});
