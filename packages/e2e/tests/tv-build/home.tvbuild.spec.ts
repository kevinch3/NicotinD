/**
 * The TV front door on the real TV bundle (#1135, #1136).
 *
 * Home is the one TV screen the Chromium suite had never rendered — the phone
 * bundle with a `tv-build` class mounts the radio landing inside the phone
 * layout, not `TvHomeComponent`. Its nav row used to sit at y≈614 on a 540px
 * screen; this pins it above the fold.
 */
import { test, expect, expectFitsTheScreen, expectNoNativeFormControls } from './tv-test';

test.describe('TV home', () => {
  test('the nav is the first thing on screen, above the shelves', async ({ page }) => {
    await page.goto('/');
    const home = page.getByTestId('tv-home');
    await expect(home).toBeVisible();
    const nav = page.getByTestId('tv-home-nav');
    const browse = page.getByTestId('tv-nav-browse');
    const settings = page.getByTestId('tv-nav-settings');
    await expect(page.getByTestId('radio-preset').first()).toBeVisible();

    await expectFitsTheScreen(page, nav, browse, settings);
    const navBox = (await nav.boundingBox())!;
    const shelves = (await page.getByTestId('radio-landing').boundingBox())!;
    expect(navBox.y, 'nav above the content, not below it').toBeLessThan(shelves.y);
    // Nothing is playing yet on this server, so no "Now playing" entry — the
    // player spec asserts the entry appears once something is.
    await expect(page.getByTestId('tv-nav-player')).toHaveCount(0);
    await expectNoNativeFormControls(page);

    // Home is built from listening state by design: Taste breakers are random
    // picks, Resume / Keep the vibe / Recently played follow play history, and
    // Tastemakers appears once the server has minted its curated playlists —
    // which, on a shared server, depends on how long it has been up (in the
    // full suite it had; alone it had not). The baseline is the front door's
    // own chrome — the nav and the vibe tiles — so the state-driven shelves are
    // hidden for the shot, after the layout assertions above ran against the
    // real page. Masking would not do: a shelf's presence moves what is below.
    await page.addStyleTag({
      content:
        'app-taste-breakers, app-tastemakers, app-keep-vibe, app-recently-played, ' +
        '[data-testid="radio-resume"] { display: none !important; }',
    });
    await expect(page).toHaveScreenshot('home.png');
  });

  test('the nav is a D-pad row: ◀ ▶ move between its entries', async ({ page }) => {
    await page.goto('/');
    const browse = page.getByTestId('tv-nav-browse');
    await browse.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('tv-nav-settings')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('tv-nav-profile')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(browse).toBeFocused();
  });
});
