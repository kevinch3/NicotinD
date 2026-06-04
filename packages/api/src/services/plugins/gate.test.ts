import { describe, expect, it, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { Plugin } from '@nicotind/core';
import type { AuthEnv } from '../../middleware/auth.js';
import { applySchema } from '../../db.js';
import { PluginRegistry } from './registry.js';
import { requireAcquisitionMiddleware } from './gate.js';

function downloadPlugin(): Plugin {
  return {
    manifest: {
      id: 'slskd',
      name: 'slskd',
      description: 'p2p',
      kind: 'acquisition',
      capabilities: ['download'],
      defaultEnabled: false,
    },
    async init() {},
    async isAvailable() {
      return true;
    },
    async dispose() {},
    download: { enqueue: async () => {} },
  };
}

function makeApp(plugins: PluginRegistry) {
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub: 'u', role: 'user', iat: 0, exp: 9999999999 } as AuthEnv['Variables']['user']);
    return next();
  });
  app.use('/hunt/*', requireAcquisitionMiddleware(plugins));
  app.get('/hunt/ping', (c) => c.json({ ok: true }));
  return app;
}

describe('requireAcquisitionMiddleware', () => {
  let db: Database;
  let plugins: PluginRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    plugins = new PluginRegistry({ db, dataDir: '/tmp/x' });
    plugins.register(downloadPlugin());
  });

  it('503s when no download-capable plugin is enabled', async () => {
    const res = await makeApp(plugins).request('/hunt/ping');
    expect(res.status).toBe(503);
  });

  it('passes through once a download-capable plugin is enabled', async () => {
    await plugins.enable('slskd', 'admin');
    const res = await makeApp(plugins).request('/hunt/ping');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
