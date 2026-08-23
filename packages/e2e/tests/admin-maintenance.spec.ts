import { test, expect } from '@playwright/test';
import { ADMIN, bearer, expandGroup } from '../helpers';

/**
 * The maintenance panel after issue #622 turned the whole-library passes into
 * background jobs.
 *
 * Lidarr isn't in the e2e harness, so the pass itself can't run; what matters
 * here is the DOM contract the change introduced — a new `maintenance-cancel`
 * button, a progress block driven by the shared ServiceReview poll, and a
 * start button whose disabled logic now comes from that slice rather than a
 * local signal. Those are exactly the selectors a UI change can silently break.
 */
test.describe('admin maintenance passes', () => {
  test('Stop ships alongside Start and is disabled while nothing runs', async ({ page }) => {
    await page.goto('/admin');
    await expandGroup(page, 'library-maintenance');

    await expect(page.getByTestId('optimize-all-metadata')).toBeVisible();
    const stop = page.getByTestId('maintenance-cancel');
    await expect(stop).toBeVisible();
    await expect(stop).toBeDisabled();
    // Nothing is running, so no progress block is rendered.
    await expect(page.getByTestId('maintenance-progress')).toHaveCount(0);
  });

  test('a running pass renders progress and flips both buttons', async ({ page }) => {
    // Stub the shared review poll so the panel sees a pass in flight. The pass
    // is server state, so this is the only way to reach the running UI without
    // a configured Lidarr.
    await page.route('**/api/admin/review', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      body.maintenance = {
        phase: 'running',
        taskId: 'metadata-optimize',
        label: 'Optimize metadata',
        total: 10,
        visited: 4,
        lastItems: ['Aphex Twin — Drukqs'],
        detail: {},
        dryRun: false,
        params: 'apply',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        lastOutcome: null,
        lastError: null,
        startedBy: 'admin',
      };
      await route.fulfill({ response: res, json: body });
    });

    await page.goto('/admin');
    await expandGroup(page, 'library-maintenance');

    const progress = page.getByTestId('maintenance-progress');
    await expect(progress).toBeVisible();
    await expect(progress).toContainText('4 / 10');
    await expect(progress).toContainText('Aphex Twin — Drukqs');

    // Start is blocked while a pass runs; Stop becomes available.
    await expect(page.getByTestId('optimize-all-metadata')).toBeDisabled();
    await expect(page.getByTestId('maintenance-cancel')).toBeEnabled();
  });

  test('the start endpoint answers immediately rather than holding the request', async ({
    request,
  }) => {
    // The `request` fixture carries no session, so authenticate explicitly.
    const login = await request.post('/api/auth/login', { data: ADMIN });
    expect(login.ok(), 'admin login should succeed').toBeTruthy();
    const token = ((await login.json()) as { token: string }).token;

    // The defect was a handler that ran for minutes. Without Lidarr the task
    // reports itself unavailable, but either way the answer must be instant and
    // must never be a 200 carrying a finished result.
    const started = Date.now();
    const res = await request.post('/api/admin/maintenance/metadata-optimize', {
      headers: bearer(token),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect([202, 503]).toContain(res.status());
  });
});
