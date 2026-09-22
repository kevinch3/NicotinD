import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  DEFAULT_RADIO_SETTINGS,
  RADIO_QUEUE_TARGET_MAX,
  RADIO_QUEUE_TARGET_MIN,
  getRadioSettings,
  isValidQueueTarget,
  setRadioSettings,
} from './radio-settings.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('radio settings', () => {
  it('defaults to the learned genre axis ON — it is an opt-OUT since #1121', () => {
    expect(DEFAULT_RADIO_SETTINGS.genreAffinity).toBe(true);
    expect(getRadioSettings(db)).toEqual(DEFAULT_RADIO_SETTINGS);
  });

  it('persists a patch and reads it back', () => {
    expect(setRadioSettings(db, { genreAffinity: true }).genreAffinity).toBe(true);
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
    expect(setRadioSettings(db, {})).toEqual(DEFAULT_RADIO_SETTINGS);
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

  describe('queue depth', () => {
    it('defaults to 20 — the depth the client holds, not a batch size', () => {
      expect(DEFAULT_RADIO_SETTINGS.queueTarget).toBe(20);
      expect(getRadioSettings(db).queueTarget).toBe(20);
    });

    it('persists a depth inside the band', () => {
      expect(setRadioSettings(db, { queueTarget: 35 }).queueTarget).toBe(35);
      expect(getRadioSettings(db).queueTarget).toBe(35);
    });

    it('accepts the band edges and rejects everything outside them', () => {
      expect(isValidQueueTarget(RADIO_QUEUE_TARGET_MIN)).toBe(true);
      expect(isValidQueueTarget(RADIO_QUEUE_TARGET_MAX)).toBe(true);
      expect(isValidQueueTarget(RADIO_QUEUE_TARGET_MIN - 1)).toBe(false);
      expect(isValidQueueTarget(RADIO_QUEUE_TARGET_MAX + 1)).toBe(false);
      expect(isValidQueueTarget(12.5)).toBe(false);
      expect(isValidQueueTarget('20')).toBe(false);
    });

    /**
     * Storing an out-of-band depth and filtering it on read would leave the
     * admin panel echoing 20 back at someone who typed 500, with no way to tell
     * a rejected write from a no-op one. It is dropped at the door instead.
     */
    it('drops an out-of-band depth rather than storing one the reader ignores', () => {
      setRadioSettings(db, { queueTarget: 500 });
      const stored = db
        .query<{ value: string }, []>(`SELECT value FROM app_settings WHERE key = 'radio'`)
        .get();
      expect(JSON.parse(stored!.value)).toEqual({});
      expect(getRadioSettings(db).queueTarget).toBe(20);
    });

    /** One unreadable key must not bury its neighbour — they are judged apart. */
    it('keeps a good depth when the affinity value stored beside it is garbage', () => {
      db.run(
        `INSERT INTO app_settings (key, value) VALUES ('radio', '{"genreAffinity":"yes","queueTarget":8}')`,
      );
      expect(getRadioSettings(db)).toEqual({ genreAffinity: true, queueTarget: 8 });
    });

    it('a depth write leaves an existing affinity opt-out alone', () => {
      setRadioSettings(db, { genreAffinity: false });
      setRadioSettings(db, { queueTarget: 12 });
      expect(getRadioSettings(db)).toEqual({ genreAffinity: false, queueTarget: 12 });
    });
  });
});
