import { test, expect } from '../helpers';
import { ADMIN, bearer, expandGroup } from '../helpers';
import type { APIRequestContext, Browser, TestInfo } from '@playwright/test';

/**
 * Account security (docs/email-invitations.md, increments 2 and 5): an admin
 * hands someone a reset link instead of typing a password for them, a signed-in
 * user changes their own password — both end every other session — and a user
 * adds an email, which only lands on the account once the mailed link is opened.
 *
 * Each test owns a user with a unique name; nothing here touches the seeded
 * admin's password, which every other spec signs in with.
 */

async function adminToken(request: APIRequestContext): Promise<string> {
  const login = await request.post('/api/auth/login', { data: ADMIN });
  expect(login.ok(), 'admin login should succeed').toBeTruthy();
  return ((await login.json()) as { token: string }).token;
}

async function createUser(request: APIRequestContext, username: string, password: string) {
  const created = await request.post('/api/admin/users', {
    headers: bearer(await adminToken(request)),
    data: { username, password },
  });
  expect(created.ok(), 'admin should create the user').toBeTruthy();
}

async function login(request: APIRequestContext, username: string, password: string) {
  return request.post('/api/auth/login', { data: { username, password } });
}

async function strangerPage(browser: Browser, testInfo: TestInfo) {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  return { context, page: await context.newPage() };
}

test.describe('account security', () => {
  test('an admin reset link lets the user choose a new password and ends old sessions', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    const username = `e2e-reset-${Date.now()}`;
    await createUser(request, username, 'original-pass-1');
    const before = (await (await login(request, username, 'original-pass-1')).json()) as {
      token: string;
    };

    await page.goto('/admin');
    await expandGroup(page, 'user-management');
    const row = page.getByTestId('users-table').locator('tr', { hasText: username });
    await row.getByTestId('user-actions-toggle').click();
    await row.getByTestId('user-action-copy-reset').click();
    const linkInput = page.getByTestId('reset-link');
    await expect(linkInput).toHaveValue(/\/reset-password#t=[\w-]{20,}$/);
    const link = await linkInput.inputValue();

    const stranger = await strangerPage(browser, testInfo);
    try {
      await stranger.page.goto(link);
      await expect(stranger.page.getByTestId('reset-state')).toHaveAttribute('data-state', 'form');
      await expect(stranger.page.getByTestId('reset-username')).toContainText(username);
      await stranger.page.getByTestId('reset-password').fill('chosen-by-user-2');
      await stranger.page.getByTestId('reset-password-confirm').fill('chosen-by-user-2');
      await stranger.page.getByTestId('reset-submit').click();
      await expect(stranger.page).not.toHaveURL(/\/reset-password/);
      expect(await stranger.page.evaluate(() => localStorage.getItem('nicotind_username'))).toBe(
        username,
      );

      // The link is spent.
      await stranger.page.goto(link);
      await expect(stranger.page.getByTestId('reset-state')).toHaveAttribute('data-state', 'used');
    } finally {
      await stranger.context.close();
    }

    expect((await login(request, username, 'original-pass-1')).status()).toBe(401);
    expect((await login(request, username, 'chosen-by-user-2')).status()).toBe(200);
    const stale = await request.get('/api/auth/me', { headers: bearer(before.token) });
    expect(stale.status(), 'a session from before the reset must be over').toBe(401);
  });

  test('a user changes their own password from Settings → Account', async ({
    browser,
    request,
  }, testInfo) => {
    const username = `e2e-chpw-${Date.now()}`;
    await createUser(request, username, 'original-pass-1');
    const elsewhere = (await (await login(request, username, 'original-pass-1')).json()) as {
      token: string;
    };

    const user = await strangerPage(browser, testInfo);
    try {
      await user.page.goto('/login');
      await user.page.getByTestId('login-username').fill(username);
      await user.page.getByTestId('login-password').fill('original-pass-1');
      await user.page.getByTestId('login-submit').click();
      await expect(user.page).not.toHaveURL(/\/login/);

      await user.page.goto('/settings/account');
      await expandGroup(user.page, 'account-password');
      await user.page.getByTestId('account-current-password').fill('original-pass-1');
      await user.page.getByTestId('account-new-password').fill('changed-pass-22');
      await user.page.getByTestId('account-confirm-password').fill('changed-pass-22');
      await user.page.getByTestId('account-change-password').click();
      await expect(user.page.getByTestId('account-current-password')).toHaveValue('');

      // This browser kept its session through the change…
      await user.page.reload();
      await expect(user.page).toHaveURL(/\/settings\/account/);
    } finally {
      await user.context.close();
    }

    // …and every other one ended.
    const stale = await request.get('/api/auth/me', { headers: bearer(elsewhere.token) });
    expect(stale.status()).toBe(401);
    expect((await login(request, username, 'changed-pass-22')).status()).toBe(200);
  });

  // Increment 5: the address lands on the account only once the mailed link is opened.
  test('a user adds an email from Settings → Account and confirms it from the mailed link', async ({
    browser,
    request,
  }, testInfo) => {
    const stamp = Date.now();
    const username = `e2e-email-${stamp}`;
    const email = `e2e-verify-${stamp}@example.com`;
    await createUser(request, username, 'original-pass-1');

    const user = await strangerPage(browser, testInfo);
    try {
      await user.page.goto('/login');
      await user.page.getByTestId('login-username').fill(username);
      await user.page.getByTestId('login-password').fill('original-pass-1');
      await user.page.getByTestId('login-submit').click();
      await expect(user.page).not.toHaveURL(/\/login/);

      await user.page.goto('/settings/account');
      await expandGroup(user.page, 'account-email');
      const status = user.page.getByTestId('account-email-status');
      await expect(status).toHaveAttribute('data-status', 'none');

      // A wrong password changes nothing and signs nobody out.
      await user.page.getByTestId('account-email-input').fill(email);
      await user.page.getByTestId('account-email-password').fill('not-my-password');
      await user.page.getByTestId('account-email-save').click();
      await expect(user.page.getByTestId('account-email-error')).toBeVisible();
      await expect(user.page).toHaveURL(/\/settings\/account/);

      await user.page.getByTestId('account-email-password').fill('original-pass-1');
      await user.page.getByTestId('account-email-save').click();
      await expect(user.page.getByTestId('account-email-result')).toHaveAttribute(
        'data-result',
        'sent',
      );
      await expect(status).toHaveAttribute('data-status', 'pending');
      await expect(status).toContainText(email);

      const res = await request.get(`/api/admin/mail/outbox?to=${encodeURIComponent(email)}`, {
        headers: bearer(await adminToken(request)),
      });
      const { messages } = (await res.json()) as { messages: Array<{ text: string }> };
      expect(messages).toHaveLength(1);
      const link = messages[0]!.text.match(/https?:\/\/\S+\/verify-email#t=[\w-]+/)?.[0];
      expect(link, 'the mail carries a verification link').toBeTruthy();

      await user.page.goto(link!);
      await expect(user.page.getByTestId('verify-state')).toHaveAttribute('data-state', 'done');
      await expect(user.page.getByTestId('verify-email')).toContainText(email);
      await user.page.getByTestId('verify-continue').click();
      await expect(user.page).toHaveURL(/\/settings\/account/);
      await expandGroup(user.page, 'account-email');
      await expect(user.page.getByTestId('account-email-status')).toHaveAttribute(
        'data-status',
        'verified',
      );

      // The same link a second time says so.
      await user.page.goto(link!);
      await expect(user.page.getByTestId('verify-state')).toHaveAttribute('data-state', 'used');
    } finally {
      await user.context.close();
    }
  });
});
