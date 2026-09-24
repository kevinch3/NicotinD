/**
 * Queue triage gestures (#1295): the ⋮⋮ handle is the mouse's HTML5 drag
 * source for reorder, and a leftward swipe on a row removes it with an Undo
 * toast. CI's Playwright is Desktop Chrome, so this drives the mouse path; the
 * touch path (long-press reorder, touch-pan-y ownership) is unit-tested in
 * row-gesture.spec.ts and gated on a real device — docs/web-ui.md
 * "Queue row gestures".
 */
import { test, expect, type Page } from '../helpers';
import { FIXTURE, openAlbumCard } from '../helpers';

const DESKTOP = { width: 1280, height: 800 };

async function openNowPlaying(page: Page): Promise<void> {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  await page.getByTestId('player-title').click();
  await expect(page.getByTestId('now-playing-heading')).toBeVisible();
  await expect(page.getByTestId('queue-item').first()).toBeVisible();
}

const titles = (page: Page) => page.getByTestId('queue-row-title').allInnerTexts();

test.describe('queue gestures', () => {
  test.use({ viewport: DESKTOP });

  test('dragging a row by its handle reorders the queue', async ({ page }) => {
    await openNowPlaying(page);
    const before = await titles(page);
    expect(before.length).toBeGreaterThanOrEqual(3);

    const items = page.getByTestId('queue-item');
    await items.nth(0).getByTestId('queue-handle').dragTo(items.nth(2));

    await expect
      .poll(() => titles(page))
      .toEqual([before[1], before[2], before[0], ...before.slice(3)]);
  });

  test('swiping a row left removes it, and Undo puts it back where it was', async ({ page }) => {
    await openNowPlaying(page);
    const before = await titles(page);
    const victim = before[1]!;

    const row = page.getByTestId('queue-item').nth(1).getByTestId('queue-row');
    // hover() waits for the sheet's slide-in to settle; a box read mid-animation lands on the next row.
    await row.hover();
    const box = (await row.boundingBox())!;
    const y = box.y + box.height / 2;
    const x = box.x + box.width * 0.6;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 60, y, { steps: 5 });
    await expect(page.getByTestId('queue-swipe-reveal')).toBeVisible();
    await page.mouse.move(x - 160, y, { steps: 5 });
    await page.mouse.up();

    await expect.poll(() => titles(page)).toEqual(before.filter((_, i) => i !== 1));
    const toast = page.getByTestId('toast').filter({ hasText: victim });
    await expect(toast).toBeVisible();
    // The swipe ended over the row: its release must not have jumped playback there.
    await expect(page.getByTestId('player-title')).not.toHaveText(victim);

    await toast.getByTestId('toast-action-0').click();
    await expect.poll(() => titles(page)).toEqual(before);
    await expect(toast).toHaveCount(0);
  });

  test('a short swipe snaps back and removes nothing', async ({ page }) => {
    await openNowPlaying(page);
    const before = await titles(page);

    const row = page.getByTestId('queue-item').nth(0).getByTestId('queue-row');
    // hover() waits for the sheet's slide-in to settle; a box read mid-animation lands on the next row.
    await row.hover();
    const box = (await row.boundingBox())!;
    const y = box.y + box.height / 2;
    const x = box.x + box.width * 0.6;
    await page.mouse.move(x, y);
    await page.mouse.down();
    // Slow and short: under the distance threshold, no flick.
    for (const dx of [12, 20, 28, 36]) {
      await page.mouse.move(x - dx, y);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(150);
    await page.mouse.up();

    await expect(page.getByTestId('queue-swipe-reveal')).toHaveCount(0);
    expect(await titles(page)).toEqual(before);
  });
});
