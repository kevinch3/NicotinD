import { test, expect } from '@playwright/test';
import { ADMIN } from '../helpers';

test.describe('onboarding', () => {
  test('full setup wizard completes all steps', async ({ page }) => {
    await page.goto('/setup');
    await expect(page.getByTestId('setup-username')).toBeVisible();

    await page.getByTestId('setup-username').fill('wizard-admin');
    await page.getByTestId('setup-password').fill('wizard-password-123');
    await page.getByTestId('setup-submit').click();

    await expect(page.getByPlaceholder('Music directory')).toBeVisible();
    await page.getByPlaceholder('Music directory').fill('~/Music');
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByText('Streaming Quality')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByText('Soulseek Network')).toBeVisible();
    await page.getByTestId('setup-soulseek-next').click();

    await expect(page.getByText('Setup Complete')).toBeVisible();
    await page.getByTestId('setup-done').click();

    await expect(page.getByTestId('search-input')).toBeVisible();
  });

  test('full setup wizard with advanced Lidarr panel', async ({ page }) => {
    await page.goto('/setup');
    await page.getByTestId('setup-username').fill('wizard-lidarr');
    await page.getByTestId('setup-password').fill('wizard-password-123');
    await page.getByTestId('setup-submit').click();

    await page.getByPlaceholder('Music directory').fill('/data/music');
    await page.getByRole('button', { name: 'Next' }).click();

    await page.getByRole('button', { name: 'Next' }).click();

    await expect(page.getByText('Advanced Services')).toBeVisible();
    await page.getByText('Advanced Services').click();
    await expect(page.getByPlaceholder('Lidarr URL')).toBeVisible();
    await page.getByPlaceholder('Lidarr URL').fill('http://localhost:8686');

    await page.getByTestId('setup-soulseek-next').click();
    await expect(page.getByText('Setup Complete')).toBeVisible();
    await expect(page.getByText('Lidarr will be available after restarting NicotinD.')).toBeVisible();
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

    await expect(page.getByText('Welcome!')).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect(page.getByText('Welcome!')).toHaveCount(0);
  });
});
