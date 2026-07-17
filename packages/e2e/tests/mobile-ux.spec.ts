import { test, expect, type Page } from '@playwright/test';
import { ADMIN, FIXTURE, bearer } from '../helpers';

/**
 * Mobile-viewport UX regressions (the G-series in
 * docs/e2e-playground-findings-2026-06.md). Runs in the CI chromium project; we
 * shrink the viewport per-spec to a phone size since the project device is
 * Desktop Chrome.
 */
const PHONE = { width: 412, height: 915 }; // Pixel 7

async function openAlbum(page: Page): Promise<void> {
  await page.goto('/library');
  await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).click();
  await expect(page).toHaveURL(/\/library\/albums\//);
  await expect(page.getByTestId('play-album')).toBeVisible();
}

/** Play the fixture album and expand the mini-player into the Now Playing sheet. */
async function openNowPlaying(page: Page): Promise<void> {
  await openAlbum(page);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  await page.getByTestId('player-title').click();
  await expect(page.getByText('Now Playing')).toBeVisible();
}

test.describe('mobile UX', () => {
  test.use({ viewport: PHONE });

  // G1 — the primary Play button must never be clipped off-screen by the
  // (now wrapping) action row.
  test('album-detail Play button is fully within the viewport', async ({ page }) => {
    await openAlbum(page);
    const box = (await page.getByTestId('play-album').boundingBox())!;
    expect(box, 'play-album should have a layout box').toBeTruthy();
    expect(box.x, 'left edge not clipped').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'right edge within viewport').toBeLessThanOrEqual(PHONE.width);
  });

  // A track-row `⋯` menu opened low on the list must not be hidden behind the
  // fixed mini-player + tab bar (the mobile context-menu-under-the-player bug).
  // With a track playing, open the LAST row's menu and assert its box clears the
  // bottom chrome — MenuPanelComponent reserves the chrome via `bottomChromeInset`
  // and flips the panel up instead of opening it downward under the player.
  test('track-row context menu stays clear of the mini-player + tab bar', async ({ page }) => {
    await openAlbum(page);
    await page.getByTestId('play-album').click();
    await expect(page.getByTestId('player-title')).toBeVisible();

    const last = page.getByTestId('track-row').last();
    await last.scrollIntoViewIfNeeded();
    await last.getByTestId('track-row-menu-toggle').click();

    const menu = page.getByTestId('track-row-menu');
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;

    // Highest top edge among the visible fixed bottom-chrome layers = where the
    // player/tab bar begins (mirrors bottomChromeInset's measurement).
    const chromeTop = await page.evaluate(() => {
      const tops = Array.from(document.querySelectorAll('[data-bottom-chrome]'))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.height > 0 && r.top < window.innerHeight)
        .map((r) => r.top);
      return tops.length ? Math.min(...tops) : window.innerHeight;
    });

    expect(chromeTop, 'the mini-player chrome is present').toBeLessThan(PHONE.height);
    expect(menuBox.y, 'menu top on-screen').toBeGreaterThanOrEqual(0);
    expect(
      menuBox.y + menuBox.height,
      'menu bottom clears the mini-player/tab bar',
    ).toBeLessThanOrEqual(chromeTop + 1);
  });

  // G2 — Now Playing renders covers via app-cover-art, so a missing/404 cover
  // degrades to the gradient fallback (no broken-image glyph). The fixtures have
  // no embedded art, so the hero cover must show the fallback initial and have
  // no <img> element (app-cover-art swaps to the gradient div on error).
  test('Now Playing hero cover degrades to the gradient fallback', async ({ page }) => {
    await openNowPlaying(page);

    const cover = page.getByTestId('now-playing-cover');
    await expect(cover).toBeVisible();
    // Fallback active: no <img> survives (it errors → gradient div) and the
    // album initial ("E" for "E2E Test Album") is shown over the gradient.
    await expect(cover.locator('img')).toHaveCount(0);
    await expect(cover).toContainText('E');
  });

  // G3 — the Track-info sheet must show which track it is (title/artist), even
  // when opened from the player (where no full library Song is passed).
  test('Track-info sheet shows the song identity', async ({ page }) => {
    await openNowPlaying(page);
    // Open the title context menu → "Track info" (scope to the menu; a visible
    // info button with the same label also exists — see the G4 test).
    await page.getByRole('heading', { name: 'Opening Static' }).click({ button: 'right' });
    await page.locator('app-track-context-menu').getByRole('button', { name: 'Track info' }).click();

    const identity = page.getByTestId('track-info-identity');
    await expect(identity).toBeVisible();
    await expect(identity).toContainText('Opening Static');
    await expect(identity).toContainText(FIXTURE.album.artist);
  });

  // Double-tap-to-zoom is disabled app-wide (stray double taps on cards/controls
  // zoomed the viewport on touch builds). `touch-action: manipulation` at the
  // root is the accessibility-preserving opt-out; assert it resolves on <html>.
  test('double-tap zoom is disabled via root touch-action', async ({ page }) => {
    await page.goto('/library');
    const touchAction = await page.evaluate(
      () => getComputedStyle(document.documentElement).touchAction,
    );
    expect(touchAction).toBe('manipulation');
  });

  // The mini-player grab "notch" must be visibly rendered on-screen while the
  // player sits at the bottom (it used to be a faint 4px /60 hatch the user
  // reported as invisible). Assert it's visible, fully within the viewport, has a
  // real size, and paints a non-transparent fill — and attach a screenshot of the
  // notch for visual review. (We shoot the static grab element, not the whole
  // playing mini-player, whose moving seek bar never stabilizes so a full-player
  // screenshot would hang on Playwright's stability wait until the test times out.)
  test('mini-player grab notch is visible on-screen', async ({ page }, testInfo) => {
    await openAlbum(page);
    await page.getByTestId('play-album').click();
    await expect(page.getByTestId('player-title')).toBeVisible();

    const grab = page.getByTestId('player-grab');
    await expect(grab).toBeVisible();

    const box = (await grab.boundingBox())!;
    expect(box, 'grab notch should have a layout box').toBeTruthy();
    expect(box.width, 'notch has width').toBeGreaterThan(0);
    expect(box.height, 'notch has height').toBeGreaterThan(0);
    expect(box.y, 'top edge on-screen').toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, 'bottom edge within viewport').toBeLessThanOrEqual(PHONE.height);

    // The hatch pill must paint a non-transparent fill (the visibility fix).
    const hatch = grab.locator('div').first();
    const bg = await hatch.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');

    const shot = await grab.screenshot({ animations: 'disabled' });
    await testInfo.attach('player-grab-notch', { body: shot, contentType: 'image/png' });
  });

  // The mini-player grab hatch must be a real drag target (it had no pointer
  // handler before — only the bar below it) and swiping it up opens Now Playing.
  test('mini-player grab handle opens Now Playing on swipe up', async ({ page }) => {
    await openAlbum(page);
    await page.getByTestId('play-album').click();
    await expect(page.getByTestId('player-title')).toBeVisible();

    const grab = page.getByTestId('player-grab');
    const box = (await grab.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 90, { steps: 6 });
    await page.mouse.up();

    await expect(page.getByText('Now Playing')).toBeVisible();
  });

  // Downloads rows must stay inside the viewport — overflowing content (long
  // titles / storage paths) used to widen the page and force the WebView to zoom
  // out. Guard that no element pushes a horizontal scroll at phone width.
  test('downloads page does not overflow horizontally', async ({ page }) => {
    await page.goto('/downloads');
    await expect(page.getByText('No active downloads.')).toBeVisible();
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow, 'no horizontal page overflow at phone width').toBeLessThanOrEqual(1);
  });

  // The Admin "Library processing" window row holds two native
  // <input type="time"> controls whose intrinsic min-width used to force the
  // whole page wider than the phone (the WebView then zoomed out). The row now
  // wraps + the inputs can shrink; guard there's no horizontal page overflow.
  // (The processing panel moved from Settings to Admin in the settings refactor.)
  test('admin page does not overflow horizontally', async ({ page }) => {
    await page.goto('/admin');
    // Admin-only processing panel with the offending time inputs.
    await expect(page.getByTestId('processing-panel')).toBeVisible();
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow, 'no horizontal page overflow at phone width').toBeLessThanOrEqual(1);
  });

  // The Library Songs tab toolbar (search + sort + Filters + Select) used a
  // non-wrapping flex row whose combined min-width exceeded the phone, pushing a
  // horizontal scroll that shifted the whole page (header/tabs clipped). It now
  // wraps like the other tabs; guard there's no horizontal page overflow.
  test('library Songs tab toolbar does not overflow horizontally', async ({ page }) => {
    await page.goto('/library');
    await page.getByRole('button', { name: 'Songs', exact: true }).click();
    await expect(page.getByTestId('library-songs')).toBeVisible();
    // The Select button (last control) only renders once songs are listed — wait
    // for it so the full toolbar is measured, not a partial one.
    await expect(page.getByRole('button', { name: 'Select' })).toBeVisible();
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow, 'no horizontal page overflow at phone width').toBeLessThanOrEqual(1);
  });

  // The sticky header folds env(safe-area-inset-top) into its top padding so it
  // clears the iOS notch. On the web/headless (inset = 0) it must resolve to the
  // unchanged py-3 (12px) — i.e. the calc() is valid and desktop is unaffected.
  test('header top padding resolves to 12px on web (safe-area inset = 0)', async ({ page }) => {
    await page.goto('/library');
    await expect(page.locator('header')).toBeVisible();
    const paddingTop = await page.evaluate(() => {
      const header = document.querySelector('header');
      return header ? getComputedStyle(header).paddingTop : null;
    });
    expect(paddingTop).toBe('12px');
  });

  // G7 — the album count is labeled (was a bare, unlabeled "1").
  test('library album count is labeled, not a bare number', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByTestId('album-card').first()).toBeVisible();
    await expect(page.getByTestId('library-album-count')).toHaveText('1 album');
  });

  // G4 — a *visible* Track-info affordance on Now Playing (previously the sheet
  // was reachable only via long-press/right-click on the title).
  test('Now Playing has a visible Track-info button that opens the sheet', async ({ page }) => {
    await openNowPlaying(page);
    const infoBtn = page.getByTestId('now-playing-info');
    await expect(infoBtn).toBeVisible();
    await infoBtn.click();
    await expect(page.getByTestId('track-info-identity')).toContainText('Opening Static');
  });

  // The live-screens `player-analysis` flow targets the transport controls by
  // testid; guard that those stable hooks exist and that shuffle reflects state.
  test('Now Playing exposes transport + queue testids', async ({ page }) => {
    await openNowPlaying(page);
    const shuffle = page.getByTestId('now-playing-shuffle');
    await expect(shuffle).toBeVisible();
    await expect(page.getByTestId('now-playing-repeat')).toBeVisible();
    await expect(page.getByTestId('now-playing-radio')).toBeVisible();
    await expect(page.getByTestId('now-playing-queue')).toBeVisible();

    // Toggling shuffle flips its pressed state (the screenshot flow relies on it).
    await expect(shuffle).toHaveAttribute('aria-pressed', 'false');
    await shuffle.click();
    await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
  });

  // Lyrics — the Track-info sheet exposes a Lyrics section; an admin can write,
  // save, and reset lyrics offline (the PUT/DELETE paths need no network, so this
  // stays deterministic in CI; the LRCLIB fetch path is exercised by unit tests).
  test('Track-info sheet lyrics: admin can add, save, and reset', async ({ page }) => {
    await openNowPlaying(page);
    await page.getByTestId('now-playing-info').click();

    const section = page.getByTestId('lyrics-section');
    await expect(section).toBeVisible();

    // First user is admin → an "Add" affordance opens the editor (no lyrics yet).
    await section.getByTestId('edit-lyrics-button').click();
    await section.getByTestId('lyrics-editor').fill('la la la\nsung softly');
    await section.getByTestId('save-lyrics-button').click();

    await expect(section.getByTestId('lyrics-text')).toContainText('sung softly');
    await expect(section).toContainText('Edited by you');

    // Reset clears it back to the empty state.
    await section.getByTestId('edit-lyrics-button').click();
    await section.getByTestId('reset-lyrics-button').click();
    await expect(section.getByTestId('lyrics-text')).toHaveCount(0);
  });

  // The Now Playing lyrics toggle swaps the queue for the lyrics panel. Lyrics
  // are pre-seeded through the real (admin) API so the panel renders stored
  // lyrics with no on-demand fetch — keeping the test offline + deterministic
  // (the LRCLIB fetch + synced parsing are covered by the API/unit tests).
  test('Now Playing lyrics toggle reveals the lyrics panel', async ({ page, request }) => {
    const token = (
      (await (await request.post('/api/auth/login', { data: ADMIN })).json()) as { token: string }
    ).token;
    const albums = (await (
      await request.get('/api/library/albums', { headers: bearer(token) })
    ).json()) as Array<{ id: string; title: string }>;
    const album = albums.find((a) => a.title === FIXTURE.album.title) ?? albums[0]!;
    const detail = (await (
      await request.get(`/api/library/albums/${album.id}`, { headers: bearer(token) })
    ).json()) as { song: Array<{ id: string }> };
    // Seed every track so whichever plays first has stored lyrics.
    for (const s of detail.song) {
      await request.put(`/api/library/songs/${s.id}/lyrics`, {
        headers: bearer(token),
        data: { plain: 'seeded chorus line' },
      });
    }

    await openNowPlaying(page);
    await expect(page.getByTestId('now-playing-queue')).toBeVisible();
    await page.getByTestId('now-playing-lyrics-toggle').click();

    const panel = page.getByTestId('now-playing-lyrics');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('now-playing-queue')).toHaveCount(0);
    await expect(panel).toContainText('seeded chorus line');
  });

  // A long lyric line (no natural break) must wrap inside the lyrics panel and
  // never push the page wider than the phone — the panel/lines gained
  // overflow-x-hidden + break-words after lyrics were reported overflowing the
  // screen. Seed an unbreakably long line and assert no horizontal overflow.
  test('long lyrics wrap and do not overflow horizontally', async ({ page, request }) => {
    const token = (
      (await (await request.post('/api/auth/login', { data: ADMIN })).json()) as { token: string }
    ).token;
    const albums = (await (
      await request.get('/api/library/albums', { headers: bearer(token) })
    ).json()) as Array<{ id: string; title: string }>;
    const album = albums.find((a) => a.title === FIXTURE.album.title) ?? albums[0]!;
    const detail = (await (
      await request.get(`/api/library/albums/${album.id}`, { headers: bearer(token) })
    ).json()) as { song: Array<{ id: string }> };
    const longLine = 'supercalifragilisticexpialidociousandthensomemoreveryverylongwordindeed';
    for (const s of detail.song) {
      await request.put(`/api/library/songs/${s.id}/lyrics`, {
        headers: bearer(token),
        data: { plain: `${longLine}\n${longLine}` },
      });
    }

    await openNowPlaying(page);
    await page.getByTestId('now-playing-lyrics-toggle').click();
    await expect(page.getByTestId('now-playing-lyrics')).toBeVisible();

    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow, 'long lyrics must not widen the page').toBeLessThanOrEqual(1);
  });
});
