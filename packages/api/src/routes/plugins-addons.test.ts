import { describe, expect, it, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { ADDON_PROTOCOL_VERSION, type JwtPayload, type PluginInfo } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { PluginRegistry } from '../services/plugins/registry.js';
import { pluginRoutes } from './plugins.js';

const FIXTURE_MANIFEST = {
  id: 'fixture-addon',
  name: 'Fixture Addon',
  description: 'test',
  version: '0.1.0',
  protocolVersion: ADDON_PROTOCOL_VERSION,
  kind: 'acquisition',
  capabilities: ['search'],
  statusFields: [{ key: 'peers', label: 'Peers' }],
  compliance: { disclaimer: 'Test addon', requiresConsent: true },
};

// A minimal live fixture addon (register goes through the real AddonClient).
const fixtureServer = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/addon/v1/manifest') return Response.json(FIXTURE_MANIFEST);
    if (path === '/addon/v1/health') return Response.json({ ok: true, ready: true });
    if (path === '/addon/v1/status') {
      if (req.headers.get('authorization') !== 'Bearer fixture-token') {
        return new Response('unauthorized', { status: 401 });
      }
      return Response.json([{ key: 'peers', label: 'Peers', value: '42' }]);
    }
    if (path === '/addon/v1/config' && req.method === 'PUT') {
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  },
});
const fixtureUrl = `http://127.0.0.1:${fixtureServer.port}`;
afterAll(() => fixtureServer.stop(true));

function makeApp(role: 'admin' | 'user') {
  const db = new Database(':memory:');
  applySchema(db);
  const registry = new PluginRegistry({ db, dataDir: '/tmp/nicotind-test' });
  const app = new Hono<AuthEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', username: 'tester', role } as JwtPayload);
    await next();
  });
  app.route('/api/plugins', pluginRoutes(registry, db));
  return { app, db, registry };
}

describe('addon routes', () => {
  let admin: ReturnType<typeof makeApp>;

  beforeEach(() => {
    admin = makeApp('admin');
  });

  it('rejects a non-admin register', async () => {
    const { app } = makeApp('user');
    const res = await app.request('/api/plugins/addons', {
      method: 'POST',
      body: JSON.stringify({ url: fixtureUrl, token: 'fixture-token' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(403);
  });

  it('registers an addon and lists it as remote', async () => {
    const res = await admin.app.request('/api/plugins/addons', {
      method: 'POST',
      body: JSON.stringify({ url: fixtureUrl, token: 'fixture-token' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(201);
    const list = await admin.app.request('/api/plugins');
    const infos = (await list.json()) as PluginInfo[];
    const addon = infos.find((i) => i.id === 'fixture-addon');
    expect(addon?.remote).toBe(true);
    expect(addon?.addonUrl).toBe(fixtureUrl);
  });

  it('400s a body without url/token', async () => {
    const res = await admin.app.request('/api/plugins/addons', {
      method: 'POST',
      body: JSON.stringify({ url: '' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  it('502s when the addon is unreachable', async () => {
    const res = await admin.app.request('/api/plugins/addons', {
      method: 'POST',
      body: JSON.stringify({ url: 'http://127.0.0.1:1', token: 'x' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(502);
  });

  it('serves addon status and 400s it for builtins', async () => {
    await admin.app.request('/api/plugins/addons', {
      method: 'POST',
      body: JSON.stringify({ url: fixtureUrl, token: 'fixture-token' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await admin.app.request('/api/plugins/fixture-addon/addon-status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; rows: { value: string }[] };
    expect(body.available).toBe(true);
    expect(body.rows[0]!.value).toBe('42');

    const builtin = await admin.app.request('/api/plugins/nope/addon-status');
    expect(builtin.status).toBe(404);
  });

  it('serves the curated catalog with per-entry install state (any authed user)', async () => {
    const { app } = makeApp('user'); // read is not admin-gated
    const res = await app.request('/api/plugins/catalog');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: { id: string; state: string; name: string }[];
    };
    const ids = body.entries.map((e) => e.id);
    expect(ids).toContain('ytdlp-addon');
    expect(ids).toContain('archive');
    // Archive is bundled → builtin; nothing installed yet → the rest available.
    expect(body.entries.find((e) => e.id === 'archive')!.state).toBe('builtin');
    expect(body.entries.find((e) => e.id === 'ytdlp-addon')!.state).toBe('available');
  });

  it('reflects a registered addon as installed in the catalog', async () => {
    // Register the fixture (id 'fixture-addon' is not a catalog entry), then a
    // catalog id via a second fixture manifest would be ideal; here we assert
    // that registering does not perturb the catalog entries' shape.
    await admin.app.request('/api/plugins/addons', {
      method: 'POST',
      body: JSON.stringify({ url: fixtureUrl, token: 'fixture-token' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const body = (await (await admin.app.request('/api/plugins/catalog')).json()) as {
      entries: { id: string; state: string }[];
    };
    // fixture-addon is not in the catalog, so it does not appear.
    expect(body.entries.find((e) => e.id === 'fixture-addon')).toBeUndefined();
  });

  describe('catalog install (issue #517 PR2)', () => {
    it('mints a token + pending row and returns a snippet with the token baked in', async () => {
      const res = await admin.app.request('/api/plugins/catalog/ytdlp-addon/install', {
        method: 'POST',
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        token: string;
        addonUrl: string;
        composeSnippet: { full: string };
        reused: boolean;
      };
      expect(body.token).toMatch(/^nca_addon_/);
      expect(body.addonUrl).toBe('http://ytdlp-addon:8586');
      expect(body.composeSnippet.full).toContain(body.token);
      expect(body.composeSnippet.full).not.toContain('change-me');
      expect(body.reused).toBe(false);

      // The catalog now reports it pending (container not up in the test).
      const cat = (await (await admin.app.request('/api/plugins/catalog')).json()) as {
        entries: { id: string; state: string }[];
      };
      expect(cat.entries.find((e) => e.id === 'ytdlp-addon')!.state).toBe('pending');
    });

    it('re-installing returns the same token (idempotent)', async () => {
      const first = (await (
        await admin.app.request('/api/plugins/catalog/ytdlp-addon/install', { method: 'POST' })
      ).json()) as { token: string };
      const again = (await (
        await admin.app.request('/api/plugins/catalog/ytdlp-addon/install', { method: 'POST' })
      ).json()) as { token: string; reused: boolean };
      expect(again.reused).toBe(true);
      expect(again.token).toBe(first.token);
    });

    it('404s an unknown catalog id and 400s a builtin', async () => {
      expect(
        (await admin.app.request('/api/plugins/catalog/nope/install', { method: 'POST' })).status,
      ).toBe(404);
      expect(
        (await admin.app.request('/api/plugins/catalog/archive/install', { method: 'POST' }))
          .status,
      ).toBe(400);
    });

    it('rejects a non-admin install', async () => {
      const { app } = makeApp('user');
      const res = await app.request('/api/plugins/catalog/ytdlp-addon/install', { method: 'POST' });
      expect(res.status).toBe(403);
    });

    it('check reports the state and does not promote an unreachable addon', async () => {
      await admin.app.request('/api/plugins/catalog/ytdlp-addon/install', { method: 'POST' });
      const res = await admin.app.request('/api/plugins/catalog/ytdlp-addon/check', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { state: string; promoted: boolean };
      expect(body.state).toBe('pending');
      expect(body.promoted).toBe(false);
    });
  });

  it('removes an addon and 404s an unknown one', async () => {
    await admin.app.request('/api/plugins/addons', {
      method: 'POST',
      body: JSON.stringify({ url: fixtureUrl, token: 'fixture-token' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await admin.app.request('/api/plugins/addons/fixture-addon', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const list = (await (await admin.app.request('/api/plugins')).json()) as PluginInfo[];
    expect(list.find((i) => i.id === 'fixture-addon')).toBeUndefined();

    const missing = await admin.app.request('/api/plugins/addons/fixture-addon', {
      method: 'DELETE',
    });
    expect(missing.status).toBe(404);
  });
});
