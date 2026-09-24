/**
 * Now Playing desktop layout (Spotify-like side panel) — at lg (≥1024px) the
 * queue/lyrics panel renders as a fixed-width right column beside the cover +
 * transport instead of stacking below them, and the mobile drag-resize handle
 * (vertical-only gesture) is hidden. Pure CSS breakpoint behavior, so it needs
 * a real browser: the unit harness (jsdom) has no layout engine.
 */
import { test, expect, type Page } from '../helpers';
import { FIXTURE, openAlbumCard } from '../helpers';

const DESKTOP = { width: 1280, height: 800 };

/** Play the fixture album and expand the mini-player into the Now Playing sheet
 *  (a tap anywhere on the bar opens it — width-independent). */
async function openNowPlaying(page: Page): Promise<void> {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  await page.getByTestId('player-title').click();
  await expect(page.getByTestId('now-playing-heading')).toBeVisible();
}

test.describe('Now Playing desktop layout', () => {
  test.use({ viewport: DESKTOP });

  test('queue panel renders beside the cover, not below it', async ({ page }) => {
    await openNowPlaying(page);

    const coverBox = (await page.getByTestId('now-playing-cover').boundingBox())!;
    const queueBox = (await page.getByTestId('now-playing-queue').boundingBox())!;

    expect(queueBox.x, 'queue starts right of the cover').toBeGreaterThanOrEqual(
      coverBox.x + coverBox.width,
    );
    expect(queueBox.y, 'queue vertically overlaps the cover (a column, not a stack)').toBeLessThan(
      coverBox.y + coverBox.height,
    );
  });

  test('the mobile drag-resize handle is hidden at desktop width', async ({ page }) => {
    await openNowPlaying(page);
    await expect(page.getByTestId('now-playing-queue-resize')).toBeHidden();
  });

  test('the Lyrics tab swaps into the same side panel', async ({ page }) => {
    await openNowPlaying(page);

    const queueBox = (await page.getByTestId('now-playing-queue').boundingBox())!;
    await page.getByTestId('now-playing-tab-lyrics').click();

    const lyrics = page.getByTestId('now-playing-lyrics');
    await expect(lyrics).toBeVisible();
    const lyricsBox = (await lyrics.boundingBox())!;
    // Same right column: the lyrics panel occupies the queue's x-range.
    expect(Math.abs(lyricsBox.x - queueBox.x), 'same column x').toBeLessThan(24);
    await expect(page.getByTestId('now-playing-queue')).toHaveCount(0);
  });

  /**
   * Waveform strip (issue #643): the server decodes the fixture on demand into
   * peaks, the sheet draws them as two envelope paths (base + played overlay
   * clipped to progress), and a tap on the strip seeks. The fixtures are
   * silent, so the envelope is a hairline — the assertion is on the contract,
   * not the shape.
   */
  test('the waveform strip renders above the seek bar and a tap seeks', async ({ page }) => {
    await openNowPlaying(page);
    const strip = page.getByTestId('now-playing-waveform');
    await expect(strip).toBeVisible();
    // The box is reserved before the decode returns (#657), so both envelope
    // paths are in the DOM from the first paint and counting them proves
    // nothing on its own — wait for the state flip that means data landed.
    await expect(strip).toHaveAttribute('data-state', 'envelope');
    await expect(strip.locator('path[d]')).toHaveCount(2);

    // locator.click() waits for the strip to stop moving (the sheet slides up
    // on open); a raw page.mouse.click at a pre-animation boundingBox lands on
    // whatever was under that point at the time.
    const box = (await strip.boundingBox())!;
    await strip.click({ position: { x: box.width * 0.5, y: box.height / 2 } });
    // The played overlay is clipped to (100 − percent)% from the right; after a
    // seek to the middle that lands near 50% and drifts as playback continues.
    // Chrome normalises the declared `inset(0 N% 0 0)` to `inset(0px N% 0px 0px)`.
    await expect(strip.locator('path').nth(1)).toHaveAttribute(
      'style',
      /inset\(0(px)? (3\d|4\d|5\d)(\.\d+)?% 0(px)? 0(px)?\)/,
    );
  });

  test('the splitter resizes the side panel and the width survives a reload', async ({ page }) => {
    await openNowPlaying(page);
    const splitter = page.getByTestId('now-playing-side-resize');
    await expect(splitter).toBeVisible();
    // hover() waits for the sheet's slide-up to settle: a box measured
    // mid-transition puts the mouse off the splitter.
    await splitter.hover();
    const queue = page.getByTestId('now-playing-queue');
    const before = (await queue.boundingBox())!;

    const box = (await splitter.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 120, y, { steps: 8 });
    await page.mouse.up();

    const after = (await queue.boundingBox())!;
    expect(after.width - before.width, 'panel grew by the drag').toBeGreaterThan(100);

    await page.reload();
    await expect(page.getByTestId('player-title')).toBeVisible();
    await page.getByTestId('player-title').click();
    await expect(page.getByTestId('now-playing-heading')).toBeVisible();
    const reloaded = (await page.getByTestId('now-playing-queue').boundingBox())!;
    expect(Math.abs(reloaded.width - after.width), 'width persisted').toBeLessThan(4);
  });

  test('the splitter is keyboard-operable', async ({ page }) => {
    await openNowPlaying(page);
    const splitter = page.getByTestId('now-playing-side-resize');
    await splitter.focus();
    await expect(splitter).toHaveAttribute('aria-valuenow', '380');
    await page.keyboard.press('ArrowLeft');
    await expect(splitter).toHaveAttribute('aria-valuenow', '396');
    await page.keyboard.press('End');
    await expect(splitter).toHaveAttribute('aria-valuenow', '640');
    await page.keyboard.press('Home');
    await expect(splitter).toHaveAttribute('aria-valuenow', '300');
  });

  /**
   * Keyboard vocabulary (#1296). Blur first: the click that opened the sheet
   * leaves focus on a button, where Space is the button's own activation.
   */
  test('the keyboard drives the player: Space, Esc, / and ?', async ({ page }) => {
    await openNowPlaying(page);
    const playPause = page.getByTestId('player-playpause').first();
    await expect(playPause).toHaveAttribute('data-playing', 'true');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await page.keyboard.press('Space');
    await expect(playPause).toHaveAttribute('data-playing', 'false');
    await page.keyboard.press('Space');
    await expect(playPause).toHaveAttribute('data-playing', 'true');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('now-playing-heading')).not.toBeInViewport();

    await page.keyboard.press('/');
    const search = page.locator('main input[type="search"]:focus');
    await expect(search).toBeVisible();
    // Typing in it is typing, not a shortcut.
    await page.keyboard.press('k');
    await expect(search).toHaveValue('k');
    await expect(playPause).toHaveAttribute('data-playing', 'true');

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('?');
    const sheet = page.getByTestId('shortcuts-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('shortcuts-row').first()).toContainText('Space');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });
});
