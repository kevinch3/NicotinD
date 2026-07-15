import { test, expect } from '@playwright/test';

/**
 * Setup wizard (self-hoster first run). Runs in the `onboarding` project against
 * a dedicated, never-seeded server (see playwright.config.ts) so `needsSetup` is
 * true. Completing the wizard creates the first admin — which can only happen
 * once per server, so this is a single end-to-end pass that also exercises the
 * optional Advanced/Lidarr panel. The basic (no-Lidarr) path and per-field
 * validation are covered by setup.test.ts + setup.component.spec.ts.
 */
test.describe('onboarding', () => {
  test('full setup wizard completes all steps and lands in the app', async ({ page }) => {
    test.setTimeout(60000);
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('requestfailed', (req) =>
      errors.push(`FAILED ${req.method()} ${req.url()} - ${req.failure()?.errorText}`),
    );

    await page.goto('/setup');

    // Step 1 — Admin account
    await expect(page.getByTestId('setup-username')).toBeVisible();
    await page.getByTestId('setup-username').fill('wizard-admin');
    await page.getByTestId('setup-password').fill('wizard-password-123');
    await page.getByTestId('setup-submit').click();

    // Step 2 — Library
    await expect(page.getByTestId('setup-music-dir')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('setup-music-dir').fill('/data/music');
    await page.getByTestId('setup-next-library').click();

    // Step 3 — Quality
    await expect(page.getByText('Streaming Quality')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('setup-next-quality').click();

    // Step 4 — Soulseek + Advanced (Lidarr) panel
    await expect(page.getByText('Soulseek Network')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('setup-advanced-toggle').click();
    await expect(page.getByTestId('setup-lidarr-url')).toBeVisible();
    await page.getByTestId('setup-lidarr-url').fill('http://127.0.0.1:1');
    await page.getByTestId('setup-lidarr-apikey').fill('wizard-lidarr-key');
    await page.getByTestId('setup-soulseek-next').click();

    // Done — completion succeeds even though the (dead) Lidarr is unreachable.
    await expect(page.getByTestId('setup-done')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('setup-done').click();

    // Reloads authenticated and lands in the app (radio landing at root).
    await expect(page.getByTestId('radio-landing')).toBeVisible({ timeout: 10000 });

    if (errors.length) console.log('Browser errors:', errors);
  });
});
