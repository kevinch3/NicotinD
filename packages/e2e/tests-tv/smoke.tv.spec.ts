/**
 * Core journeys on real Android.
 *
 * Not here for the UI logic — Chromium covers that far faster. This targets the
 * WebView-only failure modes that a desktop run cannot reproduce: CORS through
 * `nativeAppCors()`, the service worker intercepting `/api/stream` when it must
 * not (`ngsw-bypass`), and audio actually decoding on the device.
 */
import { test, expect, goto, startPlayback } from '../tv/fixtures.js';

test.describe('smoke', () => {
  test('library loads over the reverse tunnel (CORS + auth)', async ({ page }) => {
    await goto(page, '/library');
    await expect(page.getByTestId('tv-album-card').first()).toBeVisible();
  });

  test('audio actually decodes and advances', async ({ page }) => {
    await startPlayback(page);

    // Verified during design: currentTime advances in real time even with the
    // emulator's `-no-audio` (no output device ≠ no decode), so this can assert
    // real progress rather than settling for "the request returned 206".
    const now = () =>
      page.evaluate(() => {
        const a = document.querySelector('audio') as HTMLAudioElement | null;
        return a ? a.currentTime : 0;
      });

    const first = await now();
    await expect.poll(now, { timeout: 15_000 }).toBeGreaterThan(first + 1);
    expect(await page.evaluate(() => document.querySelector('audio')?.paused)).toBe(false);
  });

  test('the stream request bypasses the service worker', async ({ page }) => {
    // A SW-intercepted stream is the Firefox "never plays" class of bug; on
    // Android it would surface as silent failure. `ngsw-bypass` must be on every
    // stream URL — assert the app builds it that way rather than trusting config.
    await startPlayback(page);
    const src = await page.evaluate(() => document.querySelector('audio')?.getAttribute('src'));
    expect(src, 'stream URL must carry ngsw-bypass').toContain('ngsw-bypass');
  });

  test('settings renders', async ({ page }) => {
    await goto(page, '/settings');
    // The TV settings screen is a flat list of D-pad rows — no collapsible
    // cards, no form controls (docs/tv-ux.md).
    await expect(page.getByTestId('tv-settings')).toBeVisible();
  });

  /**
   * Cover art must actually render, not fall back to the letter placeholder.
   *
   * `/api/cover/:id` is auth-gated, so a URL built without `&token=` 401s and
   * `CoverArtComponent` silently shows its gradient placeholder — which looks
   * deliberate. Every structural test still passed while every cover on the TV
   * surface was broken, because none of them looked at pixels. This one does.
   */
  test('cover art loads rather than falling back to the placeholder', async ({ page }) => {
    await goto(page, '/library');
    const card = page.getByTestId('tv-album-card').first();
    await card.waitFor({ state: 'visible' });

    const img = card.locator('img');
    await expect(img).toHaveCount(1);
    // naturalWidth > 0 is the only honest proof the bytes arrived and decoded.
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(await img.getAttribute('src')).toContain('token=');
  });
});
