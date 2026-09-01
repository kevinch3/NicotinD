import { test, expect } from '@playwright/test';
import { ADMIN, bearer, expandGroup } from '../helpers';

/**
 * End-to-end proof that an admin changing a user's role **through the admin UI**
 * actually changes what that user sees. A freshly-created user starts as `user`
 * (acquisition visible); the admin demotes them to `listener` via the role
 * picker in the Role column; after the user reloads, the boot-time session refresh re-reads the
 * new role from the DB (see auth `/refresh`) and the Downloads acquisition
 * surface disappears from their view + its route bounces home.
 */
test.describe('admin role switching affects the user view', () => {
  const target = {
    username: `e2e-role-${Date.now()}`,
    password: 'e2e-role-pass-123',
  };

  const acquisitionNav = 'header nav a[href="/get"]';

  test('demoting a user to listener hides acquisition from their view', async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    // Admin creates a second user (defaults to role `user`) via the admin API.
    const login = await request.post('/api/auth/login', { data: ADMIN });
    expect(login.ok(), 'admin login should succeed').toBeTruthy();
    const adminToken = ((await login.json()) as { token: string }).token;
    const created = await request.post('/api/admin/users', {
      headers: bearer(adminToken),
      data: { username: target.username, password: target.password },
    });
    expect(created.ok(), 'admin should create the target user').toBeTruthy();

    // The target logs in (fresh context) and — as a `user` — sees Downloads.
    const userContext = await browser.newContext({
      baseURL: baseURL ?? undefined,
      storageState: { cookies: [], origins: [] },
    });
    const userPage = await userContext.newPage();
    await userPage.goto('/login');
    await userPage.getByTestId('login-username').fill(target.username);
    await userPage.getByTestId('login-password').fill(target.password);
    await userPage.getByTestId('login-submit').click();
    await expect(userPage.getByTestId('mosaic-home')).toBeVisible();
    await expect(userPage.locator(acquisitionNav)).toBeVisible();

    // Admin demotes them to `listener` through the role picker in the users
    // table, scoped to the target's row. Wait for the persist to land.
    await page.goto('/admin');
    // The users table lives inside the collapsible "User Management" settings
    // group, which starts collapsed by default — expand it first.
    await expandGroup(page, 'user-management');
    const row = page.locator('tr', { hasText: target.username });
    // The role control replaced the badge that used to duplicate it; the panel
    // renders inside the trigger's wrapper, so it stays inside this row.
    const roleTrigger = row.getByTestId('user-role-trigger');
    await expect(roleTrigger).toBeVisible();
    await roleTrigger.click();
    const [roleRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(`/role`) && r.request().method() === 'PUT' && r.ok(),
      ),
      row.getByTestId('user-role-option-listener').click(),
    ]);
    expect(roleRes.ok()).toBeTruthy();

    // After the user reloads, the boot refresh picks up the new role: the
    // acquisition workspace is gone from the nav and the route bounces back to
    // the radio landing.
    await userPage.reload();
    await expect(userPage.getByTestId('mosaic-home')).toBeVisible();
    await expect(userPage.locator(acquisitionNav)).toHaveCount(0);

    // Both the merged route and its legacy alias must bounce.
    await userPage.goto('/get');
    await expect(userPage).not.toHaveURL(/\/get/);
    await userPage.goto('/downloads');
    await expect(userPage).not.toHaveURL(/\/downloads/);
    await expect(userPage.getByTestId('mosaic-home')).toBeVisible();

    await userContext.close();
  });
});
