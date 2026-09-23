import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NicotinDConfigSchema, type NicotinDConfig } from '@nicotind/core';
import { buildLidarrDefinition } from './lidarr.js';

// buildLidarrDefinition hard-imports node:fs (no injectable seam), so it is
// exercised against a real temp dir rather than a mocked filesystem.
function makeConfig(dataDir: string, overrides: Partial<NicotinDConfig> = {}): NicotinDConfig {
  return NicotinDConfigSchema.parse({
    dataDir,
    musicDir: join(dataDir, 'music'),
    soulseek: { username: 'u', password: 'p' },
    slskd: {},
    jwt: { secret: 'x'.repeat(32) },
    ...overrides,
  });
}

describe('buildLidarrDefinition', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nicotind-lidarr-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes config.xml with the generated api key and default port', () => {
    buildLidarrDefinition(makeConfig(dataDir), 'TEST-API-KEY');
    const xml = readFileSync(join(dataDir, 'lidarr', 'config.xml'), 'utf-8');
    expect(xml).toContain('<ApiKey>TEST-API-KEY</ApiKey>');
    expect(xml).toContain('<Port>8686</Port>');
    expect(xml).toContain('<AuthenticationMethod>None</AuthenticationMethod>');
  });

  it('honors a custom lidarr port in both config.xml and the health check', () => {
    const def = buildLidarrDefinition(
      makeConfig(dataDir, { lidarr: { url: 'http://localhost:9999', port: 9999, apiKey: '' } }),
      'KEY',
    );
    const xml = readFileSync(join(dataDir, 'lidarr', 'config.xml'), 'utf-8');
    expect(xml).toContain('<Port>9999</Port>');
    expect(def.healthCheckUrl).toBe('http://localhost:9999/ping');
  });

  it('returns a ServiceDefinition pointing at the extracted Lidarr binary + data dir', () => {
    const def = buildLidarrDefinition(makeConfig(dataDir), 'KEY');
    expect(def.name).toBe('lidarr');
    expect(def.command).toBe(join(dataDir, 'bin', 'Lidarr', 'Lidarr'));
    expect(def.args).toEqual(['-nobrowser', '-data', join(dataDir, 'lidarr')]);
    expect(existsSync(join(dataDir, 'lidarr'))).toBe(true);
  });
});
