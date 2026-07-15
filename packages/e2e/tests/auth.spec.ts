import { test, expect } from '@playwright/test';
import { ADMIN } from '../helpers';

// Run unauthenticated — override the chromium project's saved admin storageState.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('auth', () => {
  test('rejects invalid credentials', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('login-username').fill(ADMIN.username);
    await page.getByTestId('login-password').fill('definitely-wrong');
    await page.getByTestId('login-submit').click();

    // A 401 trips the auth interceptor, which bounces back to /login. The user
    // stays unauthenticated — the app shell (search) must never appear.
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('login-submit')).toBeVisible();
    await expect(page.getByTestId('search-input')).toHaveCount(0);
  });

  test('logs in, lands in the app, and logs back out', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('login-username').fill(ADMIN.username);
    await page.getByTestId('login-password').fill(ADMIN.password);
    await page.getByTestId('login-submit').click();

    // The root route is the authenticated radio landing.
    await expect(page.getByTestId('radio-landing')).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);

    await page.getByTestId('logout').click();
    await expect(page).toHaveURL(/\/login/);
  });
});
