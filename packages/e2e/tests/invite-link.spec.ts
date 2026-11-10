import { test, expect } from '../helpers';
import { ADMIN, bearer, expandGroup } from '../helpers';
import type { Browser, TestInfo } from '@playwright/test';

/**
 * Link invitations end to end (docs/email-invitations.md): an admin mints a
 * link in User Management, a stranger with no session opens it, creates their
 * account at the preset role and lands signed in; the spent link then says so.
 *
 * Every name is unique to this spec — one server, one DB, and the invites list
 * holds every other spec's leftovers too, so rows are found by their content.
 */

/** A browser with no stored session: the invitee has never been here. */
async function strangerPage(browser: Browser, testInfo: TestInfo) {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  return { context, page: await context.newPage() };
}

async function adminToken(request: import('@playwright/test').APIRequestContext) {
  const login = await request.post('/api/auth/login', { data: ADMIN });
  expect(login.ok(), 'admin login should succeed').toBeTruthy();
  return ((await login.json()) as { token: string }).token;
}

test.describe('invite links', () => {
  test('admin mints a link, a stranger joins at the preset role, the link is then spent', async ({
    page,
    browser,
  }, testInfo) => {
    const username = `e2e-invitee-${Date.now()}`;
    const note = `e2e invite ${Date.now()}`;

    await page.goto('/admin');
    await expandGroup(page, 'user-management');
    await page.getByTestId('invite-open').click();
    await page.getByTestId('invite-role-select').selectOption('listener');
    await page.getByTestId('invite-note-input').fill(note);
    await page.getByTestId('invite-submit').click();

    const linkInput = page.getByTestId('invite-link');
    await expect(linkInput).toHaveValue(/\/invite#t=[\w-]{20,}$/);
    const link = await linkInput.inputValue();
    // The e2e server is only reachable on loopback, so the card must say the
    // link won't work for a friend elsewhere rather than hand out a dead link.
    await expect(page.getByTestId('invite-local-only')).toBeVisible();
    await expect(page.getByTestId('invite-qr')).toBeVisible();
    await page.getByTestId('invite-done').click();

    const row = page.getByTestId('invite-row').filter({ hasText: note });
    await expect(row).toHaveAttribute('data-status', 'pending');

    const stranger = await strangerPage(browser, testInfo);
    try {
      await stranger.page.goto(link);
      await expect(stranger.page.getByTestId('invite-state')).toHaveAttribute('data-state', 'form');
      await expect(stranger.page.getByTestId('invite-summary')).toContainText(ADMIN.username);
      await stranger.page.getByTestId('invite-username').fill(username);
      await stranger.page.getByTestId('invite-password').fill('invitee-pass-123');
      await stranger.page.getByTestId('invite-password-confirm').fill('invitee-pass-123');
      await stranger.page.getByTestId('invite-accept-submit').click();

      await expect(stranger.page).not.toHaveURL(/\/invite/);
      const session = await stranger.page.evaluate(() => ({
        username: localStorage.getItem('nicotind_username'),
        role: localStorage.getItem('nicotind_role'),
      }));
      expect(session).toEqual({ username, role: 'listener' });

      // Same link, another fresh visitor: spent.
      const late = await strangerPage(browser, testInfo);
      try {
        await late.page.goto(link);
        await expect(late.page.getByTestId('invite-state')).toHaveAttribute('data-state', 'used');
      } finally {
        await late.context.close();
      }
    } finally {
      await stranger.context.close();
    }

    await page.reload();
    await expandGroup(page, 'user-management');
    const spent = page.getByTestId('invite-row').filter({ hasText: note });
    await expect(spent).toHaveAttribute('data-status', 'used');
    await expect(spent.getByTestId('invite-accepted-by')).toContainText(username);
    await expect(
      page.getByTestId('users-table').locator('tr', { hasText: username }),
    ).toContainText('listener');
  });

  test('a revoked link tells the visitor it is no longer valid', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    const token = await adminToken(request);
    const note = `e2e revoke ${Date.now()}`;
    const minted = await request.post('/api/admin/invites', {
      headers: bearer(token),
      data: { role: 'user', expiresInHours: 24, maxUses: 1, note },
    });
    expect(minted.status()).toBe(201);
    const { path } = (await minted.json()) as { path: string };

    await page.goto('/admin');
    await expandGroup(page, 'user-management');
    const row = page.getByTestId('invite-row').filter({ hasText: note });
    await row.getByTestId('invite-revoke').click();
    await page.getByTestId('confirm-ok').click();
    await expect(row).toHaveAttribute('data-status', 'revoked');

    const stranger = await strangerPage(browser, testInfo);
    try {
      await stranger.page.goto(path);
      await expect(stranger.page.getByTestId('invite-state')).toHaveAttribute(
        'data-state',
        'revoked',
      );
    } finally {
      await stranger.context.close();
    }
  });
});
