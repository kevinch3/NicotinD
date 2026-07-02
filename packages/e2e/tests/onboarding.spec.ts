import { test, expect } from '@playwright/test';
import { ADMIN } from '../helpers';

test.describe('onboarding', () => {
  test('full setup wizard completes all steps', async ({ page }) => {
    await page.goto('/setup');
    await expect(page.getByTestId('setup-username')).toBeVisible();

    await page.getByTestId('setup-username').fill('wizard-admin');
    await page.getByTestId('setup-password').fill('wizard-password-123');
    await page.getByTestId('setup-submit').click();

    await expect(page.getByTestId('setup-music-dir')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('setup-music-dir').fill('~/Music');
    await page.getByTestId('setup-next-library').click();

    await expect(page.getByText('Streaming Quality')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('setup-next-quality').click();

    await expect(page.getByText('Soulseek Network')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('setup-soulseek-next').click();

    await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('setup-done').click();

    await expect(page.getByTestId('search-input')).toBeVisible({ timeout: 10000 });
  });

  test('full setup wizard with advanced Lidarr panel', async ({ page }) => {
    test.setTimeout(60000);
    await page.goto('/setup');
    await page.getByTestId('setup-username').fill('wizard-lidarr');
    await page.getByTestId('setup-password').fill('wizard-password-123');
    await page.getByTestId('setup-submit').click();

    await expect(page.getByTestId('setup-music-dir')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('setup-music-dir').fill('/data/music');
    await page.getByTestId('setup-next-library').click();

    await expect(page.getByText('Streaming Quality')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('setup-next-quality').click();

    await expect(page.getByText('Advanced Services')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('setup-soulseek-next').click();

    await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 30000 });
  });

  test('welcome banner shown to new user and dismissible', async ({ page, request }) => {
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
