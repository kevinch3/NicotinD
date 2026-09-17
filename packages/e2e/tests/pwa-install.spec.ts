import { test, expect, type Page } from '../helpers';
import { expandGroup } from '../helpers';

/**
 * In-app PWA install promotion (web.dev "promote-install"). Chromium decides on
 * its own when a page is installable and headless Playwright never fires
 * `beforeinstallprompt`, so the spec fires the event itself — through the real
 * listener `main.ts` attached before bootstrap — and proves the product side:
 * nothing is offered before the event, both surfaces appear after it, Install
 * calls `prompt()` on that very event, and "Not now" is remembered per device
 * across a reload while the Settings offer stays.
 */

/** A `beforeinstallprompt` whose `prompt()` is observable from the page. */
async function fireInstallPrompt(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __promptCalls: number };
    w.__promptCalls = 0;
    const e = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(e, {
      prompt: async () => {
        w.__promptCalls += 1;
      },
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    });
    window.dispatchEvent(e);
  });
}

test.describe('PWA install promotion', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('nicotind-install-promo-dismissed'));
  });

  test('offers nothing until the browser reports the app installable', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('mosaic-home')).toBeVisible();
    await expect(page.getByTestId('install-promo')).toHaveCount(0);

    await page.goto('/settings');
    await expandGroup(page, 'settings-account');
    await expect(page.getByTestId('settings-check-update')).toBeVisible();
    await expect(page.getByTestId('settings-install-app')).toHaveCount(0);
  });

  test('after beforeinstallprompt both surfaces appear and Install fires the captured prompt', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('mosaic-home')).toBeVisible();
    await fireInstallPrompt(page);

    const promo = page.getByTestId('install-promo');
    await expect(promo).toBeVisible();
    await expect(promo).toContainText(/Get the NicotinD app/);

    // In-app navigation keeps the SPA (and the captured event) alive.
    await gotoSettingsInApp(page);
    await expandGroup(page, 'settings-account');
    const row = page.getByTestId('settings-install-app');
    await expect(row).toBeVisible();
    await row.click();

    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __promptCalls: number }).__promptCalls),
      )
      .toBe(1);
    // The event is single-use: once prompted, every offer waits for a fresh one.
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId('install-promo')).toHaveCount(0);
  });

  test('Not now is remembered on this device, but the Settings offer stays', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('mosaic-home')).toBeVisible();
    await fireInstallPrompt(page);
    await expect(page.getByTestId('install-promo')).toBeVisible();

    await page.getByTestId('install-promo-dismiss').click();
    await expect(page.getByTestId('install-promo')).toHaveCount(0);
    expect(
      await page.evaluate(() => localStorage.getItem('nicotind-install-promo-dismissed')),
    ).toBe('1');

    // The captured event survives with the SPA; the dismissal survives a reload.
    await gotoSettingsInApp(page);
    await expandGroup(page, 'settings-account');
    await expect(page.getByTestId('settings-install-app')).toBeVisible();

    await page.reload();
    await expandGroup(page, 'settings-account');
    await fireInstallPrompt(page);
    // The row proves the fresh event was captured; the strip proves the refusal held.
    await expect(page.getByTestId('settings-install-app')).toBeVisible();
    await expect(page.getByTestId('install-promo')).toHaveCount(0);
  });
});

/** The desktop header nav (the `chromium` project is Desktop Chrome). */
async function gotoSettingsInApp(page: Page): Promise<void> {
  await page
    .getByTestId('desktop-nav')
    .getByRole('link', { name: /settings/i })
    .click();
  await expect(page).toHaveURL(/\/settings$/);
}
