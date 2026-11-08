import { test, expect, type Page } from '../helpers';
import { FIXTURE, expandGroup, openAlbumCard } from '../helpers';

/**
 * #1699: the toast stack sits just above the bottom chrome, never on it. Toasts
 * are z-[60], above the mini player's z-50, so a toast anchored too low hides
 * the player's track info and transport while it shows. The stack anchors on
 * the mini player's measured height (`--mini-player-h`, #1694), so it is
 * asserted against the real bar: on a phone (tab bar + bar) and on desktop (bar
 * alone), with and without a track, and under a forced viewport deficit. The
 * update strip is not `[data-bottom-chrome]` but sits on the viewport bottom
 * too, so it publishes `--update-banner-h` and counts as chrome here; a TV
 * build floors the offset at the overscan band.
 *
 * A toast is raised through the album page's curator Complete action with the
 * completeness routes fulfilled, as in album-completeness.spec.ts.
 */
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };
/** The stack's clearance above the chrome: 0.5rem on phones, 1rem on desktop. */
const PHONE_GAP_PX = 8;
const DESKTOP_GAP_PX = 16;
const ROUNDING_PX = 2;

const completenessPath = /\/api\/library\/albums\/([^/]+)\/completeness$/;

async function openAlbumWithToastTrigger(page: Page): Promise<void> {
  await page.route(completenessPath, (route) => {
    const albumId = completenessPath.exec(new URL(route.request().url()).pathname)![1];
    return route.fulfill({
      json: { albumId, confirmed: { expected: 12, owned: 9, missing: 3 } },
    });
  });
  await page.route('**/api/library/albums/*/complete', (route) =>
    route.fulfill({ json: { ok: true, outcome: 'already-complete', lidarrAlbumId: 1 } }),
  );
  // Through the grid card. song-menu.spec runs just before this one in a shard
  // and removes a fixture track; its restore rescans, so the album is back on
  // the grid by now (#1713).
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  await expect(page.getByTestId('play-album')).toBeVisible();
  await expect(page.getByTestId('album-complete-action')).toBeEnabled();
}

async function startTrack(page: Page): Promise<void> {
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
}

async function raiseToast(page: Page): Promise<void> {
  await page.getByTestId('album-complete-action').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Nothing to hunt' })).toBeVisible();
}

/** The toast stack's lowest edge and the top of the highest visible bottom chrome. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const toastBottom = Math.max(
      ...Array.from(document.querySelectorAll('[data-testid="toast"]')).map(
        (el) => el.getBoundingClientRect().bottom,
      ),
    );
    const chromeTops = Array.from(
      document.querySelectorAll<HTMLElement>('[data-bottom-chrome], [data-testid="update-banner"]'),
    )
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.height > 0 && r.top < vh)
      .map((r) => r.top);
    return {
      reservation: getComputedStyle(document.documentElement).getPropertyValue('--mini-player-h'),
      toastBottom: Math.round(toastBottom),
      // No visible chrome (desktop, no track): the stack anchors on the viewport bottom.
      chromeTop: Math.round(chromeTops.length ? Math.min(...chromeTops) : vh),
    };
  });
}

/**
 * Raises the real update strip: the server's health probe reports another
 * build, and Settings → "Check for updates" stages it. It stays up while the
 * page is visible (`canApplyUpdateNow`). Back is a same-document navigation, so
 * the staged state survives the return to the album.
 */
async function showUpdateBanner(page: Page): Promise<void> {
  await page.route('**/api/health', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    // A newer version as well as another commit: the e2e bundle may carry no
    // commit, and then only the version decides.
    return route.fulfill({
      response,
      json: { ...body, version: '99.0.0', commit: '0000000e2e1699' },
    });
  });
  await page.locator('header a[href="/settings"]').first().click();
  await expandGroup(page, 'settings-account');
  await page.getByTestId('settings-check-update').click();
  await expect(page.getByTestId('update-banner')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('album-complete-action')).toBeEnabled();
  await expect(page.getByTestId('update-banner')).toBeVisible();
}

async function expectToastClearOfChrome(
  page: Page,
  label: string,
  withTrack: boolean,
  gapPx: number,
): Promise<void> {
  // The mini player slides on a transform transition; let the geometry settle.
  await page.waitForTimeout(400);
  const m = await measure(page);
  if (withTrack) expect(m.reservation, `${label}: measured reservation`).not.toBe('0px');
  else expect(m.reservation, `${label}: no reservation while idle`).toBe('0px');
  expect(m.toastBottom, `${label}: the toast ends above the bottom chrome`).toBeLessThanOrEqual(
    m.chromeTop,
  );
  expect(
    Math.abs(m.chromeTop - m.toastBottom - gapPx),
    `${label}: the toast sits ${gapPx}px above the chrome (gap ${m.chromeTop - m.toastBottom}px)`,
  ).toBeLessThanOrEqual(ROUNDING_PX);
}

test.describe('toast stack clears the bottom chrome on a phone (#1699)', () => {
  test.use({ viewport: PHONE });

  test('with a track, the toast sits above the mini player', async ({ page }) => {
    await openAlbumWithToastTrigger(page);
    await startTrack(page);
    await raiseToast(page);
    await expectToastClearOfChrome(page, 'phone, track', true, PHONE_GAP_PX);
  });

  test('with no track, the toast sits above the tab bar', async ({ page }) => {
    await openAlbumWithToastTrigger(page);
    await raiseToast(page);
    await expectToastClearOfChrome(page, 'phone, no track', false, PHONE_GAP_PX);
  });

  test('under a viewport deficit, the toast follows the mini player', async ({ page }) => {
    await openAlbumWithToastTrigger(page);
    await startTrack(page);
    await page.addStyleTag({ content: ':root { --vp-deficit: 50px !important; }' });
    await raiseToast(page);
    await expectToastClearOfChrome(page, 'phone, track, deficit', true, PHONE_GAP_PX);
  });

  test('the toast follows a bar that grows after first render', async ({ page }) => {
    await openAlbumWithToastTrigger(page);
    await startTrack(page);
    // Stands in for the "Playing on" strip appearing: only a measured anchor keeps up.
    await page.addStyleTag({
      content: '[data-bottom-chrome].player-chrome { padding-bottom: 40px !important; }',
    });
    await raiseToast(page);
    await expectToastClearOfChrome(page, 'phone, grown bar', true, PHONE_GAP_PX);
  });
});

test.describe('toast stack clears the bottom chrome on desktop (#1699)', () => {
  test.use({ viewport: DESKTOP });

  test('with a track, the toast sits above the player', async ({ page }) => {
    await openAlbumWithToastTrigger(page);
    await startTrack(page);
    await raiseToast(page);
    await expectToastClearOfChrome(page, 'desktop, track', true, DESKTOP_GAP_PX);
  });

  test('with no track, the toast sits near the viewport bottom', async ({ page }) => {
    await openAlbumWithToastTrigger(page);
    await raiseToast(page);
    await expectToastClearOfChrome(page, 'desktop, no track', false, DESKTOP_GAP_PX);
  });
});

test.describe('toast stack clears the update strip on desktop (#1699)', () => {
  test.use({ viewport: DESKTOP });

  test('with no track and the update strip up, the toast sits above the strip', async ({
    page,
  }) => {
    await openAlbumWithToastTrigger(page);
    await showUpdateBanner(page);
    await raiseToast(page);
    const banner = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--update-banner-h'),
    );
    expect(banner, 'the strip publishes its measured height').not.toBe('0px');
    await expectToastClearOfChrome(page, 'desktop, no track, update strip', false, DESKTOP_GAP_PX);
  });
});

test.describe('toast stack clears the TV overscan band (#1699)', () => {
  // The TV viewport class (md branch, no mini player) and a height where the
  // 'extra' preset's 4vh band (28.8px) is past the old 16px offset plus padding.
  test.use({ viewport: { width: 960, height: 720 } });

  test("on the 'extra' overscan preset, the toast ends 1rem above the band", async ({ page }) => {
    await openAlbumWithToastTrigger(page);
    await raiseToast(page);
    // The rule keys off the class main.ts stamps on a TV build; the preset lands
    // as an inline variable, as `applyOverscan` writes it.
    await page.evaluate(() => {
      document.documentElement.classList.add('tv-build');
      document.documentElement.style.setProperty('--tv-overscan-y', '4vh');
    });
    const m = await page.evaluate(() => {
      const toasts = Array.from(document.querySelectorAll('[data-testid="toast"]'));
      return {
        vh: window.innerHeight,
        toastBottom: Math.max(...toasts.map((el) => el.getBoundingClientRect().bottom)),
      };
    });
    const band = m.vh * 0.04;
    expect(m.vh - m.toastBottom, 'the toast clears the overscan band').toBeGreaterThan(band);
    expect(
      Math.abs(m.vh - m.toastBottom - (band + DESKTOP_GAP_PX)),
      `the toast sits ${DESKTOP_GAP_PX}px above the band (gap ${m.vh - m.toastBottom}px)`,
    ).toBeLessThanOrEqual(ROUNDING_PX);
  });
});
