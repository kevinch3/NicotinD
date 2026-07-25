/**
 * Route tests for the admin config export/import endpoints (issue #221):
 * admin gate, 503 without a registry, export→import round-trip, secret
 * redaction, dry-run plan, and rejection of a malformed artifact.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { JwtPayload, Plugin, PluginManifest } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { PluginRegistry } from '../services/plugins/registry.js';
import { adminRoutes } from './admin.js';

let testDb: Database = (() => {
  const d = new Database(':memory:');
  applySchema(d);
  return d;
})();

mock.module('../db.js', () => ({
  getDatabase: () => testDb,
  initDatabase: () => testDb,
  applySchema,
}));

function makePlugin(id: string): Plugin {
  const manifest: PluginManifest = {
    id,
    name: id,
    description: 'test',
    kind: 'metadata',
    capabilities: ['genre'],
    defaultEnabled: false,
    configSchema: z
      .object({ clientId: z.string().optional(), clientSecret: z.string().optional() })
      .passthrough(),
    configFields: [
      { key: 'clientId', label: 'Client ID', type: 'text' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password' },
    ],
  };
  return {
    manifest,
    async init() {},
    async isAvailable() {
      return true;
    },
    async dispose() {},
  };
}

function authed(app: Hono<AuthEnv>, role: 'admin' | 'user' = 'admin'): Hono<AuthEnv> {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: 'admin1', username: 'admin', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', app);
  return wrap;
}

let registry: PluginRegistry;

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  registry = new PluginRegistry({ db: testDb, dataDir: '/tmp/nd-cfg-route' });
  registry.register(makePlugin('spotify'));
});

describe('admin config export/import routes', () => {
  it('rejects non-admins', async () => {
    const app = authed(adminRoutes({ musicDir: '/music', plugins: registry }), 'user');
    expect((await app.request('/config/export')).status).toBe(403);
  });

  it('503s when no plugin registry is wired', async () => {
    const app = authed(adminRoutes({ musicDir: '/music' }));
    expect((await app.request('/config/export')).status).toBe(503);
    expect(
      (await app.request('/config/import', { method: 'POST', body: '{}' })).status,
    ).toBe(503);
  });

  it('exports config as a downloadable JSON with secrets redacted', async () => {
    testDb.run(`INSERT INTO app_settings (key, value) VALUES ('processing', ?)`, [
      JSON.stringify({ enabled: true }),
    ]);
    registry.setConfig('spotify', { clientId: 'abc', clientSecret: 'SECRET-NOPE' });

    const app = authed(adminRoutes({ musicDir: '/music', plugins: registry }));
    const res = await app.request('/config/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const text = await res.text();
    expect(text).not.toContain('SECRET-NOPE');
    const artifact = JSON.parse(text);
    expect(artifact.kind).toBe('nicotind-config');
    expect(artifact.settings.processing).toEqual({ enabled: true });
  });

  it('dry-run import returns a plan without writing', async () => {
    const app = authed(adminRoutes({ musicDir: '/music', plugins: registry }));
    const artifact = {
      kind: 'nicotind-config',
      version: 1,
      appVersion: null,
      exportedAt: 'x',
      settings: { streaming: { transcode: true } },
      plugins: [],
    };
    const res = await app.request('/config/import?dryRun=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: artifact }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dryRun).toBe(true);
    expect(body.plan.settings[0]).toEqual({ key: 'streaming', action: 'create' });
    // Nothing written.
    const row = testDb
      .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
      .get('streaming');
    expect(row).toBeNull();
  });

  it('applies an import and writes an audit entry', async () => {
    const app = authed(adminRoutes({ musicDir: '/music', plugins: registry }));
    const artifact = {
      kind: 'nicotind-config',
      version: 1,
      appVersion: null,
      exportedAt: 'x',
      settings: { streaming: { transcode: true } },
      plugins: [
        {
          id: 'spotify',
          enabled: true,
          config: { clientId: 'imported' },
          redactedSecrets: ['clientSecret'],
          consentAt: null,
          consentUser: null,
        },
      ],
    };
    const res = await app.request('/config/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: artifact }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.settingsWritten).toBe(1);
    expect(registry.getConfig('spotify').clientId).toBe('imported');
    expect(registry.isEnabled('spotify')).toBe(true);
    const audit = testDb
      .query<{ action: string }, []>("SELECT action FROM audit_log WHERE action = 'config.import'")
      .all();
    expect(audit.length).toBe(1);
  });

  it('rejects a malformed artifact with 400', async () => {
    const app = authed(adminRoutes({ musicDir: '/music', plugins: registry }));
    const res = await app.request('/config/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { kind: 'wrong' } }),
    });
    expect(res.status).toBe(400);
  });
});
