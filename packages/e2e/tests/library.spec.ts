import { test, expect } from '@playwright/test';
import { FIXTURE, openAlbumCard } from '../helpers';

test.describe('library', () => {
  test('shows the fixture album in the grid and its tracklist', async ({ page }) => {
    await page.goto('/library');

    await openAlbumCard(page, FIXTURE.album.title);

    // Album detail renders the title and the bookend tracks of the 7-track album.
    await expect(page.getByText(FIXTURE.album.title, { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Opening Static')).toBeVisible();
    await expect(page.getByText('Closing Time')).toBeVisible();
  });

  test('album track rows omit the redundant per-track thumbnail', async ({ page }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
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
    await openAlbumCard(page, FIXTURE.album.title);

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

  test('the Songs tab lists the whole library newest-first with filter + actions', async ({
    page,
  }) => {
    await page.goto('/library');
    await expect(page.getByTestId('album-card').first()).toBeVisible();

    // Switch to the Songs tab (appended to the mode switcher).
    await page.getByRole('button', { name: 'Songs', exact: true }).click();
    const list = page.getByTestId('library-songs-list');
    await expect(list).toBeVisible();

    // Flat whole-library listing includes fixture album tracks.
    await expect(page.getByText('Opening Static')).toBeVisible();

    // Newest-first by default.
    await expect(page.getByTestId('library-songs-sort')).toHaveValue('newest');

    // The shared LibraryFilter panel is available here too.
    await page.getByTestId('library-songs-filters').click();
    await expect(page.getByTestId('library-songs-filter-panel')).toBeVisible();
    await page.keyboard.press('Escape');

    // Multi-select is available (Select → bar with add-to-playlist).
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(page.getByTestId('selection-add')).toBeVisible();
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

  /**
   * The album fixture ships a real `cover.jpg`, so the grid must show it rather
   * than the gradient placeholder.
   *
   * Worth asserting because the failure is invisible: `CoverArtComponent` falls
   * back to a tasteful gradient with the album initial, so a broken cover URL
   * (a missing auth token, a bad path) looks like a deliberate design choice.
   * `naturalWidth > 0` is the only honest proof the bytes arrived and decoded.
   */
  test('the album grid renders the real cover, not the placeholder', async ({ page }) => {
    await page.goto('/library');
    const card = page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title });
    await expect(card).toBeVisible();

    const img = card.locator('img');
    await expect(img).toHaveCount(1);
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 })
      .toBeGreaterThan(0);
  });

  /**
   * The cross-type find bar (feedback-log-2026-07 item #7): a user typed an
   * artist + title together, got songs back, and concluded the album was
   * missing because no album card ever surfaced. One box must return every
   * result type, not just the one whose tab happens to be open.
   */
  test('the find bar returns albums, not just songs, for an artist+title query', async ({
    page,
  }) => {
    await page.goto('/library');

    await page.getByTestId('library-find').fill(`${FIXTURE.album.artist} ${FIXTURE.album.title}`);

    // The album card is the assertion that matters — songs alone were the bug.
    const albums = page.getByTestId('library-find-albums');
    await expect(albums).toBeVisible();
    await expect(
      albums.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }),
    ).toBeVisible();

    // The browse tabs are replaced while a search is active.
    await expect(page.getByTestId('library-tabs')).toHaveCount(0);

    // The query is in the URL, so the search is linkable.
    await expect(page).toHaveURL(/find=/);
  });

  test('clearing the find bar restores the browse tabs', async ({ page }) => {
    await page.goto('/library');
    await page.getByTestId('library-find').fill(FIXTURE.album.title);
    await expect(page.getByTestId('library-find-results')).toBeVisible();

    await page.getByTestId('library-find-clear').click();
    await expect(page.getByTestId('library-tabs')).toBeVisible();
    await expect(page.getByTestId('library-find-results')).toHaveCount(0);
  });

  test('a query matching nothing you own reports empty rather than failing', async ({ page }) => {
    await page.goto('/library');

    // Wait on the search the page actually performs, not on slack. The find bar
    // debounces 250 ms (FIND_DEBOUNCE_MS) and only then mounts its results
    // subtree, so without a barrier the debounce, the navigation and the whole
    // /api/search round trip had to fit inside Playwright's default 5 s expect
    // timeout — the spec asserted a settled UI it never waited for (#767).
    const searched = page.waitForResponse(
      (r) => r.url().includes('/api/search') && r.request().method() === 'GET',
      { timeout: 15_000 },
    );
    await page.getByTestId('library-find').fill('zzz no such release zzz');
    await searched;

    // The debounce committed the query into the URL, so the find state is linkable.
    await expect(page).toHaveURL(/find=zzz/);
    // "rather than failing" is half this test's title and was never checked:
    // an errored search used to fail here as "empty not visible", naming the
    // wrong branch.
    await expect(page.getByTestId('library-find-error')).toHaveCount(0);
    await expect(page.getByTestId('library-find-empty')).toBeVisible();
  });
});
