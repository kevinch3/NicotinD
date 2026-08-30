import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  RegistrationToggle,
  REGISTRATION_SETTING_KEY,
  readRegistrationEnv,
  resolveRegistrationEnabled,
} from './registration-toggle.js';

/**
 * Precedence differs from the acquisition switch on purpose: there, env `off` is
 * a floor and an admin may still restrict further. Here the env var is simply
 * *authoritative when present* — set means locked, unset means the admin owns it.
 */
describe('resolveRegistrationEnabled — precedence', () => {
  it('env set to false wins over a stored true', () => {
    expect(resolveRegistrationEnabled(false, true, true)).toBe(false);
  });

  it('env set to true wins over a stored false', () => {
    expect(resolveRegistrationEnabled(true, false, false)).toBe(true);
  });

  it('uses the stored admin choice when env is unset', () => {
    expect(resolveRegistrationEnabled(undefined, true, false)).toBe(true);
    expect(resolveRegistrationEnabled(undefined, false, true)).toBe(false);
  });

  it('falls back to the config default when env is unset and nothing is stored', () => {
    expect(resolveRegistrationEnabled(undefined, null, false)).toBe(false);
    expect(resolveRegistrationEnabled(undefined, null, true)).toBe(true);
  });
});

describe('readRegistrationEnv', () => {
  it('is undefined when the var is absent, so the admin owns the decision', () => {
    expect(readRegistrationEnv({})).toBeUndefined();
  });

  it('reads the documented off/on spellings', () => {
    for (const v of ['off', 'false', '0', 'no', 'OFF']) {
      expect(readRegistrationEnv({ NICOTIND_REGISTRATION: v })).toBe(false);
    }
    for (const v of ['on', 'true', '1', 'yes', 'ON']) {
      expect(readRegistrationEnv({ NICOTIND_REGISTRATION: v })).toBe(true);
    }
  });

  it('treats an unparseable value as unset rather than guessing', () => {
    expect(readRegistrationEnv({ NICOTIND_REGISTRATION: 'maybe' })).toBeUndefined();
  });
});

describe('RegistrationToggle', () => {
  function db(): Database {
    const d = new Database(':memory:');
    d.run('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
    return d;
  }

  it('is configurable only when the environment leaves it unset', () => {
    expect(new RegistrationToggle(db(), undefined, false).configurable()).toBe(true);
    expect(new RegistrationToggle(db(), false, false).configurable()).toBe(false);
    expect(new RegistrationToggle(db(), true, false).configurable()).toBe(false);
  });

  it('persists an admin choice and reports it back', () => {
    const t = new RegistrationToggle(db(), undefined, false);

    expect(t.enabled()).toBe(false);
    expect(t.set(true)).toBe(true);
    expect(t.enabled()).toBe(true);
  });

  it('ignores a stored choice while the environment forces a value', () => {
    const d = db();
    const t = new RegistrationToggle(d, false, true);

    expect(t.set(true)).toBe(false);
    expect(t.enabled()).toBe(false);
    // The write still lands, so removing the env var restores the admin's intent
    // rather than silently discarding it.
    expect(new RegistrationToggle(d, undefined, false).enabled()).toBe(true);
  });

  it('survives a schema-less DB by falling back to the config default', () => {
    const bare = new Database(':memory:');

    expect(new RegistrationToggle(bare, undefined, false).enabled()).toBe(false);
  });

  it('stores under a stable key', () => {
    expect(REGISTRATION_SETTING_KEY).toBe('registration_enabled');
  });
});
