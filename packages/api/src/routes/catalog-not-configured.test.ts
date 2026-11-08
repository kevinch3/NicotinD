import { describe, it, expect } from 'bun:test';
import { catalogNotConfiguredRoutes } from './catalog.js';

/**
 * #1729: with no Lidarr the catalog routes were simply not mounted, so search
 * got a 404 that the web read as "the catalog didn't answer", offering a Retry
 * that could never succeed. It now gets a typed answer it can explain.
 */
describe('catalog routes without a Lidarr', () => {
  const app = catalogNotConfiguredRoutes();

  it('answers search with empty results and a typed not-configured reason', async () => {
    const res = await app.request('/search?q=radiohead');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ artists: [], albums: [], catalogNotConfigured: true });
  });

  it('answers the Lidarr-only actions with a typed 503 instead of a 404', async () => {
    const res = await app.request('/resolve', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'LIDARR_NOT_CONFIGURED' });
  });
});
