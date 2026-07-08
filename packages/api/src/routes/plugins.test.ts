import { describe, expect, it, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { Plugin, PluginManifest } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { PluginRegistry } from '../services/plugins/registry.js';
import { pluginRoutes } from './plugins.js';

function fixturePlugin(over: Partial<PluginManifest> = {}): Plugin {
  const manifest: PluginManifest = {
    id: 'slskd',
    name: 'slskd',
    description: 'P2P',
    kind: 'acquisition',
    capabilities: ['search', 'download'],
    defaultEnabled: false,
    compliance: { disclaimer: 'P2P legal risk varies by country.', requiresConsent: true },
    ...over,
  };
  return {
    manifest,
    async init() {},
    async isAvailable() {
      return true;
    },
    async dispose() {},
    search: { search: async () => ({ results: null }) },
    download: { enqueue: async () => {} },
  };
}

function makeApp(
  registry: PluginRegistry,
  role: 'admin' | 'user',
  slskdRef: { current: unknown } = { current: null },
) {
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'u1', role, iat: 0, exp: 9999999999 } as AuthEnv['Variables']['user']);
    return next();
  });
  app.route('/', pluginRoutes(registry, slskdRef as never));
  return app;
}

describe('plugin routes', () => {
  let db: Database;
  let registry: PluginRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    registry = new PluginRegistry({ db, dataDir: '/tmp/nicotind-test' });
    registry.register(fixturePlugin());
  });

  it('GET / lists plugins for any authenticated user', async () => {
    const res = await makeApp(registry, 'user').request('/');
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ id: string; enabled: boolean }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'slskd', enabled: false });
  });

  it('forbids enable for non-admin users', async () => {
    const res = await makeApp(registry, 'user').request('/slskd/enable', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(registry.isEnabled('slskd')).toBe(false);
  });

  it('returns 404 enabling an unknown plugin', async () => {
    const res = await makeApp(registry, 'admin').request('/nope/enable', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('requires consent before enabling a consent-gated plugin', async () => {
    const res = await makeApp(registry, 'admin').request('/slskd/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(412);
    const json = (await res.json()) as { disclaimer: string };
    expect(json.disclaimer).toContain('legal risk');
    expect(registry.isEnabled('slskd')).toBe(false);
  });

  it('enables with consent and records the acting admin', async () => {
    const res = await makeApp(registry, 'admin').request('/slskd/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true }),
    });
    expect(res.status).toBe(200);
    expect(registry.isEnabled('slskd')).toBe(true);
    const row = db
      .query<{ consent_user: string }, [string]>(`SELECT consent_user FROM plugins WHERE id = ?`)
      .get('slskd');
    expect(row?.consent_user).toBe('u1');
  });

  it('disables an enabled plugin', async () => {
    await registry.enable('slskd', 'u1');
    const res = await makeApp(registry, 'admin').request('/slskd/disable', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(registry.isEnabled('slskd')).toBe(false);
  });

  it('GET /slskd/status returns a disabled shell when the plugin is off', async () => {
    const res = await makeApp(registry, 'admin').request('/slskd/status');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { enabled: boolean; available: boolean };
    expect(json).toMatchObject({ enabled: false, available: false });
  });

  it('GET /slskd/status is admin-only', async () => {
    const res = await makeApp(registry, 'user').request('/slskd/status');
    expect(res.status).toBe(403);
  });

  it('GET /slskd/status aggregates live slskd data when enabled', async () => {
    await registry.enable('slskd', 'u1');
    const slskd = {
      server: { getState: async () => ({ state: 'Connected', username: 'me', isConnected: true }) },
      transfers: {
        getDownloads: async () => [
          {
            username: 'peer',
            directories: [
              {
                directory: 'd',
                fileCount: 1,
                files: [
                  {
                    id: '1',
                    username: 'peer',
                    filename: 'a.mp3',
                    size: 1,
                    state: 'InProgress',
                    bytesTransferred: 0,
                    averageSpeed: 250,
                    percentComplete: 0,
                  },
                ],
              },
            ],
          },
        ],
        getUploads: async () => [],
      },
      options: { get: async () => ({ global: { upload: { slots: 4 } } }) },
      application: { getInfo: async () => ({ version: '1.0', uptime: 5 }) },
    };
    const res = await makeApp(registry, 'admin', { current: slskd }).request('/slskd/status');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      available: boolean;
      speeds: { downloadBytesPerSec: number };
      connection: { username: string };
      limits: { uploadSlots: number };
    };
    expect(json.available).toBe(true);
    expect(json.speeds.downloadBytesPerSec).toBe(250);
    expect(json.connection.username).toBe('me');
    expect(json.limits.uploadSlots).toBe(4);
  });

  it('rejects invalid config with 400', async () => {
    registry.register(
      fixturePlugin({
        id: 'ytdlp',
        capabilities: ['resolve', 'download'],
        compliance: { disclaimer: 'x', requiresConsent: false },
        configSchema: z.object({ format: z.enum(['mp3']) }),
      }),
    );
    const res = await makeApp(registry, 'admin').request('/ytdlp/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'flac' }),
    });
    expect(res.status).toBe(400);
  });
});
