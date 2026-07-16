import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { NicotinDConfigSchema, type NicotinDConfig } from '@nicotind/core';
import { buildSlskdDefinition } from './slskd.js';

// buildSlskdDefinition hard-imports node:fs (no injectable seam), so it is
// exercised against a real temp dir rather than a mocked filesystem.
function makeConfig(dataDir: string): NicotinDConfig {
  return NicotinDConfigSchema.parse({
    dataDir,
    musicDir: join(dataDir, 'music'),
    soulseek: { username: 'sl-user', password: 'sl-pass', listeningPort: 51234, enableUPnP: false },
    slskd: { url: 'http://localhost:5030', port: 5030, username: 'web-user', password: 'web-pass' },
    jwt: { secret: 'x'.repeat(32) },
  });
}

describe('buildSlskdDefinition', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nicotind-slskd-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes slskd.yml with soulseek creds, web auth, and the staging downloads dir', () => {
    buildSlskdDefinition(makeConfig(dataDir));
    const configDir = join(dataDir, 'slskd');
    const yml = parse(readFileSync(join(configDir, 'slskd.yml'), 'utf-8')) as {
      soulseek: { username: string; password: string; listening_port: number; upnp: boolean };
      directories: { downloads: string };
      web: { authentication: { username: string; password: string } };
    };
    expect(yml.soulseek).toEqual({
      username: 'sl-user',
      password: 'sl-pass',
      listening_port: 51234,
      upnp: false,
    });
    expect(yml.directories.downloads).toBe(join(configDir, 'downloads'));
    expect(yml.web.authentication).toEqual({ username: 'web-user', password: 'web-pass' });
  });

  it('creates the config, music, and staging dirs', () => {
    buildSlskdDefinition(makeConfig(dataDir));
    expect(existsSync(join(dataDir, 'slskd'))).toBe(true);
    expect(existsSync(join(dataDir, 'music'))).toBe(true);
    expect(existsSync(join(dataDir, 'slskd', 'downloads'))).toBe(true);
  });

  it('seeds the music dir as the default shared folder on a fresh config', () => {
    buildSlskdDefinition(makeConfig(dataDir));
    const yml = parse(readFileSync(join(dataDir, 'slskd', 'slskd.yml'), 'utf-8')) as {
      shares: { directories: string[] };
    };
    expect(yml.shares.directories).toEqual([join(dataDir, 'music')]);
  });

  it('preserves user-configured shares from an existing slskd.yml', () => {
    // First boot seeds the default share; slskd's own API edits this same
    // file when the user adds shares in the extension page.
    buildSlskdDefinition(makeConfig(dataDir));
    const ymlPath = join(dataDir, 'slskd', 'slskd.yml');
    const existing = parse(readFileSync(ymlPath, 'utf-8')) as Record<string, unknown>;
    (existing as { shares: { directories: string[] } }).shares = {
      directories: ['/srv/extra-share'],
    };
    writeFileSync(ymlPath, stringify(existing), 'utf-8');

    // A later boot regenerates the managed keys but must not clobber shares.
    buildSlskdDefinition(makeConfig(dataDir));
    const yml = parse(readFileSync(ymlPath, 'utf-8')) as {
      shares: { directories: string[] };
      soulseek: { username: string };
    };
    expect(yml.shares.directories).toEqual(['/srv/extra-share']);
    expect(yml.soulseek.username).toBe('sl-user');
  });

  it('re-seeds the default share when an existing config has an empty shares list', () => {
    buildSlskdDefinition(makeConfig(dataDir));
    const ymlPath = join(dataDir, 'slskd', 'slskd.yml');
    const existing = parse(readFileSync(ymlPath, 'utf-8')) as Record<string, unknown>;
    (existing as { shares: { directories: string[] } }).shares = { directories: [] };
    writeFileSync(ymlPath, stringify(existing), 'utf-8');

    buildSlskdDefinition(makeConfig(dataDir));
    const yml = parse(readFileSync(ymlPath, 'utf-8')) as { shares: { directories: string[] } };
    expect(yml.shares.directories).toEqual([join(dataDir, 'music')]);
  });

  it('returns a ServiceDefinition with the config path, http port, and app-dir env', () => {
    const def = buildSlskdDefinition(makeConfig(dataDir));
    const configDir = join(dataDir, 'slskd');
    expect(def.name).toBe('slskd');
    expect(def.command).toBe(join(dataDir, 'bin', 'slskd'));
    expect(def.args).toEqual(['--config', join(configDir, 'slskd.yml'), '--http-port', '5030']);
    expect(def.cwd).toBe(join(dataDir, 'bin'));
    expect(def.env).toEqual({ SLSKD_APP_DIR: configDir });
    expect(def.healthCheckUrl).toBe('http://localhost:5030/api/v0/session/enabled');
  });
});
