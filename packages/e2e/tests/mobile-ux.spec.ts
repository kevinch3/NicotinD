import { test, expect, type Page } from '../helpers';
import {
  ADMIN,
  FIXTURE,
  bearer,
  expandGroup,
  openAlbumCard,
  preserveAlbumLyrics,
} from '../helpers';

/**
 * Mobile-viewport UX regressions (the G-series in
 * docs/e2e-playground-findings-2026-06.md). Runs in the CI chromium project; we
 * shrink the viewport per-spec to a phone size since the project device is
 * Desktop Chrome.
 */
const PHONE = { width: 412, height: 915 }; // Pixel 7

async function openAlbum(page: Page): Promise<void> {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  await expect(page.getByTestId('play-album')).toBeVisible();
}

/** Play the fixture album and expand the mini-player into the Now Playing sheet. */
async function openNowPlaying(page: Page): Promise<void> {
  await openAlbum(page);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  await page.getByTestId('player-title').click();
  await expect(page.getByTestId('now-playing-heading')).toBeVisible();
}

/**
 * Now Playing on a track with NO cover art.
 *
 * The 7-track album carries a real `cover.jpg` fixture (so screenshots and the
 * TV surface show a genuine sleeve), which makes it the wrong subject for the
 * gradient-fallback assertion below. The loose single is deliberately left
 * art-less for exactly this.
 */
async function openNowPlayingArtless(page: Page): Promise<void> {
  await page.goto('/library');
  // The library tab is component state, not a query param — `?tab=songs` does
  // nothing. Click the tab.
  await page
    .getByTestId('library-tabs')
    .getByRole('button', { name: 'Songs', exact: true })
    .click();
  const row = page.locator('app-track-row').filter({ hasText: FIXTURE.single.title }).first();
  await row.waitFor({ state: 'visible' });
  await row.getByTestId('track-row-title').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  await page.getByTestId('player-title').click();
  await expect(page.getByTestId('now-playing-heading')).toBeVisible();
}

test.describe('mobile UX', () => {
  test.use({ viewport: PHONE });
  // The lyrics tests below write to every track of the album, tags included;
  // offline-lyrics reads the same files (#1800).
  preserveAlbumLyrics('E2E_Test_Artist/E2E_Test_Album', FIXTURE.album.title);

  // G1 — the primary Play button must never be clipped off-screen by the
  // (now wrapping) action row.
  test('album-detail Play button is fully within the viewport', async ({ page }) => {
    await openAlbum(page);
    const box = (await page.getByTestId('play-album').boundingBox())!;
    expect(box, 'play-album should have a layout box').toBeTruthy();
    expect(box.x, 'left edge not clipped').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'right edge within viewport').toBeLessThanOrEqual(PHONE.width);
  });

  // On an iOS standalone PWA the fixed player + tab bar rode the page scroll (they
  // stopped following the viewport bottom and floated mid-screen over the content).
  // The shell now scrolls inside <main>, so the document itself must never scroll
  // and the bottom chrome must stay pinned to the viewport bottom while it does.
  test('scrolling a long page leaves the player and tab bar pinned to the bottom', async ({
    page,
  }) => {
    await openAlbum(page);
    await page.getByTestId('play-album').click();
    await expect(page.getByTestId('player-title')).toBeVisible();

    const gap = () =>
      page.evaluate(() => {
        const nav = document.querySelector('app-bottom-nav > *')!.getBoundingClientRect();
        return { navBottom: Math.round(nav.bottom), vh: window.innerHeight, docY: window.scrollY };
      });
    const before = await gap();

    const scrolled = await page.evaluate(() => {
      const root = document.querySelector('[data-scroll-root]') as HTMLElement;
      root.scrollTop = root.scrollHeight;
      return root.scrollTop;
    });
    expect(scrolled, 'the page scrolls inside <main>').toBeGreaterThan(0);

    const after = await gap();
    expect(after.docY, 'the document itself never scrolls').toBe(0);
    expect(after.navBottom, 'tab bar stays at the viewport bottom').toBe(before.navBottom);
    expect(after.navBottom).toBe(after.vh);
  });

  // iOS standalone can report a layout viewport shorter than the screen (measured on a 13 mini:
  // innerHeight/dvh 762, lvh 812), so `fixed bottom-0` stopped 50pt above the screen bottom and
  // left a band under the tab bar. Chromium cannot reproduce the short viewport, so force the
  // deficit variable the CSS reads and assert every bottom-anchored layer follows it.
  test('bottom chrome extends by the viewport deficit', async ({ page }) => {
    await openAlbum(page);
    await page.getByTestId('play-album').click();
    await expect(page.getByTestId('player-title')).toBeVisible();

    const measure = () =>
      page.evaluate(() => {
        const nav = document.querySelector('app-bottom-nav > *')!.getBoundingClientRect();
        const shell = document.querySelector('app-root > app-layout > div, app-layout > div');
        const player = document
          .querySelector('app-player [data-bottom-chrome]')!
          .getBoundingClientRect();
        return {
          navBottom: Math.round(nav.bottom),
          navTop: Math.round(nav.top),
          playerBottom: Math.round(player.bottom),
          shellH: Math.round(shell!.getBoundingClientRect().height),
          vh: window.innerHeight,
        };
      });

    const base = await measure();
    expect(base.navBottom, 'no deficit: nav sits on the viewport bottom').toBe(base.vh);

    await page.addStyleTag({ content: ':root { --vp-deficit: 50px !important; }' });
    const shifted = await measure();
    expect(shifted.navBottom, 'tab bar follows the deficit').toBe(base.navBottom + 50);
    // The player slides in on a transform transition, so poll until it settles on the tab bar.
    await expect
      .poll(async () => {
        const m = await measure();
        return m.playerBottom - m.navTop;
      }, 'mini player stays flush on top of the tab bar')
      .toBe(0);
    expect(shifted.shellH, 'shell fills the real screen').toBe(base.shellH + 50);
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

    // Highest top edge among the visible fixed bottom-chrome layers = where the
    // player/tab bar begins (mirrors bottomChromeInset's measurement).
    const measure = () =>
      page.evaluate(() => {
        const tops = Array.from(document.querySelectorAll('[data-bottom-chrome]'))
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.height > 0 && r.top < window.innerHeight)
          .map((r) => r.top);
        const m = document.querySelector('[data-testid="track-row-menu"]')!.getBoundingClientRect();
        return {
          chromeTop: tops.length ? Math.min(...tops) : window.innerHeight,
          top: m.top,
          bottom: m.bottom,
        };
      });

    // The mini-player is still sliding in (a transform transition) right after
    // play, so the menu re-measures on its transitionend (#1714): poll until the
    // settled menu sits on the chrome, never under it.
    await expect
      .poll(
        async () => {
          const m = await measure();
          return m.bottom - m.chromeTop;
        },
        { message: 'menu bottom clears the mini-player/tab bar' },
      )
      .toBeLessThanOrEqual(1);
    const settled = await measure();
    expect(settled.chromeTop, 'the mini-player chrome is present').toBeLessThan(PHONE.height);
    expect(settled.top, 'menu top on-screen').toBeGreaterThanOrEqual(0);
  });

  // G2 — Now Playing renders covers via app-cover-art, so a missing/404 cover
  // degrades to the gradient fallback (no broken-image glyph). Driven from the
  // art-less loose single: the 7-track album now ships a real cover.jpg, and
  // asserting a fallback on a track that HAS art would test nothing.
  test('Now Playing hero cover degrades to the gradient fallback', async ({ page }) => {
    await openNowPlayingArtless(page);

    // The current cover only: its neighbours (#1652) sit inside the same box,
    // and the track after the single may well have art.
    const cover = page.getByTestId('now-playing-cover-art');
    await expect(cover).toBeVisible();
    // Fallback active: no <img> survives (it errors → gradient div) and the
    // initial ("E") is shown over the gradient.
    await expect(cover.locator('img')).toHaveCount(0);
    await expect(cover).toContainText('E');
  });

  // G3 — the Track-info sheet must show which track it is (title/artist), even
  // when opened from the player (where no full library Song is passed).
  test('Track-info sheet shows the song identity', async ({ page }) => {
    await openNowPlaying(page);
    // Open the sheet's ⋯ menu → "Song info". The menu is the shared
    // SongMenuService list since issue #1038, so the label is the row menu's
    // ("Song info"), not the retired context menu's ("Track info").
    await page.getByTestId('now-playing-menu-toggle').click();
    await page.getByTestId('track-action-Song info').click();

    const identity = page.getByTestId('track-info-identity');
    await expect(identity).toBeVisible();
    await expect(identity).toContainText('Opening Static');
    await expect(identity).toContainText(FIXTURE.album.artist);
  });

  // The app has no zoom: stray double taps and pinches zoomed the viewport, and
  // iOS zoomed in on focusing any field under 16px. The root allows panning
  // only, and the viewport meta caps the scale (which also stops focus-zoom).
  test('zoom is disabled via root touch-action and the viewport meta', async ({ page }) => {
    await page.goto('/library');
    const touchAction = await page.evaluate(
      () => getComputedStyle(document.documentElement).touchAction,
    );
    expect(touchAction).toBe('pan-x pan-y');
    const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(viewport).toContain('maximum-scale=1');
    expect(viewport).toContain('user-scalable=no');
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

    await expect(page.getByTestId('now-playing-heading')).toBeVisible();
  });

  // Downloads rows must stay inside the viewport — overflowing content (long
  // titles / storage paths) used to widen the page and force the WebView to zoom
  // out. Guard that no element pushes a horizontal scroll at phone width.
  //
  // Readiness is the page heading, NOT an empty feed (issue #616). Asserting
  // "No active downloads." made this spec depend on every *other* spec having
  // cleaned up its jobs — and worse, it meant the test only ever ran against a
  // feed with no rows in it, which is precisely the case that cannot overflow.
  // Measuring whatever the feed actually holds is both order-independent and a
  // stricter test of the thing the comment above describes.
  test('downloads page does not overflow horizontally', async ({ page }) => {
    await page.goto('/downloads');
    // `level: 1` is load-bearing (issue #727): the active-downloads section
    // renders its own <h2>Downloads</h2>, so the unqualified role query is a
    // strict-mode violation the moment an earlier spec leaves a job in flight.
    // Ambiguous by construction — it passed only because the suite happened to
    // arrive here with an empty feed, which is also the one state that cannot
    // overflow (the same trap the #616 comment above describes).
    await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
    const overflow = await page.evaluate(() => {
      // The shell's <main> is the page scroller (the document no longer scrolls), so
      // overflow is measured on both — either one widening is the bug.
      return [document.documentElement, document.querySelector('[data-scroll-root]')]
        .filter((el): el is Element => !!el)
        .reduce((max, el) => Math.max(max, el.scrollWidth - el.clientWidth), 0);
    });
    expect(overflow, 'no horizontal page overflow at phone width').toBeLessThanOrEqual(1);
  });

  // Originally: the Admin "Library processing" window row held two native
  // <input type="time"> controls whose intrinsic min-width forced the whole page
  // wider than the phone (the WebView then zoomed out). That row is gone with the
  // processing window, so the specific offender no longer exists — but Admin is
  // the widest, most control-dense page in the app, so this stays as the general
  // guard that it fits a phone.
  test('admin page does not overflow horizontally', async ({ page }) => {
    await page.goto('/admin');
    // The panel lives inside the collapsible "Library Processing" settings
    // group, which starts collapsed by default — expand it first.
    await expandGroup(page, 'library-processing');
    await expect(page.getByTestId('processing-panel')).toBeVisible();
    const overflow = await page.evaluate(() => {
      // The shell's <main> is the page scroller (the document no longer scrolls), so
      // overflow is measured on both — either one widening is the bug.
      return [document.documentElement, document.querySelector('[data-scroll-root]')]
        .filter((el): el is Element => !!el)
        .reduce((max, el) => Math.max(max, el.scrollWidth - el.clientWidth), 0);
    });
    expect(overflow, 'no horizontal page overflow at phone width').toBeLessThanOrEqual(1);
  });

  // The Library Songs tab toolbar (search + sort + Filters + Select) used a
  // non-wrapping flex row whose combined min-width exceeded the phone, pushing a
  // horizontal scroll that shifted the whole page (header/tabs clipped). The
  // controls are icons now and the search takes what is left; guard there's no
  // horizontal page overflow.
  test('library Songs tab toolbar does not overflow horizontally', async ({ page }) => {
    await page.goto('/library');
    await page.getByRole('button', { name: 'Songs', exact: true }).click();
    await expect(page.getByTestId('library-songs')).toBeVisible();
    // The Select button (last control) only renders once songs are listed — wait
    // for it so the full toolbar is measured, not a partial one.
    await expect(page.getByRole('button', { name: 'Select' })).toBeVisible();
    const overflow = await page.evaluate(() => {
      // The shell's <main> is the page scroller (the document no longer scrolls), so
      // overflow is measured on both — either one widening is the bug.
      return [document.documentElement, document.querySelector('[data-scroll-root]')]
        .filter((el): el is Element => !!el)
        .reduce((max, el) => Math.max(max, el.scrollWidth - el.clientWidth), 0);
    });
    expect(overflow, 'no horizontal page overflow at phone width').toBeLessThanOrEqual(1);
  });

  // A fresh device opens the Library on Songs — the first tab — and at the
  // narrowest phone the tab bar and each tab's toolbar are ONE row: icons, with
  // only the active tab labelled. Run in Spanish, whose labels are the longest
  // ("Recopilaciones"), with every tab active in turn.
  test('library tab bar and toolbars fit one row at 360 px, Songs first', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.addInitScript(() => {
      localStorage.removeItem('nicotind-library-mode');
      localStorage.setItem('nicotind-lang', 'es');
    });
    await page.goto('/library');
    const tabs = page.getByTestId('library-tabs').getByRole('button');
    await expect(tabs).toHaveCount(8);
    await expect(tabs.first()).toHaveAccessibleName('Canciones');
    await expect(tabs.first()).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('library-songs')).toBeVisible();

    type Box = { top: number; right: number; width: number };
    const expectOneRow = (boxes: Box[], what: string) => {
      const shown = boxes.filter((b) => b.width > 0);
      expect(shown.length, `${what}: controls measured`).toBeGreaterThan(1);
      const top = Math.min(...shown.map((b) => b.top));
      for (const b of shown) {
        expect(b.top - top, `${what}: a control wrapped to a second row`).toBeLessThan(4);
        expect(b.right, `${what}: a control overflows the viewport`).toBeLessThanOrEqual(361);
      }
    };
    const boxesOf = (els: Element[]): Box[] =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, right: r.right, width: r.width };
      });

    const modes = await tabs.evaluateAll((els) => els.map((el) => el.getAttribute('data-mode')));
    for (const [i, mode] of modes.entries()) {
      await tabs.nth(i).click();
      await expect(tabs.nth(i)).toHaveAttribute('aria-current', 'true');
      expectOneRow(await tabs.evaluateAll(boxesOf), `tabs (${mode} active)`);
    }

    // Every tab with a toolbar: the row's controls share one line. The sort
    // control's host is `display: contents`, so its buttons are measured.
    const searchTestIds: Record<string, string> = {
      songs: 'library-songs-search',
      albums: 'library-search',
      compilations: 'library-compilations-search',
      singles: 'library-singles-search',
      artists: 'library-artists-search',
    };
    for (const [mode, searchTestId] of Object.entries(searchTestIds)) {
      const tab = page.locator(`[data-testid="library-tabs"] [data-mode="${mode}"]`);
      await tab.click();
      await expect(tab).toHaveAttribute('aria-current', 'true');
      // This tab's own field, not the previous tab's one about to be removed.
      const search = page.getByTestId(searchTestId);
      await expect(search).toBeVisible();
      const boxes = await search.evaluate((input) => {
        const row = input.closest('app-search-field')!.parentElement!;
        const items: Element[] = [];
        for (const child of Array.from(row.children)) {
          if (getComputedStyle(child).display === 'contents')
            items.push(...Array.from(child.children));
          else items.push(child);
        }
        return items.map((item) => {
          const r = item.getBoundingClientRect();
          return { top: r.top, right: r.right, width: r.width };
        });
      });
      expect(
        boxes.length,
        `${mode} toolbar: search, sort and filters at least`,
      ).toBeGreaterThanOrEqual(3);
      expectOneRow(boxes, `${mode} toolbar`);
    }
    const overflow = await page.evaluate(() => {
      // The shell's <main> is the page scroller (the document no longer scrolls), so
      // overflow is measured on both — either one widening is the bug.
      return [document.documentElement, document.querySelector('[data-scroll-root]')]
        .filter((el): el is Element => !!el)
        .reduce((max, el) => Math.max(max, el.scrollWidth - el.clientWidth), 0);
    });
    expect(overflow, 'no horizontal page overflow at 360 px').toBeLessThanOrEqual(1);
  });

  // The sticky header folds env(safe-area-inset-top) into its top padding so it
  // clears the iOS notch. On the web/headless (inset = 0) it must resolve to the
  // unchanged py-3 (12px) — i.e. the calc() is valid and desktop is unaffected.
  // Below md the header shows only on a page with a back target (#1770).
  test('header top padding resolves to 12px on web (safe-area inset = 0)', async ({ page }) => {
    await page.goto('/settings/about');
    await expect(page.getByTestId('app-header')).toBeVisible();
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

  // G4 — a *visible* way to Track info on Now Playing. Since #1716 it is the ⋯
  // on the artwork (Song info), not a standalone ⓘ beside the title.
  test('Now Playing reaches Track info from the ⋯ on the artwork', async ({ page }) => {
    await openNowPlaying(page);
    await expect(page.getByTestId('now-playing-info')).toHaveCount(0);
    const toggle = page.getByTestId('now-playing-menu-toggle');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await page.getByTestId('track-action-Song info').click();
    await expect(page.getByTestId('track-info-identity')).toContainText('Opening Static');
  });

  // The live-screens `player-analysis` flow targets the transport controls by
  // testid; guard that those stable hooks exist — and that the two the sheet no
  // longer offers are really gone, on the sheet as well as the bar (#1263).
  test('Now Playing exposes transport + queue testids, and no shuffle or repeat', async ({
    page,
  }) => {
    await openNowPlaying(page);
    await expect(page.getByTestId('now-playing-playpause')).toBeVisible();
    await expect(page.getByTestId('now-playing-radio')).toBeVisible();
    await expect(page.getByTestId('now-playing-queue')).toBeVisible();

    await expect(page.getByTestId('now-playing-shuffle')).toHaveCount(0);
    await expect(page.getByTestId('now-playing-repeat')).toHaveCount(0);
  });

  // Lyrics — the Track-info sheet exposes a Lyrics section; an admin can write,
  // save, and reset lyrics offline (the PUT/DELETE paths need no network, so this
  // stays deterministic in CI; the LRCLIB fetch path is exercised by unit tests).
  test('Track-info sheet lyrics: admin can add, save, and reset', async ({ page }) => {
    await openNowPlaying(page);
    await page.getByTestId('now-playing-menu-toggle').click();
    await page.getByTestId('track-action-Song info').click();

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

  // The Now Playing Lyrics tab swaps the queue tab for the lyrics panel. Lyrics
  // are pre-seeded through the real (admin) API so the panel renders stored
  // lyrics with no on-demand fetch — keeping the test offline + deterministic
  // (the LRCLIB fetch + synced parsing are covered by the API/unit tests).
  test('Now Playing Lyrics tab reveals the lyrics panel', async ({ page, request }) => {
    const token = (
      (await (await request.post('/api/auth/login', { data: ADMIN })).json()) as { token: string }
    ).token;
    const albums = (await (
      await request.get('/api/library/albums', { headers: bearer(token) })
    ).json()) as Array<{ id: string; name: string }>;
    const album = albums.find((a) => a.name === FIXTURE.album.title)!;
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
    await page.getByTestId('now-playing-tab-lyrics').click();

    const panel = page.getByTestId('now-playing-lyrics');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('now-playing-queue')).toHaveCount(0);
    await expect(panel).toContainText('seeded chorus line');

    // Round-trip: the Queue tab returns to the queue view.
    await page.getByTestId('now-playing-tab-queue').click();
    await expect(page.getByTestId('now-playing-queue')).toBeVisible();
    await expect(page.getByTestId('now-playing-lyrics')).toHaveCount(0);
  });

  /**
   * #1666: a change made elsewhere — another device, the MCP curator — reaches
   * the Lyrics panel already open, with no track change: the server announces
   * it as `lyrics.changed` and `LyricsService` re-reads what is on screen.
   * Before, nothing re-asked while the panel stayed up.
   */
  test('Now Playing lyrics: an edit made on another device reaches the open panel', async ({
    page,
    request,
  }) => {
    const token = (
      (await (await request.post('/api/auth/login', { data: ADMIN })).json()) as { token: string }
    ).token;
    const albums = (await (
      await request.get('/api/library/albums', { headers: bearer(token) })
    ).json()) as Array<{ id: string; name: string }>;
    // The list names albums `name` (helpers.ts): a `title` lookup never matches.
    const album = albums.find((a) => a.name === FIXTURE.album.title);
    expect(album, `fixture album "${FIXTURE.album.title}" in the library list`).toBeDefined();
    const detail = (await (
      await request.get(`/api/library/albums/${album!.id}`, { headers: bearer(token) })
    ).json()) as { song: Array<{ id: string }> };
    const seed = (plain: string) =>
      Promise.all(
        detail.song.map((s) =>
          request.put(`/api/library/songs/${s.id}/lyrics`, {
            headers: bearer(token),
            data: { plain },
          }),
        ),
      );
    await seed('words before the edit');

    const stream = page.waitForResponse((r) => r.url().includes('/api/library/events'));
    await openNowPlaying(page);
    await stream;
    await page.getByTestId('now-playing-tab-lyrics').click();
    const panel = page.getByTestId('now-playing-lyrics');
    await expect(panel).toContainText('words before the edit');
    const playing = (await page.getByTestId('player-title').textContent())!;

    await seed('words from another device');

    await expect(panel).toContainText('words from another device', { timeout: 10_000 });
    await expect(page.getByTestId('player-title')).toHaveText(playing); // same track
  });

  /**
   * Synced (LRC) lyrics end-to-end — impossible to write until now. `PUT` used
   * to hard-code `synced: null`, so no route could seed timed lyrics and the
   * karaoke path was unit-test-only. It now keeps an explicitly-sent LRC, which
   * is the same change that lets a curator fix timing without erasing it.
   */
  test('Now Playing lyrics: synced lines render and the sync offset persists', async ({
    page,
    request,
  }) => {
    const token = (
      (await (await request.post('/api/auth/login', { data: ADMIN })).json()) as { token: string }
    ).token;
    const albums = (await (
      await request.get('/api/library/albums', { headers: bearer(token) })
    ).json()) as Array<{ id: string; name: string }>;
    const album = albums.find((a) => a.name === FIXTURE.album.title)!;
    const detail = (await (
      await request.get(`/api/library/albums/${album.id}`, { headers: bearer(token) })
    ).json()) as { song: Array<{ id: string }> };
    const synced = '[00:00.50]opening line\n[00:09.00]second line';
    for (const s of detail.song) {
      await request.put(`/api/library/songs/${s.id}/lyrics`, {
        headers: bearer(token),
        data: { plain: 'opening line\nsecond line', synced },
      });
    }

    await openNowPlaying(page);
    await page.getByTestId('now-playing-tab-lyrics').click();
    const panel = page.getByTestId('now-playing-lyrics');
    // Timed lines, not the plain-text fallback — the karaoke branch.
    await expect(panel.locator('[data-karaoke-line]').first()).toContainText('opening line');

    // The control sits WITH the lyrics. Before this it only existed in the
    // empty state, i.e. nowhere a mistimed-lyrics complaint could reach it.
    const sync = page.getByTestId('lyrics-sync');
    await expect(sync).toBeVisible();
    await expect(page.getByTestId('lyrics-sync-value')).toContainText('In sync');

    await page.getByTestId('lyrics-sync-later').click();
    await expect(page.getByTestId('lyrics-sync-value')).toContainText('+0.25s');
    await page.getByTestId('lyrics-sync-later').click();
    await expect(page.getByTestId('lyrics-sync-value')).toContainText('+0.50s');

    // Durable, and the words are untouched — the correction is an offset, not
    // a rewrite, so the source's text must come back exactly as it went in.
    // Every track was seeded; exactly the one being played should carry it.
    const rows = await Promise.all(
      detail.song.map(
        async (s) =>
          (await (
            await request.get(`/api/library/songs/${s.id}/lyrics`, { headers: bearer(token) })
          ).json()) as { offsetMs: number; synced: string },
      ),
    );
    const corrected = rows.filter((r) => r.offsetMs === 500);
    expect(corrected).toHaveLength(1);
    expect(corrected[0]!.synced).toBe(synced);

    // Reset returns to the source's own timings.
    await page.getByTestId('lyrics-sync-reset').click();
    await expect(page.getByTestId('lyrics-sync-value')).toContainText('In sync');
  });

  /**
   * #1656: rapid taps issued one PATCH each, so a slow first write could reach
   * the server after the later ones and leave it — and the view — on the first
   * tap. Holding the first PATCH back models that; the last tap must still win.
   */
  test('Now Playing lyrics: rapid sync taps end on the last tap even when the first write is slow', async ({
    page,
    request,
  }) => {
    const token = (
      (await (await request.post('/api/auth/login', { data: ADMIN })).json()) as { token: string }
    ).token;
    const albums = (await (
      await request.get('/api/library/albums', { headers: bearer(token) })
    ).json()) as Array<{ id: string; name: string }>;
    const album = albums.find((a) => a.name === FIXTURE.album.title)!;
    const detail = (await (
      await request.get(`/api/library/albums/${album.id}`, { headers: bearer(token) })
    ).json()) as { song: Array<{ id: string }> };
    for (const s of detail.song) {
      await request.put(`/api/library/songs/${s.id}/lyrics`, {
        headers: bearer(token),
        data: {
          plain: 'opening line\nsecond line',
          synced: '[00:00.50]opening line\n[00:09.00]second line',
        },
      });
    }

    let inFlight = 0;
    let held = false;
    let patchedId: string | null = null;
    const isOffsetPatch = (r: { url(): string; method(): string }) =>
      r.method() === 'PATCH' && r.url().includes('/lyrics/offset');
    page.on('request', (r) => {
      if (isOffsetPatch(r)) inFlight++;
    });
    const settled = (r: { url(): string; method(): string }) => {
      if (isOffsetPatch(r)) inFlight--;
    };
    page.on('requestfinished', settled);
    page.on('requestfailed', settled);
    await page.route('**/lyrics/offset', async (route) => {
      patchedId ??= /songs\/([^/]+)\/lyrics\/offset/.exec(route.request().url())?.[1] ?? null;
      if (!held) {
        held = true;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      await route.continue();
    });

    await openNowPlaying(page);
    await page.getByTestId('now-playing-tab-lyrics').click();
    await expect(page.getByTestId('lyrics-sync-value')).toContainText('In sync');

    const later = page.getByTestId('lyrics-sync-later');
    await later.click();
    await later.click();
    await later.click();
    await expect(page.getByTestId('lyrics-sync-value')).toContainText('+0.75s');

    await expect
      .poll(async () => {
        if (inFlight > 0 || !patchedId) return 'writing';
        const row = (await (
          await request.get(`/api/library/songs/${patchedId}/lyrics`, { headers: bearer(token) })
        ).json()) as { offsetMs: number };
        return row.offsetMs;
      })
      .toBe(750);
    await expect(page.getByTestId('lyrics-sync-value')).toContainText('+0.75s');
  });

  /**
   * #1666: an Edit saved in the Track-info sheet reaches the karaoke panel
   * under it with no track change. The sheet used to keep its own copy, and
   * the panel — still mounted beneath — kept the old words until the next
   * track and back. Editing timed lyrics asks first, since the save drops the
   * timings.
   */
  test('Track-info sheet: an Edit reaches the Now Playing lyrics without a track change', async ({
    page,
    request,
  }) => {
    const token = (
      (await (await request.post('/api/auth/login', { data: ADMIN })).json()) as { token: string }
    ).token;
    const albums = (await (
      await request.get('/api/library/albums', { headers: bearer(token) })
    ).json()) as Array<{ id: string; name: string }>;
    const album = albums.find((a) => a.name === FIXTURE.album.title)!;
    const detail = (await (
      await request.get(`/api/library/albums/${album.id}`, { headers: bearer(token) })
    ).json()) as { song: Array<{ id: string }> };
    for (const s of detail.song) {
      await request.put(`/api/library/songs/${s.id}/lyrics`, {
        headers: bearer(token),
        data: { plain: 'opening line\nsecond line', synced: '[00:00.50]opening line' },
      });
    }

    await openNowPlaying(page);
    const title = await page.getByTestId('now-playing-title').textContent();
    await page.getByTestId('now-playing-tab-lyrics').click();
    const panel = page.getByTestId('now-playing-lyrics');
    await expect(panel.locator('[data-karaoke-line]').first()).toContainText('opening line');

    await page.getByTestId('now-playing-menu-toggle').click();
    await page.getByTestId('track-action-Song info').click();
    const section = page.getByTestId('lyrics-section');
    await section.getByTestId('edit-lyrics-button').click();
    await section.getByTestId('lyrics-editor').fill('words fixed in the sheet');
    await section.getByTestId('save-lyrics-button').click();
    // Timed lyrics: the save is a choice, not a side effect.
    await expect(page.getByTestId('confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-ok').click();
    await expect(section.getByTestId('lyrics-text')).toContainText('words fixed in the sheet');
    await page.getByTestId('track-info-close').click();

    await expect(panel).toContainText('words fixed in the sheet');
    await expect(panel.locator('[data-karaoke-line]')).toHaveCount(0);
    await expect(page.getByTestId('now-playing-title')).toHaveText(title ?? '');
  });

  // The drag-resize handle is shell-owned (above the Queue/Lyrics tabs) so it
  // must stay usable on the Lyrics tab — inside the queue panel it vanished with
  // the tab switch and read as a lost feature. Drag it up and assert the cover
  // actually shrinks.
  test('Now Playing resize handle works from the Lyrics tab', async ({ page }) => {
    await openNowPlaying(page);
    await page.getByTestId('now-playing-tab-lyrics').click();
    await expect(page.getByTestId('now-playing-lyrics')).toBeVisible();

    const handle = page.getByTestId('now-playing-queue-resize');
    await expect(handle).toBeVisible();

    const coverBefore = (await page.getByTestId('now-playing-cover').boundingBox())!;
    const handleBox = (await handle.boundingBox())!;
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY - 80, { steps: 8 });
    await page.mouse.up();

    const coverAfter = (await page.getByTestId('now-playing-cover').boundingBox())!;
    expect(coverAfter.width, 'cover shrinks when the panel is pulled taller').toBeLessThan(
      coverBefore.width,
    );
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
    ).json()) as Array<{ id: string; name: string }>;
    const album = albums.find((a) => a.name === FIXTURE.album.title)!;
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
    await page.getByTestId('now-playing-tab-lyrics').click();
    await expect(page.getByTestId('now-playing-lyrics')).toBeVisible();

    const overflow = await page.evaluate(() => {
      // The shell's <main> is the page scroller (the document no longer scrolls), so
      // overflow is measured on both — either one widening is the bug.
      return [document.documentElement, document.querySelector('[data-scroll-root]')]
        .filter((el): el is Element => !!el)
        .reduce((max, el) => Math.max(max, el.scrollWidth - el.clientWidth), 0);
    });
    expect(overflow, 'long lyrics must not widen the page').toBeLessThanOrEqual(1);
  });

  /** Mouse drag between two points; touch itself cannot be driven in Desktop
   *  Chrome (docs/web-ui.md), so this covers the pointer path and the wiring. */
  async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
  }
  /** Centre of an element AFTER it has stopped moving: the sheet slides up on
   *  open, and a box measured mid-transition puts the drag off the element. */
  async function settledCentre(locator: ReturnType<Page['getByTestId']>) {
    await locator.hover();
    const box = (await locator.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
  }

  // The bar body, not the notch: with `touch-pan-y` the browser reclaimed the
  // pan and only the notch opened the sheet.
  test('swiping up on the mini-player body opens Now Playing', async ({ page }) => {
    await openAlbum(page);
    await page.getByTestId('play-album').click();
    const title = page.getByTestId('player-title');
    await expect(title).toBeVisible();

    const c = await settledCentre(title);
    await drag(page, c, { x: c.x, y: c.y - 160 });
    await expect(page.getByTestId('now-playing-heading')).toBeVisible();
  });

  test('dragging down on the cover art closes Now Playing', async ({ page }) => {
    await openNowPlaying(page);
    const c = await settledCentre(page.getByTestId('now-playing-cover'));
    await drag(page, c, { x: c.x, y: c.y + 200 });
    // The closed sheet is parked below the viewport by a transform, so it is
    // still 'visible' to Playwright — off-viewport is the closed check.
    await expect(page.getByTestId('now-playing-heading')).not.toBeInViewport();
  });

  test('swiping up on the panel tabs grows the panel (cover shrinks)', async ({ page }) => {
    await openNowPlaying(page);
    const cover = page.getByTestId('now-playing-cover');
    const { box: lyricsTab } = await settledCentre(page.getByTestId('now-playing-tab-lyrics'));
    const before = (await cover.boundingBox())!;
    // Start on the tab row's empty right side (a button never starts the gesture).
    const x = lyricsTab.x + lyricsTab.width + 24;
    const y = lyricsTab.y + lyricsTab.height / 2;
    await drag(page, { x, y }, { x, y: y - 120 });
    const after = (await cover.boundingBox())!;
    expect(after.width, 'cover shrinks when the panel is pulled up').toBeLessThan(before.width);
  });

  test('one pull collapses a grown panel and continues into closing the sheet', async ({
    page,
  }) => {
    await openNowPlaying(page);
    const h = await settledCentre(page.getByTestId('now-playing-queue-resize'));
    await drag(page, h, { x: h.x, y: h.y - 100 });
    const cover = page.getByTestId('now-playing-cover');
    const grown = (await cover.boundingBox())!;
    expect(grown.width).toBeLessThan(320);

    const c = await settledCentre(cover);
    await drag(page, c, { x: c.x, y: c.y + 400 });
    // The closed sheet is parked below the viewport by a transform, so it is
    // still 'visible' to Playwright — off-viewport is the closed check.
    await expect(page.getByTestId('now-playing-heading')).not.toBeInViewport();
    // Reopen: the collapse persisted (cover back at full width).
    await page.getByTestId('player-title').click();
    await expect(page.getByTestId('now-playing-heading')).toBeVisible();
    const restored = (await cover.boundingBox())!;
    expect(restored.width).toBeGreaterThan(grown.width);
  });

  // Swipe to skip (#1297): ← next, → previous. The mouse path and the wiring;
  // the touch blocker and the axis arbitration are unit-tested.
  test('swiping the Now Playing cover sideways skips, and back again', async ({ page }) => {
    await openNowPlaying(page);
    const title = page.getByTestId('player-title');
    const first = (await title.textContent())!.trim();
    const c = await settledCentre(page.getByTestId('now-playing-cover'));

    await drag(page, c, { x: c.x - 150, y: c.y });
    await expect(title).not.toHaveText(first);
    // A sideways swipe never doubles as a dismiss.
    await expect(page.getByTestId('now-playing-heading')).toBeInViewport();

    const c2 = await settledCentre(page.getByTestId('now-playing-cover'));
    await drag(page, c2, { x: c2.x + 150, y: c2.y });
    await expect(title).toHaveText(first);
  });

  // Skip-by-swipe is the full sheet's gesture; the minimized bar only opens it.
  test('swiping the mini-player sideways neither skips nor opens Now Playing', async ({ page }) => {
    await openAlbum(page);
    await page.getByTestId('play-album').click();
    const title = page.getByTestId('player-title');
    await expect(title).toBeVisible();
    const first = (await title.textContent())!.trim();

    const c = await settledCentre(title);
    await drag(page, c, { x: c.x - 150, y: c.y });
    await expect(title).toHaveText(first);
    await expect(page.getByTestId('now-playing-heading')).not.toBeInViewport();
  });

  test('swiping beside the cover, on the sheet background, also skips', async ({ page }) => {
    await openNowPlaying(page);
    const title = page.getByTestId('player-title');
    const first = (await title.textContent())!.trim();
    const c = await settledCentre(page.getByTestId('now-playing-title'));

    await drag(page, c, { x: c.x - 150, y: c.y });
    await expect(title).not.toHaveText(first);
  });

  // Neighbour carousel (#1652): the covers a skip lands on peek in at rest,
  // bleeding to the screen edge on a phone (#1763); only the visible part of
  // them is hit-testable.
  test.describe('neighbour carousel (#1652)', () => {
    async function sliver(page: Page, side: 'next' | 'prev') {
      const { box } = await settledCentre(page.getByTestId('now-playing-cover-stage'));
      const band = box.width * 0.12;
      const dir = side === 'next' ? 1 : -1;
      const edge = side === 'next' ? box.x + box.width + 16 : box.x - 16;
      const y = box.y + box.height / 2;
      return {
        inside: { x: edge + (dir * band) / 2, y },
        beyond: { x: edge + dir * (band + 8), y },
      };
    }
    const hits = (page: Page, testId: string, p: { x: number; y: number }) =>
      page.evaluate(
        ([id, x, y]) => !!document.elementFromPoint(x, y)?.closest(`[data-testid="${id}"]`),
        [testId, p.x, p.y] as const,
      );

    test('the next cover peeks in at rest; the first track has no previous', async ({ page }) => {
      await openNowPlaying(page);
      const { inside, beyond } = await sliver(page, 'next');
      expect(inside.x, 'the sliver is on screen').toBeLessThan(PHONE.width);
      expect(await hits(page, 'now-playing-cover-next', inside), 'sliver is tappable').toBe(true);
      // #1763: past the old 12% sliver it keeps going, to the screen edge.
      expect(await hits(page, 'now-playing-cover-next', beyond), 'bleeds past it').toBe(true);
      const edge = { x: PHONE.width - 2, y: inside.y };
      expect(await hits(page, 'now-playing-cover-next', edge), 'to the screen edge').toBe(true);
      const nextBox = (await page.getByTestId('now-playing-cover-next').boundingBox())!;
      expect(nextBox.x + nextBox.width, 'runs on past it').toBeGreaterThan(PHONE.width);
      // Empty history: no previous cover, so no dead tap target on the left.
      await expect(page.getByTestId('now-playing-cover-prev')).toHaveCount(0);
    });

    // #1763: pulling the queue panel up shrinks the cover; the neighbours fade
    // out of the scene with it instead of shrinking along beside it.
    test('the neighbours fade out as the queue resize shrinks the cover', async ({ page }) => {
      await openNowPlaying(page);
      const next = page.getByTestId('now-playing-cover-next');
      const opacity = () => next.evaluate((el) => Number(getComputedStyle(el).opacity));
      await expect.poll(opacity).toBeCloseTo(0.5);

      const h = await settledCentre(page.getByTestId('now-playing-queue-resize'));
      // The cap starts at 320px and the cover rests at 60vw (247px here), so
      // the first ~73px of pull shrink nothing; 130px is part-way out.
      await drag(page, h, { x: h.x, y: h.y - 130 });
      await expect.poll(opacity).toBeLessThan(0.5);
      expect(await opacity(), 'still on its way out').toBeGreaterThan(0);

      const h2 = await settledCentre(page.getByTestId('now-playing-queue-resize'));
      await drag(page, h2, { x: h2.x, y: h2.y - 150 });
      await expect.poll(opacity).toBe(0);
      // Read the box directly: hovering the shrunken cover lands on its ⋯.
      const box = (await next.boundingBox())!;
      const inside = { x: box.x + 4, y: box.y + box.height / 2 };
      expect(await hits(page, 'now-playing-cover-next', inside), 'gone means untappable').toBe(
        false,
      );
    });

    test('tapping a peeking cover jumps to it, and back', async ({ page }) => {
      await openNowPlaying(page);
      const title = page.getByTestId('player-title');
      const first = (await title.textContent())!.trim();

      const next = await sliver(page, 'next');
      await page.mouse.click(next.inside.x, next.inside.y);
      await expect(title).not.toHaveText(first);
      await expect(page.getByTestId('now-playing-heading')).toBeInViewport();

      await expect(page.getByTestId('now-playing-cover-prev')).toHaveCount(1);
      const prev = await sliver(page, 'prev');
      expect(await hits(page, 'now-playing-cover-prev', prev.inside)).toBe(true);
      await page.mouse.click(prev.inside.x, prev.inside.y);
      await expect(title).toHaveText(first);
    });

    // #1749: the cover column clips the slivers, but `overflow-hidden` is still
    // a scroll container — anything that scrolls a sliver into view (a
    // screen reader landing on its label, Playwright retrying an obscured
    // hover) scrolled the column until the cover sat against the left edge
    // with the previous sliver off-screen. `overflow-clip` cannot scroll.
    test('scrolling a sliver into view never moves the cover off centre', async ({ page }) => {
      await openNowPlaying(page);
      const stage = page.getByTestId('now-playing-cover-stage');
      const centre = async () => {
        const b = (await stage.boundingBox())!;
        return b.x + b.width / 2;
      };
      const before = await centre();
      await page
        .getByTestId('now-playing-cover-next')
        .evaluate((el) => el.scrollIntoView({ inline: 'center', block: 'nearest' }));
      expect(Math.abs((await centre()) - before), 'the cover stays put').toBeLessThan(1);
      expect(Math.abs(before - PHONE.width / 2), 'and centred').toBeLessThan(2);
    });

    // A sliver is a button for its tap, but a drag from it is a drag of the
    // cover: pulling the peeking card in is the gesture a carousel invites.
    test('a sideways drag that starts on a peeking cover skips once', async ({ page }) => {
      await openNowPlaying(page);
      const title = page.getByTestId('player-title');
      const label = await page.getByTestId('now-playing-cover-next').getAttribute('aria-label');
      const upcoming = label!.replace(/^.*?, /, '');
      const { inside } = await sliver(page, 'next');
      await drag(page, inside, { x: inside.x - 150, y: inside.y });
      await expect(title).toHaveText(upcoming);
      // The click the drag ends with on the sliver must not skip a second time.
      await page.waitForTimeout(400);
      await expect(title).toHaveText(upcoming);
      await expect(page.getByTestId('now-playing-heading')).toBeInViewport();
    });

    test('a downward drag that starts on a peeking cover closes the sheet, skipping nothing', async ({
      page,
    }) => {
      await openNowPlaying(page);
      const title = page.getByTestId('player-title');
      const first = (await title.textContent())!.trim();
      const { inside } = await sliver(page, 'next');
      await drag(page, inside, { x: inside.x, y: inside.y + 200 });
      await expect(page.getByTestId('now-playing-heading')).not.toBeInViewport();
      await page.waitForTimeout(400);
      await expect(title).toHaveText(first);
    });
  });

  // The mouse specs above cannot model the browser reclaiming a touch pan
  // (pointercancel); real CDP touch events can. This is the PWA path.
  test.describe('touch swipe (CDP touch events)', () => {
    test.use({ hasTouch: true });

    async function touchSwipe(page: Page, from: { x: number; y: number }, dx: number) {
      const cdp = await page.context().newCDPSession(page);
      const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
        cdp.send('Input.dispatchTouchEvent', {
          type,
          touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
        });
      await send('touchStart', from.x, from.y);
      for (let i = 1; i <= 10; i++) {
        await send('touchMove', from.x + (dx * i) / 10, from.y + i);
        await page.waitForTimeout(16);
      }
      await send('touchEnd', from.x + dx, from.y + 10);
    }

    test('touch-swiping the cover skips next, then previous', async ({ page }) => {
      await openNowPlaying(page);
      const title = page.getByTestId('player-title');
      const first = (await title.textContent())!.trim();
      const c = await settledCentre(page.getByTestId('now-playing-cover'));
      await touchSwipe(page, c, -170);
      await expect(title).not.toHaveText(first);
      await expect(page.getByTestId('now-playing-heading')).toBeInViewport();
      const c2 = await settledCentre(page.getByTestId('now-playing-cover'));
      await touchSwipe(page, c2, 170);
      await expect(title).toHaveText(first);
    });

    test('touch-swiping beside the cover, over the title, skips', async ({ page }) => {
      await openNowPlaying(page);
      const title = page.getByTestId('player-title');
      const first = (await title.textContent())!.trim();
      // Right of the album line: empty sheet background, clear of the ⋯ button.
      const c = await settledCentre(page.getByTestId('now-playing-album'));
      await touchSwipe(page, { x: 380, y: c.y }, -170);
      await expect(title).not.toHaveText(first);
    });

    test('touch-swiping the mini bar does not skip', async ({ page }) => {
      await openAlbum(page);
      await page.getByTestId('play-album').click();
      const title = page.getByTestId('player-title');
      await expect(title).toBeVisible();
      const first = (await title.textContent())!.trim();
      const c = await settledCentre(title);
      await touchSwipe(page, { x: 300, y: c.y }, -170);
      await page.waitForTimeout(500);
      await expect(title).toHaveText(first);
    });
  });
});
