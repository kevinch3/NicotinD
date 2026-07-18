import { test, expect } from '@playwright/test';

/**
 * Manual PWA update check. The Settings → Account button only renders when the
 * Angular service worker is enabled (production browser builds — gated off in
 * dev, Capacitor, and Electron). The e2e harness boots the dev server
 * (`bun run src/main.ts`), so the SW is disabled and the manual control should
 * be hidden — proving the gate works. The "SW check via SwUpdate stub" path
 * (button visible, all toast outcomes) is covered by `update.service.spec.ts`
 * and `settings.component.spec.ts`; driving it through Playwright would need a
 * production-build web server plus an in-page SwUpdate override, which is more
 * harness surface than this small fix warrants.
 */
test.describe('PWA update check (manual)', () => {
  test('hides the Check-for-updates control on the dev e2e server (SW disabled)', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByText(/Account/i).first()).toBeVisible();
    await expect(page.getByTestId('settings-check-update')).toHaveCount(0);
  });
});
