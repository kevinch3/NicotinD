import { Hono } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import type { PluginRegistry } from '../services/plugins/registry.js';

/**
 * Plugin management API. Listing is readable by any authenticated user (it
 * drives the capability-gated UI — clients show/hide acquisition surfaces based
 * on what's enabled). Enable/disable/config are admin-only, and enabling a
 * plugin whose manifest requires consent demands an explicit acknowledgement.
 */
export function pluginRoutes(registry: PluginRegistry) {
  const app = new Hono<AuthEnv>();

  app.get('/', async (c) => c.json(await registry.list()));

  // Admin guard for all mutating routes (everything under /:id).
  app.use('/:id/*', async (c, next) => {
    if (c.get('user').role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }
    await next();
  });

  app.post('/:id/enable', async (c) => {
    const id = c.req.param('id');
    const plugin = registry.get(id);
    if (!plugin) return c.json({ error: 'Plugin not found' }, 404);

    if (plugin.manifest.compliance?.requiresConsent) {
      let body: { consent?: boolean } = {};
      try {
        body = await c.req.json<{ consent?: boolean }>();
      } catch {
        // Empty/invalid body — treated as no consent.
      }
      if (body.consent !== true) {
        return c.json(
          { error: 'Consent required', disclaimer: plugin.manifest.compliance.disclaimer },
          412,
        );
      }
    }

    await registry.enable(id, c.get('user').sub);
    return c.json({ ok: true });
  });

  app.post('/:id/disable', async (c) => {
    const id = c.req.param('id');
    if (!registry.get(id)) return c.json({ error: 'Plugin not found' }, 404);
    await registry.disable(id);
    return c.json({ ok: true });
  });

  app.put('/:id/config', async (c) => {
    const id = c.req.param('id');
    if (!registry.get(id)) return c.json({ error: 'Plugin not found' }, 404);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    try {
      const config = registry.setConfig(id, body);
      return c.json({ ok: true, config });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid config' }, 400);
    }
  });

  return app;
}
