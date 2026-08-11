import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { SlskdStatus } from '@nicotind/core';
import { createLogger } from '@nicotind/core';
import type { AuthEnv } from '../middleware/auth.js';
import type { PluginRegistry } from '../services/plugins/registry.js';
import type { ProviderRegistry } from '../services/provider-registry.js';
import type { SlskdRef } from '../index.js';
import { buildSlskdStatus } from '../services/slskd-status.js';
import { AddonRequestError } from '../services/addons/client.js';
import { registerAddon, removeAddon } from '../services/addons/manager.js';
import { RemoteAddonPlugin } from '../services/addons/remote-addon-plugin.js';
import { recordAudit } from '../services/audit-log.js';

const log = createLogger('routes:plugins');

/**
 * Plugin management API. Listing is readable by any authenticated user (it
 * drives the capability-gated UI — clients show/hide acquisition surfaces based
 * on what's enabled). Enable/disable/config are admin-only, and enabling a
 * plugin whose manifest requires consent demands an explicit acknowledgement.
 *
 * `slskdRef` is passed so the slskd extension's own status panel
 * (`GET /:id/slskd/status` — Nicotine+-style speeds/limits) can read live client
 * state without reaching into the core settings route. Extension-owned surface.
 *
 * Remote addons (acquisition addon protocol): `POST /addons` registers one by
 * URL + bearer token, `DELETE /addons/:id` removes it; once registered it flows
 * through every plugin route above like a builtin.
 */
export function pluginRoutes(
  registry: PluginRegistry,
  slskdRef: SlskdRef,
  db: Database,
  providerRegistry?: ProviderRegistry,
) {
  const app = new Hono<AuthEnv>();

  app.get('/', async (c) => c.json(await registry.list()));

  app.post('/addons', async (c) => {
    // why: the `/:id/*` guard below needs a subpath, so this single-segment
    // route carries its own admin check.
    if (c.get('user').role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }
    let body: { url?: unknown; token?: unknown };
    try {
      body = await c.req.json<{ url?: unknown; token?: unknown }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!url || !token) return c.json({ error: 'url and token are required' }, 400);
    try {
      const reg = await registerAddon(registry, db, {
        url,
        token,
        addedBy: c.get('user').sub,
        providerRegistry,
      });
      recordAudit(db, c.get('user'), 'addon.register', {
        targetKind: 'addon',
        targetId: reg.id,
        detail: reg.url,
      });
      const info = (await registry.list()).find((p) => p.id === reg.id);
      return c.json({ ok: true, plugin: info }, 201);
    } catch (err) {
      if (err instanceof AddonRequestError) {
        return c.json({ error: `Addon not reachable: ${err.message}` }, 502);
      }
      return c.json({ error: err instanceof Error ? err.message : 'Registration failed' }, 400);
    }
  });

  // Admin guard for all mutating routes (everything under /:id).
  app.use('/:id/*', async (c, next) => {
    if (c.get('user').role !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }
    await next();
  });

  app.delete('/addons/:id', async (c) => {
    const id = c.req.param('id');
    const plugin = registry.get(id);
    if (!plugin) return c.json({ error: 'Addon not found' }, 404);
    if (!plugin.origin?.remote) return c.json({ error: 'Not a remote addon' }, 400);
    await removeAddon(registry, db, id);
    recordAudit(db, c.get('user'), 'addon.remove', { targetKind: 'addon', targetId: id });
    return c.json({ ok: true });
  });

  /** Live status rows for the generic addon status panel. Degrades to
   *  `available:false` when the addon is down rather than 500ing the card. */
  app.get('/:id/addon-status', async (c) => {
    const plugin = registry.get(c.req.param('id'));
    if (!plugin || !(plugin instanceof RemoteAddonPlugin)) {
      return c.json({ error: 'Addon not found' }, 404);
    }
    try {
      return c.json({ available: true, rows: await plugin.status() });
    } catch {
      return c.json({ available: false, rows: [] });
    }
  });

  /**
   * slskd-scoped live status (admin-only via the guard above). Self-gates on the
   * plugin being enabled and a client being reachable; degrades to zeros/empty
   * rather than 500 when an individual slskd probe fails mid-connect.
   */
  app.get('/slskd/status', async (c) => {
    const enabled = registry.isEnabled('slskd');
    const slskd = slskdRef.current;
    const available = enabled && slskd !== null;
    if (!available) {
      const empty: SlskdStatus = {
        enabled,
        available: false,
        connection: null,
        speeds: { downloadBytesPerSec: 0, uploadBytesPerSec: 0 },
        counts: { downloading: 0, uploading: 0, queued: 0 },
        limits: {},
        shares: {},
      };
      return c.json(empty);
    }
    // Fetch each piece independently so one failing probe can't blank the panel.
    const [serverState, downloads, uploads, options, appInfo] = await Promise.all([
      slskd.server.getState().catch(() => null),
      slskd.transfers.getDownloads().catch(() => null),
      slskd.transfers.getUploads().catch(() => null),
      slskd.options.get().catch(() => null),
      slskd.application.getInfo().catch((err) => {
        log.debug({ err }, 'slskd application info probe failed');
        return null;
      }),
    ]);
    return c.json(
      buildSlskdStatus({ enabled, available, serverState, downloads, uploads, options, appInfo }),
    );
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
      // Wait for the config-triggered re-init so the caller's next read
      // (e.g. the Extensions page refreshing availability) sees the new state.
      await registry.flushReinit();
      return c.json({ ok: true, config });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Invalid config' }, 400);
    }
  });

  return app;
}
