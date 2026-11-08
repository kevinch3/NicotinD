import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveLidarrConnection } from './main.js';

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

/**
 * #1729: external mode with no Lidarr entered still pointed a Lidarr client at
 * the embedded default `http://localhost:8686`, so every search and enrichment
 * pass hit ECONNREFUSED and the UI offered a Retry that could never succeed.
 * Embedded mode keeps the default: there, localhost:8686 IS the bundled Lidarr.
 */
describe('loadConfig — Lidarr is only configured when the operator configured it', () => {
  let dataDir: string;
  let configPath: string;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'NICOTIND_DATA_DIR',
    'NICOTIND_CONFIG',
    'NICOTIND_MODE',
    'NICOTIND_LIDARR_URL',
    'LIDARR_API_KEY',
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    dataDir = mkdtempSync(join(tmpdir(), 'nicotind-cfg-'));
    configPath = join(dataDir, 'config.yml');
    process.env.NICOTIND_DATA_DIR = dataDir;
    process.env.NICOTIND_CONFIG = configPath;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('external mode with nothing entered has no Lidarr at all', () => {
    process.env.NICOTIND_MODE = 'external';
    expect(loadConfig().lidarr).toBeUndefined();
  });

  it('external mode honours NICOTIND_LIDARR_URL (the Docker compose path)', () => {
    process.env.NICOTIND_MODE = 'external';
    process.env.NICOTIND_LIDARR_URL = 'http://lidarr:8686';
    expect(loadConfig().lidarr?.url).toBe('http://lidarr:8686');
  });

  it('external mode honours a lidarr block in the config file', () => {
    process.env.NICOTIND_MODE = 'external';
    writeFileSync(configPath, 'lidarr:\n  url: http://nas.lan:8686\n');
    expect(loadConfig().lidarr?.url).toBe('http://nas.lan:8686');
  });

  it('external mode honours the Lidarr URL saved by the setup wizard', () => {
    process.env.NICOTIND_MODE = 'external';
    loadConfig(); // first boot writes secrets.json
    saveLidarrConnection(dataDir, { url: 'http://192.168.1.5:8686', apiKey: 'k' });
    const cfg = loadConfig().lidarr;
    expect(cfg?.url).toBe('http://192.168.1.5:8686');
    expect(cfg?.apiKey).toBe('k');
  });

  it('embedded mode keeps the bundled Lidarr on localhost', () => {
    process.env.NICOTIND_MODE = 'embedded';
    expect(loadConfig().lidarr?.url).toBe('http://localhost:8686');
  });
});
