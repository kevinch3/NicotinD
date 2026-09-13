import { test, expect } from '@playwright/test';
import { expandGroup } from '../helpers';

/**
 * Manual PWA update check. The Settings → Account button renders only when the
 * Angular service worker is enabled — production browser builds, gated off in
 * dev, Capacitor, and Electron (see `serviceWorkerEnabled` / `checkAvailable`).
 *
 * The e2e harness boots `bun run src/main.ts`, which serves the **production**
 * `@nicotind/web` bundle (`ng build` defaults to the production configuration,
 * `serviceWorker: ngsw-config.json`) over http://localhost — where Chromium
 * permits service workers. So the SW is enabled and the control must be
 * VISIBLE, proving the `@if (update.checkAvailable())` gate resolves true in a
 * real PWA build.
 *
 * The click outcomes (up-to-date / available / error toasts, re-entrancy,
 * `applyUpdate` activation) are covered against a stubbed `SwUpdate` in
 * `update.service.spec.ts` and `settings.component.spec.ts`; driving the live
 * SW round-trip through Playwright would hinge on service-worker registration
 * timing (delayed up to 30 s when the app never stabilizes), which is more
 * flakiness than this assertion warrants.
 */
test.describe('PWA update check (manual)', () => {
  /**
   * The server half of #1126. Hono's `serveStatic` sends no freshness at all,
   * so `index.html` / `ngsw.json` / `ngsw-worker.js` were heuristically
   * cacheable — a browser pinning any of them strands an installed PWA on an
   * old build no amount of client-side checking can rescue.
   *
   * Asserted over the wire rather than against `cacheControlForStatic`, which
   * has its own unit tests: what matters here is that the middleware actually
   * runs for the paths the catch-all answers. The `request` fixture is
   * unauthenticated (docs/e2e.md), which is fine — these are public files.
   */
  test('the shell and the service-worker control files are served no-cache', async ({
    request,
  }) => {
    for (const path of ['/', '/index.html', '/ngsw.json', '/ngsw-worker.js']) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()['cache-control'], path).toBe('no-cache');
    }
  });

  test('a content-hashed bundle is immutable, so the revalidation is not paid twice', async ({
    page,
    request,
  }) => {
    await page.goto('/settings');
    const src = await page
      .locator('script[src^="main-"], script[src^="/main-"]')
      .first()
      .getAttribute('src');
    expect(src, 'the production build emits a hashed entry bundle').toBeTruthy();

    const res = await request.get(src!.startsWith('/') ? src! : `/${src!}`);

    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toContain('immutable');
  });

  test('shows the Check-for-updates control on the production e2e build (SW enabled)', async ({
    page,
  }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByText(/Account/i).first()).toBeVisible();
    // The Account & Devices card starts collapsed (settings-cards
    // unification task 2) — expand it to reach the update-check control.
    await expandGroup(page, 'settings-account');
    const button = page.getByTestId('settings-check-update');
    await expect(button).toBeVisible();
    await expect(button).toHaveText(/Check for updates/i);
  });
});
