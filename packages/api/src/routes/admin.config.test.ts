/**
 * Route tests for the admin config export/import endpoints: admin gate, secret
 * redaction default, dry-run preview, apply + audit ledger, bad-input handling.
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { applySchema } from '../db.js';
import { adminRoutes } from './admin.js';
import type { ConfigBundle } from '../services/config-export.js';

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

function authed(role: 'admin' | 'user' = 'admin'): Hono<AuthEnv> {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', username: 'boss', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', adminRoutes({ musicDir: '/tmp/music', version: '9.9.9' }));
  return wrap;
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applySchema(testDb);
  testDb.run(`INSERT INTO plugins (id, enabled) VALUES (?, ?)`, ['spotify', 1]);
  testDb.run(`INSERT INTO plugin_kv (plugin_id, key, value) VALUES (?,?,?)`, [
    'spotify',
    'clientSecret',
    'super-secret',
  ]);
});

describe('GET /api/admin/config/export', () => {
  it('rejects a non-admin caller', async () => {
    expect((await authed('user').request('/config/export')).status).toBe(403);
  });

  it('redacts credentials by default and offers the file as a download', async () => {
    const res = await authed().request('/config/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(
      /attachment; filename="nicotind-config-/,
    );

    const bundle = (await res.json()) as ConfigBundle;
    expect(bundle.includesSecrets).toBe(false);
    expect(bundle.appVersion).toBe('9.9.9');
    expect(bundle.sections.plugin_kv?.[0]?.['value']).toBeNull();
  });

  it('includes credentials only with the explicit opt-in', async () => {
    const res = await authed().request('/config/export?secrets=1');
    const bundle = (await res.json()) as ConfigBundle;
    expect(bundle.includesSecrets).toBe(true);
    expect(bundle.sections.plugin_kv?.[0]?.['value']).toBe('super-secret');
  });

  it('ledgers the export in the audit log', async () => {
    await authed().request('/config/export?secrets=1');
    const row = testDb.query(`SELECT action, detail FROM audit_log`).get() as {
      action: string;
      detail: string;
    };
    expect(row.action).toBe('config.export');
    expect(row.detail).toMatch(/including secrets/);
  });
});

describe('POST /api/admin/config/import', () => {
  const post = (body: unknown, role: 'admin' | 'user' = 'admin') =>
    authed(role).request('/config/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function exported(): Promise<ConfigBundle> {
    return (await (await authed().request('/config/export?secrets=1')).json()) as ConfigBundle;
  }

  it('rejects a non-admin caller', async () => {
    expect((await post({ bundle: {} }, 'user')).status).toBe(403);
  });

  it('rejects a structurally invalid bundle with 400', async () => {
    expect((await post({ bundle: 'nonsense' })).status).toBe(400);
    expect(
      (await post({ bundle: { bundleVersion: 1, sections: { library_songs: [] } } })).status,
    ).toBe(400);
  });

  it('refuses a bundle from a newer server', async () => {
    const bundle = { ...(await exported()), bundleVersion: 99 };
    const res = await post({ bundle });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/newer than this server/);
  });

  it('dryRun reports the plan without writing or auditing', async () => {
    const bundle = await exported();
    testDb.run(`DELETE FROM plugin_kv`);

    const res = await post({ bundle, dryRun: true });
    const body = (await res.json()) as { dryRun: boolean; plan: { sections: unknown[] } };

    expect(body.dryRun).toBe(true);
    expect(body.plan.sections.length).toBeGreaterThan(0);
    expect(testDb.query(`SELECT COUNT(*) AS n FROM plugin_kv`).get()).toMatchObject({ n: 0 });
    expect(
      testDb.query(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'config.import'`).get(),
    ).toMatchObject({ n: 0 });
  });

  it('applies the bundle and ledgers it', async () => {
    const bundle = await exported();
    testDb.run(`DELETE FROM plugin_kv`);

    const res = await post({ bundle });
    expect(res.status).toBe(200);

    expect(testDb.query(`SELECT value FROM plugin_kv`).get()).toMatchObject({
      value: 'super-secret',
    });
    expect(
      testDb.query(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'config.import'`).get(),
    ).toMatchObject({ n: 1 });
  });

  it('rejects a non-JSON body with 400 rather than throwing', async () => {
    const res = await authed().request('/config/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});
