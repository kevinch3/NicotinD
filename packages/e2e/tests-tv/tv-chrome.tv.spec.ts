/**
 * TV surfaces that only exist on a real device.
 *
 * Hardware Back (#394, `BackHandlerStack`) is the headline: Chromium has no Back
 * key at all, so this behaviour has never had automated coverage anywhere. The
 * rest re-tests what `now-playing-tv.spec.ts` approximates by stamping the
 * `tv-build` class onto the desktop bundle — here it's the real TV bundle on a
 * real TV device, so a build-configuration regression is visible too.
 */
import { test, expect, goto, startPlayback, APP_ORIGIN } from '../tv/fixtures.js';
import type { Page } from '@playwright/test';

/** Vertical offset of the Now Playing sheet: on-screen vs pushed below. */
const sheetTop = (page: Page) =>
  page.evaluate(() => {
    const b = document.querySelector('[data-testid="now-playing-body"]');
    return b ? Math.round(b.getBoundingClientRect().top) : null;
  });

test.describe('TV chrome', () => {
  test('runs the tv build configuration', async ({ page }) => {
    await goto(page, '/library');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.className))
      .toContain('tv-build');
  });

  test('the mini-player notch is focusable and DPAD_CENTER expands Now Playing', async ({
    page,
    dpad,
  }) => {
    await startPlayback(page);
    const grab = page.getByTestId('player-grab');
    await expect(grab).toHaveAttribute('role', 'button');
    await expect(grab).toHaveAttribute('tabindex', '0');

    await grab.focus();
    const before = await sheetTop(page);
    await dpad('CENTER');
    await expect.poll(() => sheetTop(page)).toBeLessThan(before!);
  });

  test('DPAD_UP from the transport reaches the notch (spatial navigation)', async ({
    page,
    dpad,
    focusId,
  }) => {
    await startPlayback(page);
    // Nothing in the player bar is a vertical nav group, so only the WebView's
    // spatial navigation can make this move — the behaviour desktop Chrome lacks
    // entirely, and the reason this lane exists.
    await page.evaluate(() =>
      (document.querySelector('app-player-transport-mini button') as HTMLElement).focus(),
    );
    await dpad('UP');
    expect(await focusId()).toBe('player-grab');
  });

  test('hardware Back closes Now Playing instead of exiting the app', async ({ page, dpad }) => {
    await startPlayback(page);
    await page.getByTestId('player-grab').focus();
    await dpad('CENTER');
    await expect.poll(() => sheetTop(page)).toBeLessThan(100);

    await dpad('BACK');

    // The sheet is dismissed…
    await expect.poll(() => sheetTop(page)).toBeGreaterThan(400);
    // …and the app is still alive on its own origin (issue #394: Back used to
    // exit the app rather than navigate in-app).
    expect(page.url()).toContain(APP_ORIGIN);
  });
});
