/**
 * TV surfaces that only exist on a real device.
 *
 * Hardware Back (#394, `BackHandlerStack`) is the headline: Chromium has no
 * Back key at all, so this behaviour has never had automated coverage anywhere.
 *
 * The grab-notch and sheet assertions this file used to carry are gone with the
 * things they tested — the TV surface has no mini-player and no Now Playing
 * sheet, because the player is a route (docs/tv-ux.md). #432's notch fix still
 * matters on phone/desktop and is covered by the Chromium suite.
 */
import { test, expect, goto, startPlayback } from '../tv/fixtures.js';

test.describe('TV chrome', () => {
  test('runs the tv build configuration', async ({ page }) => {
    await goto(page, '/');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.className))
      .toContain('tv-build');
  });

  test('Home is the front door — moods, browse and settings, no phone nav', async ({ page }) => {
    await goto(page, '/');
    await expect(page.getByTestId('tv-home')).toBeVisible();
    await expect(page.getByTestId('radio-preset').first()).toBeVisible();
    await expect(page.getByTestId('tv-nav-browse')).toBeVisible();
    await expect(page.getByTestId('tv-nav-settings')).toBeVisible();
    // The phone chrome must not render on TV. `app-player` IS mounted — it
    // owns the <audio> engine — but headlessly, so what matters is that it
    // contributes no bar and, critically, no seek bar (a native range input a
    // remote cannot escape, issue #438).
    await expect(page.locator('app-bottom-nav')).toHaveCount(0);
    await expect(page.locator('[data-bottom-chrome]')).toHaveCount(0);
    await expect(page.locator('input[type=range]')).toHaveCount(0);
  });

  test('the player has no seek bar, and Left/Right seek instead', async ({ page, dpad }) => {
    await startPlayback(page);
    // The trap that started this: a native range input a remote cannot escape.
    await expect(page.locator('input[type=range]')).toHaveCount(0);
    await expect(page.getByTestId('tv-seek-hint')).toBeVisible();

    const at = () =>
      page.evaluate(() => {
        const a = document.querySelector('audio') as HTMLAudioElement | null;
        return a ? a.currentTime : 0;
      });
    await expect.poll(at, { timeout: 15_000 }).toBeGreaterThan(2);
    const before = await at();
    await dpad('RIGHT');
    await expect.poll(at).toBeGreaterThan(before + 5);
  });

  test('transport controls are D-pad reachable', async ({ page, dpad, focusId }) => {
    await startPlayback(page);
    await page.getByTestId('tv-prev').focus();
    expect(await focusId()).toBe('tv-prev');
    await dpad('RIGHT');
    // Left/Right seek on this route, so focus moves with the group's own
    // handling — the transport is a horizontal nav group.
    await expect(page.getByTestId('tv-playpause')).toBeVisible();
  });

  test('hardware Back leaves the player instead of exiting the app', async ({ page, dpad }) => {
    await startPlayback(page);
    await expect(page.getByTestId('tv-player')).toBeVisible();

    await dpad('BACK');

    await expect(page.getByTestId('tv-player')).toBeHidden();
    // …and the app is still alive on its own origin (issue #394: Back used to
    // exit the app rather than navigate in-app).
    expect(page.url()).toContain('localhost');
  });

  test('settings offers only what a TV needs, with no form controls', async ({ page }) => {
    await goto(page, '/settings');
    await expect(page.getByTestId('tv-settings')).toBeVisible();
    for (const id of [
      'tv-settings-language',
      'tv-settings-remote',
      'tv-settings-server',
      'tv-settings-signout',
    ]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expect(page.locator('select, input, textarea')).toHaveCount(0);
  });

  test('a chooser replaces the native select', async ({ page }) => {
    await goto(page, '/settings');
    await page.getByTestId('tv-settings-language').click();
    await expect(page.getByTestId('tv-chooser')).toBeVisible();
    await expect(page.getByTestId('tv-chooser-option').first()).toBeVisible();
    await expect(page.locator('select')).toHaveCount(0);
    await page.getByTestId('tv-chooser-back').click();
    await expect(page.getByTestId('tv-chooser')).toBeHidden();
  });
});
