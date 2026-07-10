import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

/**
 * The unified `⋯` song row menu (SongMenuService.build) on an album detail
 * page: common actions, album-page-specific suppression of "Go to album",
 * the Song info sheet, and the admin remove-from-library flow (global
 * ConfirmHost → deleteSongs → deletedSongIds filtering).
 */
test.describe('song row menu', () => {
  test('shows the common actions and hides "Go to album" on an album page', async ({ page }) => {
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).first().click();
    await expect(page).toHaveURL(/\/library\/albums\//);

    const row = page.getByTestId('track-row').first();
    await expect(row).toBeVisible();
    await row.getByTestId('track-row-menu-toggle').click();

    const menu = row.getByTestId('track-row-menu');
    await expect(menu).toBeVisible();

    for (const label of [
      'Add to queue',
      'Play next',
      'Start radio',
      'Go to artist',
      'Add to playlist',
      'Save offline',
      'Song info',
    ]) {
      await expect(row.getByTestId(`track-action-${label}`)).toBeVisible();
    }

    // Album detail passes { hideGoToAlbum: true } — redundant on the page you're
    // already viewing.
    await expect(row.getByTestId('track-action-Go to album')).toHaveCount(0);
  });

  test('"Song info" opens the track-info sheet', async ({ page }) => {
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).first().click();
    await expect(page).toHaveURL(/\/library\/albums\//);

    const row = page.getByTestId('track-row').first();
    await row.getByTestId('track-row-menu-toggle').click();
    await row.getByTestId('track-action-Song info').click();

    await expect(page.getByTestId('track-info-sheet')).toBeVisible();
    await expect(page.getByTestId('track-info-identity')).toBeVisible();
  });

  test('admin "Remove from library" confirms via the global ConfirmHost and removes the row', async ({
    page,
  }) => {
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).first().click();
    await expect(page).toHaveURL(/\/library\/albums\//);

    const rows = page.getByTestId('track-row');
    const countBefore = await rows.count();
    expect(countBefore).toBeGreaterThan(0);

    // Pick a middle track ("Quiet Hours") rather than the first/last row: other
    // specs assert the bookend tracks ("Opening Static"/"Closing Time") and one
    // asserts on "Second Wind" — deleting this one keeps the fixture album intact
    // enough for any spec that happens to run later in the shared server session.
    const removedTitle = 'Quiet Hours';
    const row = rows.filter({ hasText: removedTitle });
    await expect(row).toHaveCount(1);
    await row.getByTestId('track-row-menu-toggle').click();
    await row.getByTestId('track-action-Remove from library').click();

    // Scoped to the global ConfirmHost overlay — the legacy per-page
    // app-confirm-dialog also exposes a confirm-ok testid, so anchor on the
    // overlay-unique confirm-dialog testid and assert exactly one match.
    const dialog = page.locator('[data-testid="confirm-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCount(1);
    await expect(dialog.getByText(removedTitle, { exact: false })).toBeVisible();

    await dialog.getByTestId('confirm-ok').click();

    await expect(dialog).toHaveCount(0);
    await expect(rows).toHaveCount(countBefore - 1);
    await expect(page.getByText(removedTitle, { exact: true })).toHaveCount(0);
  });
});
