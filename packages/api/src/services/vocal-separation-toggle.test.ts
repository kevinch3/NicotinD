import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  VOCAL_SEPARATION_SETTING_KEY,
  VocalSeparationToggle,
  resolveVocalSeparationEnabled,
} from './vocal-separation-toggle.js';

describe('resolveVocalSeparationEnabled', () => {
  it('is off until an admin turns it on (opt-in, owner decision on #603)', () => {
    expect(resolveVocalSeparationEnabled(true, null)).toBe(false);
    expect(resolveVocalSeparationEnabled(true, false)).toBe(false);
    expect(resolveVocalSeparationEnabled(true, true)).toBe(true);
  });

  it('no sidecar URL is a structural floor an admin cannot lift', () => {
    expect(resolveVocalSeparationEnabled(false, true)).toBe(false);
  });
});

describe('VocalSeparationToggle', () => {
  function db(): Database {
    const d = new Database(':memory:');
    d.run('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    return d;
  }

  it('persists the admin choice under its own key and reports the effective value', () => {
    const d = db();
    const t = new VocalSeparationToggle(d, true);
    expect(t.enabled()).toBe(false);
    expect(t.configurable()).toBe(true);
    expect(t.set(true)).toBe(true);
    expect(t.enabled()).toBe(true);
    expect(
      d
        .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
        .get(VOCAL_SEPARATION_SETTING_KEY)?.value,
    ).toBe('1');
    expect(t.set(false)).toBe(false);
  });

  it('set() returns false when the environment has no sidecar, whatever was asked', () => {
    const t = new VocalSeparationToggle(db(), false);
    expect(t.configurable()).toBe(false);
    expect(t.set(true)).toBe(false);
    expect(t.enabled()).toBe(false);
  });

  it('a schema-less db reads as unset, never throws', () => {
    const t = new VocalSeparationToggle(new Database(':memory:'), true);
    expect(t.enabled()).toBe(false);
  });
});
