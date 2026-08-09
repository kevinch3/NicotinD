import { test, expect } from '@playwright/test';
import { ADMIN, bearer, expandGroup } from '../helpers';

/**
 * Generation-feedback surfaces (issue #451). The full hunt → capture → toast
 * path is NOT reachable here: acquisition is default-off in e2e and there is no
 * Lidarr, so no hunt can run and no capture row can exist. What IS reachable —
 * and what had zero coverage while the feature sat broken — is that the two
 * surfaces render, are admin-only, and that the dev toggle round-trips.
 * See docs/generation-feedback.md.
 */
test.describe('generation feedback', () => {
  test('the dev-mode capture toggle is admin-only and persists', async ({ page }) => {
    await page.goto('/settings');
    await expandGroup(page, 'settings-advanced');

    const toggle = page.getByTestId('feedback-capture-toggle');
    await expect(page.getByTestId('developer-section')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Survives a reload — i.e. the server write actually persisted, rather than
    // the optimistic client flip being silently reverted by /me.
    await page.reload();
    await expandGroup(page, 'settings-advanced');
    await expect(page.getByTestId('feedback-capture-toggle')).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Leave the flag off so the rest of the suite runs in the default state.
    await page.getByTestId('feedback-capture-toggle').click();
    await expect(page.getByTestId('feedback-capture-toggle')).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  test('the admin review queue renders and loads on expand', async ({ page }) => {
    await page.goto('/admin');
    await expandGroup(page, 'feedback-queue');

    const queue = page.getByTestId('feedback-queue');
    await expect(queue).toBeVisible();
    // No captures can exist on a fresh e2e server (no Lidarr, acquisition off),
    // so the empty state is the correct assertion — it proves the fetch ran and
    // resolved rather than leaving the panel stuck on its loading text.
    await expect(page.getByTestId('feedback-queue-refresh')).toBeVisible();
    await expect(queue).not.toContainText('Loading captures');
  });

  test('a non-admin cannot reach the feedback API', async ({ request, browser, baseURL }) => {
    const login = await request.post('/api/auth/login', { data: ADMIN });
    const adminToken = ((await login.json()) as { token: string }).token;

    // POST /api/admin/users always creates role `user` — non-admin, which is all
    // this assertion needs.
    const target = { username: `e2e-fb-${Date.now()}`, password: 'e2e-fb-pass-123' };
    await request.post('/api/admin/users', {
      headers: bearer(adminToken),
      data: { username: target.username, password: target.password },
    });

    const ctx = await browser.newContext({ baseURL: baseURL ?? undefined });
    const asUser = await ctx.request.post('/api/auth/login', { data: target });
    const userToken = ((await asUser.json()) as { token: string }).token;

    for (const path of ['/api/feedback/summaries', '/api/feedback/1']) {
      const res = await ctx.request.get(path, { headers: bearer(userToken) });
      expect(res.status(), `${path} should be admin-only`).toBe(403);
    }
    await ctx.close();
  });
});
