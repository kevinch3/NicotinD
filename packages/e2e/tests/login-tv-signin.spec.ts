/**
 * TV sign-in via phone approval — flow-cohesion deliverable #1. The TV login
 * screen (tv-build stamped, TV viewport) shows a QR + 6-char code and polls;
 * the "phone" here is the API with the admin's bearer approving the code, and
 * the TV lands signed in with no typing. Also covers the API loop alone and
 * the /approve page UI. Named to sort before offline.spec.ts (#372 blast
 * radius).
 */
import { test, expect } from '@playwright/test';
import { ADMIN, bearer } from '../helpers';

const TV_VIEWPORT = { width: 960, height: 540 };

async function adminToken(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { token: string }).token;
}

test.describe('TV sign-in API loop', () => {
  test('request → pending → approve → claim yields a session', async ({ request }) => {
    const minted = (await (
      await request.post('/api/devices/login-request', {
        data: { deviceName: 'E2E TV', platform: 'android' },
      })
    ).json()) as { token: string; code: string };

    const pending = await request.post('/api/devices/login-claim', {
      data: { token: minted.token },
    });
    expect(pending.status()).toBe(202);

    const token = await adminToken(request);
    const approved = await request.post('/api/devices/login-approve', {
      headers: bearer(token),
      data: { code: minted.code },
    });
    expect(approved.ok()).toBeTruthy();

    const claimed = await request.post('/api/devices/login-claim', {
      data: { token: minted.token },
    });
    expect(claimed.status()).toBe(200);
    const body = (await claimed.json()) as { token: string; user: { username: string } };
    expect(body.user.username).toBe(ADMIN.username);

    // Cleanup: revoke the paired device this test created.
    const devices = (await (
      await request.get('/api/devices', { headers: bearer(token) })
    ).json()) as { devices: Array<{ id: string; name: string }> };
    for (const device of devices.devices.filter((d) => d.name === 'E2E TV')) {
      await request.delete(`/api/devices/${device.id}`, { headers: bearer(token) });
    }
  });
});

test.describe('TV login screen (tv-build)', () => {
  test.use({ viewport: TV_VIEWPORT, storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const stamp = () => document.documentElement?.classList.add('tv-build');
      stamp();
      document.addEventListener('readystatechange', stamp);
      new MutationObserver(stamp).observe(document, { childList: true });
    });
  });

  test('shows QR + code, and an API-side approval signs the TV in without typing', async ({
    page,
    request,
  }) => {
    await page.goto('/login');
    await expect(page.getByTestId('tv-login-panel')).toBeVisible();
    await expect(page.getByTestId('tv-login-qr')).toBeVisible();
    const code = (await page.getByTestId('tv-login-code').textContent())?.trim() ?? '';
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

    // The "phone": approve the displayed code via the API.
    const token = await adminToken(request);
    const approved = await request.post('/api/devices/login-approve', {
      headers: bearer(token),
      data: { code },
    });
    expect(approved.ok()).toBeTruthy();

    // The TV's poll picks the approval up and lands signed in at home.
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(page.getByTestId('logout')).toBeVisible();
  });

  test('the password fallback stays reachable', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByTestId('tv-login-panel')).toBeVisible();
    await page.getByTestId('tv-login-use-password').click();
    await expect(page.getByTestId('login-username')).toBeVisible();
  });
});

test.describe('/approve page (the phone side)', () => {
  test('renders the code from the fragment and approves it', async ({ page, request }) => {
    const minted = (await (
      await request.post('/api/devices/login-request', {
        data: { deviceName: 'E2E TV 2', platform: 'android' },
      })
    ).json()) as { token: string; code: string };

    await page.goto(`/approve#c=${minted.code}`);
    await expect(page.getByTestId('approve-code')).toHaveText(minted.code);
    await page.getByTestId('approve-confirm').click();
    await expect(page.getByTestId('approve-done')).toContainText('E2E TV 2');

    // The TV-side claim now completes.
    const claimed = await request.post('/api/devices/login-claim', {
      data: { token: minted.token },
    });
    expect(claimed.status()).toBe(200);
  });
});
