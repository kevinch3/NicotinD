/**
 * Profiles on a shared TV (#1406): the box knows several people and switches
 * between them from Home. Adding a person is the real QR flow, approved over
 * the API the way login-tv-signin.spec.ts does it.
 */
import { ADMIN, bearer } from '../../helpers';
import {
  test,
  expect,
  expectNoNativeFormControls,
  expectFitsTheScreen,
  tokenFor,
  approveOnScreen,
} from './tv-test';

const GUEST = { username: `e2e-guest-${Date.now()}`, password: 'e2e-guest-pass-123' };

test.describe('TV profiles', () => {
  test.beforeAll(async ({ request }) => {
    const admin = await tokenFor(request, ADMIN);
    const created = await request.post('/api/admin/users', {
      headers: bearer(admin),
      data: { username: GUEST.username, password: GUEST.password },
    });
    expect(created.ok(), 'admin creates the guest').toBeTruthy();
  });

  test('add a person, switch, sign out — the TV follows the active person', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('tv-status-user')).toHaveText(ADMIN.username);
    await page.getByTestId('tv-nav-profile').click();
    await expect(page).toHaveURL(/\/who$/);
    await expectNoNativeFormControls(page);
    const rows = page.getByTestId('tv-who-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('aria-current', 'true');
    await expect(page).toHaveScreenshot('who.png');

    // Add the guest through the real QR card.
    await page.getByTestId('tv-who-add').click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('tv-login-back-who')).toBeVisible();
    await approveOnScreen(page, request, GUEST);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('tv-status-user')).toHaveText(GUEST.username);

    // Both people known; switching back is one press.
    await page.getByTestId('tv-nav-profile').click();
    await expect(rows).toHaveCount(2);
    await expectFitsTheScreen(page, rows.first(), rows.nth(1), page.getByTestId('tv-who-add'));
    await page.locator(`[data-testid="tv-who-row"][data-username="${ADMIN.username}"]`).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('tv-status-user')).toHaveText(ADMIN.username);

    // Sign out of the admin: the guest is still here, so the TV becomes the guest.
    await page.goto('/settings');
    await expect(page.getByTestId('tv-settings-signout')).toContainText(ADMIN.username);
    await page.getByTestId('tv-settings-signout').click();
    await expect(page.getByTestId('tv-status-user')).toHaveText(GUEST.username);

    // Sign out of the last person: back to the QR, with nobody to go back to.
    await page.goto('/settings');
    await page.getByTestId('tv-settings-signout').click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('tv-login-back-who')).toHaveCount(0);
  });
});
