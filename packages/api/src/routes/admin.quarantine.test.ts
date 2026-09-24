/** Route test for the read-only quarantine view (#1255). */
import { describe, expect, it, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { adminRoutes, type AdminRoutesDeps } from './admin.js';
import { createQuarantineRun } from '../services/transcode-quarantine.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function app(deps: Partial<AdminRoutesDeps>, role: 'admin' | 'user' = 'admin') {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: 'a', username: 'boss', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', adminRoutes({ musicDir: '/m', ...deps } as AdminRoutesDeps));
  return wrap;
}

describe('GET /quarantine', () => {
  it('reads the quarantine dir when it is set apart from dataDir', async () => {
    const data = mkdtempSync(join(tmpdir(), 'aq-data-'));
    const q = mkdtempSync(join(tmpdir(), 'aq-q-'));
    dirs.push(data, q);
    createQuarantineRun(q, new Date(2026, 8, 3));
    const res = await app({ dataDir: data, quarantineDir: q }).request('/quarantine');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: { name: string }[] };
    expect(body.runs.map((r) => r.name)).toEqual(['transcode-20260903-000000']);
  });

  it('is admin-only, and 503s with no data dir', async () => {
    expect((await app({ dataDir: '/tmp' }, 'user').request('/quarantine')).status).toBe(403);
    expect((await app({}).request('/quarantine')).status).toBe(503);
  });
});
