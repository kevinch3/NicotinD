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
  });

  // Core reaches the embedded Lidarr on localhost; nothing else should.
  it('binds the embedded Lidarr to loopback only', () => {
    buildLidarrDefinition(makeConfig(dataDir), 'KEY');
    const xml = readFileSync(join(dataDir, 'lidarr', 'config.xml'), 'utf-8');
    expect(xml).toContain('<BindAddress>127.0.0.1</BindAddress>');
    expect(xml).not.toContain('<BindAddress>*</BindAddress>');
  });

  // With AuthenticationMethod=None, GET /initialize.json returns the API key to
  // any caller. Forms keeps API-key calls working and stops that leak.
  it('requires authentication instead of None', () => {
    buildLidarrDefinition(makeConfig(dataDir), 'KEY');
    const xml = readFileSync(join(dataDir, 'lidarr', 'config.xml'), 'utf-8');
    expect(xml).toContain('<AuthenticationMethod>Forms</AuthenticationMethod>');
    expect(xml).toContain('<AuthenticationRequired>Enabled</AuthenticationRequired>');
    expect(xml).not.toContain('<AuthenticationMethod>None</AuthenticationMethod>');
  });

  it('turns Lidarr analytics off', () => {
    buildLidarrDefinition(makeConfig(dataDir), 'KEY');
    const xml = readFileSync(join(dataDir, 'lidarr', 'config.xml'), 'utf-8');
    expect(xml).toContain('<AnalyticsEnabled>False</AnalyticsEnabled>');
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
    expect(existsSync(join(dataDir, 'lidarr'))).toBe(true);
  });

  // Servarr apps only parse `-data=<dir>`. A separate `-data <dir>` pair is
  // dropped, so Lidarr fell back to ~/.config/Lidarr with its own defaults
  // (bind *, auth None, its own API key) and never read the config.xml written
  // below: the LAN exposure and the permanent 401 had this one cause.
  it('passes the data dir as a single -data=<dir> argument, the only form Lidarr parses', () => {
    const def = buildLidarrDefinition(makeConfig(dataDir), 'KEY');
    expect(def.args).toEqual(['-nobrowser', `-data=${join(dataDir, 'lidarr')}`]);
  });
});
