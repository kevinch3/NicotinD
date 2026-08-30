import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './main.js';

/**
 * `loadConfig` merges file config < persisted secrets < env. The registration
 * kill-switch matters most in the shipped image, which carries **no** config
 * file at all (`.dockerignore` excludes `config/default.yml`), so env is the
 * only lever an operator has.
 */
describe('loadConfig — registration kill-switch (NICOTIND_REGISTRATION)', () => {
  let dataDir: string;
  let configPath: string;
  const saved: Record<string, string | undefined> = {};

  const ENV_KEYS = ['NICOTIND_REGISTRATION', 'NICOTIND_DATA_DIR', 'NICOTIND_CONFIG'];

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    dataDir = mkdtempSync(join(tmpdir(), 'nicotind-cfg-'));
    configPath = join(dataDir, 'config.yml');
    process.env.NICOTIND_DATA_DIR = dataDir;
    process.env.NICOTIND_CONFIG = configPath;
    delete process.env.NICOTIND_REGISTRATION;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Write the file half of the merge (what a self-hoster's YAML would say). */
  function writeFileConfig(yaml: string): void {
    writeFileSync(configPath, yaml);
  }

  it('closes registration when NICOTIND_REGISTRATION=off', () => {
    process.env.NICOTIND_REGISTRATION = 'off';

    expect(loadConfig().registrationEnabled).toBe(false);
  });

  it('overrides a file config that opens registration', () => {
    writeFileConfig('registrationEnabled: true\n');
    process.env.NICOTIND_REGISTRATION = 'off';

    expect(loadConfig().registrationEnabled).toBe(false);
  });

  it('opens registration when NICOTIND_REGISTRATION=on', () => {
    writeFileConfig('registrationEnabled: false\n');
    process.env.NICOTIND_REGISTRATION = 'on';

    expect(loadConfig().registrationEnabled).toBe(true);
  });

  it('falls through to the file value when the env var is unset', () => {
    writeFileConfig('registrationEnabled: false\n');

    expect(loadConfig().registrationEnabled).toBe(false);
  });

  it('falls through to the file value when the env var is unparseable', () => {
    writeFileConfig('registrationEnabled: false\n');
    process.env.NICOTIND_REGISTRATION = 'maybe';

    expect(loadConfig().registrationEnabled).toBe(false);
  });
});
