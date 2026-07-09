import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

test.describe('library', () => {
  test('shows the fixture album in the grid and its tracklist', async ({ page }) => {
    await page.goto('/library');

    const card = page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title });
    await expect(card).toBeVisible();

    await card.click();
    await expect(page).toHaveURL(/\/library\/albums\//);

    // Album detail renders the title and the bookend tracks of the 7-track album.
    await expect(page.getByText(FIXTURE.album.title, { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Opening Static')).toBeVisible();
    await expect(page.getByText('Closing Time')).toBeVisible();
  });

  test('album track rows omit the redundant per-track thumbnail', async ({ page }) => {
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).first().click();
    await expect(page).toHaveURL(/\/library\/albums\//);
    await expect(page.getByText('Opening Static')).toBeVisible();

    // In a single-album context every row shares the album cover, so the per-row
    // thumbnail is suppressed — the track number carries row identity. The
    // CoverArtComponent (`app-cover-art`) renders an img OR a gradient fallback,
    // so assert the whole component is absent (an img check passes trivially when
    // the fixtures have no art).
    const rows = page.locator('app-track-row');
    await expect(rows.first()).toBeVisible();
    expect(await rows.locator('app-cover-art').count()).toBe(0);
  });

  test('the loose single is not in the Albums grid', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByTestId('album-card').first()).toBeVisible();
    // The single is bucketed as a single, so it must not appear among albums.
    await expect(
      page.getByTestId('album-card').filter({ hasText: FIXTURE.single.title }),
    ).toHaveCount(0);
  });

  test('the artist page Songs tab lazily lists the artist’s tracks', async ({ page }) => {
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).first().click();
    await expect(page).toHaveURL(/\/library\/albums\//);

    // Album detail → artist page via the artist name link.
    await page.getByRole('link', { name: FIXTURE.album.artist }).first().click();
    await expect(page).toHaveURL(/\/library\/artists\//);

    // Open the Songs tab; it lazy-loads the artist's individual tracks.
    await page.getByTestId('artist-tab-songs').click();
    const list = page.getByTestId('artist-songs-list');
    await expect(list).toBeVisible();
    await expect(page.getByText('Opening Static')).toBeVisible();

    // The Songs filter menu opens (and is clamped on-screen by MenuPanel).
    await page.getByTestId('artist-songs-filters').click();
    await expect(page.getByTestId('artist-songs-filter-panel')).toBeVisible();
  });

  test('metadata filters narrow the grid, live in the URL, and survive reload', async ({
    page,
  }) => {
    await page.goto('/library');
    await expect(page.getByTestId('album-card').first()).toBeVisible();

    // Fixtures are tagged date=2024, so yearMin=2030 must empty the grid.
    await page.getByTestId('library-filters').click();
    await expect(page.getByTestId('library-filter-panel')).toBeVisible();
    await page.getByTestId('library-filter-year-min').fill('2030');
    await page.getByTestId('library-filter-year-min').blur();

    await expect(page.getByTestId('library-filter-count')).toHaveText('1');
    await expect(page).toHaveURL(/yearMin=2030/);
    await expect(page.getByTestId('album-card')).toHaveCount(0);

    // The filter is URL state: a reload keeps it applied.
    await page.reload();
    await expect(page).toHaveURL(/yearMin=2030/);
    await expect(page.getByTestId('album-card')).toHaveCount(0);
    await expect(page.getByTestId('library-filter-count')).toHaveText('1');

    // Clearing restores the grid (and drops the param).
    await page.getByTestId('library-filters').click();
    await page.getByTestId('library-filter-clear').click();
    await expect(page.getByTestId('album-card').first()).toBeVisible();
  });

  test('the Filters menu stays inside the viewport on a narrow screen', async ({ page }) => {
    // A phone-width viewport is where a bare `right-0` panel overflowed. The
    // clamped MenuPanel must keep the whole panel on-screen.
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/library');
    await expect(page.getByTestId('album-card').first()).toBeVisible();

    await page.getByTestId('library-filters').click();
    const panel = page.getByTestId('library-filter-panel');
    await expect(panel).toBeVisible();

    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    // Fully within the viewport horizontally (small margin tolerance).
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360 + 1);
  });
});
