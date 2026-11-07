import { test, expect, type Page } from '../helpers';
import { FIXTURE, expandGroup, openAlbumCard } from '../helpers';

/**
 * #1694: at maximum scroll the last element of a view must end above the fixed
 * bottom chrome — the mini player when a track is loaded, else the tab bar. The
 * reservation lives on the scroller (`<main data-scroll-root>`), so it is
 * asserted on several long views, with and without a track, and with a forced
 * iOS-standalone viewport deficit (Chromium cannot produce a real one).
 */
const PHONE = { width: 390, height: 844 };

async function startTrack(page: Page): Promise<void> {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
}

/** Lowest painted content edge and the highest visible chrome edge, at max scroll. */
async function measureAtBottom(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-scroll-root]')!;
    root.scrollTop = root.scrollHeight;
    const vh = window.innerHeight;
    let contentBottom = 0;
    let last = '';
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (el.closest('[data-testid="pull-refresh-indicator"], [data-testid="route-progress"]'))
        continue;
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom > contentBottom) {
        contentBottom = r.bottom;
        last = `${el.tagName.toLowerCase()}${el.dataset['testid'] ? `[${el.dataset['testid']}]` : ''}`;
      }
    }
    const chromeTops = Array.from(document.querySelectorAll<HTMLElement>('[data-bottom-chrome]'))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.height > 0 && r.top < vh)
      .map((r) => r.top);
    return {
      scrolled: root.scrollTop,
      contentBottom: Math.round(contentBottom),
      chromeTop: Math.round(Math.min(...chromeTops)),
      last,
    };
  });
}

async function expectClearAtBottom(page: Page, view: string): Promise<void> {
  // The mini player slides on a transform transition; let the geometry settle.
  await page.waitForTimeout(400);
  const m = await measureAtBottom(page);
  expect(m.scrolled, `${view}: the view must be long enough to scroll`).toBeGreaterThan(0);
  expect(
    m.contentBottom,
    `${view}: last element (${m.last}) ends above the bottom chrome`,
  ).toBeLessThanOrEqual(m.chromeTop);
}

const VIEWS: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: 'library songs',
    open: async (page) => {
      await page.goto('/library');
      await page
        .getByTestId('library-tabs')
        .getByRole('button', { name: 'Songs', exact: true })
        .click();
      await page.locator('app-track-row').first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'settings',
    open: async (page) => {
      await page.goto('/settings');
      await expandGroup(page, 'settings-account');
      await expect(page.getByTestId('settings-check-update')).toBeVisible();
    },
  },
];

test.describe('bottom chrome reservation (#1694)', () => {
  test.use({ viewport: PHONE });

  for (const view of VIEWS) {
    test(`${view.name}: last element clears the tab bar with no track`, async ({ page }) => {
      await view.open(page);
      await expectClearAtBottom(page, view.name);
    });

    test(`${view.name}: last element clears the mini player`, async ({ page }) => {
      await startTrack(page);
      await view.open(page);
      await expectClearAtBottom(page, view.name);
    });

    test(`${view.name}: last element clears the mini player under a viewport deficit`, async ({
      page,
    }) => {
      await startTrack(page);
      await view.open(page);
      await page.addStyleTag({ content: ':root { --vp-deficit: 50px !important; }' });
      await expectClearAtBottom(page, view.name);
    });
  }
});

// Desktop has no tab bar: the reservation is the mini player alone.
test.describe('bottom chrome reservation on desktop (#1694)', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('library songs: last element clears the desktop player', async ({ page }) => {
    await startTrack(page);
    await VIEWS[0].open(page);
    await expectClearAtBottom(page, 'library songs (desktop)');
  });
});
