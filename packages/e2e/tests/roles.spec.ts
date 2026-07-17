import { test, expect } from '@playwright/test';
import { ADMIN, bearer } from '../helpers';

/**
 * End-to-end proof that an admin changing a user's role **through the admin UI**
 * actually changes what that user sees. A freshly-created user starts as `user`
 * (acquisition visible); the admin demotes them to `listener` via the role
 * `<select>`; after the user reloads, the boot-time session refresh re-reads the
 * new role from the DB (see auth `/refresh`) and the Downloads acquisition
 * surface disappears from their view + its route bounces home.
 */
test.describe('admin role switching affects the user view', () => {
  const target = {
    username: `e2e-role-${Date.now()}`,
    password: 'e2e-role-pass-123',
  };

  const downloadsNav = 'header nav a[href="/downloads"]';

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
    await expect(userPage.getByTestId('radio-landing')).toBeVisible();
    await expect(userPage.locator(downloadsNav)).toBeVisible();

    // Admin demotes them to `listener` through the role <select> in the users
    // table, scoped to the target's row. Wait for the persist to land.
    await page.goto('/admin');
    const row = page.locator('tr', { hasText: target.username });
    const select = row.getByTestId('user-role-select');
    await expect(select).toBeVisible();
    const [roleRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(`/role`) && r.request().method() === 'PUT' && r.ok(),
      ),
      select.selectOption('listener'),
    ]);
    expect(roleRes.ok()).toBeTruthy();

    // After the user reloads, the boot refresh picks up the new role: Downloads
    // is gone from the nav and the route bounces back to the radio landing.
    await userPage.reload();
    await expect(userPage.getByTestId('radio-landing')).toBeVisible();
    await expect(userPage.locator(downloadsNav)).toHaveCount(0);

    await userPage.goto('/downloads');
    await expect(userPage).not.toHaveURL(/\/downloads/);
    await expect(userPage.getByTestId('radio-landing')).toBeVisible();

    await userContext.close();
  });
});
