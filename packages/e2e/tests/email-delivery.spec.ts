import { test, expect } from '../helpers';
import { ADMIN, bearer, expandGroup } from '../helpers';

/**
 * Email delivery end to end (docs/email-invitations.md, increment 3). The e2e
 * server boots with `NICOTIND_MAIL_TRANSPORT=outbox`, so the card is env-locked
 * and a "sent" message lands in `mail_outbox`, which the admin-only
 * `GET /api/admin/mail/outbox?to=` reads back. The recipient is unique to this
 * run: the outbox is shared with every other spec on the server.
 */

async function adminToken(request: import('@playwright/test').APIRequestContext) {
  const login = await request.post('/api/auth/login', { data: ADMIN });
  expect(login.ok(), 'admin login should succeed').toBeTruthy();
  return ((await login.json()) as { token: string }).token;
}

test.describe('email delivery', () => {
  test('the env-pinned card sends a test email into the outbox, with a link to the server', async ({
    page,
    request,
  }, testInfo) => {
    const to = `e2e-mail-${Date.now()}@example.com`;
    const origin = new URL(testInfo.project.use.baseURL!).origin;

    await page.goto('/admin');
    await expandGroup(page, 'email-delivery');

    // NICOTIND_MAIL_TRANSPORT pins the whole block: read-only, no Save.
    await expect(page.getByTestId('email-env-locked')).toBeVisible();
    await expect(page.getByTestId('email-transport-select')).toBeDisabled();
    await expect(page.getByTestId('email-transport-select')).toHaveValue('outbox');
    await expect(page.getByTestId('email-cap-input')).toBeDisabled();
    await expect(page.getByTestId('email-save')).toHaveCount(0);
    await expect(page.getByTestId('email-quota')).toBeVisible();
    // Only loopback is known to the e2e server, and the card says so.
    await expect(page.getByTestId('email-link-base')).not.toHaveAttribute('data-base', /./);

    await page.getByTestId('email-test-to').fill(to);
    const sent = page.waitForResponse(
      (r) => r.url().endsWith('/api/admin/mail/test') && r.request().method() === 'POST',
    );
    await page.getByTestId('email-test-send').click();
    expect((await sent).ok()).toBeTruthy();
    await expect(page.getByTestId('email-test-result')).toHaveAttribute('data-ok', 'true');

    const token = await adminToken(request);
    const res = await request.get(`/api/admin/mail/outbox?to=${encodeURIComponent(to)}`, {
      headers: bearer(token),
    });
    expect(res.ok()).toBeTruthy();
    const { messages } = (await res.json()) as {
      messages: Array<{ to: string; subject: string; text: string; html: string }>;
    };
    expect(messages).toHaveLength(1);
    expect(messages[0]!.to).toBe(to);
    // With no public URL or Funnel, the link base falls back to the origin the
    // admin's browser used — the link in the mail is that base.
    expect(messages[0]!.text).toContain(`${origin}/`);
    expect(messages[0]!.html).toContain(`href="${origin}/"`);
  });

  test('the outbox is admin-only', async ({ request }) => {
    const anonymous = await request.get('/api/admin/mail/outbox');
    expect(anonymous.status()).toBe(401);
  });
});
