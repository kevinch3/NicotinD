import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  ACQUISITION_SETTING_KEY,
  AcquisitionToggle,
  resolveAcquisitionEnabled,
} from './acquisition-toggle.js';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.run('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  return db;
}

describe('resolveAcquisitionEnabled (precedence)', () => {
  it('defaults to on when nothing is stored', () => {
    expect(resolveAcquisitionEnabled(true, null)).toBe(true);
  });

  it('lets a stored false turn it off', () => {
    expect(resolveAcquisitionEnabled(true, false)).toBe(false);
  });

  it('lets a stored true keep it on', () => {
    expect(resolveAcquisitionEnabled(true, true)).toBe(true);
  });

  // The asymmetry that matters: an operator who disabled acquisition for the
  // whole deployment must not be overridden by whoever holds an admin account.
  it('treats the environment as a hard floor, not a default', () => {
    expect(resolveAcquisitionEnabled(false, null)).toBe(false);
    expect(resolveAcquisitionEnabled(false, false)).toBe(false);
    expect(resolveAcquisitionEnabled(false, true)).toBe(false);
  });
});

describe('AcquisitionToggle', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('is on by default on an env-enabled install', () => {
    const t = new AcquisitionToggle(db, true);
    expect(t.enabled()).toBe(true);
    expect(t.configurable()).toBe(true);
  });

  it('persists an admin turning it off, and reports the effective value', () => {
    const t = new AcquisitionToggle(db, true);
    expect(t.set(false)).toBe(false);
    expect(t.enabled()).toBe(false);
    // A fresh instance sees it too — the switch survives a restart.
    expect(new AcquisitionToggle(db, true).enabled()).toBe(false);
  });

  it('turns back on', () => {
    const t = new AcquisitionToggle(db, true);
    t.set(false);
    expect(t.set(true)).toBe(true);
    expect(t.enabled()).toBe(true);
  });

  it('refuses to let an admin lift the environment floor', () => {
    const t = new AcquisitionToggle(db, false);
    expect(t.configurable()).toBe(false);
    // The write is still recorded (harmless), but the effective answer is no.
    expect(t.set(true)).toBe(false);
    expect(t.enabled()).toBe(false);
  });

  // The whole point of not memoizing: a stale read means an admin turns
  // acquisition off and the routes carry on serving it.
  it('reflects an out-of-band write immediately, with no cache to go stale', () => {
    const t = new AcquisitionToggle(db, true);
    expect(t.enabled()).toBe(true);
    db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [
      ACQUISITION_SETTING_KEY,
      '0',
    ]);
    expect(t.enabled()).toBe(false);
  });

  it('accepts the string forms the settings table actually stores', () => {
    const t = new AcquisitionToggle(db, true);
    for (const [stored, expected] of [
      ['1', true],
      ['true', true],
      ['0', false],
      ['false', false],
    ] as const) {
      db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [
        ACQUISITION_SETTING_KEY,
        stored,
      ]);
      expect(t.enabled()).toBe(expected);
    }
  });

  it('falls back to the env decision on a schema-less DB rather than throwing', () => {
    const bare = new Database(':memory:');
    expect(new AcquisitionToggle(bare, true).enabled()).toBe(true);
    expect(new AcquisitionToggle(bare, false).enabled()).toBe(false);
  });
});
