import { test, expect } from '../helpers';
import { ADMIN, bearer, expandGroup } from '../helpers';
import type { APIRequestContext, Browser, Page, TestInfo } from '@playwright/test';

/**
 * Self-service password recovery end to end (docs/email-invitations.md,
 * increment 5). The admin turns "Forgot password?" on in the Email delivery
 * card — its own switch, so it works while `NICOTIND_MAIL_TRANSPORT=outbox`
 * pins the rest of the card. A user confirms an email through the real
 * Settings → Account flow (link read from the outbox), then asks for a reset
 * by username: the page says exactly the same thing for them and for a name
 * that does not exist, and the outbox holds one reset mail — for them.
 *
 * One server and DB for every spec: names and addresses are unique to this
 * run, nothing asserts a global count, and recovery is switched back off after
 * the test so the login page other specs see is unchanged.
 */

async function adminToken(request: APIRequestContext): Promise<string> {
  const login = await request.post('/api/auth/login', { data: ADMIN });
  expect(login.ok(), 'admin login should succeed').toBeTruthy();
  return ((await login.json()) as { token: string }).token;
}

async function strangerPage(browser: Browser, testInfo: TestInfo) {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  return { context, page: await context.newPage() };
}

type OutboxMessage = { to: string; subject: string; text: string };

async function outbox(request: APIRequestContext, to: string): Promise<OutboxMessage[]> {
  const res = await request.get(`/api/admin/mail/outbox?to=${encodeURIComponent(to)}`, {
    headers: bearer(await adminToken(request)),
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { messages: OutboxMessage[] }).messages;
}

const linkIn = (text: string, path: string) =>
  text.match(new RegExp(`https?://\\S+${path}#t=[\\w-]+`))?.[0] ?? null;

async function signIn(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe('forgot password', () => {
  test.afterEach(async ({ request }) => {
    // Whatever happened above, leave the login page as every other spec expects it.
    const res = await request.put('/api/admin/mail/recovery', {
      headers: bearer(await adminToken(request)),
      data: { enabled: false },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('the same confirmation for a real and an unknown user, and one reset mail for the real one', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    const stamp = Date.now();
    const username = `e2e-forgot-${stamp}`;
    const email = `e2e-forgot-${stamp}@example.com`;

    // The admin turns recovery on in the (env-locked) Email delivery card.
    await page.goto('/admin');
    await expandGroup(page, 'email-delivery');
    await expect(page.getByTestId('email-env-locked')).toBeVisible();
    const toggle = page.getByTestId('recovery-toggle');
    await expect(toggle).toBeEnabled();
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/api/admin/mail/recovery') && r.request().method() === 'PUT',
    );
    // click, not check(): the handler hands the box back to the model until the
    // server answers, so its state flips on the response, not on the click.
    await toggle.click();
    expect((await saved).ok()).toBeTruthy();
    await expect(toggle).toBeChecked();

    const created = await request.post('/api/admin/users', {
      headers: bearer(await adminToken(request)),
      data: { username, password: 'original-pass-1' },
    });
    expect(created.ok()).toBeTruthy();

    // The user confirms an address through Settings → Account.
    const user = await strangerPage(browser, testInfo);
    try {
      await signIn(user.page, username, 'original-pass-1');
      await user.page.goto('/settings/account');
      await expandGroup(user.page, 'account-email');
      await user.page.getByTestId('account-email-input').fill(email);
      await user.page.getByTestId('account-email-password').fill('original-pass-1');
      await user.page.getByTestId('account-email-save').click();
      await expect(user.page.getByTestId('account-email-result')).toHaveAttribute(
        'data-result',
        'sent',
      );
      const verify = linkIn((await outbox(request, email))[0]!.text, '/verify-email');
      expect(verify, 'the verification mail carries a link').toBeTruthy();
      await user.page.goto(verify!);
      await expect(user.page.getByTestId('verify-state')).toHaveAttribute('data-state', 'done');
    } finally {
      await user.context.close();
    }

    // Signed out, on the login page: the link is there, and leads to the form.
    const visitor = await strangerPage(browser, testInfo);
    try {
      await visitor.page.goto('/login');
      await visitor.page.getByTestId('login-forgot-link').click();
      await expect(visitor.page).toHaveURL(/\/forgot-password/);

      const ask = async (identifier: string) => {
        await expect(visitor.page.getByTestId('forgot-state')).toHaveAttribute(
          'data-state',
          'form',
        );
        await visitor.page.getByTestId('forgot-identifier').fill(identifier);
        await visitor.page.getByTestId('forgot-submit').click();
        const sent = visitor.page.getByTestId('forgot-sent');
        await expect(sent).toBeVisible();
        return sent.innerText();
      };
      const forReal = await ask(username);
      await visitor.page.getByTestId('forgot-again').click();
      const forNobody = await ask(`e2e-nobody-${stamp}`);
      expect(forNobody).toBe(forReal);
      expect(forReal).toContain('expires in 30 minutes');

      // The send runs after the response; wait for it to land.
      const resets = async () =>
        (await outbox(request, email)).filter((m) => /reset your password/i.test(m.subject));
      await expect.poll(async () => (await resets()).length).toBe(1);
      const reset = linkIn((await resets())[0]!.text, '/reset-password');
      expect(reset, 'the reset mail carries a link').toBeTruthy();

      await visitor.page.goto(reset!);
      await expect(visitor.page.getByTestId('reset-state')).toHaveAttribute('data-state', 'form');
      await visitor.page.getByTestId('reset-password').fill('recovered-pass-2');
      await visitor.page.getByTestId('reset-password-confirm').fill('recovered-pass-2');
      await visitor.page.getByTestId('reset-submit').click();
      await expect(visitor.page).not.toHaveURL(/\/reset-password/);
    } finally {
      await visitor.context.close();
    }

    const old = await request.post('/api/auth/login', {
      data: { username, password: 'original-pass-1' },
    });
    expect(old.status()).toBe(401);
    const fresh = await request.post('/api/auth/login', {
      data: { username, password: 'recovered-pass-2' },
    });
    expect(fresh.status()).toBe(200);
    // And the "password changed" notice reached the verified address.
    await expect
      .poll(async () => (await outbox(request, email)).some((m) => /was changed/i.test(m.subject)))
      .toBe(true);
  });

  test('with recovery off, the login page and /forgot-password say to ask the admin', async ({
    browser,
  }, testInfo) => {
    const visitor = await strangerPage(browser, testInfo);
    try {
      await visitor.page.goto('/login');
      await expect(visitor.page.getByTestId('login-forgot-ask-admin')).toBeVisible();
      await expect(visitor.page.getByTestId('login-forgot-link')).toHaveCount(0);
      await visitor.page.goto('/forgot-password');
      await expect(visitor.page.getByTestId('forgot-disabled')).toBeVisible();
    } finally {
      await visitor.context.close();
    }
  });
});
