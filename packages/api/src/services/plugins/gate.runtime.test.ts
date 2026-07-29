import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { requireAcquisitionEnabledMiddleware } from './gate.js';
import type { AuthEnv } from '../../middleware/auth.js';

/**
 * Issue #235 left the runtime toggle open on the grounds that boot-constructed
 * services can't tear down live. The gate never needed tearing down — it needed
 * to stop capturing a boolean. This pins that.
 */
function appWith(gate: ReturnType<typeof requireAcquisitionEnabledMiddleware>) {
  const app = new Hono<AuthEnv>();
  app.use('*', gate);
  app.get('/', (c) => c.json({ ok: true }));
  return app;
}

describe('requireAcquisitionEnabledMiddleware', () => {
  it('still accepts a plain boolean (existing callers)', async () => {
    expect((await appWith(requireAcquisitionEnabledMiddleware(true)).request('/')).status).toBe(
      200,
    );
    expect((await appWith(requireAcquisitionEnabledMiddleware(false)).request('/')).status).toBe(
      404,
    );
  });

  it('re-reads a getter on every request, so a flip needs no restart', async () => {
    let on = true;
    const app = appWith(requireAcquisitionEnabledMiddleware(() => on));

    expect((await app.request('/')).status).toBe(200);

    on = false; // admin turns it off mid-flight
    expect((await app.request('/')).status).toBe(404);

    on = true; // and back on
    expect((await app.request('/')).status).toBe(200);
  });

  it('404s rather than 403 — the module is absent, not forbidden', async () => {
    const res = await appWith(requireAcquisitionEnabledMiddleware(() => false)).request('/');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Acquisition is disabled on this deployment' });
  });
});
