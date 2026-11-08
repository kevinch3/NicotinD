import { test, expect, type Page } from '../helpers';
import { FIXTURE, openAlbumCard } from '../helpers';

/**
 * #1743: the collapsed player was cramped. On desktop the raised play button
 * overlapped the grab notch by 2px and the inline scrubber hung 4px below the
 * viewport, its time labels on the screen edge; the title and artist were 14px
 * and 12px. This measures the real bar on both layouts: desktop (transport in
 * the centre, scrubber inline under it) and phone (scrubber stacked under the
 * row). Upper bounds on the bar's height keep the fix from spending more
 * vertical room than it needs.
 */
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
/** Clear space between the notch pill and the play button. */
const NOTCH_GAP_PX = 10;
/** The scrubber's box (with its time labels on desktop) stays this far above the bar's edge. */
const SEEK_EDGE_PX = 6;

async function startTrack(page: Page): Promise<void> {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  // The bar slides in on a transform transition; let the geometry settle.
  await page.waitForTimeout(400);
}

async function measure(page: Page, seekSelector: string) {
  return page.evaluate((seekSel) => {
    const box = (sel: string) => {
      const el = Array.from(document.querySelectorAll<HTMLElement>(sel)).find(
        (e) => e.getBoundingClientRect().height > 0,
      );
      if (!el) throw new Error(`${sel} not rendered`);
      return el.getBoundingClientRect();
    };
    const px = (sel: string) => parseFloat(getComputedStyle(document.querySelector(sel)!).fontSize);
    const bar = box('[data-bottom-chrome].player-chrome');
    return {
      vh: window.innerHeight,
      barHeight: bar.height,
      barBottom: bar.bottom,
      pillBottom: box('[data-testid="player-grab"] > div').bottom,
      play: box('[data-testid="player-playpause"]'),
      prev: box('[data-testid="player-prev"]'),
      next: box('[data-testid="player-next"]'),
      seek: box(seekSel),
      title: px('[data-testid="player-title"]'),
      artist: px('[data-testid="player-artist"]'),
    };
  }, seekSelector);
}

test.describe('mini player spacing on desktop (#1743)', () => {
  test.use({ viewport: DESKTOP });

  test('notch, transport and inline scrubber are apart; the labels clear the edge', async ({
    page,
  }) => {
    await startTrack(page);
    // The labels' row: the inline scrubber plus its two time labels.
    const m = await measure(page, '[data-testid="player-time-current"]');
    const row = await page.evaluate(() => {
      const r = document
        .querySelector('[data-testid="player-time-current"]')!
        .parentElement!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });

    expect(m.play.top - m.pillBottom, 'notch → play-button gap').toBeGreaterThanOrEqual(
      NOTCH_GAP_PX,
    );
    expect(row.top, 'scrubber row starts below the play button').toBeGreaterThanOrEqual(
      m.play.bottom,
    );
    expect(m.barBottom, 'the bar ends on the viewport').toBeLessThanOrEqual(m.vh);
    expect(m.barBottom - row.bottom, 'scrubber row clears the bar edge').toBeGreaterThanOrEqual(
      SEEK_EDGE_PX,
    );
    expect(m.title, 'title size').toBe(16);
    expect(m.artist, 'artist size').toBe(14);
    expect(m.barHeight, 'the bar grows no more than it needs').toBeLessThanOrEqual(100);
  });
});

test.describe('mini player spacing on a phone (#1743)', () => {
  test.use({ viewport: PHONE });

  test('notch, transport and stacked scrubber are apart; 44px targets stay', async ({ page }) => {
    await startTrack(page);
    const m = await measure(page, '[data-testid="player-mobile-seek"] input');

    expect(m.play.top - m.pillBottom, 'notch → play-button gap').toBeGreaterThanOrEqual(
      NOTCH_GAP_PX,
    );
    expect(m.seek.top, 'scrubber starts below the play button').toBeGreaterThanOrEqual(
      m.play.bottom,
    );
    expect(m.barBottom - m.seek.bottom, 'scrubber clears the bar edge').toBeGreaterThanOrEqual(
      SEEK_EDGE_PX,
    );
    for (const [name, b] of [
      ['prev', m.prev],
      ['play', m.play],
      ['next', m.next],
    ] as const) {
      expect(b.width, `${name} is a 44px target`).toBeGreaterThanOrEqual(44);
      expect(b.height, `${name} is a 44px target`).toBeGreaterThanOrEqual(44);
    }
    expect(m.title, 'title size').toBe(16);
    expect(m.artist, 'artist size').toBe(14);
    expect(m.barHeight, 'the bar grows no more than it needs').toBeLessThanOrEqual(106);
  });
});
