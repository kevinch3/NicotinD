import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

test.describe('playback', () => {
  test('streams audio when an album is played', async ({ page }) => {
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).click();
    await expect(page).toHaveURL(/\/library\/albums\//);

    // The player streams via GET /api/stream/:id?token= (range -> 206, or 200).
    const streamResponse = page.waitForResponse(
      (r) => r.url().includes('/api/stream/') && [200, 206].includes(r.status()),
      { timeout: 15_000 },
    );

    await page.getByTestId('play-album').click();
    const res = await streamResponse;
    expect([200, 206]).toContain(res.status());

    // A double-buffered <audio> element should load and begin advancing.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll('audio')).some(
              (a) => a.readyState >= 2 || a.currentTime > 0,
            ),
          ),
        { timeout: 10_000, intervals: [250, 500] },
      )
      .toBe(true);
  });

  test('track row acknowledges the click and settles into playing state', async ({ page }) => {
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).click();
    await expect(page).toHaveURL(/\/library\/albums\//);

    const firstRow = page.getByTestId('track-row').first();
    await firstRow.getByTestId('track-row-title').click();

    // Instant acknowledgment: the row carries a playback state right away
    // (buffering while bytes arrive on slow disks, or straight to playing).
    await expect(firstRow).toHaveAttribute('data-playback-state', /buffering|playing/, {
      timeout: 2_000,
    });

    // And settles to playing once audio actually starts.
    await expect(firstRow).toHaveAttribute('data-playback-state', 'playing', {
      timeout: 15_000,
    });
  });
});
