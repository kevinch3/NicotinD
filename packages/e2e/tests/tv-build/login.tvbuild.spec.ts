/**
 * The TV sign-in screen on the real TV bundle (#1133).
 *
 * The phone card stacked to 606px in a 540px viewport, so "Use password
 * instead" sat below the fold with nothing to say it existed. The TV layout
 * is 16:9 — QR beside the code — and this pins it: nothing scrolls, and every
 * element a viewer needs is inside the viewport before any focus moves.
 */
import { test, expect, TV_VIEWPORT, expectFitsTheScreen } from './tv-test';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('TV login', () => {
  test('the sign-in card fits the screen — QR, code and both fallbacks in view', async ({
    page,
  }) => {
    await page.goto('/login');
    const panel = page.getByTestId('tv-login-panel');
    await expect(panel).toBeVisible();
    const qr = page.getByTestId('tv-login-qr');
    const code = page.getByTestId('tv-login-code');
    const usePassword = page.getByTestId('tv-login-use-password');
    await expect(qr).toBeVisible();
    // The <p> wraps the code in template whitespace; `toHaveText` keeps the
    // outer spaces, so anchor loosely.
    await expect(code).toHaveText(/^\s*[A-HJ-NP-Z2-9]{6}\s*$/);

    await expectFitsTheScreen(page, panel, qr, code, usePassword);
    // No scroll at all: a TV cuts off what does not fit rather than scrolling.
    const [scrollHeight, innerHeight] = await page.evaluate(() => [
      document.documentElement.scrollHeight,
      window.innerHeight,
    ]);
    expect(scrollHeight, 'the page must not be taller than the TV').toBeLessThanOrEqual(
      innerHeight,
    );
    expect(innerHeight).toBe(TV_VIEWPORT.height);
    // The QR keeps its size — it is read from the couch, not the sofa arm.
    expect((await qr.boundingBox())!.width).toBeGreaterThanOrEqual(180);

    // The code and the QR are minted per run; everything around them is not.
    await expect(page).toHaveScreenshot('login.png', { mask: [qr, code] });
  });

  test('the password fallback opens in view, at phone width inside the wide card', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByTestId('tv-login-use-password').click();
    const username = page.getByTestId('login-username');
    const submit = page.getByTestId('login-submit');
    await expect(username).toBeVisible();
    await expectFitsTheScreen(page, username, submit);
    expect((await username.boundingBox())!.width, 'inputs stay a form, not a banner').toBeLessThan(
      500,
    );
  });
});
