import { test, expect } from '@playwright/test';
import { ADMIN, bearer } from '../helpers';

// Device pairing (QR link): the Devices settings page mints a short-lived
// pairing code; claiming it (the phone's job — simulated here with a direct
// API call, no camera in CI) yields a device-bound JWT that shows up in the
// paired-device list and dies at refresh once revoked. CI has no tailscale, so
// the remote-access panel must degrade to its "not installed" guidance and the
// QR (which needs a phone-reachable URL) to its enable-remote-access hint.
test.describe('device pairing', () => {
  test('devices page mints a code and explains remote access', async ({ page }) => {
    await page.goto('/settings/devices');

    await expect(page.getByTestId('pairing-code')).toHaveText(/^[A-HJ-NP-Z2-9]{6}$/);
    // Browser origin is 127.0.0.1 (loopback) and no funnel exists in CI — the
    // QR placeholder prompts enabling remote access instead of a dead QR.
    await expect(page.getByTestId('link-device-qr-unavailable')).toBeVisible();
    // Admin remote-access panel renders the guided (not-installed) state.
    await expect(page.getByTestId('remote-access-state')).toContainText('Tailscale');
    await expect(page.getByTestId('devices-empty')).toBeVisible();
  });

  test('regenerate invalidates the previous code', async ({ page, request }) => {
    await page.goto('/settings/devices');
    const oldCode = await page.getByTestId('pairing-code').textContent();
    await page.getByTestId('pairing-regenerate').click();
    await expect(page.getByTestId('pairing-code')).not.toHaveText(oldCode!);

    const claim = await request.post('/api/devices/claim', {
      data: { code: oldCode, platform: 'android' },
    });
    expect(claim.status()).toBe(404);
  });

  test('claim → device listed → revoke → refresh 403s', async ({ page, request }) => {
    await page.goto('/settings/devices');
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
    await expect(page.getByTestId('device-row')).toContainText('CI phone');

    // The device JWT is a real session: refresh works…
    const refreshOk = await request.post('/api/auth/refresh', { headers: bearer(deviceJwt) });
    expect(refreshOk.ok()).toBeTruthy();

    // …until the device is revoked in the UI.
    await page.getByTestId('device-revoke').click();
    await expect(page.getByTestId('devices-empty')).toBeVisible();

    const refreshDead = await request.post('/api/auth/refresh', { headers: bearer(deviceJwt) });
    expect(refreshDead.status()).toBe(403);
  });
});
