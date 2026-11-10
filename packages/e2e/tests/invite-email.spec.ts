import { test, expect } from '../helpers';
import { ADMIN, bearer, expandGroup } from '../helpers';
import type { APIRequestContext, Browser, TestInfo } from '@playwright/test';

/**
 * Emailed invites end to end (docs/email-invitations.md, increment 4). The e2e
 * server boots with `NICOTIND_MAIL_TRANSPORT=outbox`, so "sent" lands in
 * `mail_outbox`; the spec reads its own recipient back through the admin-only
 * `GET /api/admin/mail/outbox?to=`, follows the link from the message text in a
 * browser with no session, and checks the new account carries the address,
 * verified. The address and username are unique to this run: one server, one
 * DB and one outbox for every spec.
 */

async function strangerPage(browser: Browser, testInfo: TestInfo) {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  return { context, page: await context.newPage() };
}

/** The Playwright `request` fixture carries no session; the outbox is admin-only. */
async function adminToken(request: APIRequestContext): Promise<string> {
  const login = await request.post('/api/auth/login', { data: ADMIN });
  expect(login.ok(), 'admin login should succeed').toBeTruthy();
  return ((await login.json()) as { token: string }).token;
}

test.describe('email invites', () => {
  test('an invite sent by email is accepted from the mailed link and verifies the address', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    const stamp = Date.now();
    const email = `e2e-invite-${stamp}@example.com`;
    const username = `e2e-emailed-${stamp}`;

    await page.goto('/admin');
    await expandGroup(page, 'user-management');
    await page.getByTestId('invite-open').click();
    // Enabled once the card has read the mail status (outbox here, so "on").
    await page.getByTestId('invite-email-input').fill(email);
    await expect(page.getByTestId('invite-submit')).toHaveText(/send invite/i);
    await page.getByTestId('invite-submit').click();
    await expect(page.getByTestId('invite-sent')).toContainText(email);
    await page.getByTestId('invite-done').click();
    await expect(page.getByTestId('invite-row').filter({ hasText: email })).toHaveAttribute(
      'data-status',
      'pending',
    );

    const res = await request.get(`/api/admin/mail/outbox?to=${encodeURIComponent(email)}`, {
      headers: bearer(await adminToken(request)),
    });
    expect(res.ok()).toBeTruthy();
    const { messages } = (await res.json()) as { messages: Array<{ to: string; text: string }> };
    expect(messages).toHaveLength(1);
    const link = messages[0]!.text.match(/https?:\/\/\S+\/invite#t=[\w-]+/)?.[0];
    expect(link, 'the mail carries the invite link').toBeTruthy();

    const stranger = await strangerPage(browser, testInfo);
    try {
      await stranger.page.goto(link!);
      await expect(stranger.page.getByTestId('invite-state')).toHaveAttribute('data-state', 'form');
      await expect(stranger.page.getByTestId('invite-email')).toHaveValue(email);
      await stranger.page.getByTestId('invite-username').fill(username);
      await stranger.page.getByTestId('invite-password').fill('invitee-pass-123');
      await stranger.page.getByTestId('invite-password-confirm').fill('invitee-pass-123');
      await stranger.page.getByTestId('invite-accept-submit').click();
      await expect(stranger.page).not.toHaveURL(/\/invite/);
    } finally {
      await stranger.context.close();
    }

    await page.reload();
    await expandGroup(page, 'user-management');
    const row = page.getByTestId('users-table').locator('tr', { hasText: username });
    const shown = row.getByTestId('user-email');
    await expect(shown).toContainText(email);
    await expect(shown).toHaveAttribute('data-verified', 'true');
  });
});
