import { test, expect } from '@playwright/test';

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
  test('shows the Check-for-updates control on the production e2e build (SW enabled)', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByText(/Account/i).first()).toBeVisible();
    const button = page.getByTestId('settings-check-update');
    await expect(button).toBeVisible();
    await expect(button).toHaveText(/Check for updates/i);
  });
});
