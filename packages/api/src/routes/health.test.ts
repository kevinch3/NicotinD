import { describe, expect, it } from 'bun:test';
import { healthRoutes } from './health.js';

describe('health route', () => {
  it('reports ok + the running version', async () => {
    const res = await healthRoutes('1.2.3', 'abc123').request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '1.2.3', commit: 'abc123' });
  });

  it('falls back to "unknown" when no version is provided', async () => {
    const res = await healthRoutes(undefined, '').request('/');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 'unknown', commit: null });
  });

  // A deploy of an untagged commit verifies the build by its sha, so an image
  // built without one must say so rather than report something plausible.
  it('reports a null commit for a build that was not stamped', async () => {
    const res = await healthRoutes('1.2.3', '   ').request('/');
    expect(((await res.json()) as { commit: unknown }).commit).toBeNull();
  });

  it('reads the build commit from the image environment by default', async () => {
    const before = process.env.NICOTIND_BUILD_COMMIT;
    process.env.NICOTIND_BUILD_COMMIT = 'deadbeef';
    try {
      const res = await healthRoutes('1.2.3').request('/');
      expect(((await res.json()) as { commit: unknown }).commit).toBe('deadbeef');
    } finally {
      if (before === undefined) delete process.env.NICOTIND_BUILD_COMMIT;
      else process.env.NICOTIND_BUILD_COMMIT = before;
    }
  });
});
