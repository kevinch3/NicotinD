import { test, expect } from '@playwright/test';
import { ADMIN, bearer, deviceRow, expandGroup } from '../helpers';

// Device pairing (QR link): the Devices settings page mints a short-lived
// pairing code; claiming it (the phone's job — simulated here with a direct
// API call, no camera in CI) yields a device-bound JWT that shows up in the
// paired-device list and dies at refresh once revoked. CI has no tailscale, so
// the remote-access panel must degrade to its "not installed" guidance and the
// QR (which needs a phone-reachable URL) to its enable-remote-access hint.
test.describe('device pairing', () => {
  test('devices page mints a code and explains remote access', async ({ page }) => {
    await page.goto('/settings/devices');

    // Every settings-group card is collapsed by default, with no exception —
    // a pairing code is minted only once the Link device card is expanded.
    await expandGroup(page, 'devices-link');
    await expect(page.getByTestId('pairing-code')).toHaveText(/^[A-HJ-NP-Z2-9]{6}$/);
    // Browser origin is 127.0.0.1 (loopback) and no funnel exists in CI — the
    // QR placeholder prompts enabling remote access instead of a dead QR.
    await expect(page.getByTestId('link-device-qr-unavailable')).toBeVisible();
    // Admin remote-access panel renders a guided state. Which one depends on the
    // HOST, not on the app: CI has no tailscale binary ('not-installed'), while a
    // developer machine with Tailscale installed but no funnel renders the
    // ready-but-off state. Asserting the not-installed copy coupled this spec to
    // the *absence* of a host binary, so it passed in CI and failed on any dev box
    // with Tailscale installed — and gave zero coverage of the state most
    // self-hosters actually see.
    await expandGroup(page, 'devices-remote-access');
    await expect(page.getByTestId('remote-access-state')).toHaveText(
      /Tailscale|Remote access is off/,
    );
    await expandGroup(page, 'devices-paired');
    await expect(page.getByTestId('devices-empty')).toBeVisible();
  });

  test('regenerate invalidates the previous code', async ({ page, request }) => {
    await page.goto('/settings/devices');
    await expandGroup(page, 'devices-link');
    const oldCode = await page.getByTestId('pairing-code').textContent();
    await page.getByTestId('pairing-regenerate').click();
    await expect(page.getByTestId('pairing-code')).not.toHaveText(oldCode!);

    const claim = await request.post('/api/devices/claim', {
      data: { code: oldCode, platform: 'android' },
    });
    expect(claim.status()).toBe(404);
  });

  test('camera-app path: /pair link claims the token and signs the browser in', async ({
    page,
    request,
  }) => {
    // The QR encodes `<server>/pair#t=<token>` — simulate a camera-app scan by
    // navigating straight to it. Mint via the API (the page's token is never
    // shown in the UI); the request fixture is unauthenticated, so log in first.
    const login = await request.post('/api/auth/login', { data: ADMIN });
    expect(login.ok()).toBeTruthy();
    const { token: jwt } = (await login.json()) as { token: string };
    const mint = await request.post('/api/devices/pair', { headers: bearer(jwt) });
    expect(mint.ok()).toBeTruthy();
    const { token: pairingToken } = (await mint.json()) as { token: string };

    await page.goto(`/pair#t=${pairingToken}`);
    await expect(page.getByTestId('pair-done')).toContainText(ADMIN.username);
    await page.waitForURL('/');

    // The browser now holds a device-bound session: a browser row exists.
    await page.goto('/settings/devices');
    await expandGroup(page, 'devices-paired');
    // AT LEAST one, never exactly one. This device's label comes from the user
    // agent, so it is indistinguishable from a browser session another spec left
    // paired — CI has been observed with 2. Asserting a count here is the same
    // "I own this list" mistake as the bare locator it replaced.
    const browserRows = deviceRow(page, 'browser');
    await expect(browserRows.first()).toBeVisible();
    const before = await browserRows.count();
    // Revoke through a row and assert the list shrank by one. Not `devices-empty`:
    // emptiness is a claim about everyone else's devices.
    await browserRows.first().getByTestId('device-revoke').click();
    await expect(browserRows).toHaveCount(before - 1);
  });

  test('a used or stale /pair link fails soft with guidance', async ({ page }) => {
    await page.goto('/pair#t=not-a-real-token');
    await expect(page.getByTestId('pair-error')).toBeVisible();
    await page.goto('/pair');
    await expect(page.getByTestId('pair-error')).toContainText('incomplete');
  });

  test('claim → device listed → revoke → refresh 403s', async ({ page, request }) => {
    await page.goto('/settings/devices');
    await expandGroup(page, 'devices-link');
    const code = await page.getByTestId('pairing-code').textContent();

    // Simulate the phone: claim by code, unauthenticated.
    const claim = await request.post('/api/devices/claim', {
      data: { code, deviceName: 'CI phone', platform: 'android' },
    });
    expect(claim.ok()).toBeTruthy();
    const { token: deviceJwt, user } = (await claim.json()) as {
      token: string;
      user: { username: string };
    };
    expect(user.username).toBe(ADMIN.username);

    // The paired device appears in the list (page polls nothing — reload).
    await page.reload();
    await expandGroup(page, 'devices-paired');
    // At least one: a retried attempt of this same test leaves its own
    // 'CI phone' behind, so the count is not this spec's to pin either.
    const phoneRows = deviceRow(page, 'CI phone');
    await expect(phoneRows.first()).toBeVisible();
    const phonesBefore = await phoneRows.count();

    // The device JWT is a real session: refresh works…
    const refreshOk = await request.post('/api/auth/refresh', { headers: bearer(deviceJwt) });
    expect(refreshOk.ok()).toBeTruthy();

    // …until the device is revoked in the UI. Revoke EVERY 'CI phone' row, not
    // just the first: this test goes on to assert that *its* JWT is dead, and
    // with a retry's leftover in the list there is no ordering guarantee about
    // which row is ours. Clearing them all makes the 403 below unambiguous.
    for (let n = phonesBefore; n > 0; n--) {
      await phoneRows.first().getByTestId('device-revoke').click();
      await expect(phoneRows).toHaveCount(n - 1);
    }

    const refreshDead = await request.post('/api/auth/refresh', { headers: bearer(deviceJwt) });
    expect(refreshDead.status()).toBe(403);
  });
});
