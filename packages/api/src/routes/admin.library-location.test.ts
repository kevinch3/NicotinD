/**
 * The empty-library first run (#1739) tells an admin where the server reads
 * music from. The path is the server's own filesystem layout, so it is
 * admin-only like the rest of /api/admin.
 */
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { JwtPayload } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import { adminRoutes } from './admin.js';

function app(role: 'admin' | 'user'): Hono<AuthEnv> {
  const wrap = new Hono<AuthEnv>();
  wrap.use('*', async (c, next) => {
    c.set('user', { sub: 'u1', username: 'u', role, iat: 0, exp: 0 } as JwtPayload);
    await next();
  });
  wrap.route('/', adminRoutes({ musicDir: '/srv/music' }));
  return wrap;
}

describe('GET /library-location', () => {
  it('returns the music dir to an admin', async () => {
    const res = await app('admin').request('/library-location');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ musicDir: '/srv/music' });
  });

  it('rejects non-admins', async () => {
    expect((await app('user').request('/library-location')).status).toBe(403);
  });
});
