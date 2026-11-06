import { test, expect } from '../helpers';

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
    // The rim blur is drawn at rest and stands down mid-pan (#1638): measured,
    // re-blurring a moving field every frame quadrupled a weak GPU's drops.
    const rim = page.getByTestId('mosaic-rim');
    await expect(rim).toHaveCSS('visibility', 'visible');

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 120, cy - 80, { steps: 12 });
    await expect(page.getByTestId('mosaic-stage')).toHaveClass(/is-moving/);
    await expect(rim).toHaveCSS('visibility', 'hidden');
    await page.mouse.up();

    await page.waitForTimeout(750);
    expect(await title.textContent()).toBe(before);
    // The coast comes to rest, and the blur comes back.
    await expect(page.getByTestId('mosaic-stage')).not.toHaveClass(/is-moving/, { timeout: 5_000 });
    await expect(rim).toHaveCSS('visibility', 'visible');
  });

  test('holding a song tile opens its menu instead of starting a radio, and Song info is in it', async ({
    page,
  }) => {
    await page.goto('/');
    const tiles = page.locator('[data-testid="mosaic-tile"][data-tile-kind="song"]');
    await expect(tiles.first()).toBeVisible({ timeout: 10_000 });

    // Same shared-session rule as the drag test: assert the playback did not
    // CHANGE, never that it is empty.
    const title = page.getByTestId('player-title');
    const before = await title.textContent();

    // Inertia snaps to a dead stop and there is no idle drift, so a resting
    // pooled tile is a stable press target. Pick one fully inside the viewport
    // — .first() can be a rim tile whose centre sits off screen — whose centre
    // actually hit-tests to the tile: the Shelves | Mosaic switch overlays the
    // stage's corner, and a 700 ms press on it flipped the user's persisted
    // home view, failing every later spec that expects the mosaic (#1351).
    const viewport = page.viewportSize()!;
    const boxes = await tiles.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          hitsTile: hit?.closest('[data-testid="mosaic-tile"]') === el,
        };
      }),
    );
    const box = boxes.find(
      (b) =>
        b.hitsTile &&
        b.x > 0 &&
        b.y > 0 &&
        b.x + b.w < viewport.width &&
        b.y + b.h < viewport.height,
    )!;
    expect(box).toBeDefined();

    await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
    await page.mouse.down();
    await page.waitForTimeout(700); // past the 450ms hold threshold
    await page.mouse.up();

    await expect(page.getByTestId('entity-menu')).toBeVisible({ timeout: 10_000 });
    // The release that follows the hold must not have started a radio.
    expect(await title.textContent()).toBe(before);
    // The held tile is lifted above a veiled field while its menu is open (#1638).
    const held = page.locator('[data-testid="mosaic-tile"].is-held');
    await expect(held).toHaveCount(1);
    await expect(page.getByTestId('mosaic-home')).toHaveClass(/mosaic-holding/);
    // The old hold-for-info is now an item of the same menu (#1298).
    await page.getByTestId('entity-action-Song info').click();
    await expect(page.getByTestId('track-info-sheet')).toBeVisible({ timeout: 10_000 });
    // Running an item closes the menu, and that lets the tile down.
    await expect(held).toHaveCount(0);
    await expect(page.getByTestId('mosaic-home')).not.toHaveClass(/mosaic-holding/);
  });

  test('the classic landing is still reachable', async ({ page }) => {
    await page.goto('/classic');
    await expect(page.getByTestId('radio-landing')).toBeVisible();
  });
});

test.describe('mosaic home on a phone', () => {
  test.use({ viewport: { width: 390, height: 780 } });

  test('the top bar yields to the mosaic below md, and only there', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('mosaic-home')).toBeVisible();
    // Every header control is md-gated on a phone (nav lives in the bottom tab
    // bar), so on the immersive home the bar is dead space and collapses.
    await expect(page.getByTestId('app-header')).toBeHidden();

    // Any other route keeps the sticky header.
    await page.goto('/settings');
    await expect(page.getByTestId('app-header')).toBeVisible();
  });
});

test.describe('mosaic home on a touch phone (#1642)', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test('a tap on even a small tile plays it — only a hold opens the menu', async ({ page }) => {
    await page.goto('/');
    const tiles = page.locator('[data-testid="mosaic-tile"][data-tile-kind="song"]');
    await expect(tiles.first()).toBeVisible({ timeout: 10_000 });
    const before = await page.getByTestId('player-title').textContent();

    // The smallest fully on-screen song tile whose centre hit-tests to it: the
    // case where an invisible, fixed-size ⋯ covered most of the face.
    const target = await tiles.evaluateAll((els) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let best: { x: number; y: number; w: number } | null = null;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.x < 0 || r.y < 0 || r.right > vw || r.bottom > vh - 140) continue;
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        if (document.elementFromPoint(cx, cy)?.closest('[data-testid="mosaic-tile"]') !== el)
          continue;
        if (!best || r.width < best.w) best = { x: cx, y: cy, w: r.width };
      }
      return best;
    });
    expect(target).not.toBeNull();
    await page.touchscreen.tap(target!.x, target!.y);

    await expect(page.getByTestId('player-title')).not.toHaveText(before ?? '', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('entity-menu')).toHaveCount(0);
  });
});
