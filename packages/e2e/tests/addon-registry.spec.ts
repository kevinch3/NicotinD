import { test, expect } from '@playwright/test';
import { ADMIN, bearer, expandGroup } from '../helpers';
import { startFixtureAddon, FIXTURE_ADDON_TOKEN, type FixtureAddon } from './helpers/fixture-addon';

/**
 * Phase 0 of the acquisition addon protocol (docs/acquisition-addon-protocol.md):
 * an admin registers a remote addon by URL + token and it behaves like a normal
 * extension — card, consent-gated enable, generic status panel — with zero
 * addon-specific UI code. The fixture addon runs in this worker process.
 */
test.describe('remote addon registry', () => {
  let addon: FixtureAddon;
  let auth: Record<string, string>;

  test.beforeAll(async ({ request }) => {
    addon = await startFixtureAddon();
    const login = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    expect(login.ok()).toBeTruthy();
    auth = bearer(((await login.json()) as { token: string }).token);
  });

  test.afterAll(async ({ request }) => {
    // Leave no registration behind — the suite must stay order-independent.
    await request.delete('/api/plugins/addons/fixture-addon', { headers: auth });
    await addon.close();
  });

  test('register → card with consent-gated enable + status panel → remove', async ({
    page,
    request,
  }) => {
    // Register via the API (the UI form is exercised by the web unit specs).
    const res = await request.post('/api/plugins/addons', {
      headers: auth,
      data: { url: addon.url, token: FIXTURE_ADDON_TOKEN },
    });
    expect(res.status()).toBe(201);

    // It lists as a remote acquisition plugin.
    const list = (await (await request.get('/api/plugins', { headers: auth })).json()) as Array<{
      id: string;
      remote?: boolean;
      addonUrl?: string;
    }>;
    const info = list.find((p) => p.id === 'fixture-addon');
    expect(info?.remote).toBe(true);
    expect(info?.addonUrl).toBe(addon.url);

    // The Extensions page renders it as a normal card.
    await page.goto('/settings/plugins');
    await expandGroup(page, 'plugins-acquisition');
    const card = page.locator('[data-testid="plugin-card"][data-plugin-id="fixture-addon"]');
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');

    // Enable — the fixture manifest requires consent, so the dialog is a
    // required step (same rule as the archive plugin spec).
    await card.getByTestId('plugin-toggle').click();
    await expect(page.getByTestId('confirm-ok')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Disable');

    // Expanding the card shows the generic status panel fed by the addon.
    await card.getByTestId('plugin-card-toggle').click();
    await expect(card.getByTestId('addon-url')).toHaveText(addon.url);
    const row = card.getByTestId('addon-status-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Peers');
    await expect(row).toContainText('42');

    // Remove via the card's Remove button (confirm dialog).
    await card.getByTestId('addon-remove').click();
    await expect(page.getByTestId('confirm-ok')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect(card).toHaveCount(0);

    // Fully gone server-side too.
    const after = (await (await request.get('/api/plugins', { headers: auth })).json()) as Array<{
      id: string;
    }>;
    expect(after.find((p) => p.id === 'fixture-addon')).toBeUndefined();
  });
});
