import { test, expect } from '../helpers';
import { ADMIN, bearer, expandGroup } from '../helpers';
import type { APIRequestContext, Browser, TestInfo } from '@playwright/test';

/**
 * *Assign email…* end to end (docs/email-invitations.md, "Admin: assign an
 * email"). An admin gives an existing account an address from the users table;
 * the e2e server's outbox catches the confirmation mail; the link is opened in a
 * browser with no session (the owner's inbox, not the admin's session, proves
 * it); the row then shows the address verified. Names are unique to this run:
 * one server, one DB and one outbox for every spec.
 */

async function strangerPage(browser: Browser, testInfo: TestInfo) {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  return { context, page: await context.newPage() };
}

/** The Playwright `request` fixture carries no session; these routes are admin-only. */
async function adminToken(request: APIRequestContext): Promise<string> {
  const login = await request.post('/api/auth/login', { data: ADMIN });
  expect(login.ok(), 'admin login should succeed').toBeTruthy();
  return ((await login.json()) as { token: string }).token;
}

test.describe('assign email', () => {
  test('an admin assigns an address; it is pending until the mailed link is opened', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    const stamp = Date.now();
    const username = `e2e-assign-${stamp}`;
    const email = `e2e-assign-${stamp}@example.com`;
    const token = await adminToken(request);
    const created = await request.post('/api/admin/users', {
      headers: bearer(token),
      data: { username, password: 'assignee-pass-123' },
    });
    expect(created.ok(), 'the account to assign to exists').toBeTruthy();

    await page.goto('/admin');
    await expandGroup(page, 'user-management');
    const row = page.getByTestId('users-table').locator('tr', { hasText: username });
    await row.getByTestId('user-actions-toggle').click();
    await page.getByTestId('user-action-assign-email').click();
    await page.getByTestId('assign-email-input').fill(email);
    await page.getByTestId('assign-email-submit').click();
    await expect(page.getByTestId('assign-email-dialog')).toHaveCount(0);
    await expect(row.getByTestId('user-email-pending')).toContainText(email);
    await expect(row.getByTestId('user-email')).toHaveCount(0);

    const res = await request.get(`/api/admin/mail/outbox?to=${encodeURIComponent(email)}`, {
      headers: bearer(token),
    });
    const { messages } = (await res.json()) as { messages: Array<{ text: string }> };
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('added this address to your account');
    const link = messages[0]!.text.match(/https?:\/\/\S+\/verify-email#t=[\w-]+/)?.[0];
    expect(link, 'the mail carries the confirmation link').toBeTruthy();

    const owner = await strangerPage(browser, testInfo);
    try {
      await owner.page.goto(link!);
      await expect(owner.page.getByTestId('verify-state')).toHaveAttribute('data-state', 'done');
    } finally {
      await owner.context.close();
    }

    await page.reload();
    await expandGroup(page, 'user-management');
    const shown = row.getByTestId('user-email');
    await expect(shown).toContainText(email);
    await expect(shown).toHaveAttribute('data-verified', 'true');
    await expect(row.getByTestId('user-email-pending')).toHaveCount(0);
  });
});
