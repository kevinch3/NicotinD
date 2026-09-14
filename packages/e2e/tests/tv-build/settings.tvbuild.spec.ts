/**
 * Settings on the real TV bundle (#1136): a flat list of D-pad rows, and a
 * full-screen chooser where a phone would put a <select>.
 */
import { test, expect, expectNoNativeFormControls } from './tv-test';

test.describe('TV settings', () => {
  test('four rows, no form controls', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByTestId('tv-settings')).toBeVisible();
    for (const id of [
      'tv-settings-language',
      'tv-settings-remote',
      'tv-settings-server',
      'tv-settings-signout',
    ]) {
      await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 });
    }
    await expectNoNativeFormControls(page);
    await expect(page).toHaveScreenshot('settings.png');
  });

  test('a chooser replaces the native select, and names this TV', async ({ page }) => {
    await page.goto('/settings');
    await page.getByTestId('tv-settings-language').click();
    await expect(page.getByTestId('tv-chooser')).toBeVisible();
    await expect(page.getByTestId('tv-chooser-option').first()).toBeVisible();
    await expectNoNativeFormControls(page);
    await expect(page).toHaveScreenshot('settings-language.png');
    await page.getByTestId('tv-chooser-back').click();
    await expect(page.getByTestId('tv-chooser')).toHaveCount(0);

    await page.getByTestId('tv-settings-remote').click();
    await expect(page.getByTestId('tv-settings-device-name')).toContainText('NicotinD TV');
  });
});
