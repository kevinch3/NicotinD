import type { Page } from '@playwright/test';
import { test, expect, vibesPlayable } from '../helpers';

/**
 * The centre of a resting pooled tile of one kind that is fully on screen and
 * whose centre hit-tests to it (the home-view switch overlays the stage's corner).
 * `pick` chooses among the candidates: the first, or the smallest.
 */
async function restingTile(
  page: Page,
  kind: string,
  pick: 'first' | 'smallest' = 'first',
): Promise<{ x: number; y: number }> {
  const tiles = page.locator(`[data-testid="mosaic-tile"][data-tile-kind="${kind}"]`);
  await expect(tiles.first()).toBeVisible({ timeout: 10_000 });
  const target = await tiles.evaluateAll((els, smallest) => {
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
      if (!best || (smallest && r.width < best.w)) best = { x: cx, y: cy, w: r.width };
      if (!smallest) break;
    }
    return best;
  }, pick === 'smallest');
  expect(target, `a resting ${kind} tile on screen`).not.toBeNull();
  return target!;
}

/**
 * The post-login landing (route '') is the mosaic: an infinite pannable field of
 * tiles drawn from every landing source. A tap brings a tile forward; only the
 * tile brought forward can start a radio (#2019). The shelf-based landing it
 * replaced lives on at /classic.
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

  test('hides the vibes the library cannot play (#1739)', async ({ page }) => {
    // The fixture library is silent FLACs with no mood/energy/bpm enrichment, so
    // every vibe's probe finds nothing and none is offered: a tile that would
    // play nothing is not shown. Songs prove the field itself rendered.
    await page.goto('/');
    await expect(
      page.locator('[data-testid="mosaic-tile-link"][data-tile-kind="song"]').first(),
    ).toBeAttached({ timeout: 10_000 });
    await expect(
      page.locator('[data-testid="mosaic-tile-link"][data-tile-kind="vibe"]'),
    ).toHaveCount(0);
  });

  test('a vibe with no matching tracks says so instead of failing', async ({ page }) => {
    // Offered (the probe is answered), yet the radio finds nothing: that path
    // must surface a neutral notice, never an error.
    await vibesPlayable(page);
    await page.goto('/');
    const vibe = page.locator('[data-testid="mosaic-tile-link"][data-tile-kind="vibe"]');
    await expect(vibe.first()).toBeAttached({ timeout: 10_000 });

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

  test('a click brings a tile forward with its Play and ⋯, and Escape lets it go (#2019)', async ({
    page,
  }) => {
    await page.goto('/');
    const title = page.getByTestId('player-title');
    const target = await restingTile(page, 'song');
    const before = await title.textContent();
    await page.mouse.click(target.x, target.y);

    const focus = page.getByTestId('mosaic-focus');
    await expect(focus).toBeVisible();
    await expect(page.getByTestId('mosaic-focus-play')).toBeFocused();
    await expect(page.getByTestId('mosaic-focus-more')).toBeVisible();
    // A song lists nothing; only a playlist, genre or vibe says what it starts with.
    await expect(page.getByTestId('mosaic-focus-preview')).toHaveCount(0);
    expect(await title.textContent()).toBe(before);

    await page.keyboard.press('Escape');
    await expect(focus).toHaveCount(0);
    expect(await title.textContent()).toBe(before);
  });

  test("the next song takes a tile a knight's move away, and the ring goes with it", async ({
    page,
  }) => {
    await page.goto('/');
    const target = await restingTile(page, 'song');
    await page.mouse.click(target.x, target.y);
    await page.getByTestId('mosaic-focus-play').click();
    const title = page.getByTestId('player-title');
    await expect(title).not.toHaveText('', { timeout: 15_000 });

    const ring = page.locator('[data-testid="mosaic-tile"].is-playing');
    await expect(ring).toHaveCount(1);
    const seedSlot = await ring.getAttribute('data-tile-id');
    const seedTitle = await title.textContent();

    await page.getByTestId('player-next').click();
    await expect(title).not.toHaveText(seedTitle ?? '', { timeout: 15_000 });
    const nextTitle = (await title.textContent())!.trim();
    await expect(ring).toHaveCount(1);
    expect(await ring.getAttribute('data-tile-id')).not.toBe(seedSlot);
    await expect(ring).toContainText(nextTitle);
    // The camera followed: the playing tile is on screen and the chip is not needed.
    await expect(page.getByTestId('mosaic-now-playing')).toBeHidden();
  });

  test('a vibe brought forward says when nothing matches, and cannot be played (#2019)', async ({
    page,
  }) => {
    // Offered (the probe is answered), yet the radio finds nothing — the notice
    // now sits where the tracks would be, before anything is pressed.
    await vibesPlayable(page);
    await page.goto('/');
    const target = await restingTile(page, 'vibe');
    await page.mouse.click(target.x, target.y);

    await expect(page.getByTestId('mosaic-focus-tag')).toBeVisible();
    await expect(page.getByTestId('mosaic-focus-empty')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('mosaic-focus-play')).toBeDisabled();
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

  test('below md the top bar shows only to carry a back target (#1770)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('mosaic-home')).toBeVisible();
    // Every header control is md-gated on a phone (nav lives in the bottom tab
    // bar), so the bar is dead space and collapses — and the immersive home
    // takes no status-bar strip either, it pads its own overlay.
    await expect(page.getByTestId('app-header')).toBeHidden();
    await expect(page.getByTestId('status-bar-scrim')).toHaveCount(0);

    // A top-level page has nothing to go back to: no bar, but the strip.
    await page.goto('/settings');
    await expect(page.getByTestId('app-header')).toBeHidden();
    await expect(page.getByTestId('status-bar-scrim')).toHaveCount(1);

    // A sub-page has a back target, so the bar returns to carry it.
    await page.goto('/settings/about');
    await expect(page.getByTestId('app-header')).toBeVisible();
    await expect(page.getByTestId('top-bar-back')).toBeVisible();
  });
});

test.describe('mosaic home on a touch phone (#1642)', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test('a tap on even a small tile brings it forward, and only its Play starts it (#2019)', async ({
    page,
  }) => {
    await page.goto('/');
    const title = page.getByTestId('player-title');
    // The smallest tile on screen: the case where an invisible, fixed-size ⋯
    // once covered most of the face and a tap opened the menu instead (#1642).
    const target = await restingTile(page, 'song', 'smallest');
    const before = await title.textContent();
    await page.touchscreen.tap(target.x, target.y);

    await expect(page.getByTestId('mosaic-focus')).toBeVisible();
    await expect(page.getByTestId('entity-menu')).toHaveCount(0);
    // Shared session: assert the playback did not CHANGE, never that it is empty.
    expect(await title.textContent()).toBe(before);

    await page.getByTestId('mosaic-focus-play').tap();
    await expect(title).not.toHaveText(before ?? '', { timeout: 15_000 });
    await expect(page.getByTestId('mosaic-focus')).toHaveCount(0);
  });

  // #2020: the wheel zooms the field; the type holds its size.
  test.describe('zoom', () => {
    /** On-screen title sizes, and tile widths, for every tile whose title is shown. */
    const measure = (page: Page) =>
      page.locator('[data-testid="mosaic-tile"]').evaluateAll((els) =>
        els.flatMap((el) => {
          const tile = el as HTMLElement;
          if (tile.style.display === 'none' || Number(tile.style.opacity) < 1) return [];
          const title = tile.querySelector<HTMLElement>('b.mosaic-name');
          if (!title || getComputedStyle(title).display === 'none') return [];
          // The lens draws rim tiles smaller, text included; undo that to read
          // the size the limits are stated in.
          const lens = tile.getBoundingClientRect().width / tile.offsetWidth;
          return [
            {
              width: tile.getBoundingClientRect().width,
              titlePx: parseFloat(getComputedStyle(title).fontSize) * lens,
              lens,
              text: tile.dataset['text'],
            },
          ];
        }),
      );
    const zoomOf = (page: Page) => page.getByTestId('mosaic-stage').getAttribute('data-zoom');
    const wheel = async (page: Page, deltaY: number, times: number) => {
      const box = (await page.getByTestId('mosaic-stage').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < times; i++) await page.mouse.wheel(0, deltaY);
    };

    test('a zoomed-in tile comes forward no smaller than it is drawn, and lets go softly', async ({
      page,
    }) => {
      await page.goto('/');
      await expect(page.locator('[data-testid="mosaic-tile"]').first()).toBeVisible({
        timeout: 10_000,
      });
      await wheel(page, -200, 12);
      await expect.poll(() => zoomOf(page)).toBe('2.20');
      // Zoomed in, a tile can be larger than the screen, so `restingTile`'s
      // "wholly on screen" does not hold: take any point a song tile answers at.
      const target = await page.evaluate(() => {
        const s = document.querySelector('[data-testid="mosaic-stage"]')!.getBoundingClientRect();
        for (let fy = 0.2; fy <= 0.8; fy += 0.1) {
          for (let fx = 0.2; fx <= 0.8; fx += 0.1) {
            const x = s.x + s.width * fx;
            const y = s.y + s.height * fy;
            const tile = document
              .elementFromPoint(x, y)
              ?.closest<HTMLElement>('[data-testid="mosaic-tile"]');
            if (tile?.dataset['tileKind'] === 'song') return { x, y };
          }
        }
        return null;
      });
      expect(target, 'a song tile on screen at 220%').not.toBeNull();
      await page.touchscreen.tap(target!.x, target!.y);
      const face = page.locator('[data-testid="mosaic-focus"] .mosaic-focus-face');
      await expect(face).toBeVisible();

      // Once the glide has settled, the face covers the tile at the stage centre,
      // or is as large as the stage has room for. An invariant, not the regression:
      // the fixture's tiles stay under the usual side even at 220%, so the case
      // that opened smaller is pinned in mosaic-focus.spec.ts and the component spec.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const stage = document.querySelector('[data-testid="mosaic-stage"]')!;
              const s = stage.getBoundingClientRect();
              const at = { x: s.x + s.width / 2, y: s.y + s.height / 2 };
              let centred = 0;
              let nearest = Infinity;
              for (const el of stage.querySelectorAll<HTMLElement>('[data-testid="mosaic-tile"]')) {
                if (el.style.display === 'none') continue;
                const r = (el.firstElementChild ?? el).getBoundingClientRect();
                const d = Math.hypot(r.x + r.width / 2 - at.x, r.y + r.height / 2 - at.y);
                if (d < nearest) {
                  nearest = d;
                  centred = r.width;
                }
              }
              const side = document
                .querySelector('.mosaic-focus-face')!
                .getBoundingClientRect().width;
              const room = Math.min(s.width, s.height) - 32;
              return side - Math.min(centred, room);
            }),
          { timeout: 5_000 },
        )
        .toBeGreaterThanOrEqual(-1);

      // Letting go plays the leave animation before the element goes.
      await page.evaluate(() => {
        const w = window as unknown as { __focusLeft?: boolean };
        new MutationObserver(() => {
          if (document.querySelector('.mosaic-focus-leaving')) w.__focusLeft = true;
        }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
      });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('mosaic-focus')).toHaveCount(0);
      expect(
        await page.evaluate(() => (window as unknown as { __focusLeft?: boolean }).__focusLeft),
      ).toBe(true);
    });

    test('the wheel zooms between 60% and 220%, and the page does not scroll', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('[data-testid="mosaic-tile"]').first()).toBeVisible({
        timeout: 10_000,
      });
      const widest = async () => Math.max(...(await measure(page)).map((t) => t.width));
      const at100 = await widest();

      await wheel(page, -200, 12);
      await expect.poll(() => zoomOf(page)).toBe('2.20');
      // Not 2.2×: only the exact centre gets the whole zoom, and zooming in
      // pushes every other tile further down the lens' falloff.
      await expect.poll(widest).toBeGreaterThan(at100 * 1.3);

      await wheel(page, 200, 30);
      await expect.poll(() => zoomOf(page)).toBe('0.60');
      await expect.poll(widest).toBeLessThan(at100 * 0.75);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    });

    test('a title stays between 9 and 17 px at every zoom, and small tiles drop their text', async ({
      page,
    }) => {
      await page.goto('/');
      await expect(page.locator('[data-testid="mosaic-tile"]').first()).toBeVisible({
        timeout: 10_000,
      });
      // The size the limits are stated in is the one before the fisheye, which
      // is the on-screen size divided by the lens' own scale at that tile.
      const titleSizes = async (zoom: number) =>
        (await measure(page)).map((t) => t.titlePx / (t.lens / zoom));

      for (const [deltaY, times, zoom] of [
        [-200, 12, 2.2],
        [200, 30, 0.6],
      ] as const) {
        await wheel(page, deltaY, times);
        await expect.poll(() => zoomOf(page)).toBe(zoom.toFixed(2));
        const sizes = await titleSizes(zoom);
        expect(sizes.length).toBeGreaterThan(0);
        // Before the lens, a title is natural × zoom, held in 9–17 px.
        for (const px of sizes) {
          expect(px).toBeGreaterThanOrEqual(8.9);
          expect(px).toBeLessThanOrEqual(17.1);
        }
      }
      // Which faces drop their text is unit-tested (`textLevel`): the fixture
      // library has no tile small enough to lose its words at 60%.
      // And back at 100% every face has its text again.
      await wheel(page, -200, 3);
      await wheel(page, 200, 30);
      await page.reload();
      await expect(page.locator('[data-testid="mosaic-tile"]').first()).toBeVisible({
        timeout: 10_000,
      });
      // Zoom is not remembered: a new visit starts at 100%.
      expect(await zoomOf(page)).toBeNull();
      const fresh = await page
        .locator('[data-testid="mosaic-tile"]')
        .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset['text']));
      expect(fresh.every((l) => l === 'full')).toBe(true);
    });
  });
});
