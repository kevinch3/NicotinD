import { test, expect } from '@playwright/test';
import { ADMIN, bearer, expandGroup } from '../helpers';

/**
 * The Admin users table, after it was consolidated from eight columns (four of
 * which were `hidden sm:table-cell`) down to five that always render.
 *
 * `roles.spec.ts` already covers the role picker end-to-end; this file covers
 * the parts that had no UI coverage at all — the ⋯ menu, delete through the
 * shared confirm host, the Activity column, and the narrow-viewport contract
 * that motivated the change.
 */
test.describe('admin user management table', () => {
  const target = {
    username: `e2e-users-${Date.now()}`,
    password: 'e2e-users-pass-123',
  };

  test.beforeAll(async ({ request }) => {
    const login = await request.post('/api/auth/login', { data: ADMIN });
    expect(login.ok(), 'admin login should succeed').toBeTruthy();
    const token = ((await login.json()) as { token: string }).token;
    const created = await request.post('/api/admin/users', {
      headers: bearer(token),
      data: { username: target.username, password: target.password },
    });
    expect(created.ok(), 'admin should create the target user').toBeTruthy();
  });

  test('renders five columns with nothing hidden on a narrow viewport', async ({ page }) => {
    // The whole point of the change: on a phone the admin used to lose Online,
    // Devices, Sessions and Joined — exactly the data they came to look at.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin');
    await expandGroup(page, 'user-management');

    const table = page.getByTestId('users-table');
    await expect(table.locator('thead th')).toHaveCount(5);

    const row = table.locator('tr', { hasText: target.username });
    for (const cell of await row.locator('td').all()) {
      await expect(cell).toBeVisible();
    }
    // And the page itself must not scroll sideways to achieve that.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows, 'the page should not scroll horizontally at 390px').toBe(false);
  });

  test('the Activity column reports a never-connected user and the live admin', async ({
    page,
  }) => {
    await page.goto('/admin');
    await expandGroup(page, 'user-management');
    const table = page.getByTestId('users-table');

    // The target was created over the API and has never signed in.
    await expect(
      table.locator('tr', { hasText: target.username }).getByTestId('user-activity'),
    ).toContainText('Never');

    // The admin driving this browser is heartbeating, so presence wins.
    await expect(
      table.locator('tr', { hasText: ADMIN.username }).getByTestId('user-activity'),
    ).toContainText('Online');
  });

  test('your own row offers no role control and no destructive actions', async ({ page }) => {
    await page.goto('/admin');
    await expandGroup(page, 'user-management');
    const ownRow = page.getByTestId('users-table').locator('tr', { hasText: ADMIN.username });

    await expect(ownRow.getByTestId('user-role-static')).toBeVisible();
    await expect(ownRow.getByTestId('user-role-trigger')).toHaveCount(0);

    await ownRow.getByTestId('user-actions-toggle').click();
    await expect(ownRow.getByTestId('user-action-status')).toBeDisabled();
    await expect(ownRow.getByTestId('user-action-delete')).toBeDisabled();
  });

  test('the ⋯ menu disables and re-enables an account', async ({ page }) => {
    await page.goto('/admin');
    await expandGroup(page, 'user-management');
    const row = page.getByTestId('users-table').locator('tr', { hasText: target.username });

    for (const expected of ['disabled', 'active']) {
      await row.getByTestId('user-actions-toggle').click();
      await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes('/status') && r.request().method() === 'PUT' && r.ok(),
        ),
        row.getByTestId('user-action-status').click(),
      ]);
      await expect(row).toContainText(expected);
    }
  });

  test('delete goes through the shared confirm host', async ({ page }) => {
    await page.goto('/admin');
    await expandGroup(page, 'user-management');
    const table = page.getByTestId('users-table');
    const row = table.locator('tr', { hasText: target.username });

    // Cancelling must leave the row alone — this replaced a hand-rolled modal,
    // so the cancel path is worth pinning, not just the happy one.
    await row.getByTestId('user-actions-toggle').click();
    await row.getByTestId('user-action-delete').click();
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-cancel').click();
    await expect(row).toBeVisible();

    await row.getByTestId('user-actions-toggle').click();
    await row.getByTestId('user-action-delete').click();
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/admin/users/') && r.request().method() === 'DELETE' && r.ok(),
      ),
      page.getByTestId('confirm-ok').click(),
    ]);
    await expect(table.locator('tr', { hasText: target.username })).toHaveCount(0);
  });
});
