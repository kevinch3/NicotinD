import { describe, expect, it } from 'bun:test';
import { healthRoutes } from './health.js';

describe('health route', () => {
  it('reports ok + the running version', async () => {
    const res = await healthRoutes('1.2.3').request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '1.2.3' });
  });

  it('falls back to "unknown" when no version is provided', async () => {
    const res = await healthRoutes().request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 'unknown' });
  });
});
