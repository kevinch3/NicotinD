import { test, expect } from '@playwright/test';

/**
 * The post-login landing (route '') is the mosaic: an infinite pannable field of
 * tiles drawn from every landing source, where every tile starts a radio. The
 * shelf-based landing it replaced lives on at /classic.
 *
 * The pooled tiles inside the stage are created by the render loop, not by
 * Angular, and are recycled as they cross the lens — so anything order- or
 * timing-sensitive is asserted through the accessible list instead, which is a
 * plain Angular `@for` over the same tiles.
 */
test.describe('mosaic home', () => {
  test('renders the stage and packs tiles into it', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('mosaic-home')).toBeVisible();
    await expect(page.getByTestId('mosaic-stage')).toBeVisible();

    // The 8 vibe presets are unconditional, so the mosaic always has tiles even
    // on a library with no history and no curated playlists.
    const tiles = page.getByTestId('mosaic-tile');
    await expect(tiles.first()).toBeVisible({ timeout: 10_000 });

    const links = page.getByTestId('mosaic-tile-link');
    expect(await links.count()).toBeGreaterThanOrEqual(8);
  });

  test('the stage fills the viewport rather than sitting in a page column', async ({ page }) => {
    await page.goto('/');
    const stage = page.getByTestId('mosaic-stage');
    await expect(stage).toBeVisible();
    const box = await stage.boundingBox();
    const viewport = page.viewportSize()!;
    // Full-bleed: no page-shell width cap.
    expect(box!.width).toBeGreaterThan(viewport.width * 0.9);
  });

  test('tapping a song tile starts a radio', async ({ page }) => {
    await page.goto('/');
    // Song tiles come from the random-picks lane, so the fixture library always
    // has them — unlike the vibe tiles, whose filters need enrichment data the
    // silent-FLAC fixtures do not carry (see the next test).
    const song = page.locator('[data-testid="mosaic-tile-link"][data-tile-kind="song"]');
    await expect(song.first()).toBeAttached({ timeout: 10_000 });

    // The list is visually hidden (sr-only), so a normal click would fail
    // Playwright's visibility check. Dispatching is what a screen reader's
    // activation does anyway.
    await song.first().dispatchEvent('click');
    await expect(page.getByTestId('player-title')).not.toHaveText('', { timeout: 15_000 });
  });

  test('a vibe with no matching tracks says so instead of failing', async ({ page }) => {
    await page.goto('/');
    const vibe = page.locator('[data-testid="mosaic-tile-link"][data-tile-kind="vibe"]');
    await expect(vibe.first()).toBeAttached({ timeout: 10_000 });

    // The fixture library is silent FLACs with no mood/energy/bpm enrichment, so
    // every perceptual filter legitimately matches nothing. That path must
    // surface a neutral notice, never an error.
    await vibe.first().dispatchEvent('click');
    await expect(page.getByText('No tracks match that vibe yet')).toBeVisible({ timeout: 10_000 });
  });

  test('dragging the stage pans instead of starting a radio', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('mosaic-tile').first()).toBeVisible({ timeout: 10_000 });

    // Never assert an EMPTY player here: this suite shares one server and one
    // session, so an earlier spec's playback may still be loaded. What the drag
    // must not do is CHANGE what is playing.
    const title = page.getByTestId('player-title');
    const before = await title.textContent();

    const box = (await page.getByTestId('mosaic-stage').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // A drag that both starts and ends over the tile field. Without the
    // tap-slop test this pointerup would land on a tile and start a radio.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 120, cy - 80, { steps: 12 });
    await page.mouse.up();

    await page.waitForTimeout(750);
    expect(await title.textContent()).toBe(before);
  });

  test('the classic landing is still reachable', async ({ page }) => {
    await page.goto('/classic');
    await expect(page.getByTestId('radio-landing')).toBeVisible();
  });
});
