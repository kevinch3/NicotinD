import { test, expect } from '@playwright/test';
import { ADMIN } from '../helpers';

/**
 * First-login welcome banner for admin-provisioned app users. Runs against the
 * seeded server (the admin from auth.setup.ts creates the new user), so it lives
 * in the chromium project rather than the onboarding wizard's fresh server.
 */
test.describe('welcome banner', () => {
  test('shown to a new user and dismissible', async ({ page, request }) => {
    const loginRes = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    const { token } = (await loginRes.json()) as { token: string };

    const userRes = await request.post('/api/admin/users', {
      data: { username: 'newuser', password: 'newuser-pass' },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(userRes.status()).toBe(201);

    await page.goto('/login');
    await page.getByTestId('login-username').fill('newuser');
    await page.getByTestId('login-password').fill('newuser-pass');
    await page.getByTestId('login-submit').click();

    await expect(page.getByText('Welcome!')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect(page.getByText('Welcome!')).toHaveCount(0);
  });
});
