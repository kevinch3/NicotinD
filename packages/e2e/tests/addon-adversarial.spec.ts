import { test, expect } from '@playwright/test';
import { ADMIN, bearer } from '../helpers';
import { startHostileAddon, HOSTILE_ADDON_TOKEN, type HostileAddon } from './helpers/hostile-addon';

/**
 * §4 adversarial fixture: a hostile addon must be rejected at registration and
 * core must stay healthy — the proof the trust boundary holds through the real
 * HTTP path (the size-cap / SSRF / ingest defenses are unit-tested at their
 * chokepoints). See docs/superpowers/specs/2026-08-13-addon-ecosystem-security-
 * contract-foundation-design.md §4.
 */
test.describe('hostile addon rejection', () => {
  let auth: Record<string, string>;
  const addons: HostileAddon[] = [];

  test.beforeAll(async ({ request }) => {
    const login = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    auth = bearer(((await login.json()) as { token: string }).token);
  });

  test.afterAll(async () => {
    await Promise.all(addons.map((a) => a.close()));
  });

  const baseManifest = {
    id: 'hostile-addon',
    name: 'Hostile',
    description: 'evil',
    version: '0.1.0',
    protocolVersion: '1.0.0',
    kind: 'acquisition',
    capabilities: ['search', 'download'],
    compliance: { disclaimer: 'x', requiresConsent: true },
  };

  async function tryRegister(
    request: import('@playwright/test').APIRequestContext,
    manifest: unknown,
  ) {
    const addon = await startHostileAddon(manifest);
    addons.push(addon);
    return request.post('/api/plugins/addons', {
      headers: auth,
      data: { url: addon.url, token: HOSTILE_ADDON_TOKEN },
    });
  }

  test('rejects an addon speaking an unsupported protocol major', async ({ request }) => {
    const res = await tryRegister(request, { ...baseManifest, protocolVersion: '2.0.0' });
    expect(res.status()).toBe(400);
  });

  test('rejects an addon declaring no capability this core can use', async ({ request }) => {
    // A metadata capability: core consumes acquisition caps from addons
    // (search/browse/download/resolve), not metadata ones, so this negotiates empty.
    const res = await tryRegister(request, {
      ...baseManifest,
      kind: 'metadata',
      capabilities: ['lyrics'],
    });
    expect(res.status()).toBe(400);
  });

  test('rejects a structurally malformed manifest', async ({ request }) => {
    const res = await tryRegister(request, { id: 'hostile-addon' /* missing everything else */ });
    expect(res.status()).toBe(400);
  });

  test('core stays healthy after rejecting hostile addons', async ({ request }) => {
    const health = await request.get('/api/health');
    expect(health.ok()).toBeTruthy();
    // None of the hostile addons leaked into the plugin registry.
    const list = (await (await request.get('/api/plugins', { headers: auth })).json()) as Array<{
      id: string;
    }>;
    expect(list.find((p) => p.id === 'hostile-addon')).toBeUndefined();
  });
});
