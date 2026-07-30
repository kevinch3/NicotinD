import { test, expect } from '@playwright/test';

/**
 * Runtime network detection (the offline crash/UX fix). The app now folds a live
 * connectivity signal into `SetupService.isOffline()`, so dropping/regaining the
 * network mid-session is reflected immediately — an offline banner appears and
 * the shell reacts, without a reload. In the browser the signal is driven by
 * `navigator.onLine` + window online/offline events, which Playwright's
 * `context.setOffline()` emulates; the native shell uses @capacitor/network.
 */
test.describe('offline network detection', () => {
  test('shows the offline banner when connectivity drops and hides it on reconnect', async ({
    page,
    context,
  }) => {
    // Boot online — the banner must not be present.
    await page.goto('/library');
    await expect(page.getByTestId('offline-banner')).toHaveCount(0);

    // Drop the network mid-session: the banner appears reactively (no reload).
    await context.setOffline(true);
    await expect(page.getByTestId('offline-banner')).toBeVisible();

    // The Library stays reachable offline (it serves on-device downloaded tracks).
    await expect(page).toHaveURL(/\/library/);

    // Reconnect: the banner clears on its own.
    await context.setOffline(false);
    await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  });

  test('boots into a usable Library when the server is unreachable at launch', async ({ page }) => {
    // The crash scenario, browser analog: the native app bundles its assets (so
    // they load offline) but the API is unreachable. Block only /api/** so the
    // SPA loads while every backend call fails — the boot must still land on a
    // usable Library with the offline banner, not hang on a blank screen.
    await page.route('**/api/**', (route) => route.abort());

    await page.goto('/library');

    await expect(page.getByTestId('offline-banner')).toBeVisible();
    await expect(page).toHaveURL(/\/library/);
  });

  test('switches into offline mode by itself when the server dies mid-session, and recovers', async ({
    page,
    context,
  }) => {
    // Mid-session server loss: the device network stays up (navigator.onLine is
    // true throughout) but the API stops answering. The next API call fails at
    // the network level → the interceptor reports it → SetupService verifies
    // with a probe → the app flips itself into offline mode: banner shown and
    // the shell redirected to the offline-capable Library. No reload involved.
    await page.goto('/library');
    await expect(page.getByTestId('offline-banner')).toHaveCount(0);

    await page.route('**/api/**', (route) => route.abort());
    // Trigger an API call by navigating to Home (radio landing fetches data).
    await page.getByTestId('desktop-nav').getByRole('link').first().click();

    await expect(page.getByTestId('offline-banner')).toBeVisible();
    await expect(page).toHaveURL(/\/library/);

    // Server comes back + a device online event fires (the reconnect fast path):
    // the app re-probes immediately and leaves offline mode on its own.
    await page.unroute('**/api/**');
    await context.setOffline(true);
    await context.setOffline(false);

    await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  });
});
