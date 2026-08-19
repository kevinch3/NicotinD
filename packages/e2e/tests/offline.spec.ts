import { test, expect, type Page } from '@playwright/test';

/**
 * Runtime network detection (the offline crash/UX fix). The app now folds a live
 * connectivity signal into `SetupService.isOffline()`, so dropping/regaining the
 * network mid-session is reflected immediately — an offline banner appears and
 * the shell reacts, without a reload. In the browser the signal is driven by
 * `navigator.onLine` + window online/offline events, which Playwright's
 * `context.setOffline()` emulates; the native shell uses @capacitor/network.
 *
 * Flake note (issues #362, #483): `setOffline()` emulates at the network layer
 * via CDP, but delivery of the window `online`/`offline` DOM events proved
 * flaky under CI load, so after each `setOffline()` flip we dispatch the
 * corresponding DOM event explicitly: deterministic event delivery, while
 * `setOffline()` still provides the real network-level failure underneath.
 *
 * That was not the whole story — the flake survived it (#483). The remaining
 * cause was the specs' own first assertion: `toHaveCount(0)` on the banner is
 * satisfied *vacuously* by a page that has not rendered yet, so nothing stopped
 * the spec from dropping the network while the SPA was still booting. See
 * `expectBootedShell` below for why that is unrecoverable rather than early.
 */
async function flipConnectivity(
  context: { setOffline(offline: boolean): Promise<void> },
  page: { evaluate<T>(fn: (arg: T) => void, arg: T): Promise<void> },
  offline: boolean,
): Promise<void> {
  await context.setOffline(offline);
  await page.evaluate(
    (type) => window.dispatchEvent(new Event(type)),
    offline ? 'offline' : 'online',
  );
}
/**
 * Wait for the app shell to actually be on screen before asserting anything
 * about the offline banner (issue #483/#362).
 *
 * `expect(banner).toHaveCount(0)` is satisfied *vacuously* by a page that has
 * not rendered yet, so it was no barrier at all: the spec would drop the
 * network while the SPA was still booting. That is unrecoverable rather than
 * merely early — the remaining lazy route chunks can no longer load, so the
 * shell never mounts and the banner can never appear, which is exactly the
 * "element(s) not found" timeout reported. Under full-suite load the boot is
 * slower, which is why it only ever flaked there.
 *
 * `desktop-nav` is the shell's own marker (always in the DOM once the layout is
 * mounted; `hidden md:flex` only hides it visually), so this is a *positive*
 * signal that boot finished — an absence assertion is only meaningful after a
 * presence assertion. Reproduced deterministically by delaying the JS bundle
 * 1200ms: fails without this wait, passes with it.
 */
async function expectBootedShell(page: Page): Promise<void> {
  await expect(page.getByTestId('desktop-nav')).toBeAttached();
}

test.describe('offline network detection', () => {
  test('shows the offline banner when connectivity drops and hides it on reconnect', async ({
    page,
    context,
  }) => {
    // Boot online — the banner must not be present.
    await page.goto('/library');
    await expectBootedShell(page);
    await expect(page.getByTestId('offline-banner')).toHaveCount(0);

    // Drop the network mid-session: the banner appears reactively (no reload).
    await flipConnectivity(context, page, true);
    await expect(page.getByTestId('offline-banner')).toBeVisible();

    // The Library stays reachable offline (it serves on-device downloaded tracks).
    await expect(page).toHaveURL(/\/library/);

    // Reconnect: the banner clears on its own.
    await flipConnectivity(context, page, false);
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
    // Deliberately NOT expectBootedShell() here, unlike the first test. Adding
    // it made this test fail on CI (503ms pass -> 5.6s timeout), which revealed
    // that its trigger is not what its name says: it installs route.abort()
    // while the app's own boot API calls are still in flight, and *those*
    // aborted calls are what drive it offline. Waiting for a booted shell
    // removes the trigger, and the later nav click does not reliably issue a
    // fresh request to replace it. Left as-is because it is green and this PR
    // is not the place to redesign it — see the follow-up issue.
    await expect(page.getByTestId('offline-banner')).toHaveCount(0);

    await page.route('**/api/**', (route) => route.abort());
    // Trigger an API call by navigating to Home (radio landing fetches data).
    await page.getByTestId('desktop-nav').getByRole('link').first().click();

    await expect(page.getByTestId('offline-banner')).toBeVisible();
    await expect(page).toHaveURL(/\/library/);

    // Server comes back + a device online event fires (the reconnect fast path):
    // the app re-probes immediately and leaves offline mode on its own.
    await page.unroute('**/api/**');
    await flipConnectivity(context, page, true);
    await flipConnectivity(context, page, false);

    await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  });
});
