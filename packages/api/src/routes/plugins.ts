import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { AuthEnv } from '../middleware/auth.js';
import type { PluginRegistry } from '../services/plugins/registry.js';
import type { ProviderRegistry } from '../services/provider-registry.js';
import { AddonRequestError, AddonContractError } from '../services/addons/client.js';
import {
  registerAddon,
  removeAddon,
  createPendingRegistration,
  promotePendingAddons,
  previewAddonManifest,
} from '../services/addons/manager.js';
import type { AddonCircuitBreaker } from '../services/addons/circuit-breaker.js';
import { RemoteAddonPlugin } from '../services/addons/remote-addon-plugin.js';
import { recordAudit } from '../services/audit-log.js';
import {
  ADDON_CATALOG,
  catalogEntry,
  catalogInstallState,
  renderComposeSnippet,
  type AddonCatalogInstallState,
  type CatalogRegistrationView,
} from '@nicotind/core';
import { listAddonRegistrations } from '../services/addons/store.js';

/**
 * Plugin management API. Listing is readable by any authenticated user (it
 * drives the capability-gated UI — clients show/hide acquisition surfaces based
 * on what's enabled). Enable/disable/config are admin-only, and enabling a
 * plugin whose manifest requires consent demands an explicit acknowledgement.
 *
 * Remote addons (acquisition addon protocol): `POST /addons` registers one by
 * URL + bearer token, `DELETE /addons/:id` removes it; once registered it flows
 * through every plugin route above like a builtin.
 */
export function pluginRoutes(
  registry: PluginRegistry,
  db: Database,
  providerRegistry?: ProviderRegistry,
  breaker?: AddonCircuitBreaker,
) {
  const app = new Hono<AuthEnv>();

  app.get('/', async (c) => c.json(await registry.list()));

  // The curated addon marketplace (issue #517). Readable by any authed user
  // like GET / — it only exposes the static catalog + each entry's install
  // state (diffed against the live registrations). The compose snippet is
  // rendered client-side from the entry (pure `renderComposeSnippet`); the
  // minted-token install flow is a separate admin route (PR2).
  app.get('/catalog', async (c) => {
    // Opening Extensions is the natural "did my container come up yet?" moment,
    // so promote any reachable pending installs before reporting state.
    await promotePendingAddons(registry, db, { providerRegistry, breaker }).catch(() => []);
    const registrations: CatalogRegistrationView[] = listAddonRegistrations(db).map((r) => ({
      id: r.id,
      status: r.status,
    }));
    const entries = ADDON_CATALOG.map((entry) => ({
      ...entry,
      state: catalogInstallState(entry, registrations) satisfies AddonCatalogInstallState,
    }));
    return c.json({ entries });
  });

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
        breaker,
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
    await removeAddon(registry, db, id, breaker);
    recordAudit(db, c.get('user'), 'addon.remove', { targetKind: 'addon', targetId: id });
    return c.json({ ok: true });
  });

  // Preview an addon's manifest without registering it (issue #517 PR3): the
  // "see what it is before you commit + consent" step for the from-URL flow.
  // Persists nothing. Admin-only (under the /:id/* guard, :id='addons').
  app.post('/addons/preview', async (c) => {
    let body: { url?: unknown; token?: unknown };
    try {
      body = await c.req.json<{ url?: unknown; token?: unknown }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!url) return c.json({ error: 'url is required' }, 400);
    try {
      const manifest = await previewAddonManifest(url, token);
      return c.json({ manifest });
    } catch (err) {
      if (err instanceof AddonRequestError || err instanceof AddonContractError) {
        return c.json({ error: `Addon not reachable: ${err.message}` }, 502);
      }
      return c.json({ error: err instanceof Error ? err.message : 'Preview failed' }, 400);
    }
  });

  // Install a catalog entry (issue #517 PR2): mint a token, write a `pending`
  // registration, and hand back the compose snippet with that token baked in.
  // The admin brings the container up; the promoter auto-activates it. Admin-
  // only (covered by the /:id/* guard, :id='catalog') + audited.
  app.post('/catalog/:id/install', (c) => {
    const entry = catalogEntry(c.req.param('id'));
    if (!entry) return c.json({ error: 'Unknown catalog addon' }, 404);
    if (entry.builtin) return c.json({ error: 'This addon is built-in — nothing to install' }, 400);
    try {
      const { token, reused } = createPendingRegistration(db, entry, c.get('user').sub);
      if (!reused) {
        recordAudit(db, c.get('user'), 'addon.install', {
          targetKind: 'addon',
          targetId: entry.id,
          detail: entry.addonUrl,
        });
      }
      const snippet = renderComposeSnippet(entry, token);
      return c.json({ token, addonUrl: entry.addonUrl, composeSnippet: snippet, reused }, 201);
    } catch (err) {
      // Already installed (active) is the only throw createPendingRegistration makes.
      return c.json({ error: err instanceof Error ? err.message : 'Install failed' }, 409);
    }
  });

  // Manual "Check now" — promote reachable pending installs on demand. Returns
  // this entry's fresh state so the card can flip to Installed immediately.
  app.post('/catalog/:id/check', async (c) => {
    const id = c.req.param('id');
    if (!catalogEntry(id)) return c.json({ error: 'Unknown catalog addon' }, 404);
    const promoted = await promotePendingAddons(registry, db, { providerRegistry, breaker });
    const reg = listAddonRegistrations(db).find((r) => r.id === id);
    const state: AddonCatalogInstallState = !reg
      ? 'available'
      : reg.status === 'pending'
        ? 'pending'
        : 'installed';
    return c.json({ state, promoted: promoted.includes(id) });
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
    breaker?.reset(id); // a re-enabled addon gets a fresh circuit-breaker slate
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
