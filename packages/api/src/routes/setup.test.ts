/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { setupRoutes } from './setup.js';
import { applySchema } from '../db.js';
import { getDownloadsSettings } from '../services/downloads-settings.js';

const testDb = new Database(':memory:');
applySchema(testDb);

mock.module('../db.js', () => ({ getDatabase: () => testDb, applySchema }));

const mockConfig = {
  musicDir: '~/Music',
  downloads: { transcodeLossless: { enabled: true, format: 'opus', bitRate: 192 } },
  jwt: { secret: 'test-secret-at-least-32-chars-long-xx', expiresIn: '30d' },
  soulseek: { username: '', password: '', url: 'http://localhost:5030', port: 5030 },
  lidarr: { url: 'http://localhost:8686', apiKey: '', port: 8686 },
};

const mockServiceManager = {
  updateConfig: mock(() => {}),
  hasService: mock(() => false),
  restartService: mock(() => Promise.resolve()),
};

function buildApp() {
  const app = new Hono();
  app.route(
    '/api/setup',
    setupRoutes({
      config: mockConfig as any,
      serviceManager: mockServiceManager as any,
      saveLidarrSecretsFn: mock(() => {}),
    }),
  );
  return app;
}

describe('GET /api/setup/status', () => {
  it('returns needsSetup: true when no users exist', async () => {
    testDb.run('DELETE FROM users');
    const app = buildApp();
    const res = await app.request('/api/setup/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { needsSetup: boolean };
    expect(body.needsSetup).toBe(true);
  });

  it('returns needsSetup: false when users exist', async () => {
    testDb.run(
      "INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'admin', 'hash', 'admin')",
    );
    const app = buildApp();
    const res = await app.request('/api/setup/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { needsSetup: boolean };
    expect(body.needsSetup).toBe(false);
  });
});

describe('POST /api/setup/complete', () => {
  beforeEach(() => {
    testDb.run('DELETE FROM users');
    testDb.run('DELETE FROM user_settings');
  });

  it('creates admin user and returns token', async () => {
    const app = buildApp();
    const res = await app.request('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin: { username: 'admin', password: 'password123' } }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; user: { username: string; role: string } };
    expect(body.token).toBeTruthy();
    expect(body.user.username).toBe('admin');
    expect(body.user.role).toBe('admin');
  });

  it('stores musicDir in config when provided', async () => {
    const app = buildApp();
    await app.request('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        admin: { username: 'admin', password: 'password123' },
        musicDir: '/mnt/music',
      }),
    });
    expect(mockServiceManager.updateConfig).toHaveBeenCalled();
    const updatedConfig = (
      mockServiceManager.updateConfig as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0]?.[0];
    expect(updatedConfig).toBeDefined();
    const config = updatedConfig as unknown as { musicDir: string };
    expect(config.musicDir).toBe('/mnt/music');
  });

  // This block previously asserted the value landed in the `streaming` key, which
  // is playback-time on-the-fly transcoding and has nothing to do with the
  // question the wizard asks. It pinned the defect rather than the behaviour, so
  // it is inverted here rather than deleted — the same discipline #1177 used.
  it('stores transcodeLossless under the downloads key, not streaming', async () => {
    const app = buildApp();
    await app.request('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        admin: { username: 'admin', password: 'password123' },
        transcodeLossless: { enabled: true, bitRate: 256 },
      }),
    });

    const row = testDb.query('SELECT value FROM app_settings WHERE key = ?').get('downloads') as
      { value: string } | undefined;
    expect(row).toBeTruthy();
    expect(JSON.parse(row!.value).transcodeLossless).toEqual({ enabled: true, bitRate: 256 });

    // The playback setting must be untouched: writing it was the bug.
    const streaming = testDb.query('SELECT value FROM app_settings WHERE key = ?').get('streaming');
    expect(streaming).toBeFalsy();
  });

  it('turning the toggle OFF at setup actually disables the download transcode', async () => {
    // The user-visible bug: an operator who declined lossless→Opus still got
    // every FLAC converted, because the answer never reached this setting.
    // The suite shares one database, so clear the key this case is about.
    testDb.run(`DELETE FROM app_settings WHERE key = 'downloads'`);
    const app = buildApp();
    await app.request('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        admin: { username: 'admin', password: 'password123' },
        transcodeLossless: { enabled: false },
      }),
    });

    // Read it back the way the download path does, against a config that says ON.
    const effective = getDownloadsSettings(testDb, { enabled: true, bitRate: 192 });
    expect(effective.transcodeLossless.enabled).toBe(false);
    // bitRate was never mentioned, so the configured value still governs it.
    expect(effective.transcodeLossless.bitRate).toBe(192);
  });

  it('returns needsRestart: true when lidarr is configured', async () => {
    const app = buildApp();
    const res = await app.request('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        admin: { username: 'admin', password: 'password123' },
        lidarr: { url: 'http://localhost:8686', apiKey: 'test-key' },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { needsRestart: boolean };
    expect(body.needsRestart).toBe(true);
  });

  it('updates config.lidarr when lidarr url/key provided', async () => {
    const app = buildApp();
    await app.request('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        admin: { username: 'admin', password: 'password123' },
        lidarr: { url: 'http://localhost:9999', apiKey: 'key123' },
      }),
    });
    expect(mockServiceManager.updateConfig).toHaveBeenCalled();
    const updatedConfig = (
      mockServiceManager.updateConfig as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0]?.[0];
    expect(updatedConfig).toBeDefined();
    const config = updatedConfig as unknown as { lidarr: { url: string; apiKey: string } };
    expect(config.lidarr.url).toBe('http://localhost:9999');
    expect(config.lidarr.apiKey).toBe('key123');
  });

  it('calls saveLidarrSecretsFn when lidarr apiKey provided', async () => {
    const saveLidarrSecretsFn = mock(() => {});
    const app = new Hono();
    app.route(
      '/api/setup',
      setupRoutes({
        config: mockConfig as any,
        serviceManager: mockServiceManager as any,
        saveLidarrSecretsFn,
      }),
    );
    await app.request('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        admin: { username: 'admin', password: 'password123' },
        lidarr: { url: 'http://localhost:8686', apiKey: 'my-secret-key' },
      }),
    });
    expect(saveLidarrSecretsFn).toHaveBeenCalledWith('my-secret-key');
  });

  it('rejects when users already exist', async () => {
    testDb.run(
      "INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'admin', 'hash', 'admin')",
    );
    const app = buildApp();
    const res = await app.request('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin: { username: 'admin2', password: 'password123' } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Setup already completed');
  });

  it('requires admin username and password', async () => {
    const app = buildApp();
    const res = await app.request('/api/setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin: { username: '', password: '' } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Admin username and password are required');
  });
});
